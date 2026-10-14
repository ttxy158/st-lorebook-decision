/**
 * 决策模型（阿里云百炼 System One）请求层
 *
 * 与 services/llmApi.js 的区别：这个接口不是 OpenAI 兼容格式，请求体是
 * { model, state, questions }，响应是 { answers: { 问题id: { type, noul|choice|score, ... } } }，
 * 没有 messages / temperature，也不能流式，所以单独一个文件，不复用 LLMApiService。
 *
 * 实测（2026-10-03，Node 直连）：固定开销约 122ms / 270 token，之后每多问 1 条加 7.3ms / 175 token；
 * 16 条一次问完约 231ms。多轮之间可以并发，80 条 5 轮并发只要 ~250ms（串行 ~1150ms）。
 */

export const DECISION_DEFAULT_MODEL = 'decision-model-preview';

// 服务端硬上限：一次请求最多 16 个问题，超了直接 400
// {"code":"ValidationError","message":"...questions: 60 exceeds the limit of 16"}（2026-10-03 实测）
export const DECISION_MAX_QUESTIONS = 16;

// 多轮时分几路并发。接口侧 8 路实测不限流（2026-10-03：并发 5 路 249ms、8 路 371ms，全 HTTP 200、无 429），
// 瓶颈是浏览器对同一个来源只有 6 个连接 —— 插件走的是 ST 自带的 /proxy/，
// 这 6 个口子还要留给正常收发、存聊天、加载图片，所以留 2 个，用 4。
export const DECISION_MAX_IN_FLIGHT = 4;

// 相关性问法。实测同一个「角色档案」条目，问「续写是否需要这条」只得 0.50，
// 问「本段是否涉及该条目描述的内容」得 0.95 —— 问法决定成败，不要改成主观需求问法。
// 用户可在设置里改这份模板，占位符见 renderInstruction。
export const DEFAULT_INSTRUCTION_TEMPLATE = '本段剧情是否涉及以下条目所描述的人物、地点、道具或事件？条目：{digest}';

// 拼在最后那句「正要发送但还没进聊天记录」的输入后面的标注，可整段清空
export const DEFAULT_PENDING_NOTE = '（这句正要发出，尚未写入记录）';

// 拼在 state 最前面的任务说明的默认值。以前 state 里只有场景、角色、对话，模型并不知道
// 自己判的是「这一条现在用不用得上」，只能照字面回答「是否涉及」——摘要索引那层把问法
// 分细了，但没有这段交代，分细的问法还是会被当成「这句话提没提到」。
// 这段文字现在是设置页里可直接改的（decision_task_briefing），这里只是没被改过时的默认值。
// 2026-10-11 去掉流水线黑话（用户拍的 B）：原本写的「该不该注入 AI 的系统提示词」「相关度概率」「内容尺度」
// 是我们这行的用语，判别式模型的语料里更常见的是「这条背景跟当前内容搭不搭」，所以整段改用它认识的词，
// 意思一件没少：判用不用得上、只提名字不算、别因摘要短压分、别管文笔和尺度。
// 注意：0.85/0.25 两个阈值是在没有这段的时候校准的，改这段要重看一次决策报告。
// 2026-10-13 再清一层黑话：判别模型没读过 SillyTavern 的语料，「一张世界书里的条目」对它只是一个陌生名词，
// 换成对它自己有用的说法——这些是备用的背景设定，每条这里只给一行说明。
export const DEFAULT_DECISION_TASK_BRIEFING = '【你的任务】下面每个问题各对应一条备用的背景设定（角色扮演／小说创作的资料，一条写一个人物、地点、道具、事件或规则）。你要判断：接下来续写这一段剧情时，这条设定是不是已经用得上或马上要用上——用得上＝当前剧情正在起作用，或紧接着就要起作用。只是提到了它的名字、或者你觉得以后可能用得上，都算用不上。你只管它跟当前剧情搭不搭，不评文笔，也不管情节尺度。那句简介背后的原文详细得多，别因为简介短就压分。';

/**
 * 任务说明取设置里的值；没这个键（老存档）用默认，整段清空就是真的不要这段
 * @param {string|undefined} raw
 * @returns {string}
 */
