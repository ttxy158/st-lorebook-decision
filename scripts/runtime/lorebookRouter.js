/**
 * 决策模型接管世界书注入
 *
 * 流程（两个事件，都在 ST 的 await 链上，所以来得及影响本次生成）：
 *   GENERATION_STARTED      → 采集候选条目 → 一次批量请求决策模型 → 结果存到 pending
 *   WORLDINFO_ENTRIES_LOADED → 用 pending 改本次扫描的条目副本（压制）并 emit 强制激活
 *   GENERATION_ENDED        → 清空 pending
 *
 * 为什么不在 ENTRIES_LOADED 里直接发请求：getSortedEntries 也会在切换聊天时被调用
 * （world-info.js:1017 的预缓存），在那里发请求会在用户没生成的时候也花钱。
 *
 * 三态判定：高概率强推、低概率压制、中间带不动。压制默认关闭，只记录「本会被压制」，
 * 因为实测无关项的概率落在 0.23~0.35 而不是 0.01，阈值没校准前去压制有误伤风险。
 *
 * 中间带默认交回关键词规则；勾选「关闭关键词触发注入」后不再交回：判过的条目只有强推才注入。
 * 没拿到判定的条目（超出候选上限、模型没返回）任何情况下都保持关键词原样，不会凭空消失。
 *
 * 决策时机（每轮 / 每 n 轮 / 自主启动）与依据来源（正文 / LLM 摘要）见 decisionBasis.js：
 * 摘要那条路是给「正文太露骨会被整批拒答」准备的。
 */
import { APP, EDITOR, USER } from '../../core/manager.js';
import { getSortedEntries } from '/scripts/world-info.js';
import { POPUP_RESULT } from '/scripts/popup.js';
import {
    buildQuestions,
    buildState,
    buildDigestState,
    buildEntryDigest,
    entryTitle,
    chunk,
    isModerationRejection,
    isProxyNotEnabled,
    proxyFixCommand,
    mergeAnswers,
    parseAnswers,
    applyInjectQuota,
    renderInstruction,
    requestDecision,
    resolveTaskBriefing,
    DECISION_DEFAULT_MODEL,
    DECISION_MAX_QUESTIONS,
    DECISION_MAX_IN_FLIGHT,
} from '../../services/decisionApiService.js';
import {
    basisConfig,
    basisDigest,
    decideTiming,
    skipsAfterDecision,
    effectiveReuseRounds,
    readBasisState,
    refreshBasisAfterGeneration,
    resolveBasisMode,
    resolveTiming,
    summarizeBasis,
} from './decisionBasis.js';
import {
    filterDecisionEntries,
    createMaterialResolver,
    normalizeTypes,
    normalizeIndex,
    readIndexNumbers,
    fnv1aHex,
} from './decisionEntryIndex.js';
import { getPrivacyKey } from '../settings/standaloneAPI.js';
import { newPopupConfirm } from '../../components/popupConfirm.js';
import { SECRET_UNUSABLE_HINT } from '../../utils/utility.js';

// 本轮生成的决策结果，null 表示不接管
let pending = null;
// 最近一次决策的完整报告，只存内存
let lastReport = null;
// 按轮复用：判定成功后记下「这一轮到底问了什么」，之后 N 轮生成一个请求都不发。
// 键里刻意不含 state——正文每轮都是新的，带 state 的缓存等于每轮都失效（旧的「结果复用（秒）」就是这么废掉的）。
// 代价说清楚：这 N 轮的判定是旧的，剧情推进了也不会重问；条目内容/摘要/问法一变就当场作废。
let reuse = null;
// 决策时机的记账：「每 n 轮」还差几轮才到点（判完一次设成 n-1，每歇一轮减一）、
// 自主启动档里用户是否许了「下一次生成要判」
let skipsUntilDue = 0;
let manualArmed = false;
// 这一轮为什么没判（小栏要能说清「本轮没问模型」是间隔、还是你压根没点按钮）
let lastSkip = '';

function readConfig() {
    const setting = USER.store || {};
    // 数字输入框被清空时会存下空字符串，Number('') 是 0，阈值类设置必须回到默认值
    const num = (value, fallback) => {
        if (value === '' || value === null || value === undefined) return fallback;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    };
    const indexMap = normalizeIndex(setting.decision_entry_index);
    return {
        enabled: setting.decision_router_enabled === true,
        url: String(setting.decision_api_url || '').trim(),
        model: String(setting.decision_model || '').trim() || DECISION_DEFAULT_MODEL,
        useProxy: setting.decision_use_proxy !== false,
        forceThreshold: num(setting.decision_force_threshold, 0.85),
        suppressThreshold: num(setting.decision_suppress_threshold, 0.25),
        suppressEnabled: setting.decision_suppress_enabled === true,
        // 勾选后：判过的条目不再走关键词兜底，只有强推才注入
        blockKeyword: setting.decision_block_keyword === true,
        maxCandidates: Math.max(1, num(setting.decision_max_candidates, 60)),
        // 本轮注入名额上限：候选上限管「问多少条」，这两个管「判出来以后实际塞进去多少条」。
        // 0 = 不限。只在注入那一刻套，不进判定、也不进复用键，所以改了这个数下一轮直接生效，不用重新问模型。
        injectMaxEntries: Math.max(0, num(setting.decision_inject_max_entries, 0)),
        injectMaxChars: Math.max(0, num(setting.decision_inject_max_chars, 0)),
        // 单次请求塞多少条。接口有硬上限 16 条（超了直接 400），所以这里无论存的是多少都要夹住，
        // 它和「候选上限」是两个独立的数：候选上限管总共判多少，单批上限管分几轮问。
        batchSize: Math.min(DECISION_MAX_QUESTIONS, Math.max(1, num(setting.decision_batch_size, DECISION_MAX_QUESTIONS))),
        // 多轮时同时发几路。接口不限流，但浏览器对同一个来源只有 6 个连接，留 2 个给正常收发
        inFlight: Math.max(1, Math.min(DECISION_MAX_IN_FLIGHT, num(setting.decision_in_flight, DECISION_MAX_IN_FLIGHT))),
        multiRound: setting.decision_multi_round === true,
        digestLimit: Math.max(40, num(setting.decision_digest_limit, 120)),
        contextMessages: Math.max(1, num(setting.decision_context_messages, 4)),
        contextChars: Math.max(50, num(setting.decision_context_chars, 600)),
        // 末尾几条整段带、不截字数：AI 回复的结尾才是「此刻在发生什么」，保头去尾恰好把它砍掉
        contextFullMessages: Math.max(0, num(setting.decision_context_full_messages, 1)),
        // 决策依据换成 LLM 写的滚动摘要、不拼正文：正文里的露骨描写会让决策模型整批拒答（DataInspectionFailed）。
        // 摘要在每轮 AI 回复写完时由 decisionBasis.js 刷新。
        basisSummary: resolveBasisMode(setting) === 'summary',
        ...basisConfig(setting),
        // 每轮 / 每 n 轮 / 自主启动
        timing: resolveTiming(setting),
        // 判定成功后连着几轮不再问模型。「每 n 轮」时生效值至少要是 n，
        // 否则间隔里那些轮没有判定、会悄悄退回关键词注入（抬的是生效值，你存的数不动）
        reuseRounds: effectiveReuseRounds(num(setting.decision_reuse_rounds, 0), resolveTiming(setting)),
        instructionTemplate: String(setting.decision_instruction_template || ''),
        stateNote: String(setting.decision_state_note || '').trim(),
        // 工作认知（任务说明）：老存档没这个键才回默认，清空成 '' 就是真的不要这段
        taskBriefing: resolveTaskBriefing(setting.decision_task_briefing),
        // 用户把这段清空就是真的不要标注，不能退回默认值，所以这里不用 ??
        pendingNote: String(setting.decision_pending_note ?? ''),
        timeoutMs: Math.max(2000, num(setting.decision_timeout_ms, 15000)),
        failSilent: setting.decision_fail_silent === true,
        autoPopup: setting.decision_auto_popup === true,
        // 条目摘要索引：开着的条目用「LLM 写好的短摘要 + 那一类自己的问法」，
        // 关着或这条没索引就退回以前的正文片段 + 通用问法。索引内容变了要重算，所以指纹/分类都重新读。
        indexEnabled: setting.decision_index_enabled === true,
        indexTypes: normalizeTypes(setting.decision_entry_types),
        indexMap,
        indexSummaryLimit: readIndexNumbers(setting).summaryLimit,
        // 建索引的趟号：并进缓存键，刚重建过索引就不会复用上一份按旧摘要判的结果。
        // 手填那一条不改趟号，所以把最新的写入时间也带上，免得刚保存完还在吃旧摘要判出来的缓存。
        indexAt: Math.max(num(setting.decision_index_at, 0), ...Object.values(indexMap).map(record => record.at || 0), 0),
    };
}

