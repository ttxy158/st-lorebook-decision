/**
 * 条目摘要索引：先让一个 LLM 把世界书条目读一遍，写成短摘要并归类，
 * 之后决策模型每轮只看这条摘要，并且按它所属的分类用「这一类自己的问法」提问。
 *
 * 为什么要这一层：直接把所有条目的正文片段塞给决策模型，数量和类型都很杂，
 * 而问法只有一条通用模板 —— 问人物「是否出现」、问设定规则「是否在管辖范围」其实不是一回事，
 * 一条模棱两可的问法只能给出模棱两可的概率。摘要顺带把长条目压到几十字，输入也小了。
 *
 * 口径（用户 2026-10-10 拍板）：
 * - 索引只影响「怎么问」，不影响注入什么：强推时照旧发完整条目，正文一个字都不会少。
 * - 索引存在插件自己的设置里（extension_settings.stLorebookDecision），不碰世界书文件。
 * - 只给「启用中的世界书 + 会被决策路由当候选的那批条目」建索引，跟路由同一份过滤口径。
 * - 只有手动按钮会发请求；开关默认关着，关着时行为与以前逐字一致。
 */
import { EDITOR, USER } from '../../core/manager.js';
import { getSortedEntries } from '/scripts/world-info.js';
import { handleCustomAPIRequest, handleMainAPIRequest } from '../settings/standaloneAPI.js';
import { beginReply, finishReply } from '../settings/llmReplyViewer.js';
import { entryTitle } from '../../services/decisionApiService.js';

/** 「其他」这个分类删不掉：条目归不进现有分类时总得有个去处 */
export const DECISION_OTHER_TYPE_ID = 'other';

/** 内置分类表。id 是记账用的，用户改名字不会让已建好的索引失效，所以 id 一律用英文 */
export const DEFAULT_DECISION_TYPES = [
    { id: 'character', name: '人物', instruction: '本段剧情里这个人物是否出场、被提到，或需要对当前发生的事作出反应？条目：{digest}' },
    { id: 'place', name: '地点', instruction: '本段剧情发生的地点是否就是这里，或者即将前往、正提到这里？条目：{digest}' },
    { id: 'item', name: '道具', instruction: '本段剧情里这件东西是否被使用、看到、拿到、失去或提到？条目：{digest}' },
    { id: 'event', name: '事件', instruction: '本段剧情是否正在经历、回顾、推进或直接提到这件事？条目：{digest}' },
    { id: 'org', name: '组织势力', instruction: '本段剧情是否涉及这个组织或势力（成员在场、受它管辖、与它冲突都算）？条目：{digest}' },
    { id: 'rule', name: '设定规则', instruction: '本段剧情是否处在这条设定或规则管辖的范围内，即使没有直接提到它？条目：{digest}' },
    { id: DECISION_OTHER_TYPE_ID, name: '其他', instruction: '本段剧情是否涉及以下条目所描述的内容？条目：{digest}' },
];

/**
 * 建索引那趟的系统提示词，设置里清空就回这里
 * @description 开头先把「这句话之后怎么用」讲清：不建立这个认知，模型会写成剧情概括，判定模型每轮就得自己反推相关性。
 * @description 不提「世界书」「插件」：读这句话的模型没有 SillyTavern 的认知，只认「资料条目」和「有人拿你这句去判断要不要用这条资料」。
 */
export const DEFAULT_INDEX_SYSTEM_PROMPT = '你是设定条目的检索标注员。下面这些条目来自一部角色扮演／小说创作故事的资料库，一条写一个人物、地点、道具、事件、组织或规则。你为条目写的摘要会被一个模型用来判断是否需要注入系统提示词：每轮它只读你写的这一句，看不到条目原文。所以请给每条写一句「它是什么类型、什么时候该拿出来用」的用处说明并归类，不要写成剧情概括；什么时候用只写一个最主要的触发，别把各种情况罗列开。只输出规定的 JSON 行，不要解释、不要编号以外的文字、不要代码围栏。';

/**
 * 建索引那趟的用户提示词模板
 * `{types}` 分类清单、`{count}` 本批条数、`{entries}` 编号+标题+关键词+正文、`{limit}` 条目摘要字数限制、`{otherName}` 「其他」那一类的名字
 * @description 口径（用户 2026-10-11 选 A）：这句是给「要不要注入这条」的判定读的，所以**触发时机排在内容前面**；
 * @description 只概括剧情而不说什么时候用，模型每轮都得自己反推相关性，判得偏松也偏慢。
 */
export const DEFAULT_INDEX_TEMPLATE = `【这份索引之后怎么用】
你写的 summary 会被一个模型用来判断是否需要注入系统提示词：每一轮它只读你写的这一句 summary，看不到条目原文，也不知道这些条目出自哪部作品。所以你写的必须是「这是什么＋什么时候该用它」的用处说明，不是剧情概括——只写剧情的话，它每轮还得自己反推这条跟当前内容搭不搭。

【可选分类】每条目只选一个，名字要一模一样；哪个都不合就填「{otherName}」
分类不是标签：它决定这一条以后用哪种问法判（人物问「是否出场」、设定规则问「是否在管辖范围」），所以按用处选，别只看标题里的词。
{types}

【条目】共 {count} 条
{entries}

【要求】
- 每条一行 JSON：{"id":编号,"summary":"摘要","type":"分类名"}
- summary 不超过 {limit} 字，按这个顺序写：**这是什么**（类型＋名字／关系，如「陈伯的人物设定，镇上的铁匠」）→ **一个主触发**（这一类判定问的那件事，人物就是「登场或被提及时」）→ 现在什么状态。别只复述标题。
- 主触发只写一个，别把用得上的情况一条条罗列（「出场、独处、被忽略、身体描写时」）——判定问的就是一件事，罗列只会挤掉名字和关系。
- 也不要写放之四海都成立的空话（「相关时使用」「需要时」），那等于没写；主触发要具体到能被一句话验证。
- 原文里的露骨描写照实概括行为与关系就行。这是在给检索做标注，不是创作，不需要回避或含糊。
- 看不出属于哪一类的，type 填「{otherName}」。`;

/** 数值兜底：输入框被清空、或老存档里根本没这些键时用 */
export const INDEX_DEFAULTS = { summaryLimit: 60, contentLimit: 1200, batchSize: 20, batchChars: 6000 };

/**
 * 一批最多几条：真正的打包依据是「单批字数限制」，这条只是硬顶。
 * 切批按累计字数走，字数那颗填得再大也不该让一批牵连几十条条目一起失败
 * （请求挂了、或者整批没按 JSON 行回，是整批记账的）。
 */
export const INDEX_MAX_BATCH_SIZE = 50;
/**
 * FNV-1a 32 位哈希（同步）。只用来判断「条目内容变了没有」。
 * 不复用 utils/utility.js 里的 calculateStringHash：那个是 async（crypto.subtle），
 * 而查索引、比指纹都在同步路径上，为了一份内容校验把整条链变成 await 不值得。
 * @param {string} text
 * @returns {string} 8 位十六进制
 */
export function fnv1aHex(text) {
    let hash = 0x811c9dc5;
    const str = String(text ?? '');
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/** 索引主键：同一个 uid 在不同世界书里可能重复，所以带上书名 */
export function indexKey(world, uid) {
    return `${String(world ?? '')}::${String(uid ?? '')}`;
}

/** 条目的关键词（主+次），跟决策摘要那份口径一致 */
export function keysOf(entry) {
    return [...(entry?.key || []), ...(entry?.keysecondary || [])]
        .map(key => String(key ?? '').trim())
        .filter(Boolean)
        .slice(0, 12)
        .join('、');
}

/**
 * 内容指纹：标题、关键词、正文任意一个变了就要重摘要
 * @param {object} entry 世界书条目
 * @returns {string}
 */
export function entryFingerprint(entry) {
    const body = String(entry?.content ?? '').replace(/\s+/g, ' ').trim();
    return fnv1aHex([entryTitle(entry), keysOf(entry), body].join('\u0001'));
}
const DEFAULT_OTHER_INSTRUCTION = (DEFAULT_DECISION_TYPES.find(type => type.id === DECISION_OTHER_TYPE_ID) || {}).instruction || '';

/** 内置项的默认问法：老数据里缺 instruction 字段时补这个，用户亲手清空的 '' 不动 */
function defaultInstructionOf(id) {
    return (DEFAULT_DECISION_TYPES.find(type => type.id === id) || {}).instruction ?? '';
}

/**
 * 分类表规整：认不出来的项丢掉，「其他」永远补在最后
 * @param {Array} raw 设置里存的数组
 * @returns {Array<{id:string, name:string, instruction:string}>}
 * @description 存的是空数组或根本不是数组 = 还没动过，回落到内置分类；
 * @description 用户把自定义项都删光时至少还剩「其他」一项，所以空数组不可能是他的真实意图。
 */
export function normalizeTypes(raw) {
    const list = Array.isArray(raw) ? raw.filter(item => item && typeof item === 'object') : [];
    if (!list.length) return DEFAULT_DECISION_TYPES.map(type => ({ ...type }));
    const types = [];
    const seen = new Set();
    for (const item of list) {
        const name = String(item.name ?? '').trim();
        if (!name) continue;
        const id = String(item.id ?? '').trim() || `t${fnv1aHex(name)}`;
        if (id === DECISION_OTHER_TYPE_ID || seen.has(id)) continue;
        seen.add(id);
        types.push({ id, name, instruction: String(item.instruction ?? defaultInstructionOf(id)) });
    }
    const other = list.find(item => String(item.id ?? '').trim() === DECISION_OTHER_TYPE_ID);
    types.push({
        id: DECISION_OTHER_TYPE_ID,
        name: String(other?.name ?? '').trim() || '其他',
        // 字段根本不存在（老数据）才补内置问法；用户亲手清空是 ''，那就退回通用判定问法
        instruction: typeof other?.instruction === 'string' ? other.instruction : DEFAULT_OTHER_INSTRUCTION,
    });
    return types;
}
/**
 * 索引本体规整：只认 `{ 摘要, 分类id, 内容指纹, 时间 }` 这一种形状
 * @param {object} raw
 * @returns {object}
 * @description 摘要是空的记录一律丢掉（当没索引过）：拒答或模型偷懒回个空串时，
 * @description 拿空摘要去判定等于「所有条目都判成无关」，比不索引更糟。
 */
export function normalizeIndex(raw) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const index = {};
    for (const [key, value] of Object.entries(source)) {
        if (!value || typeof value !== 'object') continue;
        const summary = String(value.s ?? '').replace(/\s+/g, ' ').trim();
        if (!summary) continue;
        index[key] = {
            s: summary,
            t: String(value.t ?? '').trim() || DECISION_OTHER_TYPE_ID,
            h: String(value.h ?? ''),
            at: Number(value.at) || 0,
            // 手填标记：只用来在统计和清单里说清「这条是你自己写的」，判定时和 LLM 写的没区别
            ...(value.m ? { m: 1 } : {}),
        };
    }
    return index;
}
/** 索引相关的数值设置，非法/空白一律回默认 */
export function readIndexNumbers(setting = {}) {
    const num = (value, fallback) => {
        if (value === '' || value === null || value === undefined) return fallback;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    };
    return {
        summaryLimit: Math.max(20, Math.floor(num(setting.decision_index_summary_limit, INDEX_DEFAULTS.summaryLimit))),
        contentLimit: Math.max(200, Math.floor(num(setting.decision_index_content_limit, INDEX_DEFAULTS.contentLimit))),
        batchSize: Math.max(1, Math.min(INDEX_MAX_BATCH_SIZE, Math.floor(num(setting.decision_index_batch_size, INDEX_DEFAULTS.batchSize)))),
        batchChars: Math.max(500, Math.floor(num(setting.decision_index_batch_chars, INDEX_DEFAULTS.batchChars))),
    };
}