export function resolveTaskBriefing(raw) {
    return typeof raw === 'string' ? raw : DEFAULT_DECISION_TASK_BRIEFING;
}

// ---- 决策摘要（把正文改写成概括再送进决策请求）那两份默认文案
// 放在这里而不是 decisionBasis.js，是因为 pluginSetting.js 要拿它当默认值，
// 而那份模块会反过来 import manager，绕成循环依赖。
export const DEFAULT_BASIS_SYSTEM_PROMPT = '你是剧情摘要器。你的输出不是给人读的，是给另一个只能读概括、不看原文的判别模型当依据用的。只输出摘要正文，不要标题、编号、解释你做了什么。';

export const DEFAULT_BASIS_TEMPLATE = '把【新增剧情】并进【已有摘要】，重写成一段新的摘要。\n\n【已有摘要】\n{old}\n\n【新增剧情】\n{new}\n\n【要求】总长不超过 {limit} 字。写清现在谁在场、在什么地方、刚刚发生了什么、用户正想要什么，按时间顺序写成连贯一段。用词收敛到「做了什么／想要什么」这一层，不要复述身体、动作、呻吟之类的露骨细节描写，也不用委婉说法去暗示它。新增剧情为空时，原样输出已有摘要。';

/**
 * 渲染单个条目的判定问法
 *
 * 模板里一个占位符都没有时会自动补上 {digest}：否则所有条目问的是同一句话，
 * 概率全都一样，决策就完全没有意义了。未知占位符原样留着，方便你发现写错了。
 * @param {string} template 用户模板，空则用默认
 * @param {{digest: string, label: string, keys: string, content: string}} vars
 * @returns {string}
 */
export function renderInstruction(template, vars) {
    let tpl = String(template || '').trim();
    if (!tpl) tpl = DEFAULT_INSTRUCTION_TEMPLATE;
    if (!/\{(digest|label|keys|content)\}/.test(tpl)) tpl = `${tpl}{digest}`;
    return tpl.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? vars[name] : match));
}

/**
 * 条目对人（对模型）可读的标题
 * @param {object} entry 世界书条目
 * @returns {string}
 */
export function entryTitle(entry) {
    return String(entry?.comment ?? '').trim() || `条目${entry?.uid ?? ''}`;
}

/**
 * 条目摘要：标题｜关键词｜内容前若干字
 * 决策模型只看摘要，所以关键词必须一起给，否则长条目里的细节会被漏掉。
 * @param {object} entry 世界书条目
 * @param {number} [contentLimit=120]
 * @returns {string}
 */
export function buildEntryDigest(entry, contentLimit = 120) {
    const title = entryTitle(entry);
    const keys = [...(entry?.key || []), ...(entry?.keysecondary || [])]
        .map(key => String(key ?? '').trim())
        .filter(Boolean)
        .slice(0, 12)
        .join('、');
    let body = String(entry?.content ?? '').replace(/\s+/g, ' ').trim();
    if (body.length > contentLimit) body = `${body.slice(0, contentLimit)}…`;
    return [title, keys ? `关键词：${keys}` : '', body].filter(Boolean).join('｜');
}

/**
 * 把候选条目编成一次批量请求的 questions，并返回 id → 条目的映射表
 * @param {Array} entries
 * @param {number} [contentLimit]
 * @param {string} [instructionTemplate] 判定问法模板，留空用默认
 * @param {number} [idOffset=0] 分轮询问时后几轮要接着前面的编号，否则各轮都是 q0..，
 *   合并 answers 时后面的轮次会把前面的覆盖掉
 * @param {(entry: object) => ({digest:string, template:string, indexed:boolean, typeId?:string}|null)} [materialFor]
 *   条目材料选择器（来自条目摘要索引）。给了且这一条有索引，就用索引里的短摘要 + 这一类自己的问法；
 *   返回 null（没索引、或索引功能关着）就退回正文片段 + 上面的通用问法，与以前逐字一致。
 * @returns {{questions: object, map: Array}}
 */