/**
 * 候选条目 = 带关键词的普通条目。常驻、用户已关闭、@@ 手动钉住的都不接管。
 * @description 过滤口径和建索引那一趟共用 filterDecisionEntries，两边认的必须是同一批条目
 * @param {object} config
 * @returns {Promise<Array>}
 */
async function collectCandidates(config) {
    const entries = await getSortedEntries();
    const filtered = filterDecisionEntries(entries);
    return { list: filtered.slice(0, config.maxCandidates), total: filtered.length };
}

/**
 * 输入框里「本次要发、但还没写进聊天记录」的那句话。
 *
 * GENERATION_STARTED 在 script.js:4216，用户消息在 script.js:4370 才入列，
 * 也就是世界书关键词扫描看得见这句话、而决策模型默认看不到 —— 这里补上，两边对齐。
 * @param {string} type 生成类型
 * @returns {string}
 */
function readDraftInput(type) {
    // 只有用户点发送才代表本轮新输入；regenerate / swipe / quiet 时框里可能躺着没发出去的草稿，不能算剧情
    if (type && type !== 'normal') return '';
    return String($('#send_textarea').val() || '').trim();
}

/**
 * 拼本轮的决策依据
 * @description 两条路：正文（默认）和 LLM 摘要。摘要还没写出来时（新开聊天第一轮）退回正文并说明一次，
 * @description 因为宁可用可能让模型拒答的正文判一轮，也不要因为依据是空的就整轮不判。
 * @description 返回的 parts 是给「拒答后临时改用摘要再判一次」那条路复用的，不用再读一遍聊天。
 * @param {object} config readConfig() 的结果
 * @param {string} type 生成类型
 * @returns {{state: string, source: 'summary'|'chat', rows: number, chars: number, fallback: boolean, parts: object}}
 */
function buildStateText(config, type) {
    const context = USER.getContext() || {};
    const shared = {
        userName: context.name1 || '',
        characterName: context.name2 || '',
        sceneNote: config.stateNote,
        pendingNote: config.pendingNote,
        taskBriefing: config.taskBriefing,
    };
    const draft = readDraftInput(type);
    const pendingDraft = draft ? [{ isUser: true, name: context.name1 || '', text: draft, pending: true }] : [];
    const chat = (context.chat || []).filter(message => message && !message.is_system);
    const recent = chat.slice(-config.contextMessages).map(message => ({
        isUser: !!message.is_user,
        name: message.name,
        text: message.mes,
    }));
    if (draft && String(recent[recent.length - 1]?.text || '').trim() !== draft) {
        recent.push({ isUser: true, name: context.name1 || '', text: draft, pending: true });
    }
    const parts = { shared, pendingDraft, recent, floors: chat.slice(-config.contextMessages) };

    if (config.basisSummary) {
        const digest = basisDigest(context);
        if (digest) {
            return {
                source: 'summary',
                rows: readBasisState(context)?.covered ?? 0,
                chars: digest.length,
                fallback: false,
                parts,
                state: buildDigestState({ ...shared, digest, messages: pendingDraft }, config.contextChars, config.contextFullMessages),
            };
        }
        noticeOnce('basis_fallback', '决策依据设成了「LLM 摘要」，但这个聊天还没有摘要（每轮 AI 回复写完才会写出来），本轮先改用最近几楼正文。');
    }

    return {
        source: 'chat',
        rows: recent.length,
        chars: recent.reduce((sum, message) => sum + message.text.length, 0),
        fallback: config.basisSummary === true,
        parts,
        state: buildState({ ...shared, messages: recent }, config.contextChars, config.contextFullMessages),
    };
}

/**
 * 复用键：只由「这轮问了什么」决定，不含正文
 * @description 问题文本里已经带上条目摘要和那一类的问法，所以改条目正文、重建索引、手填摘要、
 * @description 改判定问法、改摘要字数都会让键当场对不上；任务说明和固定背景只进 state、不进问题，所以另拼一份。
 * @description 缓存键只要「同一批问题对得上」，不是安全用途，所以用同步的 FNV-1a（utils/utility.js 里那个
 * @description calculateStringHash 走 crypto.subtle 的 MD5，浏览器根本不支持：它一抛 NotSupportedError 就会
 * @description 从 try 之外逃出去，整轮决策静默死掉，世界书退回关键词注入且一句提示都没有）。
 */
function buildReuseKey(batches, config) {
    const asked = (batches || []).map(built => JSON.stringify(built.questions)).join('');
    return fnv1aHex(`${asked}@@idx${config.indexAt}@@brief${config.taskBriefing}|${config.stateNote}`);
}

/**
 * 请求失败时暂停问用户
 * @description 重试没有次数上限——用户要的是「我还没说停，你不许替我放弃」。生成卡在这条 await 链上，
 * @description 所以每点一次重试才会多问一次，不会自己转圈。静默模式（decision_fail_silent）根本不弹。
 * @description 被对端当敏感内容拒掉时多给两颗：复用上轮判定（不花钱）、或先让另一个模型把正文摘要一遍
 * @description 再拿摘要来判（花钱、慢，但是这一轮唯一还能继续让决策模型接管的路）。
 * @param {string} message 失败原因
 * @param {string} roundLabel 多轮时是「第 2/3 轮」，单轮为空
 * @param {number} retried 已经重试过几次
 * @param {number} candidateCount 本轮候选条数，为 0 时不给「自己挑」那颗按钮
 * @param {{reuse?: boolean, basis?: boolean}} offers 要不要给那两颗新按钮
 * @returns {Promise<'retry'|'keyword'|'pick'|'reuse'|'basis'>}
 */