/**
 * 一条条目在建索引那趟里占多少字
 * @description 口径跟 buildIndexPrompt 发出去的那一段一致：标题＋关键词＋正文（正文按「读条目正文上限」截）。
 * @description 用它切批，切出来的批才不会跟实际请求长度脱节。
 * @param {object} entry 世界书条目
 * @param {{contentLimit?: number}} options
 * @returns {number}
 */
export function indexEntryCost(entry, options = {}) {
    const contentLimit = options.contentLimit ?? INDEX_DEFAULTS.contentLimit;
    const body = String(entry?.content ?? '').replace(/\s+/g, ' ').trim();
    const keys = keysOf(entry);
    // 12 = 「N. 标题：」「｜关键词：」「\n正文：」这些固定字和条目间空行的量级
    return entryTitle(entry).length + keys.length + Math.min(body.length, contentLimit) + 12;
}

/**
 * 按「单批字数限制」切批，「单批条数上限」当第二道硬顶，谁先到算谁
 * @description 为什么以字数为主：条目长短差几十倍（一句道具 vs 三千字的人物设定），
 * @description 按条数切的话，短条目一批浪费一次请求、长条目一批塞进几万字。
 * @description 一条就超字数限制时它单独成批 —— 不能出现空批，否则那条永远建不上索引。
 * @param {Array} queue 待建索引的条目
 * @param {{batchChars?: number, batchSize?: number, contentLimit?: number}} numbers readIndexNumbers 的结果
 * @returns {Array<Array>}
 */
export function packIndexBatches(queue, numbers = {}) {
    const maxEntries = Math.max(1, Math.floor(numbers.batchSize || 1));
    const maxChars = Math.max(1, Math.floor(numbers.batchChars || 0));
    const batches = [];
    let current = [];
    let chars = 0;
    for (const entry of queue || []) {
        const cost = indexEntryCost(entry, numbers);
        if (current.length && (current.length >= maxEntries || chars + cost > maxChars)) {
            batches.push(current);
            current = [];
            chars = 0;
        }
        current.push(entry);
        chars += cost;
    }
    if (current.length) batches.push(current);
    return batches;
}

/** 严格判真：默认值已经是开着（这一份插件以索引档为主、原文为补充），只有明确勾掉才关 */
export function decisionIndexEnabled(setting = {}) {
    return setting.decision_index_enabled === true;
}

/** 分类名 → 分类 id，认不出回「其他」。容忍多余空格和大小写差 */
export function resolveTypeId(types, name) {
    const want = String(name ?? '').trim().replace(/[「」【】\s]/g, '');
    if (!want) return DECISION_OTHER_TYPE_ID;
    const hit = (types || []).find(type => String(type.name ?? '').trim().replace(/[「」【】\s]/g, '') === want);
    if (hit) return hit.id;
    const byId = (types || []).find(type => String(type.id ?? '') === String(name ?? '').trim());
    return byId ? byId.id : DECISION_OTHER_TYPE_ID;
}
/**
 * 有索引时的条目摘要：标题｜关键词｜LLM 摘要
 * @param {object} entry
 * @param {{s:string}} record
 * @param {number} summaryLimit
 * @returns {string}
 * @description 关键词仍然带着：摘要负责「这条讲的是什么」，关键词负责「剧情里哪些词会牵到它」，
 * @description 两者不重复，而关键词最多 12 个，花不了几个字。
 */
export function indexedDigest(entry, record, summaryLimit = INDEX_DEFAULTS.summaryLimit) {
    const limit = Math.max(20, Math.floor(Number(summaryLimit) || INDEX_DEFAULTS.summaryLimit));
    let summary = String(record?.s ?? '').replace(/\s+/g, ' ').trim();
    if (summary.length > limit) summary = `${summary.slice(0, limit)}…`;
    const keys = keysOf(entry);
    return [entryTitle(entry), keys ? `关键词：${keys}` : '', summary].filter(Boolean).join('｜');
}

/**
 * 生成决策请求用的「材料选择器」：每个条目该用什么摘要、该用哪一类的问法
 * @param {{enabled:boolean, index?:object, types?:Array, summaryLimit?:number, globalTemplate?:string}} options
 * @returns {(entry: object) => ({digest:string, template:string, typeId:string, typeName:string, indexed:true}|null)}
 * @description 开关关着时整趟返回 null，buildQuestions 走的就是以前那条路，一个字都不差。
 * @description 没建过索引的条目也返回 null = 退回正文片段 + 通用问法，判得照样判，只是照旧宽泛。
 */
export function createMaterialResolver(options = {}) {
    if (options.enabled !== true) return () => null;
    const index = options.index || {};
    const types = options.types || [];
    const summaryLimit = options.summaryLimit ?? INDEX_DEFAULTS.summaryLimit;
    const globalTemplate = String(options.globalTemplate ?? '');
    return (entry) => {
        const record = index[indexKey(entry?.world, entry?.uid)];
        if (!record || !record.s) return null;
        const typeId = types.some(type => type.id === record.t) ? record.t : DECISION_OTHER_TYPE_ID;
        const type = types.find(item => item.id === typeId) || {};
        const instruction = String(type.instruction ?? '').trim();
        return {
            digest: indexedDigest(entry, record, summaryLimit),
            // 这一类没写问法就用上面的通用判定问法，别让一个空框把整条判成同一句话
            template: instruction || globalTemplate,
            typeId,
            typeName: type.name || DECISION_OTHER_TYPE_ID,
            indexed: true,
        };
    };
}
/**
 * 算这一趟要问哪些条目：内容没变的不重算，变了或没索引过的才问
 * @param {Array} entries 当前会被决策路由当候选的条目（已按同一份口径过滤）
 * @param {object} index normalizeIndex 的结果
 * @param {Array} types normalizeTypes 的结果
 * @returns {{total:number, todo:Array, fresh:number, reclassify:Array, stale:Array, missing:number}}
 * @description reclassify 是「内容没变、但它那一类被用户删了」的条目：它们的摘要还能用，
 * @description 只是分类失效了，判定时自动算「其他」，所以不重算也不丢判定，只给一个单独的按钮去重问。
 */
export function planIndex(entries = [], index = {}, types = []) {
    const validIds = new Set((types || []).map(type => type.id));
    const liveKeys = new Set();
    const todo = [];
    const reclassify = [];
    let fresh = 0;
    for (const entry of entries || []) {
        const key = indexKey(entry.world, entry.uid);
        liveKeys.add(key);
        const record = index[key];
        if (!record) { todo.push(entry); continue; }
        if (record.h !== entryFingerprint(entry)) { todo.push(entry); continue; }
        if (!validIds.has(record.t)) { reclassify.push(entry); continue; }
        fresh++;
    }
    const stale = Object.keys(index).filter(key => !liveKeys.has(key));
    return { total: (entries || []).length, todo, fresh, reclassify, stale, missing: todo.length };
}
/**
 * 渲染建索引那趟的用户提示词
 * @param {string} template 用户模板，空则用内置
 * @param {{types:string, count:string, entries:string, limit:string, otherName:string}} vars
 * @returns {string}
 * @description 模板里没 {entries} 等于根本没把条目喂进去，模型只会复述分类表 —— 自动补在末尾，
 * @description 免得设置写错之后整趟请求白花。未知占位符原样留着，方便发现拼错。
 */
export function renderIndexPrompt(template, vars = {}) {
    let tpl = String(template || '').trim();
    if (!tpl) tpl = DEFAULT_INDEX_TEMPLATE;
    if (!tpl.includes('{entries}')) tpl = `${tpl}\n\n【条目】\n{entries}`;
    return tpl.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? vars[name] : match));
}

/**
 * 拼一批条目的摘要请求
 * @param {Array} entries 这一批（本批内编号从 1 开始，回行的 id 就按它对号）
 * @param {{types?:Array, summaryLimit?:number, contentLimit?:number, template?:string}} options
 * @returns {{system:string, user:string, labels:Array<string>}}
 * @description 正文要给足：这一趟的目的就是把长条目读明白，只给前 120 字等于白摘要。
 * @description 但也不能无限长，超出 contentLimit 会截断并在 labels 里标出来，让用户知道是哪几条。
 */
export function buildIndexPrompt(entries = [], options = {}) {
    const types = options.types || [];
    const summaryLimit = options.summaryLimit ?? INDEX_DEFAULTS.summaryLimit;
    const contentLimit = options.contentLimit ?? INDEX_DEFAULTS.contentLimit;
    const other = types.find(type => type.id === DECISION_OTHER_TYPE_ID) || { name: '其他' };
    const truncated = [];
    const blocks = (entries || []).map((entry, index) => {
        let body = String(entry?.content ?? '').replace(/\s+/g, ' ').trim();
        if (body.length > contentLimit) {
            truncated.push(entryTitle(entry));
            body = `${body.slice(0, contentLimit)}…（正文过长，已截断）`;
        }
        const keys = keysOf(entry);
        return `${index + 1}. 标题：${entryTitle(entry)}${keys ? `｜关键词：${keys}` : ''}\n正文：${body}`;
    });
    const typeNames = types.map(type => `${type.name}`).join('、');
    const system = String(options.systemPrompt ?? '').trim() || DEFAULT_INDEX_SYSTEM_PROMPT;
    const custom = String(options.template ?? '').trim();
    const user = renderIndexPrompt(custom, {
        types: typeNames,
        count: String(blocks.length),
        entries: blocks.join('\n\n'),
        limit: String(summaryLimit),
        otherName: other.name,
    });
    return { system, user, labels: truncated };
}
/**
 * 把模型的回行解析成 { id, summary, type }
 * @param {string} text
 * @returns {{items:Array, bad:number}}
 * @description 一行一条 JSON 是最理想的，但模型会加编号、加代码围栏、甚至写成「1. {...}」，
 * @description 所以只抓每行里第一段 {...} 来 parse；parse 不动再退回到按字段抠。
 */