export function buildQuestions(entries, contentLimit = 120, instructionTemplate = '', idOffset = 0, materialFor = null) {
    const questions = {};
    const map = [];
    (entries || []).forEach((entry, index) => {
        const id = `q${idOffset + index}`;
        const material = materialFor ? materialFor(entry) : null;
        const digest = material?.digest || buildEntryDigest(entry, contentLimit);
        questions[id] = {
            type: 'noul',
            instructions: renderInstruction(material?.template || instructionTemplate, {
                digest,
                label: entryTitle(entry),
                keys: [...(entry?.key || []), ...(entry?.keysecondary || [])]
                    .map(key => String(key ?? '').trim()).filter(Boolean).join('、'),
                content: String(entry?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, contentLimit),
            }),
        };
        map.push({
            id,
            world: entry.world,
            uid: entry.uid,
            label: entryTitle(entry),
            digest,
            entry,
            // 报告要能交代这条是按索引判的、还是按正文片段判的，不然「同一轮两种判据」没法解释
            indexed: !!material?.indexed,
            typeId: material?.typeId || '',
        });
    });
    return { questions, map };
}

/**
 * 把消息列表渲染成「谁：说了什么」，顺带截断超长内容
 * @description 截断是从尾部倒着免截的：最后几条（尤其最新那段 AI 回复）的结尾才是「此刻正在发生什么」，
 * @description 而保头去尾恰好把它砍掉，所以那几条整段带过去，更早的只当背景、按字数截。
 * @param {Array<{isUser: boolean, name?: string, text: string, pending?: boolean}>} messages
 * @param {string} userName
 * @param {string} characterName
 * @param {number} messageLimit 单条消息截断长度
 * @param {string} pendingNote 待发送那句的标注
 * @param {number} [fullCount=0] 末尾几条不截字数、整段带过去
 * @returns {string[]}
 */
function renderDialog(messages, userName, characterName, messageLimit, pendingNote, fullCount = 0) {
    const list = messages || [];
    return list.map((message, index) => {
        const who = message.isUser ? (userName || '用户') : (message.name || characterName || 'AI');
        let text = String(message.text ?? '').replace(/\s+/g, ' ').trim();
        if (index < list.length - fullCount && text.length > messageLimit) text = `${text.slice(0, messageLimit)}…`;
        return `${who}：${text}${message.pending && pendingNote ? pendingNote : ''}`;
    });
}

/**
 * 任务说明那一行：没传（老存档没这个键）用默认，整段清空就是不拼这一行
 * @param {string|undefined} taskBriefing
 * @returns {string[]}
 */
function briefingLines(taskBriefing) {
    const text = String(taskBriefing ?? DEFAULT_DECISION_TASK_BRIEFING).trim();
    return text ? [text] : [];
}

/**
 * 拼装 state：任务说明 + 背景说明 + 角色信息 + 最近对话，纯文本
 * @param {{userName?: string, characterName?: string, sceneNote?: string, messages?: Array<{isUser: boolean, name?: string, text: string, pending?: boolean}>, pendingNote?: string, taskBriefing?: string}} input
 * @param {number} [messageLimit=600] 单条消息截断长度
 * @param {number} [fullCount=0] 末尾几条整段带、不截字数
 * @returns {string}
 */
export function buildState({ userName = '', characterName = '', sceneNote = '', messages = [], pendingNote = DEFAULT_PENDING_NOTE, taskBriefing }, messageLimit = 600, fullCount = 0) {
    const lines = briefingLines(taskBriefing);
    if (sceneNote) lines.push(`当前场景：${sceneNote}`);
    if (characterName || userName) lines.push(`角色：${characterName || 'AI'} 与 ${userName || '用户'}`);
    const dialog = renderDialog(messages, userName, characterName, messageLimit, pendingNote, fullCount);
    if (dialog.length) lines.push(`最近对话：\n${dialog.join('\n')}`);
    return lines.join('\n');
}

