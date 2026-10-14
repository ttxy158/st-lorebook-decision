/**
 * 决策依据的两种来源：正文 / LLM 摘要
 *
 * 为什么要摘要这一层：决策模型（阿里云那个判别接口）会整批拒答露骨描写，
 * 一个判定都拿不到 —— 实测报错就是 DataInspectionFailed（2026-10-12）。
 * 而判「这条世界书条目本轮该不该注入」只需要谁在场、在哪儿、刚刚发生了什么、用户想要什么。
 *
 * 两条路（设置页「决策依据」那颗下拉）：
 *   正文（默认）  决策请求直接拼最近几楼，可能被拒答；拒答时弹窗里可以临时改用摘要再判一次。
 *   LLM 摘要      每轮 AI 回复写完，另发一次请求把新剧情并进一份滚动摘要，下一轮生成时只送这份摘要。
 *
 * 摘要走的是「不拒答的那个模型」：默认主 API（就是写正文的那个），也可以切到插件的自定义 API。
 * 摘要存在当前聊天的 chat_metadata 里，换聊天各算各的；重生成/编辑最后一条会把那一条再摘要一遍。
 */
import { EDITOR, USER } from '../../core/manager.js';
import { handleCustomAPIRequest, handleMainAPIRequest } from '../settings/standaloneAPI.js';
import { beginReply, finishReply } from '../settings/llmReplyViewer.js';
import { DEFAULT_BASIS_SYSTEM_PROMPT, DEFAULT_BASIS_TEMPLATE } from '../../services/decisionApiService.js';
import { fnv1aHex } from './decisionEntryIndex.js';

/** 依据来源的两档取值（'table' 是旧的「以表代正文」，10-12 已删，读到它一律退回正文） */
export const BASIS_MODES = ['chat', 'summary'];

/** 摘要文本存进 chat_metadata 的键 */
export const BASIS_STATE_KEY = 'dlb_decision_basis';

export const BASIS_CHAR_LIMIT_DEFAULT = 800;

// 两份默认文案住在 decisionApiService.js（那里没有依赖，pluginSetting 也要读它们）
export { DEFAULT_BASIS_SYSTEM_PROMPT, DEFAULT_BASIS_TEMPLATE };

/** 决策时机三档：每轮 / 每 n 轮 / 自主启动（只有点了按钮的那一次生成才判） */
export const TIMING_MODES = ['every_round', 'every_n', 'manual'];

/**
 * 依据来源取哪一档；老存档里那个「以表代正文」的勾选不再参与判断
 * @param {object} setting USER.store
 * @returns {'chat'|'summary'}
 */
export function resolveBasisMode(setting) {
    return setting?.decision_basis_mode === 'summary' ? 'summary' : 'chat';
}

/**
 * 决策时机：认档 + 夹住间隔轮数
 * @param {object} setting USER.store
 * @returns {{mode: string, everyN: number}}
 */
export function resolveTiming(setting) {
    const mode = TIMING_MODES.includes(setting?.decision_timing_mode) ? setting.decision_timing_mode : 'every_round';
    const raw = Number(setting?.decision_every_n_rounds);
    const everyN = Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 1;
    return { mode, everyN: mode === 'every_n' ? everyN : 1 };
}

/**
 * 「每 n 轮」时复用轮数至少要是 n，否则间隔里那些轮没有判定，会悄悄退回关键词注入。
 * @description 只抬生效值，不写盘：他存的数还是他填的那个，界面上把生效值单独显示出来。
 * @param {number} reuseRounds 设置里存的复用轮数
 * @param {{mode: string, everyN: number}} timing resolveTiming 的结果
 * @returns {number}
 */
export function effectiveReuseRounds(reuseRounds, timing) {
    const stored = Math.max(0, Math.floor(Number(reuseRounds) || 0));
    return timing.mode === 'every_n' ? Math.max(stored, timing.everyN) : stored;
}

/**
 * 这一轮该不该问模型
 * @param {{mode: string, everyN: number}} timing
 * @param {number} skipsLeft 「每 n 轮」档里还剩几轮不问（判完一次就设成 n-1，每过一轮不问就减一）
 * @param {boolean} manualArmed 自主启动档：用户是否许了「下一次生成要判」
 * @returns {{due: boolean, reason: string}}
 * @description 计数用「还剩几轮不问」而不是「已过几轮」：判完那一轮计数归 0 就等于下一轮又判，
 *   n=3 要的是问、歇、歇、问，所以判完设置的是 n-1。填 1 时 n-1=0，就是现行的每轮都判。
 */
export function decideTiming(timing, skipsLeft, manualArmed) {
    if (timing.mode === 'manual') {
        return manualArmed
            ? { due: true, reason: '你点了「本轮进行决策」' }
            : { due: false, reason: '自主启动：没点按钮就不问模型' };
    }
    if (timing.mode === 'every_n') {
        return (Number(skipsLeft) || 0) <= 0
            ? { due: true, reason: `每 ${timing.everyN} 轮判一次，到点了` }
            : { due: false, reason: `每 ${timing.everyN} 轮判一次，还有 ${skipsLeft} 轮到点` };
    }
    return { due: true, reason: '每轮都判' };
}