export function parseIndexLines(text) {
    const lines = String(text ?? '')
        .replace(/```[a-zA-Z]*/g, '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line !== '');
    const items = [];
    let bad = 0;
    for (const line of lines) {
        const json = line.match(/\{[\s\S]*?\}/);
        let obj = null;
        if (json) {
            try { obj = JSON.parse(json[0]); } catch (error) { obj = null; }
        }
        if (!obj) {
            const id = line.match(/"(?:id|uid|编号)"\s*[:：]\s*"?(\d+)/);
            const summary = line.match(/"summary"\s*[:：]\s*"([^"]*)"/);
            const type = line.match(/"type"\s*[:：]\s*"([^"]*)"/);
            if (!id || !summary) { bad++; continue; }
            obj = { id: Number(id[1]), summary: summary[1], type: type ? type[1] : '' };
        }
        const id = Number(obj.id ?? obj.uid ?? obj['编号']);
        const summary = String(obj.summary ?? '').replace(/\s+/g, ' ').trim();
        if (!Number.isFinite(id) || summary === '') { bad++; continue; }
        items.push({ id, summary, type: String(obj.type ?? '').trim() });
    }
    return { items, bad };
}
/**
 * 把一批的解析结果并回索引
 * @param {object} index 直接改这个对象（调用方负责存盘）
 * @param {Array} entries 这一批的条目，顺序就是提示词里的编号
 * @param {Array<{id:number, summary:string, type:string}>} items
 * @param {{types?:Array, now?:number}} options
 * @returns {{written:number, failed:Array<{label:string, reason:string}>, otherType:number}}
 * @description 只认本批编号：模型回个越界 id、或干脆漏了某条，那条就进 failed 清单，
 * @description 索引保持原样（有旧记录就用旧的），下次点按钮还会再问它。
 */
export function mergeIndexResults(index, entries = [], items = [], options = {}) {
    const types = options.types || [];
    const now = options.now ?? Date.now();
    const byId = new Map();
    for (const item of items || []) byId.set(Number(item.id), item);
    let written = 0;
    let otherType = 0;
    const failed = [];
    (entries || []).forEach((entry, position) => {
        const item = byId.get(position + 1);
        if (!item) { failed.push({ label: entryTitle(entry), reason: '模型没回这一条（编号对不上或漏行）' }); return; }
        const summary = String(item.summary ?? '').replace(/\s+/g, ' ').trim();
        if (!summary) { failed.push({ label: entryTitle(entry), reason: '摘要为空' }); return; }
        const typeId = resolveTypeId(types, item.type);
        if (typeId === DECISION_OTHER_TYPE_ID && String(item.type).trim() !== (types.find(t => t.id === DECISION_OTHER_TYPE_ID) || {}).name) otherType++;
        index[indexKey(entry.world, entry.uid)] = { s: summary, t: typeId, h: entryFingerprint(entry), at: now };
        written++;
    });
    return { written, failed, otherType };
}
/**
 * 决策路由的候选口径：带关键词、没被关闭、非常驻、没被 @@activate 钉住
 * @param {Array} entries getSortedEntries 的结果
 * @returns {Array}
 * @description 建索引和判定时都调这一个函数，免得两处口径漂开——索引里少一条，那条就永远用不上摘要。
 */
export function filterDecisionEntries(entries) {
    return (entries || []).filter(entry =>
        !entry.disable &&
        !entry.constant &&
        Array.isArray(entry.key) && entry.key.length > 0 &&
        !(entry.decorators || []).some(decorator => String(decorator).includes('activate'))
    );
}

/**
 * 当前该建索引的条目（启用中的世界书 + 上面那份过滤，不按「候选上限」截断）
 * @returns {Promise<Array>}
 * @description 不截断：索引是一次性的，把 60 条上限套上来会导致第 61 条永远建不起索引。
 * @description getSortedEntries 只包含选中且启用的书，所以「只索引启用中的世界书」天然成立。
 */
export async function collectIndexableEntries() {
    return filterDecisionEntries(await getSortedEntries());
}
/**
 * 用插件自带的两套 API 通道发一次条目摘要请求
 * @param {string} system
 * @param {string} user
 * @returns {Promise<string|null>} 拿不到文本回 null（被中止、只回了思考内容）；请求本身失败把异常原样抛上去，
 * 好让失败清单写的是「请求失败：401」而不是含糊的「可能拒答」
 */
async function askIndex(system, user) {
    const setting = USER.store || {};
    const useMain = setting.decision_index_use_main_api ?? true;
    beginReply({
        purpose: '条目索引',
        apiType: useMain ? 'main' : 'custom',
        model: useMain ? '' : (USER.privacy.custom_model_name || ''),
        promptText: `${system}\n\n【本次请求】\n${user}`,
    });
    let raw = null;
    try {
        raw = useMain
            ? await handleMainAPIRequest(system, user, false)
            : await handleCustomAPIRequest(system, user, false);
    } catch (error) {
        finishReply({ error: String(error?.message || error) });
        throw error;
    }
    finishReply({ rawContent: String(raw ?? '') });
    return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
}

/** 一次建索引的进度回调：{done, total, written, failed} */
function reportProgress(onProgress, state) {
    if (typeof onProgress !== 'function') return;
    try { onProgress(state); } catch (error) { console.error('[条目索引] 进度回调出错', error); }
}

// 重入保护：建索引是手动按钮，双开等于同一个条目问两遍、还互相覆盖
let indexRunning = false;

/** 现在是不是正在建索引（设置页的按钮要按这个变灰） */
export function isIndexRunning() {
    return indexRunning;
}
/**
 * 建/更新条目索引（只有填写弹窗里的按钮会走到这里，绝不自动发请求）
 * @param {{scope?:'missing'|'reclassify'|'all', keys?:Array<string>, onProgress?:Function}} options
 *        missing = 只问「没索引过」或「内容改过」的；reclassify = 只重问「那一类被删了」的；
 *        all = 全部重问（连你手写的、内容没变的也重摘要，会被盖掉）；keys = 只问这些键（弹窗里勾中的行）
 * @returns {Promise<{asked:number, written:number, failed:Array, stale:number, skipped:number}|null>}
 */
export async function buildEntryIndex(options = {}) {
    const scope = ['reclassify', 'all'].includes(options.scope) ? options.scope : 'missing';
    if (indexRunning) {
        EDITOR.warning('已经在建索引了，等这一趟跑完再点。');
        return null;
    }
    const setting = USER.store || {};
    const numbers = readIndexNumbers(setting);
    const types = normalizeTypes(setting.decision_entry_types);
    const index = normalizeIndex(setting.decision_entry_index);
    const entries = await collectIndexableEntries();
    const plan = planIndex(entries, index, types);
    // 勾中的即使内容没变也重问：不然勾了却没动静，看着像按钮坏了
    const picked = Array.isArray(options.keys) && options.keys.length ? new Set(options.keys.map(String)) : null;
    const queue = picked ? entries.filter(entry => picked.has(indexKey(entry.world, entry.uid)))
        : scope === 'all' ? entries
        : scope === 'reclassify' ? plan.reclassify
        : plan.todo;
    // 「跳过多少条」只在补没填的那一档成立：全填和勾中的都是照问不误
    const skipped = picked || scope !== 'missing' ? 0 : plan.fresh;
    if (!queue.length) {
        EDITOR.info(picked ? '勾中的条目这一屏已经不在了（刚筛选过？），没发请求。'
            : scope === 'reclassify' ? '没有分类失效的条目（被删掉的那一类下面没有条目），没发请求。'
            : `该建索引的 ${plan.total} 条都已经建好且内容没变，没发请求。要重来一遍就点「让 LLM 全填」。`);
        return { asked: 0, written: 0, failed: [], stale: plan.stale.length, skipped };
    }
    const customTemplate = String(setting.decision_index_template ?? '').trim();
    if (customTemplate && !customTemplate.includes('{entries}')) {
        EDITOR.warning('建索引的提示词里没有 {entries}（条目正文），插件已自动把它补在末尾。请检查模板是否漏写。');
    }
    indexRunning = true;
    const now = () => Date.now();
    const batches = packIndexBatches(queue, numbers);
    let done = 0;
    let written = 0;
    const failed = [];
    try {
        for (const batch of batches) {
            const prompt = buildIndexPrompt(batch, {
                types,
                summaryLimit: numbers.summaryLimit,
                contentLimit: numbers.contentLimit,
                systemPrompt: setting.decision_index_system_prompt,
                template: customTemplate,
            });
            for (const label of prompt.labels) {
                failed.push({ label, reason: `正文超过 ${numbers.contentLimit} 字，只摘了前半段` });
            }
            let raw = null;
            try {
                raw = await askIndex(prompt.system, prompt.user);
            } catch (error) {
                raw = null;
                console.error('[条目索引] 请求失败', error);
                batch.forEach(entry => failed.push({ label: entryTitle(entry), reason: `请求失败：${error?.message ?? error}` }));
            }
            if (raw) {
                const parsed = parseIndexLines(raw);
                if (!parsed.items.length) {
                    // 整批没解析出行：多半是拒答。世界书条目里带露骨描写时这很常见，
                    // 所以这不算「这条目没救」，只写清原因，摘要和旧记录都不动。
                    const reason = parsed.bad ? `整批 ${parsed.bad} 行都解析不了（可能拒答，或没按 JSON 行回）` : '模型没回任何内容行（可能拒答）';
                    batch.forEach(entry => failed.push({ label: entryTitle(entry), reason }));
                } else {
                    const merged = mergeIndexResults(index, batch, parsed.items, { types, now: now() });
                    written += merged.written;
                    failed.push(...merged.failed);
                }
            }
            // 每批之后都存一次盘：中途刷新页面丢的只是还没跑的那几批
            USER.store.decision_entry_index = index;
            USER.store.decision_index_at = now();
            USER.saveSettings && USER.saveSettings();
            done += batch.length;
            reportProgress(options.onProgress, { done, total: queue.length, written, failed: failed.length });
        }
        const after = planIndex(await collectIndexableEntries(), index, types);
        return { asked: queue.length, written, failed, stale: after.stale.length, skipped };
    } finally {
        indexRunning = false;
    }
}
/**
 * 每一类下挂着多少条索引记录
 * @description 分类被删掉的记录并进「其他」那一列：判定时它们走的就是「其他」的问法，账要按判法记
 * @param {Array} types normalizeTypes 的结果
 * @param {object} index normalizeIndex 的结果
 * @returns {Array<{id:string, name:string, count:number}>} 顺序跟 types 一致
 */
export function countIndexByType(types = [], index = {}) {
    const validIds = new Set((types || []).map(type => type.id));
    const counts = new Map((types || []).map(type => [type.id, 0]));
    for (const record of Object.values(index || {})) {
        const id = validIds.has(record?.t) ? record.t : DECISION_OTHER_TYPE_ID;
        counts.set(id, (counts.get(id) || 0) + 1);
    }
    return (types || []).map(type => ({ id: type.id, name: type.name, count: counts.get(type.id) || 0 }));
}

/**
 * 索引概况（只读，不发请求）
 * @param {object} setting
 * @returns {{records:number, byType:Array<{name:string, count:number}>, invalid:number, manual:number, lastAt:number}}
 */
export function indexOverview(setting = USER.store || {}) {
    const types = normalizeTypes(setting.decision_entry_types);
    const index = normalizeIndex(setting.decision_entry_index);
    const records = Object.values(index);
    const lastAt = records.reduce((max, record) => Math.max(max, record.at || 0), 0);
    return {
        records: Object.keys(index).length,
        byType: countIndexByType(types, index).filter(item => item.count > 0).map(item => ({ name: item.name, count: item.count })),
        invalid: records.filter(record => !types.some(type => type.id === record.t)).length,
        manual: records.filter(record => record.m).length,
        lastAt,
    };
}

/**
 * 清掉「条目已经不在了」的索引记录（删了条目、关了世界书都会留尾巴）
 * @returns {Promise<{removed:number, kept:number}|null>} 没有尾巴时返回 {removed:0}
 */
export async function pruneStaleIndex() {
    const setting = USER.store || {};
    const index = normalizeIndex(setting.decision_entry_index);
    const plan = planIndex(await collectIndexableEntries(), index, normalizeTypes(setting.decision_entry_types));
    if (!plan.stale.length) {
        EDITOR.info('索引里没有失效项，没改动。');
        return { removed: 0, kept: Object.keys(index).length };
    }
    for (const key of plan.stale) delete index[key];
    USER.store.decision_entry_index = index;
    USER.saveSettings && USER.saveSettings();
    EDITOR.success(`已清掉 ${plan.stale.length} 条失效索引记录，剩下 ${Object.keys(index).length} 条。`);
    return { removed: plan.stale.length, kept: Object.keys(index).length };
}
export function editorText(value) {
    return String(value ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/**
 * 索引统计弹窗：每一类多少条、还差多少条没建、有多少条要清
 * @returns {Promise<void>}
 */
export async function showIndexReport() {
    const setting = USER.store || {};
    const numbers = readIndexNumbers(setting);
    const types = normalizeTypes(setting.decision_entry_types);
    const index = normalizeIndex(setting.decision_entry_index);
    const plan = planIndex(await collectIndexableEntries(), index, types);
    const overview = indexOverview(setting);
    const instructionOf = new Map(types.map(type => [type.id, String(type.instruction ?? '').trim()]));
    const rows = countIndexByType(types, index)
        .map(item => `<tr><td>${editorText(item.name)}</td><td class="decision-index-count">${item.count}</td><td>${editorText(instructionOf.get(item.id) || '（用通用判定问法）')}</td></tr>`)
        .join('');
    const summary = [
        `当前该建索引的条目 ${plan.total} 条（启用中的世界书、带关键词、非常驻、没被 @@ 钉住）`,
        `已建好且内容没变 ${plan.fresh} 条`,
        `要新建或重摘要 ${plan.todo.length} 条`,
        overview.manual ? `其中你手填了 ${overview.manual} 条` : '',
        plan.reclassify.length ? `分类失效（那一类被你删了）${plan.reclassify.length} 条，判定时先按「${(types.find(t => t.id === DECISION_OTHER_TYPE_ID) || {}).name || '其他'}」走` : '',
        plan.stale.length ? `条目已经不在了 ${plan.stale.length} 条，可用「清理失效项」删掉` : '',
        `条目摘要字数限制 ${numbers.summaryLimit}｜单批最多送 ${numbers.batchChars} 字（也不超过 ${numbers.batchSize} 条）｜条目正文最多读 ${numbers.contentLimit} 字`,
        overview.lastAt ? `最后一条写于 ${new Date(overview.lastAt).toLocaleString()}` : '还没建过索引',
    ].filter(Boolean);
    const html = `
<div class="wide100p padding5" style="display:flex;flex-direction:column;gap:8px;">
    <div class="decision-report-meta">${editorText(summary.join('　|　'))}</div>
    ${plan.todo.length === 0 && plan.reclassify.length === 0 ? '<small class="toggle-description justifyLeft">索引已经是最新的，这一轮不用发请求。要整个重来，到「填写条目索引」里点「让 LLM 全填」（会盖掉你手写的）。</small>' : ''}
    <table class="decision-index-table">
        <thead><tr><th>分类</th><th style="width:60px">条目数</th><th>这一类的判定问法</th></tr></thead>
        <tbody>${rows}</tbody>
    </table>
    <small class="toggle-description justifyLeft">索引只决定「怎么问」：条目被强制注入时发的还是完整正文，不会因为摘要短就少注入内容。</small>
</div>
<style>
    .decision-report-meta { color: var(--SmartThemeEmColor); font-size: 12px; text-align: left; }
    .decision-index-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .decision-index-table th, .decision-index-table td { border-bottom: 1px solid var(--SmartThemeBorderColor); padding: 3px 6px; text-align: left; vertical-align: top; }
    .decision-index-count { width: 60px; text-align: right; font-family: var(--mainFixedWidthFont, monospace); }
</style>`;
    await new EDITOR.Popup(html, EDITOR.POPUP_TYPE.TEXT, '', {
        large: true, wide: true, allowVerticalScrolling: true, okButton: '关闭',
    }).show();
}
/**
 * 一趟 LLM 摘要之后的结果，嵌在填写弹窗里显示（不套第二层弹窗）
 * @param {{asked:number, written:number, failed:Array<{label:string, reason:string}>, stale:number, skipped:number}} result
 * @returns {string}
 * @description 失败清单必须逐个点名：拒答是整批发生的，不列出来用户只会觉得「某些条目就是不灵」
 * @description 折叠着放：成功的那一趟不该被一大段日志挡住下面的条目行。
 */
export function indexOutcomeHtml(result) {
    const failed = result?.failed || [];
    const rows = failed.map(item => `<tr><td>${editorText(item.label)}</td><td>${editorText(item.reason)}</td></tr>`).join('');
    const head = `这一趟问了 ${result?.asked ?? 0} 条：写入 ${result?.written ?? 0} 条，失败 ${failed.length} 条`
        + `${result?.skipped ? `，另有 ${result.skipped} 条内容没变所以没重问` : ''}。`;
    return `
<div class="manual-index-outcome-text">
    <div>${editorText(head)}</div>
    ${result?.stale ? `<div>另有 ${result.stale} 条索引记录对应的条目已经不在了（删了条目或关了世界书），可用「清理失效项」删掉，留着不影响判定。</div>` : ''}
    ${failed.length ? `<details><summary>失败的 ${failed.length} 条：为什么没写进去</summary><table class="manual-index-fail-table"><thead><tr><th>条目</th><th>为什么没写进去</th></tr></thead><tbody>${rows}</tbody></table><div>失败的那些条目索引没动过（有旧摘要就继续用旧的），再点一次「让 LLM 补没填的」会只问这些没成功的。</div></details>` : ''}
</div>`;
}

/** 新增分类用的 id：只用一次（时间戳+随机），改名、删了再建都不会撞已存记录的账 */
export function makeTypeId() {
    return `c${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

/**
 * 手填时的参考模板：每一类该写什么 + 一条范例
 * @description 措辞按分类分开，是因为判定时每一类问的本来就不是同一件事（问人物「是否出场」、问规则「是否在管辖范围」）
 * @description 口径（2026-10-11 选 A）：每一类都**先写触发时机**再写它是什么——这句是给「要不要注入」的判定读的。
 */
export const MANUAL_INDEX_GUIDE = [
    '先弄清这句是干什么的：世界书原文平时不发给 AI，每轮由一个判断模型只看你写的这句，决定这一条要不要注入系统提示词（当作背景设定或写作规范）。所以写的是「这一条的用处说明」，不是剧情概括。',
    '顺序：这是什么（类型＋名字／关系）→ 一个主触发（这一类判定问的那件事）→ 现在什么状态。一到两句，别只复述标题。',
    '主触发只写一个：人物写「登场或被提及时」就够了，别罗列「出场、独处、被忽略、身体描写时」——判定问的就是一件事，罗列只会把名字和关系挤掉。也别写「相关时使用」「需要的时候」这种空话，那等于没写。',
    '- 人物：这是谁的角色设定｜登场或被提及时。例：老周的人物设定（主角的师父，两人已断绝来往）｜他登场或被提及时',
    '- 地点：这是什么地方｜剧情发生在这里或即将前往时。例：海边废弃灯塔（门已塌）｜剧情移到海边或有人提到它时',
    '- 道具：它是什么、现在在谁手上｜被使用、看到或提及时。例：会说话的旧铁剑（主角随身，替主角挡过一次箭）｜这件东西出现或被提及时',
    '- 事件：何时何地发生了什么、后果｜正在经历或回顾这件事时。例：10-03 夜里酒馆被搜，主角藏起信件，老板娘因此被怀疑｜谈到被搜一事或被牵连时',
    '- 组织势力：是什么组织、与主角什么关系｜涉及它或受它管辖时。例：城卫队（正在通缉主角，管到酒馆一带）｜卫兵出现或被通缉牵涉时',
    '- 设定规则：规则内容是什么｜落在它管辖范围时。例：入水会留下印记，被标过的人无法说谎｜角色入水或被印记标过时',
    '- 其他：一句话说清这是什么、什么时候用得上。',
].join('\n');

/**
 * 写一条手填记录（一个字都不发请求）
 * @param {object} entry
 * @param {string} summary
 * @param {string} typeId
 * @param {{now?:number}} [options]
 * @returns {{record:object|null, reason:string}}
 * @description 指纹按「当前正文」算：这样 LLM 那一趟认为内容没变，不会来覆盖你写的；等你改了条目正文才会重问
 * @description 分类只认现有分类，认不出的一律落「其他」，免得手滑写出一个没有问法的类
 */
export function saveManualIndex(entry, summary, typeId, options = {}) {
    const text = String(summary ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return { record: null, reason: '摘要那格是空的，先写一句再保存。' };
    const setting = USER.store || {};
    const types = normalizeTypes(setting.decision_entry_types);
    const index = normalizeIndex(setting.decision_entry_index);
    const record = {
        s: text,
        t: (types || []).some(type => type.id === typeId) ? typeId : DECISION_OTHER_TYPE_ID,
        h: entryFingerprint(entry),
        at: options.now ?? Date.now(),
        m: 1,
    };
    index[indexKey(entry?.world, entry?.uid)] = record;
    setting.decision_entry_index = index;
    USER.saveSettings && USER.saveSettings();
    return { record, reason: '' };
}

/**
 * 删掉某一条索引记录（手填的和 LLM 写的都能删）
 * @param {string} world
 * @param {number|string} uid
 * @returns {boolean} 有没有真删掉东西
 */
export function clearIndexRecord(world, uid) {
    const setting = USER.store || {};
    const index = normalizeIndex(setting.decision_entry_index);
    const key = indexKey(world, uid);
    if (!index[key]) return false;
    delete index[key];
    setting.decision_entry_index = index;
    USER.saveSettings && USER.saveSettings();
    return true;
}

// ---- 索引文件的导出 / 导入（纯本机操作，一个请求都不发）----

/** 文件里认这个标识：不是「填写条目索引」导出的 JSON 一律拒绝，免得把别的文件当索引灌进设置 */
export const INDEX_FILE_KIND = 'st-memory-enhancement.decision_index';
export const INDEX_FILE_VERSION = 1;

/**
 * 打包一份索引文件内容
 * @param {object} setting
 * @returns {object}
 * @description 分类表要一起带上：只搬索引的话，换到别的机器上每条的分类都可能认不出来，
 * @description 判定照样能跑（认不出的落「其他」），但那一类自己写的问法就丢了。
 */
export function buildIndexExport(setting = USER.store || {}) {
    return {
        kind: INDEX_FILE_KIND,
        version: INDEX_FILE_VERSION,
        exported_at: Date.now(),
        types: normalizeTypes(setting.decision_entry_types).map(type => ({ id: type.id, name: type.name, instruction: type.instruction })),
        index: normalizeIndex(setting.decision_entry_index),
    };
}

/** 文件名：时间戳后缀，导多次不互相盖（下载目录里能按时间挑） */
export function indexFileName(now = Date.now()) {
    const date = new Date(now);
    const pad = (value) => String(value).padStart(2, '0');
    return `decision-index-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.json`;
}

/**
 * 从读回来的对象里挑出索引映射
 * @param {object} data
 * @returns {object|null}
 * @description 认两种写法：官方的 `{ kind, index: {...} }`，以及免费 AI 常犯的「顶层直接就是
 * @description `书名::uid` 那张映射」（少写一层外壳）。要求至少一个键带 `::`，
 * @description 这样别的项目里的同名 `index` 字段不会被当成索引。
 */
export function pickIndexMap(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const nested = data.index && typeof data.index === 'object' ? normalizeIndex(data.index) : null;
    if (nested && Object.keys(nested).some(key => key.includes('::'))) return nested;
    const flat = normalizeIndex(data);
    return Object.keys(flat).some(key => key.includes('::')) ? flat : null;
}

/**
 * 把网页 AI 爱加的包装剥掉，只留最外层那个 JSON 对象
 * @param {string} text
 * @returns {string|null}
 * @description 免费聊天 AI 基本不会只回裸 JSON：常见是 ```json 围栏，或者前后各说两句客气话。
 * @description 这里先把围栏里的内容取出来，再取第一个 `{` 到最后一个 `}`，剩下的交给 JSON.parse。
 */
export function extractJsonObject(text) {
    const raw = String(text ?? '');
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    const body = fenced ? fenced[1] : raw;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    return body.slice(start, end + 1);
}

/**
 * 读回来的文件 → 能用的记录
 * @param {string} text 文件全文
 * @returns {{ok:boolean, reason?:string, index?:object, types?:Array, count?:number, tolerant?:boolean}}
 * @description 逐条走 normalizeIndex：空摘要、形状不对的记录在这里就被丢掉，
 * @description 所以 count 是「真能用的条数」，不是文件里写了多少条。
 * @description **文件名不参与任何判断**：只看内容里的标识。标识缺失但形状对得上也照用（tolerant），
 * @description 因为免费 AI 十次里有一次会漏抄 `kind` 那一行。
 */
export function parseIndexFile(text) {
    const jsonText = extractJsonObject(text);
    if (jsonText === null) return { ok: false, reason: '这个文件里没找到一个 JSON 对象（连 `{` 都没有），一个字都没动。' };
    let data = null;
    try {
        data = JSON.parse(jsonText);
    } catch (error) {
        return { ok: false, reason: `这个文件读不出 JSON：${error.message}` };
    }
    const marked = !!data && typeof data === 'object' && data.kind === INDEX_FILE_KIND;
    const index = pickIndexMap(data);
    if (!marked && !index) {
        return { ok: false, reason: '这个文件不是「填写条目索引」导出的（既没认到它的标识，键也不是「世界书名::条目号」那种形状），一个字都没动。' };
    }
    if (Number(data.version ?? 1) > INDEX_FILE_VERSION) {
        return { ok: false, reason: `文件是更插件版本导出的（v${data.version} 比现在的 v${INDEX_FILE_VERSION} 新），先更新插件再导入。` };
    }
    if (!index) return { ok: false, reason: '文件里没有一条能用的摘要（全是空的或者形状不对），一个字都没动。' };
    const count = Object.keys(index).length;
    if (!count) return { ok: false, reason: '文件里没有一条能用的摘要（全是空的或者形状不对），一个字都没动。' };
    const types = Array.isArray(data.types) ? data.types.filter(item => item && typeof item === 'object') : [];
    return { ok: true, index, types, count, tolerant: !marked };
}

/**
 * 合并进本机索引
 * @param {object} current 本机现有索引
 * @param {object} incoming 文件里的索引
 * @param {{overwrite?:boolean, knownKeys?:Set}} options overwrite=连本机已有的（含你手写的）一起盖掉
 * @returns {{index:object, added:number, updated:number, skipped:number, manualConflicts:number, foreign:number}}
 * @description 默认只补本机空着的：手填的那部分是逐条保存下来的，不能被一份旧文件无声盖掉。
 * @description manualConflicts 是「本机已有且标着手填」的冲突数，确认条上要把它说出来。
 * @description foreign 是文件里那些不属于当前候选集的记录（别的世界书的），照样存进来，用得上时自然用得上。
 */
export function mergeImportedIndex(current, incoming, options = {}) {
    const target = normalizeIndex(current);
    const source = normalizeIndex(incoming);
    const overwrite = options.overwrite === true;
    const known = options.knownKeys;
    const result = { index: target, added: 0, updated: 0, skipped: 0, manualConflicts: 0, foreign: 0 };
    for (const [key, record] of Object.entries(source)) {
        const existing = target[key];
        if (known && !known.has(key)) result.foreign++;
        if (!existing) {
            target[key] = { ...record };
            result.added++;
            continue;
        }
        if (existing.m) result.manualConflicts++;
        if (!overwrite) {
            result.skipped++;
            continue;
        }
        // 手填标记跟着文件里那条走：盖成 LLM 版的还留着 m，统计就会说「这条是你写的」
        target[key] = { ...record };
        result.updated++;
    }
    return result;
}

/**
 * 落盘：合并索引，按需带上分类表
 * @param {object} setting
 * @param {object} parsed parseIndexFile 的返回
 * @param {{overwrite?:boolean, knownKeys?:Set}} options
 * @returns {object} mergeImportedIndex 的结果 + typesImported / typesSkipped
 * @description 分类表只在「本机这套还是内置默认」时才跟文件走（判据：设置里存的不是数组＝从没动过）。
 * @description 他已经改过分类的话，文件里那套不覆盖本机，认不出的分类在判定时自动落「其他」的问法。
 * @description 真写进新摘要时把趟号推到此刻：决策缓存键带着它，不推的话最多多用 30 秒旧摘要判出来的结果。
 */
export function applyImportedIndex(parsed, setting = USER.store || {}, options = {}) {
    const merged = mergeImportedIndex(setting.decision_entry_index, parsed.index, options);
    const typesTouched = Array.isArray(setting.decision_entry_types);
    let typesImported = false;
    if (!typesTouched && parsed.types.length) {
        const imported = normalizeTypes(parsed.types);
        if (JSON.stringify(imported) !== JSON.stringify(normalizeTypes([]))) {
            setting.decision_entry_types = imported;
            typesImported = true;
        }
    }
    setting.decision_entry_index = merged.index;
    if (merged.added || merged.updated) setting.decision_index_at = options.now ?? Date.now();
    USER.saveSettings && USER.saveSettings();
    return { ...merged, typesImported, typesSkipped: typesTouched };
}

/**
 * 导入后的概况（写在弹窗里，不另开弹窗）
 * @param {object} result applyImportedIndex 的结果
 * @param {{overwrite:boolean, fileName?:string}} info
 * @returns {string}
 */
export function indexImportOutcomeHtml(result, info = {}) {
    const fileName = info.fileName || '文件';
    const head = info.overwrite
        ? `已从「${fileName}」导入：新增 ${result.added} 条，覆盖 ${result.updated} 条（本机原有的按文件的盖掉了）。`
        : `已从「${fileName}」导入：新增 ${result.added} 条，本机已有的 ${result.skipped} 条没动。`;
    // 只在整句这一层转义一次：文件名里的 & 和尖括号是用户自己起的，套两层转义会显示成 &amp;lt; 这种乱码
    const escape = (text) => `<div>${editorText(text)}</div>`;
    return `
<div class="manual-index-outcome-text">
    ${escape(head)}
    ${info.tolerant ? escape('这份文件没写插件标识，但每条的键都是「世界书名::条目号」那种形状，照收了——文件名插件从来不看，随便叫什么。') : ''}
    ${result.foreign ? escape(`文件里另有 ${result.foreign} 条不属于现在这几本世界书，也一并存着了——以后挂上那本书就用得上。`) : ''}
    ${info.overwrite && result.manualConflicts ? escape(`其中你手写的 ${result.manualConflicts} 条被盖掉了，下次要改得重写。`) : ''}
    ${result.typesImported ? '<div>分类表也按文件里的内容改了（本机原来没动过分类表）。</div>' : ''}
    ${result.typesSkipped ? '<div>本机分类表你改过，文件里那套没有覆盖它；文件里认不出的分类，判定时按「其他」的问法走。</div>' : ''}
    ${escape(result.added || result.updated
        ? '下一句生成就会按新摘要重新判：导入把索引趟号推到此刻，之前那批旧判定当场作废。'
        : '这一份文件里的摘要本机都已经有了，判定依据一个字都没变。')}
</div>`;
}

/**
 * 把内容存成文件下载走（浏览器专属，离线路径不碰）
 * @param {object} payload
 * @param {string} fileName
 * @returns {number} 写出去的字符数
 */
export function downloadIndexFile(payload, fileName) {
    return downloadTextFile(JSON.stringify(payload, null, 2), fileName, 'application/json');
}

/**
 * 任意文本走浏览器下载（创作文件那一颗按钮用）
 * @param {string} text
 * @param {string} fileName
 * @param {string} [mime]
 * @returns {number} 写出去的字符数
 */
export function downloadTextFile(text, fileName, mime = 'text/plain') {
    const body = String(text ?? '');
    const url = URL.createObjectURL(new Blob([body], { type: mime }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // 马上回收的话，有些浏览器还没来得及把文件取走
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return body.length;
}

// ---- 「让别的 AI 替我写这份索引」：复制一段创作提示词，插件自己不花一分钱 ----

/**
 * 生成「给网页端免费 AI 的创作提示词」
 * @param {{entries?:Array, setting?:object, withBodies?:boolean}} options
 * @returns {string}
 * @description 关键设计：**清单里每条都预先算好 key 和 h**，AI 只负责填摘要和分类。
 * @description 键和指纹都由插件在本机算，AI 照抄——它既不知道书名怎么拼，也不该知道，
 * @description 抄错一条就对不上一个条目，所以这一段是「导入就能用」的全部保障。
 * @description withBodies=false（复制那棵树）：正文靠用户自己附上的角色卡/世界书文件，这段文字可以放心粘贴。
 * @description withBodies=true（导出成文件那一版）：正文由 buildIndexAuthoringFile 附在末尾，所以不再叫它去找卡文件。
 */
export function buildIndexAuthoringPrompt(options = {}) {
    const setting = options.setting ?? (USER.store || {});
    const numbers = readIndexNumbers(setting);
    const types = normalizeTypes(setting.decision_entry_types);
    const entries = Array.isArray(options.entries) ? options.entries : [];
    const withBodies = !!options.withBodies;
    const plainTypes = types.map(type => ({ id: type.id, name: type.name, instruction: type.instruction }));
    // 内置那七类插件自己就有，没必要让 AI 抄一遍；只有用户改过/加过类时才把 types 原文附上
    const customTypes = JSON.stringify(plainTypes) !== JSON.stringify(normalizeTypes([]).map(type => ({ id: type.id, name: type.name, instruction: type.instruction })));
    const skeleton = { kind: INDEX_FILE_KIND, version: INDEX_FILE_VERSION };
    if (customTypes) skeleton.types = plainTypes;
    const first = entries[0];
    skeleton.index = {
        [first ? indexKey(first.world, first.uid) : '书名::条目号']: {
            s: '这是什么（类型＋名字／关系）｜一个主触发（别罗列情况）｜现在什么状态',
            t: 'item',
            h: first ? entryFingerprint(first) : '清单里那条的 h，原样抄',
            at: 1,
        },
    };
    const typeLines = types.map(type => `- ${type.id}｜${type.name}`).join('\n');
    const listLines = entries.map((entry, i) => `${i + 1}. key="${indexKey(entry.world, entry.uid)}" h="${entryFingerprint(entry)}" 标题="${entryTitle(entry)}" 关键词="${keysOf(entry) || '（无）'}"`).join('\n');
    const bodyWhere = withBodies ? `【正文在哪里】
每条的完整正文就贴在这份文字的最末尾，一节一条，开头的「【正文 N】」和上面清单的编号一一对应。只读那一节的正文写摘要，我这次没有另外附角色卡文件。` : `【正文在哪里】
我这条消息一起给你的应该是一个角色卡文件，或者一份装着这批设定的 JSON 文件。设定条目在角色卡里看 data.character_book.entries，在另一份文件里看 entries：按清单里的「标题」和「关键词」找到对应那一条，读它的正文，再写摘要。`;
    const cantRead = withBodies ? '如果你打不开这份文件、或者看不到末尾的【条目正文】那一节，只回一句「看不到条目正文」，绝对不要凭标题编造摘要。'
        : '如果你读不到我附上的文件，只回一句「看不到条目正文」，绝对不要凭标题编造摘要。';
    return `【这份索引拿来干什么（先看这段再动笔）】
我给的这批条目是角色扮演／小说创作用的背景设定，一条写一个人物、地点、道具、事件、组织或规则。这些原文平时不会全发给写作的 AI，每轮挑出该用的那几条注入系统提示词，当作背景设定或写作规范。**你为条目写的这句 s 会被一个模型用来判断是否需要注入系统提示词**：它每轮只读你写的这一句，看不到条目原文，也不知道这些设定出自哪部作品。
所以 s 不是内容摘要，而是**这一条的用处说明**，按这个顺序写：这是什么（类型＋名字／关系）→ **一个主触发**（这一类判定问的那件事：人物=登场或被提及，地点=剧情发生在这里，规则=落在它管辖范围）→ 现在什么状态。两个毛病都别犯：写成纯剧情概括，判断模型得自己反推相关性；把情况一条条罗列开（「出场、独处、被忽略、身体描写时使用」），名字和关系就被挤掉了——判定问的本来就是一件事，一个主触发够了。

【你要做什么】
把最后【条目清单】里每一条的 s（用处说明）和 t（分类）写出来，输出一份「决策索引」JSON 文件。这份文件导入以后，每一轮该注入哪些设定，就是靠你在这里写的这句 s 决定的。

【输出形式：一个 markdown 代码块，里面一个 JSON 对象】
不要解释、不要道歉、不要提问、不要拆成几段。把整个 JSON 用 \`\`\`json 围栏包起来输出，代码块外面一个字都别写——网页端能直接把这个块复制走或下载成文件，连着围栏一起收也认。下面这个骨架只画了一条，实际要把最后【条目清单】里的每一条都写成 index 下的一项。形状照骨架，把示例值换成真的（键、h、t 的写法都照骨架）：

\`\`\`json
${JSON.stringify(skeleton, null, 2)}
\`\`\`

【硬性规则】
1. index 里每条的键，必须把下面清单里对应的 key= 一字不差抄过来。它是「书名::条目号」这种形状，导入时全靠它对上是哪一条——多一个空格、换个引号、自己改成英文都对不上。
2. 每条的 h 也必须把清单里的 h= 原样抄过去。那是这条正文的指纹，以后靠它判断这条后来有没有被改过；抄错或自己编，会被当成过期内容。
3. s = 用处说明＋摘要，不是内容概括：不超过 ${numbers.summaryLimit} 个字，一句到两句。顺序照上面说的那段走：**这是什么（类型＋名字／关系）→ 一个主触发 → 现在什么状态**。主触发只写一个（人物=登场或被提及、规则=落在它管辖范围），别罗列「出场、独处、被忽略、身体描写时」，也别写「相关时使用」这种空话——前者会把名字和关系挤掉，后者判定时验证不了。
4. 摘要里不要复述细节、不要引用原文句子、不要带露骨描写，也不要用委婉说法暗示细节。这段概括是给一个判断相关性的模型读的，写得越具体它越容易整批拒绝回答。
5. t = 分类：只能从下面【可选分类】里挑一个 id。分类不是标签——以后判断这一条时，问的是**这一类自己的问法**（问人物「是否出场」、问设定规则「是否在管辖范围」，本来就不是同一句话），所以按它的用处挑，别只看标题里的词。拿不准就填 other，别自创分类。
6. at 全部填 1，时间导入时自己补。
7. 只写清单里列出的条目，一条都别漏。正文找不到或读不懂的那条就整条省略——交一条空摘要等于没填，白写。
8. ${cantRead}
9. 存成文件时文件名和后缀随便写（.json、.txt、.md 都行），导入只看内容里有没有 kind 那一行和「书名::条目号」这种键，不看名字。
10. 一次把清单里的条目写完，不要分段输出、也不要说「篇幅所限先给一部分」；条目很多时宁可摘要短，也别漏条目。

${bodyWhere}

【可选分类】（t 只认这些 id）
${typeLines}
${customTypes ? '\n【注意】我这份分类表是自己改过的，不是默认那七类：输出里请把骨架中那段 types 一并带上，原样照抄，一个字别改。\n' : ''}
【条目清单】（共 ${entries.length} 条，一条都别漏）
${listLines || '（这一屏没有需要写的条目）'}`;
}

/**
 * 把候选条目的完整正文摊成「【正文 N】」那一节（导出创作文件用）
 * @param {Array} entries
 * @returns {string}
 * @description 编号必须和 buildIndexAuthoringPrompt 的清单同一份 entries、同一个顺序，两边对不上就全乱了。
 * @description 这里一个字都不截：整份文件的存在理由就是让 AI 不必去解角色卡里的 PNG。
 */
export function buildIndexAuthoringBodies(entries = []) {
    if (!Array.isArray(entries) || !entries.length) return '';
    return entries.map((entry, i) => `【正文 ${i + 1}】标题：${entryTitle(entry)}｜关键词：${keysOf(entry) || '（无）'}\n${String(entry?.content ?? '').trim() || '（这一条没有正文）'}`).join('\n\n');
}

/**
 * 一份自带你自己的正文的创作文件：发给网页端 AI 只要传这一个文件
 * @param {{entries?:Array, setting?:object}} options
 * @returns {{text:string, count:number, chars:number, bodies:number}}
 */
export function buildIndexAuthoringFile(options = {}) {
    const entries = Array.isArray(options.entries) ? options.entries : [];
    const prompt = buildIndexAuthoringPrompt({ entries, setting: options.setting, withBodies: true });
    const bodies = buildIndexAuthoringBodies(entries);
    const text = `${prompt}\n\n【条目正文】（共 ${entries.length} 条，编号跟上面清单对得上）\n\n${bodies || '（这一份里没有条目正文）'}\n`;
    return { text, count: entries.length, chars: text.length, bodies: bodies.length };
}

/**
 * 创作文件的文件名：带时间戳，来回导几份不会互相盖
 * @param {number} [now]
 * @returns {string}
 */
export function authoringFileName(now = Date.now()) {
    const d = new Date(now);
    const pad = (n) => String(n).padStart(2, '0');
    return `decision-index-authoring-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.md`;
}

/**
 * 导出创作文件之后写在弹窗里的说明（不套第二层弹窗）
 * @param {{count:number, chars:number, bodies:number, fileName:string, exported:boolean}} info
 * @returns {string}
 */
export function indexAuthoringFileOutcomeHtml(info = {}) {
    const escape = (text) => editorText(String(text ?? ''));
    return `
<div class="manual-index-outcome-text">
    <div>${escape(info.exported ? `创作文件已导出：${info.fileName}（${info.count} 条条目、正文那段约 ${info.bodies} 字，整份约 ${info.chars} 字）` : '创作文件没能存出去（浏览器拦了下载）。给这个页面允许下载再点一次；急用就先在这页逐条自己填，填一条点一条保存。')}</div>
    <div>${escape('用法：在网页端 AI 里把这一个文件传上去，跟它说「按文件里的要求输出」；它回的那个 json 代码块复制出来存成任意文件名，点「导入索引文件」就能用。')}</div>
    <div>${escape('这一份把正文原样贴全了、一个字没截，所以整份偏大。免费端读到一半断掉或被内容审核拦下时，改按世界书分几轮：每次只勾一部分条目导出。')}</div>
</div>`;
}

/** 一次最多渲染多少行：条目几百条时别把页面卡死，用上面的筛选框缩小范围 */
const MANUAL_INDEX_RENDER_LIMIT = 150;

/**
 * 手填清单里的一行
 * @param {object} entry
 * @param {object|undefined} record 已有的索引记录
 * @param {Array} types
 * @param {number} summaryLimit
 * @returns {string}
 */
export function manualIndexRowHtml(entry, record, types, summaryLimit) {
    const key = indexKey(entry.world, entry.uid);
    const currentType = record?.t || DECISION_OTHER_TYPE_ID;
    const options = (types || []).map(type => `<option value="${editorText(type.id)}"${type.id === currentType ? ' selected' : ''}>${editorText(type.name)}</option>`).join('');
    const body = String(entry?.content ?? '').trim();
    const state = record ? (record.m ? '已填（你写的）' : '已填（LLM 写的）') : '没填';
    const search = `${entryTitle(entry)} ${keysOf(entry)} ${record?.s ?? ''}`.toLowerCase();
    return `<div class="manual-index-row${record ? '' : ' manual-index-empty'}" data-key="${editorText(key)}" data-world="${editorText(entry.world)}" data-uid="${editorText(entry.uid)}" data-search="${editorText(search)}">
        <div class="manual-index-head">
            <input type="checkbox" class="manual-index-pick" title="勾上＝让 LLM 只填这些条目">
            <b>${editorText(entryTitle(entry))}</b>
            <span class="manual-index-state">${editorText(state)}</span>
            <small class="toggle-description">${editorText(String(entry.world ?? ''))}${keysOf(entry) ? `｜关键词：${editorText(keysOf(entry))}` : ''}</small>
            <div class="menu_button button-square-icon fa-solid fa-eye manual-index-toggle" title="展开／收起条目原文"></div>
        </div>
        <div class="manual-index-content" style="display:none;">${editorText(body) || '（这条没有正文）'}</div>
        <textarea class="text_pole settings_textarea wide100p manual-index-summary" rows="2" title="判定时只取前 ${summaryLimit} 字，写长了会被切成 …" placeholder="这是什么（类型＋名字／关系）｜一个主触发（什么时候用它，别罗列情况）｜现在什么状态">${editorText(record?.s ?? '')}</textarea>
        <div class="manual-index-actions">
            <select class="text_pole manual-index-type" title="这一条归哪一类，判定时就用那一类的问法">${options}</select>
            <div class="menu_button menu_button_icon manual-index-save" title="只存这一条到本机设置里的索引，不发任何请求"><i class="fa-solid fa-floppy-disk"></i><span>保存这一条</span></div>
            <div class="menu_button menu_button_icon manual-index-clear" title="删掉这条记录；这条以后按正文片段判"><i class="fa-solid fa-eraser"></i><span>清除</span></div>
            <span class="manual-index-tip"></span>
        </div>
    </div>`;
}
/** 按 data-key 找行：书名中可能有引号，用属性选择器会写崩，逐个比属性最稳 */
function rowByKey(rowsHost, key) {
    return [...rowsHost.querySelectorAll('.manual-index-row')].find(row => row.getAttribute('data-key') === key) || null;
}

/**
 * 「填写条目索引」这一页的工厂：工作台弹窗切到这一页时用它
 * @returns {{key:string, label:string, hint:string, mount(root:HTMLElement):Promise<{dispose:Function,isBusy:Function}>}}
 */
export function createManualIndexPage() {
    return {
        key: 'index',
        label: '填写条目索引',
        hint: '逐条看原文、写摘要、选分类。这一页只有「让 LLM…」那几颗按钮会发请求、消耗 token。',
        mount: mountManualIndexPage,
    };
}

/**
 * 挂载这一页：往工作台给的容器里画内容，返回拆页函数
 * @param {HTMLElement} root 工作台弹窗的内容容器
 * @returns {Promise<{dispose:Function, isBusy:Function}>}
 * @description 保存只写本机设置里的 decision_entry_index，一个请求都不发；发 LLM 请求的只有那几颗「让 LLM…」按钮。
 * @description 手填记录跟 LLM 摘要共用同一份索引，判定侧不用分叉；m 标记只用来显示「你写的」。
 * @description LLM 的结果嵌在这一页里显示，不套第二层弹窗。
 * @description 挑不出候选条目（没加载世界书、或书里挑不出「带关键词、非常驻、没被 @@ 钉住」的条目）时照样打开，
 * @description 只是按现有分类列出空区块——不加载也能先看结构、顺手切去分类页改问法。
 */
async function mountManualIndexPage(root) {
    if (isIndexRunning()) EDITOR.warning('正在建索引，等这一趟跑完再手动填，不然两边会互相盖掉。');
    const entries = await collectIndexableEntries();
    const setting = USER.store || {};
    const numbers = readIndexNumbers(setting);
    const types = normalizeTypes(setting.decision_entry_types);
    const byKey = new Map(entries.map(entry => [indexKey(entry.world, entry.uid), entry]));
    // 没点保存的草稿按 key 存着：筛选和翻列表都会重绘整行，不存等于把用户刚打的字清掉
    const drafts = new Map();
    // 勾给「让 LLM 填勾中的」用的那一批：跟筛选/重绘无关，重绘时要照原样把勾恢复回去
    const picked = new Set();
    const filter = { query: '', onlyMissing: false };
    const html = `
<div class="wide100p padding5" style="display:flex;flex-direction:column;gap:8px;">
    <div class="manual-index-counter"></div>
    <details class="manual-index-guide">
        <summary>参考模板：摘要写什么、各分类怎么写</summary>
        <pre class="manual-index-guide-body">${editorText(MANUAL_INDEX_GUIDE)}</pre>
        <small class="toggle-description justifyLeft">先弄清这句是干什么的：世界书原文平时并不发给 AI，每轮是由一个判断模型<b>只看你写的这句</b>来决定这一条要不要注入系统提示词（当作背景设定或写作规范）。所以它得是「这一条的用处说明」——<b>先点明这是什么</b>（类型＋名字／关系），再给<b>一个主触发</b>（这一类判定问的那件事：人物就是「登场或被提及时」，规则就是「落在它管辖范围时」），最后补一句现在什么状态。<b>主触发只写一个</b>：把各种情况罗列开（「出场、独处、被忽略、身体描写时」）只会把名字和关系挤掉。上限 ${numbers.summaryLimit} 字，写超了判定时只取前面那截。分类决定这一条用哪种问法，拿不准就留「其他」。原文只在这里给你看，不会因为你写了摘要就少注入一个字。</small>
    </details>
    <div class="manual-index-filter">
        <input type="text" id="dlb_manual_index_filter" class="text_pole" placeholder="筛选：标题／关键词／已写的摘要，输入即过滤" />
        <label class="checkbox_label" for="dlb_manual_index_only_missing"><input id="dlb_manual_index_only_missing" type="checkbox" /> <span>只列没填的</span></label>
    </div>
    <div class="manual-index-llm">
        <label class="checkbox_label" for="dlb_manual_index_pick_all"><input id="dlb_manual_index_pick_all" type="checkbox" /> <span>全选这一屏</span></label>
        <div class="menu_button menu_button_icon manual-index-llm-picked" title="只问勾中的条目（勾中的即使内容没变也重问一遍）。会发 LLM 请求"><i class="fa-solid fa-wand-magic-sparkles"></i><span>让 LLM 填勾中的</span></div>
        <div class="menu_button menu_button_icon manual-index-llm-missing" title="问「没填过」和「正文改过」的，你手写过的不动。会发 LLM 请求"><i class="fa-solid fa-database"></i><span>让 LLM 补没填的</span></div>
        <div class="menu_button menu_button_icon manual-index-llm-all" title="全部条目重问一遍，连你手写的摘要也会被盖掉（点它会再确认一次）。会发 LLM 请求"><i class="fa-solid fa-rotate"></i><span>让 LLM 全填</span></div>
        <div class="menu_button menu_button_icon manual-index-llm-reclassify" title="只重问「所属分类被你删掉」的那几条（摘要一起重做）。没有这种条目时不发请求"><i class="fa-solid fa-shuffle"></i><span>重建失效分类</span></div>
    </div>
    <div class="manual-index-files">
        <div class="menu_button menu_button_icon manual-index-export" title="把已经填好的摘要和分类打成一个 JSON 文件存到本机（不发请求、不花钱）。换机器、或者连着角色卡发给别人时带上它。"><i class="fa-solid fa-file-export"></i><span>导出索引文件</span></div>
        <div class="menu_button menu_button_icon manual-index-import" title="选一个导出的 JSON，把里面的摘要灌进本机设置（不发请求、不花钱）。按下去会先说清新增几条、已有几条，你选「只补空着的」还是「一起覆盖」。"><i class="fa-solid fa-file-import"></i><span>导入索引文件</span></div>
        <div class="menu_button menu_button_icon manual-index-authoring-file" title="导出一个 .md 文件：里面是创作要求，末尾把每条的完整正文原样贴上。整份文件丢给网页端 AI 就行，它不用去解角色卡图片。勾了条目就只带勾中的那几条（拿来分几轮发）。它回的 json 代码块存成任意文件名，点「导入索引文件」收进来（不发请求、不花钱）。"><i class="fa-solid fa-file-arrow-down"></i><span>导出创作文件</span></div>
        <input type="file" id="dlb_manual_index_file" class="manual-index-file-input" />
    </div>
    <div class="manual-index-confirm"></div>
    <small class="manual-index-progress toggle-description justifyLeft"></small>
    <div class="manual-index-outcome"></div>
    <div id="dlb_manual_index_rows" class="manual-index-rows"></div>
    <small class="manual-index-note">「保存这一条」只写进本机设置里的索引，一个请求都不发；上面那几颗「让 LLM…」才会发请求、会消耗 token。填好的条目判定时用你的摘要和那一类的问法，没填的照旧读正文片段。「补没填的」不会动你手写的（指纹算的是当前正文），「全填」会把手写的盖掉。索引是存在本机设置里的，不跟着世界书文件走——要带走就「导出索引文件」，别人在他那边点「导入索引文件」就行；不想花 token 也不想自己一条条写，就把这活交给任意网页端免费 AI：点「导出创作文件」传一个文件最省事（创作要求和每条完整正文都在这一个文件里，它不需要能读懂角色卡图片）；条目太多怕它读不完，就勾几条再导、分几轮发。它回的 json 存成任意文件名，点「导入索引文件」收进来。<b>导入只看文件内容，文件名和后缀随便叫，怎么改都不影响匹配。</b></small>
</div>
<style>
    .manual-index-counter { color: var(--SmartThemeEmColor); font-size: 12px; text-align: left; }
    .manual-index-guide { text-align: left; font-size: 12px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 4px; padding: 4px 8px; }
    .manual-index-guide summary { cursor: pointer; }
    .manual-index-guide-body { white-space: pre-line; font-family: inherit; font-size: 12px; margin: 6px 0; text-align: left; }
    .manual-index-filter { display: flex; gap: 8px; align-items: center; }
    .manual-index-llm { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .manual-index-files { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .manual-index-file-input { display: none; }
    .manual-index-confirm { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 12px; color: var(--SmartThemeEmColor); text-align: left; }
    .manual-index-outcome { font-size: 12px; color: var(--SmartThemeEmColor); }
    .manual-index-outcome summary { cursor: pointer; }
    .manual-index-fail-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .manual-index-fail-table th, .manual-index-fail-table td { border-bottom: 1px solid var(--SmartThemeBorderColor); padding: 3px 6px; text-align: left; vertical-align: top; }
    .manual-index-rows { display: flex; flex-direction: column; gap: 8px; }
    .manual-index-row { border: 1px solid var(--SmartThemeBorderColor); border-radius: 4px; padding: 6px 8px; text-align: left; }
    .manual-index-empty { border-left: 3px solid var(--SmartThemeEmColor); }
    .manual-index-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .manual-index-state { font-size: 11px; color: var(--SmartThemeEmColor); }
    .manual-index-content { white-space: pre-line; font-size: 12px; color: var(--SmartThemeEmColor); max-height: 220px; overflow-y: auto; border-left: 2px solid var(--SmartThemeBorderColor); padding-left: 6px; margin: 6px 0; }
    .manual-index-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 4px; }
    .manual-index-actions .manual-index-type { width: 140px; }
    .manual-index-tip { font-size: 11px; color: var(--SmartThemeEmColor); }
    .manual-index-note { font-size: 12px; color: var(--SmartThemeEmColor); text-align: left; }
    .manual-index-blank { border: 1px dashed var(--SmartThemeBorderColor); border-radius: 4px; padding: 8px; text-align: left; }
    .manual-index-blank-title { font-size: 13px; }
    .manual-index-blank-type { font-size: 12px; color: var(--SmartThemeEmColor); padding: 2px 0 2px 10px; border-left: 2px solid var(--SmartThemeBorderColor); margin-top: 4px; }
</style>`;
    root.innerHTML = html;
    const rowsHost = root.querySelector('#dlb_manual_index_rows');
    const counterHost = root.querySelector('.manual-index-counter');
    const progressHost = root.querySelector('.manual-index-progress');
    const confirmHost = root.querySelector('.manual-index-confirm');
    const outcomeHost = root.querySelector('.manual-index-outcome');
    const fileInput = root.querySelector('#dlb_manual_index_file');
    const LLM_BUTTONS = '.manual-index-llm-picked, .manual-index-llm-missing, .manual-index-llm-all, .manual-index-llm-reclassify';
    /** 每回都从设置里读最新索引：保存是逐条落盘的，攥一份旧快照会把后来的编辑盖掉 */
    const currentIndex = () => normalizeIndex((USER.store || {}).decision_entry_index);
    const filledCount = () => {
        const index = currentIndex();
        return entries.filter(entry => index[indexKey(entry.world, entry.uid)]).length;
    };
    const updateCounter = () => {
        const filled = filledCount();
        const shown = rowsHost.querySelectorAll('.manual-index-row').length;
        const matchedCount = matched().length;
        const truncated = matchedCount > shown ? `（筛出 ${matchedCount} 条，一屏最多列 ${MANUAL_INDEX_RENDER_LIMIT} 条，请再缩小范围）` : '';
        counterHost.textContent = `共 ${entries.length} 条候选｜已保存 ${filled} 条｜没填 ${entries.length - filled} 条｜这一屏 ${shown} 条${truncated}${picked.size ? `｜勾了 ${picked.size} 条` : ''}`;
    };
    const matched = () => {
        const index = currentIndex();
        const words = filter.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
        return entries.filter(entry => {
            const key = indexKey(entry.world, entry.uid);
            if (filter.onlyMissing && index[key]) return false;
            if (!words.length) return true;
            const text = `${entryTitle(entry)} ${keysOf(entry)} ${index[key]?.s ?? ''} ${drafts.get(key) ?? ''}`.toLowerCase();
            return words.every(word => text.includes(word));
        });
    };
    const renderRows = () => {
        const index = currentIndex();
        if (!entries.length) {
            // 没加载世界书（或书里挑不出候选条目）也要有东西可看：按现有分类列空区块，
            // 让人先确认分类对不对，再切去分类页改问法
            rowsHost.innerHTML = `<div class="manual-index-blank">
                <div class="manual-index-blank-title">现在一条候选都没有，所以这里没有可填的条目。</div>
                <small class="toggle-description justifyLeft">只有「启用中的世界书里、带关键词、非常驻、没被 @@ 钉住」的条目才进这份清单——打开一张带世界书的卡、或到世界书面板里把那本书勾上，回来重开这一页就有了。下面先按你现在的分类列着，切右上角「分类编辑」可以改分类和每类的问法，这些不用加载世界书也能做。</small>
                ${(types || []).map(type => `<div class="manual-index-blank-type">${editorText(type.name)}｜0 条${String(type.instruction ?? '').trim() ? '' : '（这一类没写专属问法，走通用判定问法）'}</div>`).join('')}
            </div>`;
            updateCounter();
            return;
        }
        const list = matched();
        const shown = list.slice(0, MANUAL_INDEX_RENDER_LIMIT);
        rowsHost.innerHTML = shown.map(entry => manualIndexRowHtml(entry, index[indexKey(entry.world, entry.uid)], types, numbers.summaryLimit)).join('')
            || '<div class="manual-index-note">筛不出条目：换个词，或把「只列没填的」取消。</div>';
        // 草稿回填到输入框（不写进 record，否则状态会显示成「已填」，骗人去点生成）
        shown.forEach(entry => {
            const key = indexKey(entry.world, entry.uid);
            const row = rowByKey(rowsHost, key);
            if (!row) return;
            row.querySelector('.manual-index-pick').checked = picked.has(key);
            const draft = drafts.get(key);
            if (draft === undefined) return;
            row.querySelector('.manual-index-summary').value = draft;
            row.querySelector('.manual-index-tip').textContent = '改了还没保存，记得点「保存这一条」';
        });
        syncPickAll();
        updateCounter();
    };
    /** 「全选这一屏」的勾：跟着当前渲染出来的行走，筛了就不会显示成全选 */
    const syncPickAll = () => {
        const boxes = [...rowsHost.querySelectorAll('.manual-index-pick')];
        const all = root.querySelector('#dlb_manual_index_pick_all');
        if (all) all.checked = boxes.length > 0 && boxes.every(box => box.checked);
    };
    const setTip = (row, text) => { const tip = row?.querySelector('.manual-index-tip'); if (tip) tip.textContent = text; };
    /** 空白视图里那几颗按钮照样能点，点了要说清为什么没活可干 */
    const noEntries = () => { EDITOR.warning('一条候选都没有：先打开一张带世界书的卡（或到世界书面板里把那本书勾上启用），回来重开这一页就有了。'); };
    /** 「让 LLM 全填」的确认条：就地确认，不套第二层弹窗 */
    const armFullRefill = () => {
        if (!entries.length) { noEntries(); return; }
        const index = currentIndex();
        const manualCount = entries.filter(entry => index[indexKey(entry.world, entry.uid)]?.m).length;
        confirmHost.innerHTML = `<span>「让 LLM 全填」会把全部 ${entries.length} 条重新问一遍${manualCount ? `，其中你手写的 ${manualCount} 条摘要会被盖掉` : ''}，而且会消耗 token。要继续吗？</span><div class="menu_button menu_button_icon manual-index-confirm-yes"><i class="fa-solid fa-circle-check"></i><span>确认，全部重填</span></div><div class="menu_button menu_button_icon manual-index-confirm-no"><i class="fa-solid fa-ban"></i><span>取消</span></div>`;
    };
    const clearConfirm = () => { confirmHost.innerHTML = ''; };
    let busy = false;
    const runLlmPass = async (options) => {
        if (busy) { EDITOR.warning('这一趟还没跑完，先等它结束（中途每批跑完都会存盘）。'); return; }
        if (!entries.length) { noEntries(); return; }
        if (options.keys && !options.keys.length) {
            EDITOR.warning('一条都没勾：先勾上条目左边的小方块，再点这颗按钮（勾中的即使内容没变也会重问一遍）。');
            return;
        }
        busy = true;
        clearConfirm();
        outcomeHost.innerHTML = '';
        setLlmButtons(true);
        const label = options.keys ? `勾中的 ${options.keys.length} 条`
            : options.scope === 'all' ? `全部 ${entries.length} 条`
            : options.scope === 'reclassify' ? '分类失效的那些条目'
            : '没填过的和正文改过的';
        progressHost.textContent = `正在让 LLM 摘要：${label}…`;
        let result = null;
        try {
            result = await buildEntryIndex({
                ...options,
                onProgress: (state) => { progressHost.textContent = `正在让 LLM 摘要：已处理 ${state.done}/${state.total} 条｜写入 ${state.written}｜失败 ${state.failed}`; },
            });
        } finally {
            busy = false;
            setLlmButtons(false);
        }
        if (!result) { progressHost.textContent = ''; return; }
        progressHost.textContent = '';
        // 索引整片变了：草稿缓存里那些字已经被 LLM 的摘要盖掉，留着只会让人以为还没保存
        drafts.clear();
        picked.clear();
        renderRows();
        outcomeHost.innerHTML = indexOutcomeHtml(result);
    };
    /** 待确认的那份文件内容：点「导入索引文件」→ 选文件 → 确认条 → 才落盘 */
    let stagedImport = null;
    const exportIndexFile = () => {
        const payload = buildIndexExport(USER.store || {});
        const keys = Object.keys(payload.index);
        if (!keys.length) {
            EDITOR.warning('索引里一条都还没有：先填几条（自己写或让 LLM 填），导出才有内容。');
            return;
        }
        const fileName = indexFileName();
        const foreign = keys.filter(key => !byKey.has(key)).length;
        downloadIndexFile(payload, fileName);
        EDITOR.success(`已导出 ${keys.length} 条摘要和分类到 ${fileName}${foreign ? `（其中 ${foreign} 条不属于当前这几本世界书，也一起带着）` : ''}。没发请求；别人拿到这个文件在他那边点「导入索引文件」就行。`);
    };
    const openFilePicker = () => {
        // 导入也是写同一份索引：LLM 那一趟是逐批落盘的，两边同时写会互相盖
        if (busy) { EDITOR.warning('这一趟 LLM 还没跑完，先等它结束（中途每批跑完都会存盘），再导入文件。'); return; }
        // 清空后再开：连着选同一个文件时 change 不会二次触发
        fileInput.value = '';
        fileInput.click();
    };
    /** 导入前先把账算清：各档分别会动多少条，看完再决定盖不盖 */
    const previewImport = (parsed) => {
        const index = currentIndex();
        const keys = Object.keys(parsed.index);
        const existing = keys.filter(key => index[key]);
        return {
            added: keys.length - existing.length,
            existing: existing.length,
            manual: existing.filter(key => index[key]?.m).length,
            foreign: keys.filter(key => !byKey.has(key)).length,
        };
    };
    const armImportConfirm = (staged) => {
        const p = previewImport(staged);
        confirmHost.innerHTML = `<span>要从「${editorText(staged.fileName)}」导入 ${p.added + p.existing} 条：本机还空着的 ${p.added} 条${p.existing ? `｜本机已有 ${p.existing} 条${p.manual ? `（其中你手写 ${p.manual} 条）` : ''}` : ''}${p.foreign ? `｜另有 ${p.foreign} 条不属于当前这几本世界书` : ''}。</span><div class="menu_button menu_button_icon manual-index-import-yes" data-overwrite="false"><i class="fa-solid fa-plus"></i><span>只补空着的（推荐）</span></div><div class="menu_button menu_button_icon manual-index-import-yes" data-overwrite="true"><i class="fa-solid fa-rotate"></i><span>连已有的一起覆盖</span></div><div class="menu_button menu_button_icon manual-index-import-cancel"><i class="fa-solid fa-ban"></i><span>取消</span></div>`;
    };
    const onFilePicked = async () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        let parsed = null;
        try {
            parsed = parseIndexFile(await file.text());
        } catch (error) {
            EDITOR.error(`这个文件读不出来：${error?.message || error}`);
            return;
        }
        if (!parsed.ok) { EDITOR.error(parsed.reason); return; }
        stagedImport = { ...parsed, fileName: file.name };
        armImportConfirm(stagedImport);
    };
    const runImport = (overwrite) => {
        const staged = stagedImport;
        stagedImport = null;
        clearConfirm();
        if (!staged) { EDITOR.warning('没拿到文件内容：重新点一次「导入索引文件」选文件。'); return; }
        const result = applyImportedIndex(staged, USER.store || {}, { overwrite, knownKeys: new Set(byKey.keys()) });
        // 索引整片变了：草稿缓存里那些字已经被文件内容盖掉，留着只会让人以为还没保存
        drafts.clear();
        picked.clear();
        renderRows();
        outcomeHost.innerHTML = indexImportOutcomeHtml(result, { overwrite, fileName: staged.fileName, tolerant: !!staged.tolerant });
    };
    /**
     * 创作文件的取材范围：勾了就只带勾中的，没勾带全部候选
     * @description 一整本世界书的原文一次贴给免费端很容易被读到一半断掉，勾一部分分批导就是现成的分轮办法——
     * @description 不必再加一套「每次几条」的控件，勾选框本来就在。
     */
    const authoringEntries = () => (picked.size ? entries.filter(entry => picked.has(indexKey(entry.world, entry.uid))) : entries);
    const exportAuthoringFile = () => {
        const list = authoringEntries();
        if (!list.length) {
            EDITOR.warning('没有可带的条目：世界书里挑不出候选，或者勾中的那几条已经不在清单里了。');
            return;
        }
        const built = buildIndexAuthoringFile({ entries: list, setting: USER.store || {} });
        const fileName = authoringFileName();
        let exported = true;
        try {
            downloadTextFile(built.text, fileName, 'text/markdown');
        } catch (error) {
            exported = false;
            EDITOR.error(`这份文件存不出去：${error?.message || error}`);
        }
        outcomeHost.innerHTML = indexAuthoringFileOutcomeHtml({ ...built, fileName, exported });
        if (exported) EDITOR.success(`创作文件已导出 ${fileName}：${built.count} 条条目连同完整正文，整份约 ${built.chars} 字。把它一份传给网页端 AI 就够，不用再附角色卡。`);
    };
    const onClick = (event) => {
        const target = event.target;
        if (target?.closest?.('.manual-index-confirm-yes')) { void runLlmPass({ scope: 'all' }); return; }
        if (target?.closest?.('.manual-index-confirm-no')) { clearConfirm(); return; }
        if (target?.closest?.('.manual-index-import-yes')) { runImport(target.closest('.manual-index-import-yes').dataset.overwrite === 'true'); return; }
        if (target?.closest?.('.manual-index-import-cancel')) { stagedImport = null; clearConfirm(); return; }
        if (target?.closest?.('.manual-index-authoring-file')) { exportAuthoringFile(); return; }
        if (target?.closest?.('.manual-index-export')) { exportIndexFile(); return; }
        if (target?.closest?.('.manual-index-import')) { openFilePicker(); return; }
        if (target?.closest?.('.manual-index-llm-picked')) { void runLlmPass({ keys: [...picked] }); return; }
        if (target?.closest?.('.manual-index-llm-missing')) { void runLlmPass({ scope: 'missing' }); return; }
        if (target?.closest?.('.manual-index-llm-all')) { armFullRefill(); return; }
        if (target?.closest?.('.manual-index-llm-reclassify')) { void runLlmPass({ scope: 'reclassify' }); return; }
        const button = event.target?.closest?.('.manual-index-toggle, .manual-index-save, .manual-index-clear');
        if (!button || !rowsHost.contains(button)) return;
        const row = button.closest('.manual-index-row');
        if (!row) return;
        if (button.classList.contains('manual-index-toggle')) {
            const body = row.querySelector('.manual-index-content');
            const open = !body.style.display || body.style.display === 'none';
            body.style.display = open ? '' : 'none';
            button.classList.toggle('fa-eye', !open);
            button.classList.toggle('fa-eye-slash', open);
            return;
        }
        const key = row.getAttribute('data-key');
        if (button.classList.contains('manual-index-clear')) {
            if (!clearIndexRecord(row.getAttribute('data-world'), row.getAttribute('data-uid'))) {
                setTip(row, '这一条本来就没填过。');
                return;
            }
            drafts.delete(key);
            row.classList.add('manual-index-empty');
            row.querySelector('.manual-index-state').textContent = '没填';
            setTip(row, '已删掉这条记录：这条以后按正文片段判。');
            updateCounter();
            return;
        }
        const entry = byKey.get(key);
        if (!entry) {
            setTip(row, '这一条已经不在清单里了（换了世界书、删了条目或改了关键词），关掉重开一次。');
            return;
        }
        const result = saveManualIndex(entry, row.querySelector('.manual-index-summary').value, row.querySelector('.manual-index-type').value);
        if (!result.record) {
            setTip(row, result.reason);
            return;
        }
        drafts.delete(key);
        row.classList.remove('manual-index-empty');
        row.querySelector('.manual-index-state').textContent = '已填（你写的）';
        const over = String(result.record.s ?? '').length - numbers.summaryLimit;
        setTip(row, `已保存 ${new Date(result.record.at).toLocaleTimeString()}${over > 0 ? `｜超过上限 ${over} 字，判定时只取前 ${numbers.summaryLimit} 字` : ''}`);
        updateCounter();
    };
    let filterTimer = 0;
    const onInput = (event) => {
        const target = event.target;
        if (!target?.classList) return;
        if (target.id === 'dlb_manual_index_filter') {
            filter.query = String(target.value ?? '');
            clearTimeout(filterTimer);
            filterTimer = setTimeout(renderRows, 200);
            return;
        }
        if (target.id === 'dlb_manual_index_only_missing') {
            filter.onlyMissing = !!target.checked;
            renderRows();
            return;
        }
        if (target.id === 'dlb_manual_index_pick_all') {
            const boxes = [...rowsHost.querySelectorAll('.manual-index-pick')];
            boxes.forEach(box => {
                box.checked = !!target.checked;
                const key = box.closest('.manual-index-row')?.getAttribute('data-key');
                if (!key) return;
                if (target.checked) picked.add(key); else picked.delete(key);
            });
            updateCounter();
            return;
        }
        if (target.classList.contains('manual-index-pick')) {
            const key = target.closest('.manual-index-row')?.getAttribute('data-key');
            if (!key) return;
            if (target.checked) picked.add(key); else picked.delete(key);
            syncPickAll();
            updateCounter();
            return;
        }
        if (!target.classList.contains('manual-index-summary') || !rowsHost.contains(target)) return;
        const row = target.closest('.manual-index-row');
        const key = row?.getAttribute('data-key');
        if (!key) return;
        const value = String(target.value ?? '');
        if (value.replace(/\s+/g, ' ').trim() === (currentIndex()[key]?.s ?? '')) {
            drafts.delete(key);
            setTip(row, '');
            return;
        }
        drafts.set(key, value);
        setTip(row, '改了还没保存，记得点「保存这一条」');
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('input', onInput);
    fileInput?.addEventListener('change', onFilePicked);
    renderRows();
    return {
        // 工作台切页前问一句：LLM 那一趟是逐批落盘的，中途切走看不见进度，但跑完照样存盘
        isBusy: () => busy,
        // 摘掉 document 上那两条：留着会跟着每一次点击跑，还会串到下一次打开这一页
        dispose: () => {
            document.removeEventListener('click', onClick, true);
            document.removeEventListener('input', onInput);
        },
    };
}