/**
 * 拼装 state：任务说明 + 背景说明 + 角色信息 + LLM 写好的剧情摘要 + 本轮正要发的那句
 * @description 走这条是因为正文里的露骨描写会让决策模型整批拒答；摘要由不拒答的模型改写，
 * @description 用词收敛到「做了什么/想要什么」这一层。它滞后一轮，所以本轮草稿仍要单独带上。
 * @param {{userName?: string, characterName?: string, sceneNote?: string, digest?: string, messages?: Array, pendingNote?: string, taskBriefing?: string}} input
 * @param {number} [messageLimit=600] 单条消息截断长度
 * @param {number} [fullCount=0] 末尾几条整段带、不截字数
 * @returns {string}
 */
export function buildDigestState({ userName = '', characterName = '', sceneNote = '', digest = '', messages = [], pendingNote = DEFAULT_PENDING_NOTE, taskBriefing }, messageLimit = 600, fullCount = 0) {
    const lines = briefingLines(taskBriefing);
    if (sceneNote) lines.push(`当前场景：${sceneNote}`);
    if (characterName || userName) lines.push(`角色：${characterName || 'AI'} 与 ${userName || '用户'}`);
    const summary = String(digest || '').trim();
    if (summary) lines.push(`剧情要点（由上一个模型改写的概括，不含细节描写）：\n${summary}`);
    const dialog = renderDialog(messages, userName, characterName, messageLimit, pendingNote, fullCount);
    if (dialog.length) lines.push(`本轮正要发出的话：\n${dialog.join('\n')}`);
    return lines.join('\n');
}

/**
 * 按大小切分数组
 * @param {Array} list
 * @param {number} size 每段多少个，<1 时按 1 算
 * @returns {Array<Array>}
 */
export function chunk(list, size) {
    const step = Math.max(1, Math.floor(Number(size) || 1));
    const parts = [];
    for (let i = 0; i < (list || []).length; i += step) {
        parts.push((list || []).slice(i, i + step));
    }
    return parts;
}

/**
 * 合并各轮 answers。用 Object.assign 而不是展开，因为条目 id 是全局的 q0..qN，不会撞键。
 * @param {Array<object>} parts
 * @returns {object}
 */
export function mergeAnswers(parts) {
    return Object.assign({}, ...(parts || []).map(part => part || {}));
}

/**
 * 解析 answers → 三态处置
 *
 * 中间带既不强推也不压制，交回原来的关键词规则：实测真相关在 0.92~0.97、
 * 明显无关在 0.23~0.35，硬把中间带判成「注入」或「不注入」都会误伤。
 * @param {object} answers 响应里的 answers
 * @param {Array} map buildQuestions 的映射表
 * @param {{forceThreshold?: number, suppressThreshold?: number, suppressEnabled?: boolean}} thresholds
 * @returns {{force: Array, suppress: Array, scores: object, missing: Array}}
 */
export function parseAnswers(answers, map, thresholds = {}) {
    const forceThreshold = Number(thresholds.forceThreshold ?? 0.85);
    const suppressThreshold = Number(thresholds.suppressThreshold ?? 0.25);
    const suppressEnabled = thresholds.suppressEnabled === true;
    const result = { force: [], suppress: [], scores: {}, missing: [] };
    for (const item of map || []) {
        const probability = Number(answers?.[item.id]?.noul);
        if (!Number.isFinite(probability)) {
            result.missing.push(item);
            continue;
        }
        result.scores[item.id] = { uid: item.uid, world: item.world, label: item.label, probability };
        if (probability >= forceThreshold) {
            // WORLDINFO_FORCE_ACTIVATE 会把收到的对象原样当作激活条目（world-info.js:4758），
            // 所以这里必须给完整条目，只给 world+uid 的话注入内容是空的。
            result.force.push({ ...(item.entry || {}), world: item.world, uid: item.uid });
        } else if (suppressEnabled && probability <= suppressThreshold) {
            result.suppress.push({ world: item.world, uid: item.uid });
        }
    }
    return result;
}

/**
 * 按本轮注入名额把强推清单截断：条数和字数两条线，谁先到算谁
 *
 * 概率从高到低累计，第一条无论如何都留（它已经是模型判出来最相关的，
 * 一个名额都不给等于把这轮的判定整个扔掉）。被挤掉的条目不是「判成不相关」：
 * 关着「关闭关键词触发注入」时它照旧走关键词规则，开着那颗时它这一轮不注入。
 * 两个数都是 0（默认）时原样退回，连顺序都不动。
 * @param {Array} force parseAnswers 的强推清单（完整条目对象）
 * @param {object} scores parseAnswers 的 scores，按 world+uid 反查每条的概率
 * @param {{maxEntries?: number, maxChars?: number}} quota 0 或留空 = 不限
 * @returns {{kept: Array, squeezed: Array, keptChars: number}}
 */