/**
 * 判定成功之后要歇几轮
 * @param {{mode: string, everyN: number}} timing
 * @returns {number}
 */
export function skipsAfterDecision(timing) {
    return timing.mode === 'every_n' ? Math.max(0, timing.everyN - 1) : 0;
}

/**
 * 摘要提示词：模板里缺 {new} 等于没把新剧情喂进去，自动补在末尾（跟压缩梗概同一个口径）
 * @param {string} template 用户模板，空则用默认
 * @param {{oldText: string, newLines: string, limit: number}} vars
 * @returns {string}
 */
export function renderBasisPrompt(template, vars = {}) {
    let tpl = String(template || '').trim() || DEFAULT_BASIS_TEMPLATE;
    if (!tpl.includes('{new}')) tpl = `${tpl}\n\n【新增剧情】\n{new}`;
    const oldText = String(vars.oldText || '').trim();
    if (!oldText) tpl = tpl.replace(/【已有摘要】\s*\n?\{old\}\s*/g, '').replace(/\s+/g, ' ').trim();
    return tpl.replace(/\{(\w+)\}/g, (match, name) => {
        if (name === 'old') return oldText;
        if (name === 'new') return String(vars.newLines || '');
        if (name === 'limit') return String(vars.limit || BASIS_CHAR_LIMIT_DEFAULT);
        return match;
    });
}

/** 去掉模型可能包上的代码围栏和「摘要：」这类前缀 */
export function cleanBasis(text) {
    return String(text ?? '')
        .replace(/^```[a-zA-Z]*\s*/, '')
        .replace(/```\s*$/, '')
        .replace(/^\s*(剧情)?摘要\s*[:：]\s*/, '')
        .trim();
}

/** 超长就截断并说明截了（不许静默裁） */
export function capBasis(text, maxChars) {
    const value = String(text ?? '');
    const limit = Math.max(100, Math.floor(Number(maxChars) || 0) || BASIS_CHAR_LIMIT_DEFAULT);
    if (value.length <= limit) return { text: value, truncated: false };
    return { text: `${value.slice(0, limit)}…（摘要超长已截断）`, truncated: true };
}

/** 一楼层成「谁：说了什么」，跟决策请求里那套写法一致 */
export function floorToLine(message, userName, characterName) {
    if (!message) return '';
    // 摘要吃的是 ST 原样楼层（is_user），不是路由那边自己拼的 isUser，两个键都得认：
    // 只认 isUser 的话用户那句话会被安上角色的名字，摘要里就分不清谁在说话
    const isUser = message.isUser ?? message.is_user;
    const who = isUser ? (userName || message.name || '用户') : (message.name || characterName || 'AI');
    return `${who}：${String(message.mes ?? '').replace(/\s+/g, ' ').trim()}`;
}

/**
 * 挑出「还没摘要过」的楼层
 * @param {Array} chat 当前聊天（不含系统消息）
 * @param {{covered: number, marker: string}|null} state 已摘要到哪
 * @returns {Array}
 * @description 楼层数没涨但最后一条变了（重新生成／编辑），也要重摘要那一条，否则摘要永远追不上剧情
 */
export function pickNewFloors(chat, state) {
    const list = chat || [];
    const covered = Math.min(Number(state?.covered) || 0, list.length);
    if (list.length > covered) return list.slice(covered);
    if (!state || !list.length) return [];
    return markerOf(list) === state.marker ? [] : list.slice(-1);
}

/** 当前剧情的「摘要到哪了」标记：楼层数 + 最后一条内容 */
export function markerOf(chat) {
    const list = chat || [];
    const last = list[list.length - 1];
    return fnv1aHex(`${list.length}|${String(last?.mes ?? '').slice(-300)}`);
}

/** 读当前聊天的摘要状态（形状不认识一律当「还没摘要过」） */
export function readBasisState(context = USER.getContext()) {
    const raw = context?.chatMetadata?.[BASIS_STATE_KEY];
    if (!raw || typeof raw !== 'object') return null;
    const text = String(raw.text ?? '').trim();
    if (!text) return null;
    return { text, covered: Number(raw.covered) || 0, at: Number(raw.at) || 0, marker: String(raw.marker ?? '') };
}

/** 写进内存（不落盘）；拿不到元数据就说清楚，别假装成功 */
export function writeBasisState(state, context = USER.getContext()) {
    const meta = context?.chatMetadata;
    if (!meta || typeof meta !== 'object') {
        EDITOR.error('决策摘要存不下来：当前聊天没有可读写的元数据。', 'decisionBasis');
        return false;
    }
    if (state) meta[BASIS_STATE_KEY] = state;
    else delete meta[BASIS_STATE_KEY];
    return true;
}

/**
 * 当前可用的摘要文本（没有就空串）
 * @returns {string}
 */
export function basisDigest(context = USER.getContext()) {
    return readBasisState(context)?.text ?? '';
}