async function askRetry(message, roundLabel = '', retried = 0, candidateCount = 0, offers = {}) {
    const buttons = [];
    if (candidateCount > 0) buttons.push({ text: '我自己挑注入条目', result: POPUP_RESULT.CUSTOM1 });
    if (offers.reuse) buttons.push({ text: '全部复用上轮结果', result: POPUP_RESULT.CUSTOM2 });
    if (offers.basis) buttons.push({ text: '本轮使用正文摘要', result: POPUP_RESULT.CUSTOM3 });
    const options = {
        okButton: '重试',
        cancelButton: '取消（按原关键词注入）',
        allowVerticalScrolling: true,
        // 回车/ESC 走「按原关键词注入」：默认值落在「再发一次请求」上太危险
        defaultResult: POPUP_RESULT.NEGATIVE,
    };
    // 注意这颗是 customButtons：ST 的 Popup 构造函数只认这个名字（popup.js:206），
    // 以前写的 buttons 会被整个丢掉，所以「我自己挑」那颗其实从来没出现过。
    if (buttons.length) options.customButtons = buttons;
    const html = `
<div class="wide100p padding5" style="display:flex;flex-direction:column;gap:8px;">
    <div class="justifyLeft">决策模型调用失败${roundLabel ? `（${roundLabel}）` : ''}：</div>
    <div class="decision-fail-reason justifyLeft">${escapeHtml(message)}</div>
    ${offers.basis || offers.reuse ? `<small class="toggle-description justifyLeft">这一条是<b>内容被对端过滤</b>（不是网络问题）：同样的正文再问一遍大概率还是被拒，所以多了下面两颗。</small>` : ''}
    <small class="toggle-description justifyLeft">
        「重试」把失败的轮次再问一遍，可以一直重试${retried ? `（已经重试 ${retried} 次）` : ''}。
        ${candidateCount > 0 ? '「我自己挑」列出这轮的条目，你勾中哪些就注入哪些，本轮不再问模型，没勾的照关键词规则走。' : ''}
        ${offers.reuse ? '「全部复用上轮结果」直接拿上一次那份判定当本轮判定，一个请求都不发（判定是旧的，这几轮剧情推进了也不会重问）。' : ''}
        ${offers.basis ? '「本轮使用正文摘要」先让写正文那个模型把这几楼改写成概括，再拿概括去判——要多等一趟摘要请求，不能常用。' : ''}
        「取消」放弃本次决策、按原关键词注入照常生成。
    </small>
</div>
<style>
    .decision-fail-reason { font-size: 12px; color: var(--SmartThemeEmColor); max-height: 120px; overflow: auto; text-align: left; }
</style>`;
    const result = await new EDITOR.Popup(html, EDITOR.POPUP_TYPE.CONFIRM, '', options).show();
    const custom = {
        [POPUP_RESULT.CUSTOM1]: 'pick',
        [POPUP_RESULT.CUSTOM2]: 'reuse',
        [POPUP_RESULT.CUSTOM3]: 'basis',
    };
    if (custom[result]) return custom[result];
    return result === POPUP_RESULT.AFFIRMATIVE ? 'retry' : 'keyword';
}

/**
 * 上一次真正判出来的那份结果（弹窗里「全部复用上轮结果」的根据）
 * @description 复用窗口走完（roundsLeft 归 0）也算有上轮结果——那颗按钮要的就是「别问了，照上次办」，
 * @description 跟自动复用的窗口长度无关。手动勾选那轮不算：那不是模型判的，再拿它凑一轮等于把用户的临时选择变成默认。
 * @returns {object|null}
 */
function previousVerdict() {
    const source = reuse?.result || lastReport;
    return source && !source.manual ? source : null;
}

/**
 * 手动挑条目的清单：一行一条，勾了才注入
 * @description 列的就是决策模型的判据范围（带关键词、未关闭、非常驻），
 * @description 在世界书里被关掉的条目不在这个范围里 —— 它们救不回来（disable 判断早于外部激活），
 * @description 要注入得先去世界书面板把那条打开。
 * @param {Array} candidates 本轮候选条目
 * @param {number} contentLimit 正文片段取多少字
 * @returns {string}
 */
export function buildEntryPickerHtml(candidates, contentLimit = 60) {
    const rows = (candidates || []).map(entry => {
        const keys = (Array.isArray(entry.key) ? entry.key : []).filter(Boolean).join('、');
        const content = String(entry.content || '').replace(/\s+/g, ' ').trim().slice(0, contentLimit);
        return `<tr>
            <td><input type="checkbox" class="decision-pick" data-world="${escapeHtml(entry.world)}" data-uid="${escapeHtml(entry.uid)}"></td>
            <td>${escapeHtml(entryTitle(entry))}</td>
            <td>${escapeHtml(keys)}</td>
            <td>${escapeHtml(content)}${String(entry.content || '').length > contentLimit ? '…' : ''}</td>
        </tr>`;
    }).join('');
    return `
<div class="wide100p padding5" style="display:flex;flex-direction:column;gap:8px;">
    <small class="toggle-description justifyLeft">
        勾中的条目本轮强制注入（共 ${candidates.length} 条可挑，来源是世界书里带关键词、且没被关闭的条目）。
        本轮不会再问决策模型，没勾中的照关键词规则注入。
    </small>
    <table class="decision-pick-table">
        <thead><tr><th style="width:28px"></th><th>条目</th><th>关键词</th><th>正文开头</th></tr></thead>
        <tbody>${rows}</tbody>
    </table>
</div>
<style>
    .decision-pick-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .decision-pick-table th, .decision-pick-table td { border-bottom: 1px solid var(--SmartThemeBorderColor); padding: 3px 6px; text-align: left; vertical-align: top; }
    .decision-pick-table td:first-child { text-align: center; }
</style>`;
}

/**
 * 从弹窗里把勾中的条目捞回来
 * @description show() 是在关闭动画之后才 resolve 的，那时 dlg 已经从文档里摘掉，
 * @description 但元素还在内存里，所以照样能查 —— 别改成查 document。
 * @param {any} popup EDITOR.Popup 实例
 * @param {Array} candidates 本轮候选条目
 * @returns {Array}
 */
export function readPickedEntries(popup, candidates) {
    const boxes = popup?.dlg?.querySelectorAll ? Array.from(popup.dlg.querySelectorAll('input.decision-pick:checked')) : [];
    const picked = new Set(boxes.map(box => `${box.dataset.world}.${box.dataset.uid}`));
    return (candidates || []).filter(entry => picked.has(`${entry.world}.${entry.uid}`));
}

/**
 * 弹条目清单让用户挑
 * @returns {Promise<Array|null>} 选中的条目；null = 用户取消（等于放弃决策、按关键词走）
 */
async function pickManualEntries(candidates, config) {
    const popup = new EDITOR.Popup(buildEntryPickerHtml(candidates, config.digestLimit), EDITOR.POPUP_TYPE.TEXT, '', {
        okButton: '注入这些条目',
        cancelButton: '按原关键词注入',
        large: true,
        wide: true,
        allowVerticalScrolling: true,
        defaultResult: POPUP_RESULT.NEGATIVE,
    });
    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;
    return readPickedEntries(popup, candidates);
}

/**
 * 把「手动挑条目」伪装成一份决策报告
 * @description 走的是同一条注入通道（force_activate），报告和小栏也就不用分叉写
 * @param {object} args
 * @returns {object}
 */
export function buildManualPending({ candidates, picked, totalCandidates, config, state, stateSource, stateRows, stateChars, stateFallback, attempts, startedAt }) {
    return {
        time: new Date().toLocaleString(),
        cached: false,
        // 本轮的判定是用户给的，不是模型给的：报告和小栏要说清
        manual: true,
        model: config.model,
        state,
        stateSource,
        stateRows,
        stateChars,
        stateFallback,
        instructionTemplate: config.instructionTemplate,
        candidateCount: candidates.length,
        totalCandidates,
        // 问了几次全失败了，这个数只用来在报告里交代「重试过」
        rounds: attempts,
        batchSize: config.batchSize,
        inFlight: config.inFlight,
        waves: 0,
        roundStats: [],
        retried: attempts > 0,
        truncated: totalCandidates > candidates.length,
        force: picked.map(entry => ({ ...entry })),
        suppress: [],
        // 手动这一轮不套用「关闭关键词注入」：本轮一条都没判定，拿它去禁条目等于把没挑的都杀掉
        blockKeyword: false,
        nearSuppress: [],
        scores: {},
        missing: [],
        inputTokens: 0,
        latencyMs: Date.now() - startedAt,
        thresholds: { force: config.forceThreshold, suppress: config.suppressThreshold, suppressEnabled: config.suppressEnabled },
    };
}