export function applyInjectQuota(force, scores, quota = {}) {
    const maxEntries = Math.max(0, Math.floor(Number(quota.maxEntries) || 0));
    const maxChars = Math.max(0, Math.floor(Number(quota.maxChars) || 0));
    const all = force || [];
    const charCount = (list) => list.reduce((sum, entry) => sum + String(entry?.content ?? '').length, 0);
    if (!maxEntries && !maxChars) {
        // 一个上限都没设就不动：连顺序也保持原来的条目顺序，别让「关着的功能」悄悄改了注入次序
        return { kept: all.slice(), squeezed: [], keptChars: charCount(all) };
    }
    const items = all.map((entry, index) => ({
        entry,
        index,
        probability: probabilityOf(entry, scores),
        chars: String(entry?.content ?? '').length,
    })).sort((a, b) => (b.probability - a.probability) || (a.index - b.index));

    const kept = [];
    const squeezed = [];
    let keptChars = 0;
    for (const item of items) {
        const overEntries = maxEntries > 0 && kept.length >= maxEntries;
        const overChars = maxChars > 0 && kept.length > 0 && keptChars + item.chars > maxChars;
        if (overEntries || overChars) {
            squeezed.push(item.entry);
            continue;
        }
        kept.push(item.entry);
        keptChars += item.chars;
    }
    return { kept, squeezed, keptChars };
}

/**
 * 从 scores 里把这条目的概率找回来（键是 q0..qN，只能按 world+uid 反查）
 * @param {object} entry 完整条目
 * @param {object} scores parseAnswers 的 scores
 * @returns {number}
 */
function probabilityOf(entry, scores) {
    for (const value of Object.values(scores || {})) {
        if (value?.uid === entry?.uid && value?.world === entry?.world) {
            return Number(value.probability) || 0;
        }
    }
    return 0;
}

/**
 * 补全成完整的 systemone 地址，并按需套上 SillyTavern 的同源转发前缀
 *
 * 该端点不返回 access-control-allow-origin，浏览器直连必被 CORS 拦掉，
 * 所以默认走 ST 自带的 /proxy/<完整URL>（需要 config.yaml 里 enableCorsProxy: true）。
 * @param {string} rawUrl
 * @param {boolean} useProxy
 * @returns {string}
 */
export function resolveEndpoint(rawUrl, useProxy = true) {
    const url = String(rawUrl || '').trim();
    if (!url) throw new Error('决策模型地址未填写');
    const full = /\/systemone\/?$/.test(url) ? url.replace(/\/+$/, '') : `${url.replace(/\/+$/, '')}/systemone`;
    return useProxy ? `/proxy/${full}` : full;
}

// 「对端答了、但拒绝处理这段文本」的识别词。只有这一类失败才值得弹「改用摘要再判一次」，
// 所以判据先要求「对端返回了错误」——requestDecision 的非 2xx 分支统一带「返回 HTTP 状态码」这个头，
// 超时（它包成「决策模型请求超时」）、断网（TypeError: Failed to fetch）都不会命中。
// 阿里云百炼实测原文（2026-10-12）：
//   决策模型返回 HTTP 400：{"code":"DataInspectionFailed","message":"<400> InternalError.Algo.DataInspectionFailed:
//   Input text data may contain inappropriate content. (Input data may contain inappropriate content.)","request_id":"..."}
// 同一层的 ValidationError（questions 超过 16 条）也是 HTTP 400，但它不含下面任何词，不会被误判成拒答。
const MODERATION_NEEDLES = [
    'datainspectionfailed', 'inappropriate content', 'content_filter', 'content policy',
    'responsibleinventory', 'safety', '敏感', '违规', '不适当', '不适合',
];