/**
 * 清掉当前聊天的摘要（换档、想重来时用）
 * @returns {Promise<boolean>}
 */
export async function dropBasis(context = USER.getContext()) {
    if (!readBasisState(context)) return false;
    if (!writeBasisState(null, context)) return false;
    if (typeof context?.saveMetadata !== 'function') return false;
    await context.saveMetadata();
    return true;
}

/**
 * 发一次摘要请求（花钱）
 * @param {{oldText: string, floors: Array, userName: string, characterName: string}} input
 * @param {object} config readConfig 里那组 basis 相关设置
 * @param {boolean} [silent] 静默模式：自动摘要不弹进度条
 * @returns {Promise<{text: string, truncated: boolean, error: string}>}
 */
export async function summarizeBasis(input, config, silent = false) {
    const { oldText = '', floors = [], userName = '', characterName = '' } = input || {};
    const newLines = (floors || []).map(message => floorToLine(message, userName, characterName)).filter(line => line !== '');
    if (!newLines.length) return { text: oldText, truncated: false, error: '' };
    const user = renderBasisPrompt(config.basisTemplate, {
        oldText,
        newLines: newLines.join('\n'),
        limit: config.basisCharLimit,
    });
    let raw = null;
    // 把这趟请求的原文留在内存里，设置页「查看上次 LLM 回复」随时摊开
    beginReply({
        purpose: '决策摘要',
        apiType: config.basisUseMainApi ? 'main' : 'custom',
        model: config.basisUseMainApi ? '' : (USER.privacy.custom_model_name || ''),
        promptText: `${config.basisSystemPrompt}\n\n【摘要要求】\n${user}`,
    });
    try {
        raw = config.basisUseMainApi
            ? await handleMainAPIRequest(config.basisSystemPrompt, user, silent)
            : await handleCustomAPIRequest(config.basisSystemPrompt, user, silent);
    } catch (error) {
        const message = String(error?.message || error);
        finishReply({ error: message });
        return { text: '', truncated: false, error: message };
    }
    finishReply({ rawContent: String(raw ?? '') });
    const cleaned = cleanBasis(raw);
    if (!cleaned) return { text: '', truncated: false, error: '摘要模型没有返回内容' };
    const capped = capBasis(cleaned, config.basisCharLimit);
    return { text: capped.text, truncated: capped.truncated, error: '' };
}

// 同一时间只跑一趟摘要：自动挂点和失败弹窗里那颗按钮可能撞车
let basisRunning = false;

/**
 * 一轮生成结束后刷新摘要（模式 2 的挂点）。不满足条件时安静返回，不花钱。
 * @returns {Promise<{ran: boolean, reason?: string, text?: string, floors?: number, error?: string}>}
 */
export async function refreshBasisAfterGeneration() {
    const setting = USER.store || {};
    if (setting.decision_router_enabled !== true || resolveBasisMode(setting) !== 'summary') {
        return { ran: false, reason: 'off' };
    }
    const context = USER.getContext() || {};
    const chat = (context.chat || []).filter(message => message && !message.is_system);
    if (!chat.length) return { ran: false, reason: 'empty' };
    const state = readBasisState(context);
    const floors = pickNewFloors(chat, state);
    if (!floors.length) return { ran: false, reason: 'no_new' };
    if (basisRunning) return { ran: false, reason: 'running' };
    basisRunning = true;
    try {
        const config = basisConfig(setting);
        const result = await summarizeBasis({
            oldText: state?.text ?? '',
            floors,
            userName: context.name1 || '',
            characterName: context.name2 || '',
        }, config, true);
        if (result.error) {
            // 摘要失败不推进 covered：下一轮生成还会把这几楼补上，不会静默丢掉一段剧情
            EDITOR.warning(`决策摘要没写出来：${result.error}，下一轮再补。这几轮决策依据先用旧摘要或正文。`);
            return { ran: false, reason: 'failed', error: result.error };
        }
        writeBasisState({ text: result.text, covered: chat.length, at: Date.now(), marker: markerOf(chat) }, context);
        if (typeof context?.saveMetadata === 'function') await context.saveMetadata();
        if (result.truncated) EDITOR.warning(`决策摘要超过「摘要字数限制」，已截断到 ${config.basisCharLimit} 字。要留更多细节就调高它。`);
        return { ran: true, text: result.text, floors: floors.length };
    } finally {
        basisRunning = false;
    }
}

/** 摘要这趟请求用哪个模型、什么提示词、留多少字 */
export function basisConfig(setting = USER.store || {}) {
    const num = (value, fallback) => {
        if (value === '' || value === null || value === undefined) return fallback;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    };
    return {
        basisUseMainApi: setting.decision_basis_use_main_api !== false,
        basisCharLimit: Math.max(100, num(setting.decision_basis_char_limit, BASIS_CHAR_LIMIT_DEFAULT)),
        basisTemplate: String(setting.decision_basis_template || ''),
        basisSystemPrompt: String(setting.decision_basis_system_prompt || '').trim() || DEFAULT_BASIS_SYSTEM_PROMPT,
    };
}