/**
 * 待判条目装不进一个请求时问用户要不要分轮
 * @param {number} total 待判条目数
 * @param {number} batchSize 单批上限
 * @param {number} rounds 分轮的话要问几轮
 * @returns {Promise<'all'|'firstOnly'>}
 */
async function askSplitChoice(total, batchSize, rounds) {
    const choice = await newPopupConfirm(
        `世界书里有 ${total} 条待判条目，单批上限 ${batchSize} 条装不下。\n\n`
        + `「分轮问完」会连问 ${rounds} 轮再一起决策——总 token 不变，只是生成前多等几轮。\n`
        + `「只问第一批」保持现状，超出的 ${total - batchSize} 条这次仍按关键词规则走。\n\n`
        + `选「分轮问完」会同时打开设置里的多轮开关，以后不再问。`,
        '只问第一批',
        '分轮问完（并记住）',
        'decision_split_choice',
        '这个页面不再问，只问第一批',
    );
    if (choice === true) return 'all';
    // 点「不再问」的两次都按只问第一批：第一次拿到 'dont_remind_selected'，之后是 'dont_remind_active'。
    // 以前这个按钮被组件改写成 true，第一次点反而被判成「分轮问完」，跟它自己的文案相反。
    return 'firstOnly';
}

// 同一轮生成里同样的提醒只弹一次 toast，避免刷屏
const noticeKeys = new Set();
function noticeOnce(kind, text) {
    const key = `${kind}|${text}`;
    if (noticeKeys.has(key)) return;
    noticeKeys.add(key);
    if (noticeKeys.size > 12) noticeKeys.clear();
    EDITOR.warning(text);
}

/**
 * 在 GENERATION_STARTED 上调用（必须 await，ST 的发射器会等监听器）
 * @param {string} type 生成类型
 * @param {object} args 生成参数（含 skipWIAN）
 * @param {boolean} dryRun 是否只是试算
 * @returns {Promise<void>}
 */