/**
 * 这次失败是不是「内容被对端过滤掉了」
 * @param {string} message 错误消息（requestDecision 抛出的那句）
 * @returns {boolean}
 */
export function isModerationRejection(message) {
    const text = String(message ?? '').toLowerCase();
    if (!/返回 http [0-9]{3}/.test(text)) return false;
    return MODERATION_NEEDLES.some(needle => text.includes(needle));
}

export const PROXY_NOT_ENABLED_HEAD = '本机酒馆的同源转发没打开';

// Termux 上那条可粘贴命令：不写死酒馆装在哪，让命令自己按插件目录名把脚本找出来。
// 无 root 的手机上，用 pkg 装的酒馆一定在 ~ 下面（~/SillyTavern），所以从 ~ 找能命中；
// 脚本自己是向上找 config.yaml 的，所以只要这一句命中，后面它就知道该改哪个 config。
// 跳过 node_modules／.git／storage：前两者又大又慢，storage 是软链接到共享存储、几万个文件白扫一遍。
const PROXY_FIND = String.raw`find ~ \( -type d \( -name node_modules -o -name .git -o -name storage \) -prune \) -o \( -type f -path '*/st-lorebook-decision/tools/enable-cors-proxy.sh' -print \) 2>/dev/null | head -n1`;

// 酒馆在开关关着时，把 /proxy 换成一个只会回 404 + 这句话的占位处理器
// （1.17 与 1.19 的 src/server-main.js 里逐字相同）。请求带上 CSRF 令牌后就不会再被半路的 CSRF 中间件挡下，
// 所以「没开」能拿到这句明确的话，不用再靠「403 + 一整页 HTML」去猜。
export const PROXY_DISABLED_SENTENCE = 'CORS proxy is disabled';

// 自证地址：浏览器直接打开它，看到 example.com 的内容就是通了；看到上面那句话就是还没生效。
export const PROXY_SELF_CHECK_PATH = '/proxy/https://example.com/';

const HTML_PAGE_MARKERS = ['<!doctype', '<html', '<body'];

function readUserAgent(userAgent) {
    return String(userAgent ?? (typeof navigator !== 'undefined' ? navigator?.userAgent : '') ?? '');
}

function readOrigin(origin) {
    return String(origin ?? (typeof location !== 'undefined' ? location?.origin : '') ?? '');
}

/**
 * 这段响应体是不是一整页 HTML 错误页
 * @param {string} text
 * @returns {boolean}
 */
export function isHtmlErrorPage(text) {
    const head = String(text ?? '').slice(0, 300).toLowerCase();
    return HTML_PAGE_MARKERS.some(marker => head.includes(marker));
}

/**
 * 自证用的同源地址；拿不到当前站点就返回空
 * @param {string} [origin]
 * @returns {string}
 */
export function proxySelfCheckUrl(origin) {
    const base = readOrigin(origin);
    return base ? base + PROXY_SELF_CHECK_PATH : '';
}

/**
 * 手机上能直接粘贴执行的那条命令；电脑上给的是双击，没有命令可复制就返回空
 * @param {string} [userAgent]
 * @returns {string}
 */
export function proxyFixCommand(userAgent) {
    if (!/android/i.test(readUserAgent(userAgent))) return '';
    return `bash "$(${PROXY_FIND})"`;
}

/**
 * 转发没开该怎么修——把三步全写进这句话里
 * @param {string} [userAgent] 浏览器 UA，缺省时读当前环境
 * @param {string} [selfCheckUrl] 自证地址，缺省时读当前站点
 * @returns {string}
 */