export async function armForGeneration(type, args = {}, dryRun = false) {
    pending = null;
    lastSkip = '';
    const config = readConfig();
    if (!config.enabled) {
        // 接管拨回去再拨开，不该接着白嫖关掉之前那份判定
        reuse = null;
        skipsUntilDue = 0;
        manualArmed = false;
        return;
    }
    if (dryRun || args?.skipWIAN) return;

    if (!config.url) {
        EDITOR.warning('决策模型已开启，但接口地址没填，本次按原关键词注入。');
        return;
    }
    const apiKey = getPrivacyKey('decision_api_key');
    if (!apiKey) {
        EDITOR.warning(`决策模型已开启，但拿不到可用的 API Key（没填，或 Key 里混进了空格之类不能用的字符）。${SECRET_UNUSABLE_HINT}本次按原关键词注入。`);
        return;
    }
    // 自主启动档且没点按钮：一轮都不问。放在采集候选之前，免得白跑一趟还弹出「要不要分轮」那种询问
    if (config.timing.mode === 'manual' && !manualArmed) {
        lastSkip = '自主启动：这一轮没点「本轮进行决策」，按关键词注入';
        return;
    }

    let candidates;
    let totalCandidates = 0;
    let map;
    let builtBatches;
    let state;
    let parts = null;
    let stateSource = '';
    let stateRows = 0;
    let stateChars = 0;
    let stateFallback = false;
    let indexedCount = 0;
    let materialFor = null;
    try {
        const collected = await collectCandidates(config);
        candidates = collected.list;
        totalCandidates = collected.total;
        // 一条候选都没有就不问，但要说一句：这句和「本轮根本没发起决策」是同一种症状，
        // 闷声退回关键词注入会让人以为开关没生效
        if (!candidates.length) {
            noticeOnce('no_candidates', '决策路由：这个对话里找不到带关键词的普通条目（世界书没开、或条目都是常驻/已关闭/@@ 手动激活），本轮按原关键词注入。');
            return;
        }
        const built = buildStateText(config, type);
        state = built.state;
        parts = built.parts;
        stateSource = built.source;
        stateRows = built.rows;
        stateChars = built.chars;
        stateFallback = built.fallback;

        const rounds = Math.ceil(candidates.length / config.batchSize);
        let mode = 'all';
        if (rounds > 1 && !config.multiRound) {
            mode = await askSplitChoice(candidates.length, config.batchSize, rounds);
            // 选「分轮问完」就顺手把开关打开，否则下一轮生成还要再弹一次
            if (mode === 'all') {
                USER.store.decision_multi_round = true;
                // 设置是代码写的，抽屉里的勾选框不会自己变，顺手同步一下免得看着矛盾
                $('#dlb_multi_round').prop('checked', true);
            }
        }
        const batches = mode === 'all' ? chunk(candidates, config.batchSize) : [candidates.slice(0, config.batchSize)];
        materialFor = createMaterialResolver({
            enabled: config.indexEnabled,
            index: config.indexMap,
            types: config.indexTypes,
            summaryLimit: config.indexSummaryLimit,
            globalTemplate: config.instructionTemplate,
        });
        let offset = 0;
        builtBatches = batches.map(batch => {
            const built = buildQuestions(batch, config.digestLimit, config.instructionTemplate, offset, materialFor);
            offset += batch.length;
            return built;
        });
        map = builtBatches.flatMap(built => built.map);
        indexedCount = map.filter(item => item.indexed).length;
        // 提醒要说的是「下一步去哪儿补」：手填和让 LLM 填都收在同一个弹窗里，指一处就够
        const fillHint = '到设置里点「填写条目索引」，自己逐条写或在那儿让 LLM 填。';
        if (config.indexEnabled && indexedCount === 0) {
            noticeOnce('index_empty', `决策路由：已开启「条目摘要索引」，但这 ${map.length} 条里一条都没有索引记录，本轮全部按老办法（正文片段 + 通用问法）判。${fillHint}`);
        } else if (config.indexEnabled && indexedCount < map.length) {
            noticeOnce('index_partial', `决策路由：本轮 ${map.length} 条里 ${indexedCount} 条用了索引摘要，仍有 ${map.length - indexedCount} 条没有索引（新加的、之前摘要失败的、或还没填的），按老办法判。${fillHint}`);
        }
        if (totalCandidates > map.length) {
            noticeOnce('truncated', `决策路由：带关键词的条目共 ${totalCandidates} 条，本轮只判前 ${map.length} 条，其余保持关键词注入。可调高「候选上限」，或打开「多轮决策」分 ${Math.ceil(totalCandidates / config.batchSize)} 轮问完。`);
        }
    } catch (error) {
        console.error('[决策路由] 采集候选失败', error);
        EDITOR.warning(`决策模型采集候选失败：${error.message}，本次按原关键词注入。`);
        return;
    }

    // 复用窗口里：这一轮一个请求都不发，直接拿上次判定当本轮判定
    const reuseKey = buildReuseKey(builtBatches, config);
    // 设置改小了就跟着收口：填 0 等于「这一轮就重新判」，不该等旧窗口自己走完
    if (reuse) reuse.roundsLeft = Math.min(reuse.roundsLeft, config.reuseRounds);
    const timing = decideTiming(config.timing, skipsUntilDue, manualArmed);
    // 自主启动档里那颗按钮许的就是「这一次」，用过就作废，不然会每轮都判
    if (timing.due) manualArmed = false;
    const windowHits = !!(reuse && reuse.key === reuseKey && reuse.roundsLeft > 0);
    // 白嫖窗口在哪几轮算数：「每轮都判」时它随时算数（就是纯粹的省钱）；
    // 「每 n 轮」时只在间隔那几轮算数，到点那一轮必须真问一次，否则 n 填 5 和填 1 没区别。
    const reuseThisRound = windowHits && (config.timing.mode === 'every_round' || !timing.due);
    if (reuseThisRound) {
        reuse.roundsLeft--;
        skipsUntilDue = Math.max(0, skipsUntilDue - 1);
        // 缓存里存的是判定结果，处置策略（含关键词注入开关）永远以本轮设置为准
        pending = { ...reuse.result, cached: true, reuseLeft: reuse.roundsLeft, skipReason: timing.reason, blockKeyword: config.blockKeyword, candidateCount: map.length, truncated: totalCandidates > map.length, roundStats: [], retried: false };
        lastReport = pending;
        return;
    }
    // 没到点、上一次判定又已经作废（条目、摘要、问法变了）：这一轮一个请求都不发，退回关键词。
    // 「每 n 轮」是他给的花钱上限，不能因为判定过期就自己加钱重问；计数照走，不然永远到不了点。
    if (!timing.due) {
        skipsUntilDue = Math.max(0, skipsUntilDue - 1);
        lastSkip = `${timing.reason}，上次那份判定已作废，本轮按关键词注入`;
        return;
    }
    // 到了点就必问。旧判定对不上时也照样重问：
    // 依据都换了还接着白嫖，注入的就是按过期问题判出来的结果，比多花一次请求更难解释。

    const startedAt = Date.now();
    const isMulti = builtBatches.length > 1;
    const slots = new Array(builtBatches.length).fill(null);
    const roundStats = [];
    let waves = 0;
    // 用户点了几次「重试」。没有上限：只有他亲口选「按原关键词注入」才停
    let attempts = 0;
    let lastError = null;
    // 「本轮使用正文摘要」只许试一次：摘要也要花钱，试过一次还被拒就说明不是露骨描写的事
    let basisTried = false;
    let basisEmergency = false;

    /**
     * 跑一轮，不抛异常：失败信息带回来交给外层统一处理（并发下不能各自弹窗）
     * @param {number} index 轮次下标
     * @param {boolean} retried 这一次是不是重试
     */
    async function runRound(index, retried) {
        const from = Date.now();
        try {
            const data = await requestDecision({
                endpoint: config.url,
                apiKey,
                model: config.model,
                state,
                questions: builtBatches[index].questions,
                useProxy: config.useProxy,
                timeoutMs: config.timeoutMs,
            });
            return { index, data, ms: Date.now() - from, retried };
        } catch (error) {
            console.error('[决策路由] 请求失败', error);
            return { index, error, ms: Date.now() - from, retried };
        }
    }

    // 分批并发：一批最多发 inFlight 路，整批都有结果才开下一批。
    // 接口侧并发 8 路实测不限流，卡的是浏览器对同一个来源只有 6 个连接（插件走 /proxy）。
    let queue = builtBatches.map((_, index) => index);
    while (queue.length) {
        const wave = queue.slice(0, config.inFlight);
        queue = queue.slice(config.inFlight);
        waves++;
        const settled = await Promise.all(wave.map(index => runRound(index, attempts > 0)));
        const failed = [];
        for (const item of settled) {
            roundStats.push({
                round: item.index + 1,
                ms: item.ms,
                ok: !!item.data,
                retried: item.retried,
                tokens: Number(item.data?.usage?.input_tokens) || 0,
            });
            if (!item.data) { failed.push(item); continue; }
            slots[item.index] = item.data;
        }
        if (!failed.length) continue;
        lastError = failed[0].error;
        if (config.failSilent) break;
        // 这一批失败的轮次合成一组只问一次：并发时逐轮弹窗会连着弹好几个，反而看不清
        const label = failed.length === 1
            ? (isMulti ? `第 ${failed[0].index + 1}/${builtBatches.length} 轮` : '')
            : `失败的 ${failed.length} 轮（${failed.map(f => `第 ${f.index + 1} 轮`).join('、')}）`;
        const reason = String(failed[0].error?.message || failed[0].error);
        // 只有「对端把这段内容过滤掉了」才值得劝改用摘要／复用上轮：超时和断网换依据也没用
        const rejected = isModerationRejection(reason);
        const choice = await askRetry(reason, label, attempts, candidates.length, {
            reuse: rejected && !!previousVerdict(),
            basis: rejected && !config.basisSummary && !basisTried,
        });
        if (choice === 'keyword') break;
        if (choice === 'pick') {
            const picked = await pickManualEntries(candidates, config);
            // 挑了 0 条也算放弃决策：本轮一条都不强制注入，回到关键词原样，跟点「按原关键词注入」一样
            if (!picked || !picked.length) break;
            pending = buildManualPending({ candidates, picked, totalCandidates, config, state, stateSource, stateRows, stateChars, stateFallback, attempts, startedAt });
            lastReport = pending;
            // 手动结果不进缓存：它不是模型对这份状态的判定，下一轮生成该老老实实再问一次
            EDITOR.info(`本轮注入你自己勾选的 ${picked.length} 条世界书条目，这一轮没有再问决策模型。`);
            return;
        }
        if (choice === 'reuse') {
            const prev = previousVerdict();
            if (!prev) {
                EDITOR.warning('这个聊天里还没有过一次成功的判定，没有可复用的上轮结果，本轮按原关键词注入。');
                break;
            }
            // 强制复用不看键：那颗按钮要的就是「别问了，照上次办」，条目变了也照办
            pending = { ...prev, cached: true, reusedByUser: true, reuseLeft: 0, skipReason: '你选了「全部复用上轮结果」', blockKeyword: config.blockKeyword, candidateCount: map.length, truncated: totalCandidates > map.length, roundStats: [], retried: attempts > 0 };
            lastReport = pending;
            EDITOR.info('本轮改用上一次那份判定，没有再问决策模型。');
            return;
        }
        if (choice === 'basis') {
            basisTried = true;
            const result = await summarizeBasis({
                oldText: '',
                floors: parts?.floors || [],
                userName: USER.getContext()?.name1 || '',
                characterName: USER.getContext()?.name2 || '',
            }, config, false);
            if (result.error) {
                EDITOR.error(`正文摘要没写出来：${result.error}，本轮仍用原来的依据重试。`);
            } else {
                state = buildDigestState({
                    ...parts.shared,
                    digest: result.text,
                    messages: parts.pendingDraft,
                }, config.contextChars, config.contextFullMessages);
                stateSource = 'summary';
                stateRows = (parts.floors || []).length;
                stateChars = result.text.length;
                stateFallback = false;
                basisEmergency = true;
                EDITOR.info('本轮改用正文摘要作决策依据，正在拿摘要重问失败的轮次。');
            }
        }
        attempts++;
        queue = failed.map(f => f.index).concat(queue);
    }

    // 任何一轮没结果就整批作废：只拿半截判定会让「哪些条目没被问」随请求成败而变，比按关键词更难解释
    const missingRounds = slots.map((slot, index) => (slot ? -1 : index)).filter(index => index >= 0);
    if (missingRounds.length) {
        const which = missingRounds.length === 1 ? `第 ${missingRounds[0] + 1} 轮` : `第 ${missingRounds.map(index => index + 1).join('、')} 轮（共 ${missingRounds.length} 轮）`;
        const label = isMulti || missingRounds.length > 1 ? `（${which}没结果）` : '';
        EDITOR.warning(`决策模型未能给出结果${label}：${lastError?.message || '未知原因'}，本次按原关键词注入。`);
        return;
    }

    const answers = slots.map(data => data.answers);
    const inputTokens = roundStats.reduce((sum, item) => sum + (item.ok ? item.tokens : 0), 0);
    const serverLatency = slots[0]?.latency_ms ?? null;

    const parsed = parseAnswers(mergeAnswers(answers), map, config);
    if (config.blockKeyword) {
        // 关掉的只是「判过」的那批：没问到或没返回的条目如果也被禁掉，它会凭空从提示词里消失，
        // 那比多注入一条难查得多，所以宁可保留关键词原样并明确提醒。
        const unjudged = (totalCandidates - map.length) + parsed.missing.length;
        if (unjudged > 0) {
            noticeOnce('block_kept', `决策路由：已关闭关键词注入，但有 ${unjudged} 条没拿到判定（未问到 ${totalCandidates - map.length} 条、模型无返回 ${parsed.missing.length} 条），这些条目本轮仍按关键词注入。想让决策模型全接管，请调高「候选上限」或打开「多轮决策」。`);
        }
    }
    const suppressedKeys = new Set(parsed.suppress.map(item => `${item.world}.${item.uid}`));
    // 压制开关关着时，把「本来会被压制」的条目也记下来，供你校准阈值用
    const nearSuppress = Object.values(parsed.scores)
        .filter(item => item.probability <= config.suppressThreshold && !suppressedKeys.has(`${item.world}.${item.uid}`))
        .map(item => ({ uid: item.uid, world: item.world, label: item.label }));
    pending = {
        time: new Date().toLocaleString(),
        cached: false,
        // 这份判定还能白嫖几轮（报告和小栏要能说「下一轮不花钱」）
        reuseLeft: config.reuseRounds,
        model: config.model,
        state,
        // 依据是哪来的：小栏和报告都要能说「这次判的是摘要」还是「这次用的正文」
        stateSource,
        stateRows,
        stateChars,
        stateFallback,
        // 拒答弹窗里临时改用摘要那一趟：跟「每轮自动摘要」是两回事，报告里要分得开
        basisEmergency,
        instructionTemplate: config.instructionTemplate,
        // 索引这条要能说清「几条是按摘要判的」：开着功能但没建索引时，判据其实和以前一模一样
        indexOn: config.indexEnabled,
        indexedCount,
        candidateCount: map.length,
        totalCandidates,
        rounds: builtBatches.length,
        batchSize: config.batchSize,
        // 并发实况：几路一批、分了几批、每轮各自花多少毫秒（并发下总耗时不等于各轮相加）
        inFlight: config.inFlight,
        waves,
        roundStats,
        retried: roundStats.some(item => item.retried),
        truncated: totalCandidates > map.length,
        force: parsed.force,
        suppress: parsed.suppress,
        blockKeyword: config.blockKeyword,
        nearSuppress,
        scores: parsed.scores,
        missing: parsed.missing.map(item => item.label),
        inputTokens,
        latencyMs: isMulti ? (Date.now() - startedAt) : (serverLatency ?? (Date.now() - startedAt)),
        thresholds: { force: config.forceThreshold, suppress: config.suppressThreshold, suppressEnabled: config.suppressEnabled },
    };
    // 开一个复用窗口：这份判定接下来还能白嫖 config.reuseRounds 轮（0 = 下一轮老老实实再问）
    reuse = { key: reuseKey, result: pending, roundsLeft: config.reuseRounds };
    lastReport = pending;
    // 判成了才开始歇：「每 n 轮」要问完歇 n-1 轮，别的档下一轮照旧到点
    skipsUntilDue = skipsAfterDecision(config.timing);
    if (config.autoPopup) {
        // 不能 await：这里在 GENERATION_STARTED 的 await 链上，等用户关掉弹窗就等于卡住整轮生成
        showDecisionReport().catch(error => console.error('[决策路由] 自动弹窗失败', error));
    }
}

/**
 * 本轮实际注入哪几条：把报告里的强推清单按「本轮注入名额上限」现算一遍
 * @description 名额是注入时才套的，所以它不进判定、也不进复用键——改了这个数，
 * @description 下一轮就按新的走，哪怕这一轮的判定是白嫖来的。
 * @description 自己在弹窗里手动挑的那一批豁免：那是一条条点出来的，再被名额悄悄丢掉比多注入一条更难查。
 * @param {object|null} report 决策报告（pending / lastReport）
 * @returns {{kept: Array, squeezed: Array, keptChars: number, limits: {maxEntries: number, maxChars: number}}}
 */
export function getInjectView(report) {
    if (!report) return { kept: [], squeezed: [], keptChars: 0, limits: { maxEntries: 0, maxChars: 0 } };
    const config = readConfig();
    const limits = { maxEntries: config.injectMaxEntries, maxChars: config.injectMaxChars };
    return {
        ...applyInjectQuota(report.force, report.scores, report.manual ? { maxEntries: 0, maxChars: 0 } : limits),
        limits,
    };
}

/**
 * 在 WORLDINFO_ENTRIES_LOADED 上调用：只改本次扫描用的副本，不碰世界书存档
 * @param {{globalLore?: Array, characterLore?: Array, chatLore?: Array, personaLore?: Array}} payload
 * @returns {Promise<void>}
 */
export async function applyToLoadedEntries(payload) {
    if (!pending) return;
    const { kept } = getInjectView(pending);
    const forced = new Set(kept.map(item => `${item.world}.${item.uid}`));
    // 压制清单 + 「判过但没到强推线」的条目一起禁掉；强推项必须留着，否则会被这一步误杀
    const killed = new Set(pending.suppress.map(item => `${item.world}.${item.uid}`));
    if (pending.blockKeyword) {
        // 被名额挤掉的也落在这里：全接管模式下「本轮不注入」才是名额该有的意思
        for (const item of Object.values(pending.scores)) {
            const key = `${item.world}.${item.uid}`;
            if (!forced.has(key)) killed.add(key);
        }
    }
    if (killed.size) {
        for (const list of [payload?.globalLore, payload?.characterLore, payload?.chatLore, payload?.personaLore]) {
            for (const entry of list || []) {
                if (killed.has(`${entry.world}.${entry.uid}`)) entry.disable = true;
            }
        }
    }
    if (kept.length) {
        await APP.eventSource.emit(APP.event_types.WORLDINFO_FORCE_ACTIVATE, kept);
    }
}

export function disarm() {
    pending = null;
}

/**
 * @returns {object|null} 最近一次决策报告
 */
export function getLastReport() {
    return lastReport;
}

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * 报告和小栏上那句「本轮依据是哪来的」
 * @description 摘要和正文判出来的概率不是一回事（摘要看不到细节），所以来源必须摆在脸上；
 * @description 拒答弹窗里临时改用摘要那一趟也只管本轮，跟「每轮自动摘要」要分得开。
 * @param {object} report 决策报告
 * @returns {string}
 */
export function describeBasis(report) {
    if (!report?.stateSource) return '';
    if (report.stateSource === 'summary') {
        return report.basisEmergency
            ? `摘要 ${report.stateChars ?? 0} 字（被拒答后临时改写，只本轮）`
            : `摘要 ${report.stateChars ?? 0} 字（已覆盖 ${report.stateRows ?? 0} 楼）`;
    }
    return report.stateFallback ? '正文（摘要档，但这个聊天还没写出摘要）' : `最近正文 ${report.stateRows ?? 0} 条`;
}

function renderScoreRows(items) {
    if (!items.length) return '<tr><td colspan="2" style="text-align:center;color:var(--SmartThemeEmColor)">无</td></tr>';
    return items.map(item => `<tr><td>${escapeHtml(item.label)}</td><td class="decision-report-score">${item.probability.toFixed(2)}</td></tr>`).join('');
}