export function describeProxyNotEnabled(userAgent, selfCheckUrl) {
    const ua = readUserAgent(userAgent);
    const step1 = /android/i.test(ua)
        ? `① 在 Termux 里粘这一句跑一下（它会自己找到插件里的脚本，找的过程可能要等两三秒）：${proxyFixCommand(ua)}`
        : '① 双击插件目录里的 tools\\enable-cors-proxy.bat（它只改 config.yaml 里 enableCorsProxy 这一行，改之前先留一份 .bak）';
    const step2 = /android/i.test(ua)
        ? '② 在 Termux 里按 Ctrl+C 停掉，再跑一次 node server.js'
        : '② 关掉酒馆那个命令行窗口，重新双击 Start.bat';
    const url = readOrigin(selfCheckUrl) ? proxySelfCheckUrl(selfCheckUrl) : '';
    const step3 = url
        ? `③ 想确认到底生效没有：浏览器地址栏打开 ${url}，看到 example.com 的网页内容就是通了；看到「${PROXY_DISABLED_SENTENCE}」就是还没生效。`
        : '';
    return `${PROXY_NOT_ENABLED_HEAD}：请求还没发出去就被本机酒馆挡下了（不是接口地址或 Key 的问题）。`
        + `${step1}。这个开关只在进程启动时读一次，改完不重启等于没改，刷新页面没用——${step2}。${step3}`;
}

/**
 * 这个响应码加响应体，是不是「本机转发没开」的回执
 * @param {number} status
 * @param {string} text 响应体
 * @returns {boolean}
 */
export function isProxyNotEnabledResponse(status, text) {
    if (Number(status) === 404 && String(text ?? '').includes(PROXY_DISABLED_SENTENCE)) return true;
    // 令牌没拿到（老酒馆、跨用户页）时仍会撞上半路的 CSRF 错误页：状态 403 加一整页 HTML。
    // 对端的错误一律是 JSON（实测 401 {"error":…}、400 {"code":"DataInspectionFailed"…}），不会误判。
    return Number(status) === 403 && isHtmlErrorPage(text);
}

/**
 * 取本页的 CSRF 令牌：走 /proxy 时它是同源请求，开关关着时会被酒馆的 CSRF 中间件先挡下
 * @returns {Promise<string>} 拿不到就返回空串，请求照发
 */
async function fetchCsrfToken() {
    try {
        const response = await fetch('/csrf-token');
        const text = await response.text();
        return String(JSON.parse(text)?.token ?? '');
    } catch (error) {
        return '';
    }
}

/**
 * 这句错误是不是「本机酒馆的转发没打开」
 * @param {string} message 错误消息（requestDecision 抛出的那句）
 * @returns {boolean}
 */
export function isProxyNotEnabled(message) {
    return String(message ?? '').includes(PROXY_NOT_ENABLED_HEAD);
}

/**
 * 发一次决策请求
 * @param {{endpoint: string, apiKey?: string, model?: string, state: string, questions: object, useProxy?: boolean, timeoutMs?: number}} options
 * @returns {Promise<object>} 完整响应
 */
export async function requestDecision({ endpoint, apiKey = '', model = DECISION_DEFAULT_MODEL, state, questions, useProxy = true, timeoutMs = 15000 }) {
    const url = resolveEndpoint(endpoint, useProxy);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 15000));
    try {
        const headers = {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        };
        // 开关关着时 CSRF 中间件排在 /proxy 前面，不带令牌的 POST 会被本机挡下、回一整页 HTML，
        // 就只能靠猜。带上令牌后请求能走到 /proxy 本身，没开时拿到的是酒馆自己那句 404。
        if (useProxy) {
            const csrfToken = await fetchCsrfToken();
            if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
        }
        const response = await fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers,
            body: JSON.stringify({ model, state, questions }),
        });
        const text = await response.text();
        if (!response.ok) {
            if (useProxy && isProxyNotEnabledResponse(response.status, text)) {
                throw new Error(`决策模型返回 HTTP ${response.status}：${describeProxyNotEnabled()}`);
            }
            throw new Error(`决策模型返回 HTTP ${response.status}：${text.slice(0, 200)}`);
        }
        let data;
        try {
            data = JSON.parse(text);
        } catch (error) {
            throw new Error(`决策模型返回的不是 JSON：${text.slice(0, 200)}`);
        }
        if (!data || typeof data !== 'object' || !data.answers) throw new Error('决策模型响应里没有 answers 字段');
        return data;
    } catch (error) {
        if (error && (error.name === 'AbortError' || /abort/i.test(String(error.message || '')))) {
            throw new Error(`决策模型请求超时（${Math.round((Number(timeoutMs) || 15000) / 1000)} 秒）`);
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}