/**
 * 手动挑条目那一轮的报告
 * @description 三条判定表是从 scores 派生的，手动这一轮一条都没判定，硬套就全是「无」，
 * @description 所以只列勾中的条目，并把「为什么没判」说清楚。
 * @param {object} report buildManualPending() 的结果
 * @returns {Promise<void>}
 */
async function showManualReport(report) {
    const rows = report.force.length
        ? report.force.map(entry => `<tr>
            <td>${escapeHtml(entryTitle(entry))}</td>
            <td>${escapeHtml((Array.isArray(entry.key) ? entry.key : []).filter(Boolean).join('、'))}</td>
        </tr>`).join('')
        : '<tr><td colspan="2" style="text-align:center;color:var(--SmartThemeEmColor)">无</td></tr>';
    const meta = [
        `时间 ${report.time}`,
        `模型 ${report.model}`,
        report.stateSource ? `依据 ${describeBasis(report)}` : '',
        `候选 ${report.candidateCount} 条${report.truncated ? `（待判共 ${report.totalCandidates ?? report.candidateCount} 条）` : ''}`,
        // rounds 这里是「点了几次重试」，不是请求轮次
        `重试 ${report.rounds} 次仍未成功，改为你手动勾选的 ${report.force.length} 条`,
        `耗时 ${Math.round(report.latencyMs)} ms`,
        '关键词注入：保留（本轮没有判定结果，没勾中的条目照关键词规则走）',
    ].filter(Boolean).join('　|　');
    const html = `
<div class="wide100p padding5" style="display:flex;flex-direction:column;gap:8px;">
    <div class="decision-report-meta">${escapeHtml(meta)}</div>
    <div class="decision-report-block">
        <div class="decision-report-label">本轮强制注入（你勾的）</div>
        <table class="decision-report-table">${rows}</table>
    </div>
    <small class="toggle-description justifyLeft">这份结果只对本次生成有效，也不会写进决策缓存。</small>
</div>
<style>
    .decision-report-meta { color: var(--SmartThemeEmColor); font-size: 12px; text-align: left; }
    .decision-report-label { font-weight: bold; margin-bottom: 4px; text-align: left; }
    .decision-report-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .decision-report-table td { border-bottom: 1px solid var(--SmartThemeBorderColor); padding: 3px 6px; text-align: left; }
</style>`;
    await new EDITOR.Popup(html, EDITOR.POPUP_TYPE.TEXT, '', {
        large: true,
        wide: true,
        allowVerticalScrolling: true,
        okButton: '关闭',
    }).show();
}

/**
 * 弹窗展示最近一次决策的依据：哪些条目被强推、哪些被压制、哪些留在中间带
 * @returns {Promise<void>}
 */
export async function showDecisionReport() {
    const report = lastReport;
    if (!report) {
        EDITOR.info('本次会话还没有跑过决策模型。');
        return;
    }
    if (report.manual) {
        await showManualReport(report);
        return;
    }
    const scored = Object.values(report.scores).map(item => ({ ...item }));
    const inject = getInjectView(report);
    const keptKeys = new Set(inject.kept.map(item => `${item.world}.${item.uid}`));
    const squeezedKeys = new Set(inject.squeezed.map(item => `${item.world}.${item.uid}`));
    const forced = scored.filter(item => keptKeys.has(`${item.world}.${item.uid}`));
    const squeezed = scored.filter(item => squeezedKeys.has(`${item.world}.${item.uid}`))
        .sort((a, b) => b.probability - a.probability);
    const suppressed = scored.filter(item => report.suppress.some(entry => entry.world === item.world && entry.uid === item.uid));
    const middle = scored.filter(item => !forced.includes(item) && !suppressed.includes(item) && !squeezed.includes(item))
        .sort((a, b) => b.probability - a.probability);

    const meta = [
        `时间 ${report.time}`,
        `模型 ${report.model}`,
        // 依据来源要单列：摘要读的是概括词、正文读的是原样剧情，判出来的概率不是一回事
        report.stateSource ? `依据 ${describeBasis(report)}` : '',
        `问法 ${String(report.instructionTemplate || '').trim() || '默认'}`,
        report.indexOn ? `摘要索引 ${report.indexedCount}/${report.candidateCount} 条${report.indexedCount < report.candidateCount ? '（没索引的那几条按正文片段+通用问法判）' : ''}` : '',
        `候选 ${report.candidateCount} 条${report.truncated ? `（待判共 ${report.totalCandidates ?? report.candidateCount} 条，超出部分保持关键词原样）` : ''}`,
        `请求 ${report.rounds ?? 1} 次${(report.rounds ?? 1) > 1 ? `（单批上限 ${report.batchSize}，${report.inFlight ?? 1} 路并发 → ${report.waves ?? 1} 批${report.retried ? '，含重试' : ''}）` : ''}`,
        `输入 ${report.inputTokens} token`,
        `耗时 ${Math.round(report.latencyMs)} ms${report.cached ? `（本轮没问模型，用的是上面那次判定，还能这样省 ${report.reuseLeft} 轮）` : (report.reuseLeft || 0) > 0 ? `（接下来的 ${report.reuseLeft} 轮不再问模型）` : ''}`,
        // 并发下总耗时不等于各轮相加，所以每轮各自多少毫秒单独列出来
        (report.roundStats || []).length > 1 ? `每轮 ${report.roundStats.filter(f => f.ok).map(f => `第${f.round}轮 ${Math.round(f.ms)}ms${f.retried ? '(重试)' : ''}`).join('　')}` : '',
        `阈值：强推 ≥ ${report.thresholds.force}　压制 ≤ ${report.thresholds.suppress}${report.thresholds.suppressEnabled ? '（已开）' : '（未开，仅记录）'}`,
        // 名额是注入时才套的，跟这一轮的判定是不是白嫖来的无关，所以这里显示的是当前生效值
        (inject.limits.maxEntries || inject.limits.maxChars)
            ? `本轮注入名额：${[inject.limits.maxEntries ? `最多 ${inject.limits.maxEntries} 条` : '', inject.limits.maxChars ? `最多 ${inject.limits.maxChars} 字` : ''].filter(Boolean).join('　')}`
                + ` → 实际注入 ${inject.kept.length} 条 / ${inject.keptChars} 字`
                + (squeezed.length ? `，挤掉 ${squeezed.length} 条（${report.blockKeyword ? '本轮不注入' : '退回关键词规则'}）` : '')
            : '',
        // 关键词注入开关是策略，不进缓存，所以这里读的是本轮生效值
        `关键词注入：${report.blockKeyword ? `已关闭（判过 ${scored.length} 条，只有强推的 ${forced.length} 条会注入）` : '保留（中间带交回关键词规则）'}`,
    ].filter(Boolean).join('　|　');

    const table = (title, rows) => `
        <div class="decision-report-block">
            <div class="decision-report-label">${title}</div>
            <table class="decision-report-table">${rows}</table>
        </div>`;
    const html = `
<div class="wide100p padding5" style="display:flex;flex-direction:column;gap:8px;">
    <div class="decision-report-meta">${escapeHtml(meta)}</div>
    ${table('强制激活（关键词没命中也注入）', renderScoreRows(forced))}
    ${squeezed.length ? table(`本轮被注入名额挤掉的（概率到了，但名额排在其后：${report.blockKeyword ? '这一轮不注入' : '仍按关键词规则'}）`, renderScoreRows(squeezed)) : ''}
    ${table(report.thresholds.suppressEnabled ? '已压制（关键词命中也不注入）' : '本会被压制（压制开关未开，仅记录）', renderScoreRows(report.thresholds.suppressEnabled ? suppressed : scored.filter(item => item.probability <= report.thresholds.suppress)))}
    ${table(report.blockKeyword ? '中间带（关键词注入已关闭，本轮不注入）' : '中间带（交回关键词规则）', renderScoreRows(middle))}
    ${report.missing.length ? `<small class="toggle-description justifyLeft">没有返回结果的条目：${escapeHtml(report.missing.join('、'))}</small>` : ''}
</div>
<style>
    .decision-report-meta { color: var(--SmartThemeEmColor); font-size: 12px; text-align: left; }
    .decision-report-label { font-weight: bold; margin-bottom: 4px; text-align: left; }
    .decision-report-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .decision-report-table td { border-bottom: 1px solid var(--SmartThemeBorderColor); padding: 3px 6px; text-align: left; }
    .decision-report-score { width: 60px; text-align: right; font-family: var(--mainFixedWidthFont, monospace); }
</style>`;

    const popup = new EDITOR.Popup(html, EDITOR.POPUP_TYPE.TEXT, '', {
        large: true,
        wide: true,
        allowVerticalScrolling: true,
        okButton: '关闭',
    });
    await popup.show();
}

/**
 * 用两条固定问题试一次接口，验证地址与密钥是否通
 * @returns {Promise<void>}
 */
export async function testDecisionConnection() {
    const config = readConfig();
    if (!config.url) {
        EDITOR.error('请先填写决策模型接口地址。');
        return;
    }
    const apiKey = getPrivacyKey('decision_api_key');
    if (!apiKey) {
        EDITOR.error(`拿不到可用的决策模型 API Key（没填，或 Key 里混进了空格之类不能用的字符）。${SECRET_UNUSABLE_HINT}`);
        return;
    }
    // 用你自己的问法试：问法没写好的话，连通测试通过了也会在真实决策里全给同一个分
    const testEntries = [
        { comment: '测试条目甲', key: ['甲', '铁剑'], keysecondary: [], content: '一把会说话的旧铁剑。' },
        { comment: '测试条目乙', key: ['乙', '飞船'], keysecondary: [], content: '一艘脱离航线的货运飞船。' },
    ];
    const questions = {};
    testEntries.forEach((entry, index) => {
        questions[index === 0 ? 'a' : 'b'] = {
            type: 'noul',
            instructions: renderInstruction(config.instructionTemplate, {
                digest: buildEntryDigest(entry, config.digestLimit),
                label: entry.comment,
                keys: entry.key.join('、'),
                content: entry.content,
            }),
        };
    });
    const startedAt = Date.now();
    try {
        const data = await requestDecision({
            endpoint: config.url,
            apiKey,
            model: config.model,
            state: '角色：测试\n最近对话：\n用户：我拔出了那把旧铁剑，指向前方。\nAI：剑身轻轻一颤，低声说：轻点。',
            questions,
            useProxy: config.useProxy,
            timeoutMs: config.timeoutMs,
        });
        const related = Number(data.answers?.a?.noul);
        const unrelated = Number(data.answers?.b?.noul);
        const latency = data.latency_ms ?? (Date.now() - startedAt);
        const ok = related >= 0.5 && (Number.isFinite(unrelated) ? unrelated <= 0.5 : true);
        const text = `决策模型连通。相关条目 ${Number.isFinite(related) ? related.toFixed(2) : '无返回'}／无关条目 ${Number.isFinite(unrelated) ? unrelated.toFixed(2) : '无返回'}，耗时 ${Math.round(latency)} ms，输入 ${data.usage?.input_tokens ?? '?'} token。${ok ? '' : '（两项没有拉开差距，请先核对问法再启用）'}`;
        if (ok) EDITOR.success(text); else EDITOR.warning(text);
        console.log('[决策路由] 测试结果', data);
    } catch (error) {
        console.error('[决策路由] 测试失败', error);
        const message = String(error?.message || error);
        // 转发没开这一类值得弹窗：修法是一条命令，toast 里根本没法复制
        if (isProxyNotEnabled(message)) {
            const command = proxyFixCommand();
            await new EDITOR.Popup(`
<div class="wide100p padding5" style="display:flex;flex-direction:column;gap:8px;">
    <div class="justifyLeft">${escapeHtml(message)}</div>
    ${command ? `<pre class="decision-proxy-command">${escapeHtml(command)}</pre>
    <small class="toggle-description justifyLeft">点上面那行会整行选中，复制后粘到 Termux 里执行，跑完重启酒馆。</small>` : ''}
</div>
<style>
    .decision-proxy-command { white-space: pre-wrap; word-break: break-all; user-select: all; font-size: 12px; text-align: left; padding: 6px 8px; border-radius: 4px; background: var(--SmartThemeBlurTintColor); }
</style>`, EDITOR.POPUP_TYPE.TEXT, '我知道了').show();
            return;
        }
        EDITOR.error(`测试失败：${message}`);
    }
}

/**
 * 小栏要说的话：这一轮到底判没判、为什么没判、下一次点不点得动按钮
 * @returns {{skip: string, timing: object, manualArmed: boolean, basisMode: string}}
 */
export function getDecisionStatus() {
    const config = readConfig();
    return {
        skip: lastSkip,
        timing: config.timing,
        manualArmed,
        basisMode: config.basisSummary ? 'summary' : 'chat',
    };
}

/**
 * 自主启动档：用户点了「本轮进行决策」，让下一次生成真的去问模型
 * @description 只许一次，用完作废；当场不发请求（请求在那一轮的 GENERATION_STARTED 上发，
 * @description 那时依据才是最新的，包括输入框里刚打的那句）。
 * @returns {void}
 */
export function armManualDecision() {
    manualArmed = true;
    EDITOR.info('下一次生成会走决策模型。在那之前生成的几轮仍按关键词注入。');
}

/**
 * 挂上事件。由 index.js 在扩展激活时调用一次。
 */
export function initLorebookRouter() {
    // ST 的发射器只会 console.error 监听器抛出的异常，界面上一句提示都没有：
    // 决策这一趟要是半路抛了，症状就是「没决策过程 + 世界书按关键词注入」，所以自己接住说明白。
    APP.eventSource.on(APP.event_types.GENERATION_STARTED, (type, args, dryRun) => armForGeneration(type, args, dryRun).catch((error) => {
        console.error('[决策路由] 本轮决策中止', error);
        noticeOnce(`arm_error_${error?.name || 'Error'}_${error?.message || ''}`, `决策模型这一趟没跑起来：${error?.message || error}，本次按原关键词注入。`);
    }));
    APP.eventSource.on(APP.event_types.WORLDINFO_ENTRIES_LOADED, payload => applyToLoadedEntries(payload));
    APP.eventSource.on(APP.event_types.GENERATION_ENDED, () => {
        disarm();
        // 摘要档：这一轮的回复写完了，趁现在把它并进决策摘要，下一轮生成就不必再等这一趟
        refreshBasisAfterGeneration().catch(error => console.error('[决策摘要] 自动摘要失败', error));
    });
    // 复用键里不带正文（这是「按轮白嫖 N 轮」的根据），所以新开对话时必须当场清掉窗口：
    // 否则新剧情头几轮会拿上一个聊天判出来的结果凑数，而且小栏上那个时间还是旧聊天的。
    // 决策时机的记账同理：新剧情第一轮该老老实实判一次。
    APP.eventSource.on(APP.event_types.CHAT_CHANGED, () => {
        reuse = null;
        skipsUntilDue = 0;
        manualArmed = false;
        lastSkip = '';
    });
}
