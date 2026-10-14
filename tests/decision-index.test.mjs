// decision-index.test.mjs
// 条目摘要索引（先让 LLM 把世界书条目摘要+归类，决策模型每轮只看摘要并按类别问法提问）的回归测试
// 运行：node tests/decision-index.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 插件根目录相对测试文件算，装在哪都能跑
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(`${ROOT}/${p}`, 'utf8');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
    ok ? pass++ : fail++;
};
const truthy = (label, actual) => {
    const ok = !!actual;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
    ok ? pass++ : fail++;
};

/** 把 ESM 源文件剥成可在 new Function 里跑的工厂：丢掉 import/export，外部依赖用参数注入 */
function toFactory(path, deps) {
    const exportNames = deps.__exports;
    const src = read(path)
        .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?$/gm, '')
        .replace(/^export\s+async\s+function/gm, 'async function')
        .replace(/^export\s+function/gm, 'function')
        .replace(/^export\s+/gm, '');
    delete deps.__exports;
    const names = Object.keys(deps);
    const factory = new Function(...names, `${src}\n return { ${exportNames.join(', ')} };`);
    return factory(...names.map(n => deps[n]));
}

// 标题口径跟插件一致就够了，测试关心的是「摘要里带不带标题/关键词」
const entryTitle = (entry) => String(entry?.comment ?? '').trim() || `条目${entry?.uid ?? '?'}`;

const EXPORTS = ['DECISION_OTHER_TYPE_ID', 'DEFAULT_DECISION_TYPES', 'DEFAULT_INDEX_SYSTEM_PROMPT', 'DEFAULT_INDEX_TEMPLATE',
    'INDEX_DEFAULTS', 'INDEX_MAX_BATCH_SIZE', 'fnv1aHex', 'indexKey', 'keysOf', 'entryFingerprint', 'normalizeTypes', 'normalizeIndex',
    'readIndexNumbers', 'decisionIndexEnabled', 'resolveTypeId', 'indexedDigest', 'createMaterialResolver', 'planIndex',
    'indexEntryCost', 'packIndexBatches',
    'renderIndexPrompt', 'buildIndexPrompt', 'parseIndexLines', 'mergeIndexResults', 'filterDecisionEntries', 'collectIndexableEntries',
    'isIndexRunning', 'buildEntryIndex', 'indexOverview', 'pruneStaleIndex', 'makeTypeId', 'countIndexByType', 'editorText',
    'MANUAL_INDEX_GUIDE', 'saveManualIndex', 'clearIndexRecord', 'manualIndexRowHtml', 'createManualIndexPage', 'indexOutcomeHtml',
    'INDEX_FILE_KIND', 'INDEX_FILE_VERSION', 'buildIndexExport', 'indexFileName', 'parseIndexFile', 'mergeImportedIndex',
    'applyImportedIndex', 'indexImportOutcomeHtml', 'downloadIndexFile', 'pickIndexMap', 'extractJsonObject',
    'buildIndexAuthoringPrompt',
    'buildIndexAuthoringBodies', 'buildIndexAuthoringFile', 'authoringFileName', 'indexAuthoringFileOutcomeHtml', 'downloadTextFile'];

/** 每次新建一份模块实例：indexRunning 是模块级变量，隔离用例全靠它 */
function makeIndex(over = {}) {
    const log = { info: [], warning: [], toast: [], saved: 0, asks: [], replies: [] };
    const setting = over.setting ?? {};
    const USER = { privacy: over.privacy ?? {}, store: setting, saveSettings: () => { log.saved++; } };
    const EDITOR = {
        info: (m) => log.info.push(String(m)),
        warning: (m) => log.warning.push(String(m)),
        success: (m) => log.toast.push(String(m)),
        error: (m) => log.toast.push(String(m)),
    };
    const reply = async (channel, system, user) => {
        log.asks.push([channel, system, user]);
        if (over.throwOn && log.asks.length >= over.throwOn) throw new Error(over.throwMessage || 'network down');
        if (typeof over.reply === 'function') return over.reply(log.asks.length, system, user);
        return over.reply ?? null;
    };
    const mod = toFactory('scripts/runtime/decisionEntryIndex.js', {
        __exports: EXPORTS,
        EDITOR, USER,
        getSortedEntries: async () => (over.entries ?? []),
        handleMainAPIRequest: (system, user) => reply('main', system, user),
        handleCustomAPIRequest: (system, user) => reply('custom', system, user),
        entryTitle,
        // 「查看上次 LLM 回复」：建索引每一趟都要记账，否则跑失败了用户只看到没动静
        beginReply: (meta) => { log.replies.push({ kind: 'begin', meta }); },
        finishReply: (patch) => { log.replies.push({ kind: 'finish', patch }); },
        console,
    });
    return { mod, log, USER, setting };
}

const entry = (over = {}) => ({ uid: 1, world: 'w1', comment: '旧铁剑', key: ['铁剑', '武器'], content: '一把会说话的旧铁剑。', disable: false, constant: false, decorators: [], ...over });

const TYPE_EXPORTS = ['editDecisionType', 'removeDecisionType', 'addDecisionType', 'renderDecisionTypeRowsHtml', 'describeDecisionTypes', 'createDecisionTypePage'];

/** 分类编辑那一页：纯函数在 Node 里跑，createDecisionTypePage 的 mount 要真 DOM，只在源码文本上验接线 */
function makeTypeUi(over = {}) {
    const setting = over.setting ?? {};
    const log = { saved: 0, warning: [] };
    const USER = { privacy: over.privacy ?? {}, store: setting, saveSettings: () => { log.saved++; } };
    const EDITOR = { warning: (m) => log.warning.push(String(m)) };
    const idx = toFactory('scripts/runtime/decisionEntryIndex.js', {
        __exports: EXPORTS,
        EDITOR, USER,
        getSortedEntries: async () => (over.entries ?? []),
        handleMainAPIRequest: async () => null,
        handleCustomAPIRequest: async () => null,
        entryTitle,
        beginReply: () => {},
        finishReply: () => {},
        console,
    });
    const mod = toFactory('scripts/runtime/decisionTypeEditor.js', {
        __exports: TYPE_EXPORTS,
        EDITOR, USER,
        DECISION_OTHER_TYPE_ID: idx.DECISION_OTHER_TYPE_ID,
        countIndexByType: idx.countIndexByType,
        editorText: idx.editorText,
        makeTypeId: idx.makeTypeId,
        normalizeTypes: idx.normalizeTypes,
    });
    return { mod, idx, log, setting, USER };
}

console.log('===== 1. 分类表与索引本体规整 =====');
const { mod: idx } = makeIndex();
check('没动过（空数组）= 内置分类', idx.normalizeTypes([]).map(t => t.id),
    ['character', 'place', 'item', 'event', 'org', 'rule', 'other']);
check('根本不是数组也回内置', idx.normalizeTypes(undefined).length, 7);
check('「其他」永远排在最后', idx.normalizeTypes([{ id: 'x', name: '甲' }]).map(t => t.id), ['x', 'other']);
check('没名字的项丢掉', idx.normalizeTypes([{ id: 'a' }, { name: '  ' }, { name: '乙', id: 'b' }]).map(t => t.name), ['乙', '其他']);
check('重复 id 只留第一个', idx.normalizeTypes([{ id: 'b', name: '乙' }, { id: 'b', name: '丙' }]).map(t => t.name), ['乙', '其他']);
check('自定义项缺 instruction 时补内置（内置 id 才有），新类补空串',
    [idx.normalizeTypes([{ id: 'rule', name: '规则' }])[0].instruction.includes('{digest}'), idx.normalizeTypes([{ id: 'x', name: '甲' }])[0].instruction],
    [true, '']);
check('用户亲手清空问法 = 保持空串，不拿内置顶回去', idx.normalizeTypes([{ id: 'rule', name: '规则', instruction: '' }])[0].instruction, '');
check('「其他」的问法：存过用存的，没存过用内置',
    [idx.normalizeTypes([{ id: 'other', name: '其他', instruction: '专属问法' }])[0].instruction,
        idx.normalizeTypes([{ id: 'a', name: '甲' }])[1].instruction.includes('{digest}')],
    ['专属问法', true]);
check('「其他」的名字可以改', [idx.normalizeTypes([{ id: 'other', name: '拿不准' }])[0].name, idx.normalizeTypes([{ id: 'other' }])[0].name], ['拿不准', '其他']);
check('没有 id 的项按名字生成一个，不会和 other 撞', idx.normalizeTypes([{ name: '甲' }])[0].id.startsWith('t'), true);
console.log('===== 2. 索引记录 / 数值 / 指纹 =====');
check('索引键带书名', idx.indexKey('w1', 7), 'w1::7');
check('关键词主+次，最多 12 个', idx.keysOf({ key: ['a', '', 'b'], keysecondary: ['c'] }), 'a、b、c');
check('指纹稳定：换空白写法不算改过',
    idx.entryFingerprint(entry({ content: '甲\n  乙' })) === idx.entryFingerprint(entry({ content: '甲 乙' })), true);
check('指纹跟正文走', idx.entryFingerprint(entry({ content: '改了' })) !== idx.entryFingerprint(entry()), true);
check('指纹跟标题、关键词也走（只改这两样也要重摘要）',
    [idx.entryFingerprint(entry({ comment: '新名字' })) !== idx.entryFingerprint(entry()),
        idx.entryFingerprint(entry({ key: ['铁剑'] })) !== idx.entryFingerprint(entry())],
    [true, true]);
truthy('指纹是 8 位十六进制', /^[0-9a-f]{8}$/.test(idx.fnv1aHex('abc')));

check('摘要为空的记录当没索引过（拒答不能拿空摘要去判）', idx.normalizeIndex({ 'w1::1': { s: '   ', t: 'rule' } }), {});
check('规整：补默认分类、留指纹和时间',
    idx.normalizeIndex({ 'w1::1': { s: ' 一句话说完 ', t: '', h: 'aaaa1111', at: '123' }, 'w1::2': null, 'w1::3': 'x' }),
    { 'w1::1': { s: '一句话说完', t: 'other', h: 'aaaa1111', at: 123 } });
check('不是对象的索引整个当空', idx.normalizeIndex([]), {});
check('数值：空白回默认（字数才是打包依据，条数是第二道硬顶）', idx.readIndexNumbers({}),
    { summaryLimit: 60, contentLimit: 1200, batchSize: 20, batchChars: 6000 });
check('数值：越界夹住（单批条数最大 50、字数最小 500）', idx.readIndexNumbers({ decision_index_summary_limit: 1, decision_index_content_limit: 5, decision_index_batch_size: 999, decision_index_batch_chars: 1 }),
    { summaryLimit: 20, contentLimit: 200, batchSize: 50, batchChars: 500 });
check('数值：不是数字回默认', [idx.readIndexNumbers({ decision_index_batch_size: 'abc' }).batchSize, idx.readIndexNumbers({ decision_index_batch_chars: 'abc' }).batchChars], [20, 6000]);
check('开关严格判真：老存档没这个键就是关着', [idx.decisionIndexEnabled({}), idx.decisionIndexEnabled({ decision_index_enabled: 'true' }), idx.decisionIndexEnabled({ decision_index_enabled: true })], [false, false, true]);
check('分类名认得出（容忍书名号空格）', idx.resolveTypeId(idx.normalizeTypes([]), '「 人物 」'), 'character');
check('按 id 也能认', idx.resolveTypeId(idx.normalizeTypes([]), 'rule'), 'rule');
check('认不出回「其他」', [idx.resolveTypeId(idx.normalizeTypes([]), '外星科技'), idx.resolveTypeId(idx.normalizeTypes([]), '')], ['other', 'other']);
check('有索引时摘要形如 标题｜关键词｜摘要', idx.indexedDigest(entry(), { s: '一把会说话的旧铁剑，剑身有裂纹' }, 60), '旧铁剑｜关键词：铁剑、武器｜一把会说话的旧铁剑，剑身有裂纹');
check('摘要超上限才截断', idx.indexedDigest(entry(), { s: '甲'.repeat(30) }, 20), `旧铁剑｜关键词：铁剑、武器｜${'甲'.repeat(20)}…`);
check('没关键词时不出现「关键词：」', idx.indexedDigest({ uid: 3, world: 'w1', comment: '甲', content: '' }, { s: '乙' }, 60), '甲｜乙');

console.log('===== 3. 候选口径与材料选择器 =====');
const all = [entry({ uid: 1 }), entry({ uid: 2, comment: '乙' }), entry({ uid: 3, constant: true }), entry({ uid: 4, disable: true }),
    entry({ uid: 5, key: [] }), entry({ uid: 6, decorators: ['activate'] })];
check('建索引和判定时认的是同一批条目', idx.filterDecisionEntries(all).map(e => e.uid), [1, 2]);
check('filterDecisionEntries 能吃 undefined', idx.filterDecisionEntries(undefined), []);

const types = idx.normalizeTypes([]);
const rec = { s: '主角的佩剑，会说话', t: 'item', h: 'x', at: 1 };
const on = idx.createMaterialResolver({ enabled: true, index: { 'w1::1': rec }, types, summaryLimit: 60, globalTemplate: '通用问法 {digest}' });
check('关着时永远返回 null = 跟以前逐字一致',
    idx.createMaterialResolver({ enabled: false, index: { 'w1::1': rec }, types })({ uid: 1, world: 'w1' }), null);
const hit = on(entry({ uid: 1 }));
check('命中：用摘要当材料、用这一类的问法', [hit.digest, hit.typeId, hit.typeName, hit.indexed], ['旧铁剑｜关键词：铁剑、武器｜主角的佩剑，会说话', 'item', '道具', true]);
truthy('每类问法自带 {digest} 占位符', hit.template.includes('{digest}'));
check('没索引过的条目回 null（退回正文片段+通用问法）', on(entry({ uid: 9 })), null);
const deleted = idx.createMaterialResolver({ enabled: true, index: { 'w1::1': { ...rec, t: 'no_such_type' } }, types, globalTemplate: '通用 {digest}' });
check('分类被删了：判定时自动按「其他」的问法走，不用重算索引', deleted(entry({ uid: 1 })).typeId, 'other');
const blank = idx.createMaterialResolver({ enabled: true, index: { 'w1::1': { ...rec, t: 'rule' } }, types: [{ id: 'rule', name: '规则', instruction: '  ' }], globalTemplate: '通用 {digest}' });
check('这一类没填问法：退回上面的通用判定问法', blank(entry({ uid: 1 })).template, '通用 {digest}');
console.log('===== 4. 这一趟要问谁 =====');
const e1 = entry({ uid: 1 }), e2 = entry({ uid: 2, comment: '乙' }), e3 = entry({ uid: 3, comment: '丙' });
const fp = (e) => idx.entryFingerprint(e);
const seeded = { 'w1::1': { s: '甲', t: 'item', h: fp(e1), at: 1 }, 'w1::2': { s: '乙', t: 'rule', h: 'old-old', at: 1 }, 'w9::9': { s: '幽灵', t: 'item', h: 'x', at: 1 } };
const plan = idx.planIndex([e1, e2, e3], seeded, types);
check('内容没变的跳过、改过和没建过的都要问', [plan.total, plan.todo.map(e => e.uid), plan.fresh], [3, [2, 3], 1]);
check('条目已经不在了 = 失效项（清索引按钮用这个）', plan.stale, ['w9::9']);
check('分类被删了 = 单独一趟「重建失效分类」，摘要本身还能用',
    idx.planIndex([e1], { 'w1::1': { s: '甲', t: 'no_such', h: fp(e1), at: 1 } }, types).reclassify.map(e => e.uid), [1]);

// 10-13 用户选 B：打包依据从「几条」换成「多少字」，条数退成第二道硬顶
truthy('字数算的是「送给模型的那段材料」：标题＋关键词＋正文（正文只读到上限，超出部分不占预算）',
    [idx.indexEntryCost(e1), idx.indexEntryCost(entry({ content: '字'.repeat(500) }), { contentLimit: 200 })], [30, 3 + 5 + 200 + 12]);
check('空队列不产生批次（不能有空气泡）', idx.packIndexBatches([], { batchChars: 6000, batchSize: 20 }), []);
const short = [1, 2, 3, 4, 5, 6].map(uid => entry({ uid, comment: `短${uid}`, content: '一句话。' }));
check('短条目按字数根本切不动，是条数那道硬顶在切（失败是整批记账，所以留着）',
    idx.packIndexBatches(short, { batchChars: 6000, batchSize: 2 }).map(b => b.length), [2, 2, 2]);
const longOnes = [1, 2, 3].map(uid => entry({ uid, comment: `长${uid}`, content: '字'.repeat(900) }));
check('长条目一批塞不下：字数先到，条数还没到',
    idx.packIndexBatches(longOnes, { batchChars: 1000, batchSize: 20 }).map(b => b.map(e => e.uid)), [[1], [2], [3]]);
check('一条自己就超字数限制 = 单独成批，不能被永远挤出批次',
    idx.packIndexBatches([entry({ uid: 7, comment: '超长', content: '字'.repeat(5000) }), e1], { batchChars: 1000, batchSize: 20 })
        .map(b => b.map(e => e.uid)), [[7], [1]]);
check('打包用的是同一份数值口径（contentLimit 会影响每条占多少字）',
    idx.packIndexBatches(longOnes, { batchChars: 1000, batchSize: 20, contentLimit: 200 }).map(b => b.length), [3]);

console.log('===== 5. 建索引的提示词 =====');
const vars = { types: '人物、其他', count: '2', entries: '正文块', limit: '60', otherName: '其他' };
truthy('空模板用内置默认', idx.renderIndexPrompt('', vars).includes('【可选分类】'));
check('占位符都替换得到', idx.renderIndexPrompt('类型{types}｜{count}条｜{limit}字｜{otherName}｜{entries}', vars), '类型人物、其他｜2条｜60字｜其他｜正文块');
check('模板漏了 {entries} 会自动补在末尾（不然等于没喂条目）',
    idx.renderIndexPrompt('请摘要。', { ...vars, entries: 'E' }).endsWith('【条目】\nE'), true);
truthy('拼错的占位符原样留着，方便发现', idx.renderIndexPrompt('这里要写 {entrise}', vars).includes('{entrise}'));

const long = entry({ uid: 4, comment: '长条目', content: '字'.repeat(300) });
const built = idx.buildIndexPrompt([e1, long], { types, summaryLimit: 60, contentLimit: 200 });
truthy('每条带编号、标题、关键词', built.user.includes('1. 标题：旧铁剑｜关键词：铁剑、武器\n正文：一把会说话的旧铁剑。'));
check('正文超上限：只读前半段并把这条点名出来', [built.labels, built.user.includes('…（正文过长，已截断）')], [['长条目'], true]);
check('系统提示词：清空回内置，填了用填的', [idx.buildIndexPrompt([], { types }).system === idx.DEFAULT_INDEX_SYSTEM_PROMPT, idx.buildIndexPrompt([], { types, systemPrompt: '自定义' }).system], [true, '自定义']);
truthy('{otherName} 用的是「其他」当前的名字（用户改了名也跟着改）',
    idx.buildIndexPrompt([], { types: idx.normalizeTypes([{ id: 'other', name: '拿不准' }]) }).user.includes('「拿不准」'));

// 10-11 用户选 A：摘要口径统一改成「先写触发时机，再说它是什么」，索引结构一个字不动
truthy('内置系统提示词先建立认知：这句是给「要不要注入」的判定读的，不是剧情概括，且触发只写一个',
    idx.DEFAULT_INDEX_SYSTEM_PROMPT.includes('检索标注员')
    && idx.DEFAULT_INDEX_SYSTEM_PROMPT.includes('你为条目写的摘要会被一个模型用来判断是否需要注入系统提示词')
    && idx.DEFAULT_INDEX_SYSTEM_PROMPT.includes('不要写成剧情概括')
    && idx.DEFAULT_INDEX_SYSTEM_PROMPT.includes('什么时候用只写一个最主要的触发'));
truthy('内置模板的 summary 那行给死了顺序：这是什么→一个主触发→状态',
    idx.DEFAULT_INDEX_TEMPLATE.includes('**这是什么**（类型＋名字／关系')
    && idx.DEFAULT_INDEX_TEMPLATE.includes('**一个主触发**') && idx.DEFAULT_INDEX_TEMPLATE.includes('现在什么状态'));
truthy('内置模板单独一条禁「罗列情况」（10-11 实测：AI 把人物设定写成六种场景，挤掉了名字和关系）',
    idx.DEFAULT_INDEX_TEMPLATE.includes('主触发只写一个') && idx.DEFAULT_INDEX_TEMPLATE.includes('出场、独处、被忽略、身体描写时'));
truthy('内置模板禁掉放之四海都成立的空话（「相关时使用」判定时验证不了）',
    idx.DEFAULT_INDEX_TEMPLATE.includes('空话') && idx.DEFAULT_INDEX_TEMPLATE.includes('相关时使用'));
truthy('内置模板开头那段先讲清「这份索引之后怎么用」（认知建在动笔前）',
    idx.DEFAULT_INDEX_TEMPLATE.startsWith('【这份索引之后怎么用】')
    && idx.DEFAULT_INDEX_TEMPLATE.includes('你写的 summary 会被一个模型用来判断是否需要注入系统提示词')
    && idx.DEFAULT_INDEX_TEMPLATE.includes('不是剧情概括'));
truthy('露骨描写那条改口径成「给检索做标注，不是创作」（照实概括，不回避）',
    idx.DEFAULT_INDEX_TEMPLATE.includes('给检索做标注') && idx.DEFAULT_INDEX_TEMPLATE.includes('照实概括'));

console.log('===== 6. 回行解析与合并 =====');
const p1 = idx.parseIndexLines('{"id":1,"summary":"会说话的旧铁剑","type":"人物"}\n{"id":2,"summary":"海边","type":"地点"}');
check('标准 JSON 行', [p1.items, p1.bad], [[{ id: 1, summary: '会说话的旧铁剑', type: '人物' }, { id: 2, summary: '海边', type: '地点' }], 0]);
const p2 = idx.parseIndexLines('```json\n1. {"id":1,"summary":"甲","type":"道具"}\n2、{"id":2,"summary":"乙"}\n```');
check('带代码围栏、带编号前缀也读得动', [p2.items.map(i => [i.id, i.summary, i.type]), p2.bad], [[[1, '甲', '道具'], [2, '乙', '']], 0]);
check('不是 JSON 但字段抠得出来 = 兜底能用', idx.parseIndexLines('"id": 3, "summary": "丙", "type": "其他"').items, [{ id: 3, summary: '丙', type: '其他' }]);
check('整行看不懂才算坏行', idx.parseIndexLines('抱歉，我不能总结这些内容。').bad, 1);
check('摘要为空的不收（等于没索引过，下次还会再问）', idx.parseIndexLines('{"id":1,"summary":"  "}'), { items: [], bad: 1 });
truthy('摘要里的换行压成空格', idx.parseIndexLines('{"id":1,"summary":"甲\\n乙","type":"道具"}').items[0].summary === '甲 乙');

const merged = { 'w1::1': { s: '旧', t: 'rule', h: 'keep', at: 1 } };
const r = idx.mergeIndexResults(merged, [e1, e2], [
    { id: 1, summary: '新摘要', type: '道具' },
    { id: 2, summary: '', type: '地点' },
    { id: 99, summary: '越界也要丢', type: '地点' },
], { types, now: 555 });
check('按本批编号对号：写进去的那条带指纹和时间',
    [merged['w1::1'].s, merged['w1::1'].t, merged['w1::1'].h === fp(e1), merged['w1::1'].at], ['新摘要', 'item', true, 555]);
check('空摘要的那条不写坏索引，并进失败清单', [r.written, merged['w1::2'], r.failed.map(f => f.reason)], [1, undefined, ['摘要为空']]);
truthy('失败清单要能告诉用户是哪一条', r.failed.some(f => f.label === '乙'));
truthy('越界 id 不会写坏别人的记录', !('99' in merged));
const pass2 = idx.mergeIndexResults({}, [e1, e2], [{ id: 1, summary: '甲', type: '人物' }], { types, now: 1 });
truthy('模型漏回一行的原因写清楚（下次点按钮只问没成功的）', pass2.failed[0].reason.includes('模型没回这一条'));
check('认不出的分类名归「其他」并计数',
    (() => { const t = {}; const g = idx.mergeIndexResults(t, [e1], [{ id: 1, summary: '甲', type: '外星科技' }], { types, now: 1 }); return [t['w1::1'].t, g.otherType]; })(),
    ['other', 1]);
console.log('===== 7. 手动建索引那一趟 =====');
const linesFor = (n) => Array.from({ length: n }, (_, i) => `{"id":${i + 1},"summary":"摘要${i + 1}","type":"人物"}`).join('\n');

// 全都建好且内容没变 = 一条请求都不发（这是「不会悄悄花钱」最硬的证据）
const freshRun = makeIndex({ entries: [e1], setting: { decision_entry_index: { 'w1::1': { s: '甲', t: 'character', h: fp(e1), at: 1 } } } });
const freshResult = await freshRun.mod.buildEntryIndex({});
check('没活干时 asked=0', [freshResult.asked, freshResult.written, freshResult.skipped, freshRun.log.asks.length], [0, 0, 1, 0]);
truthy('没活干要有说明，不是静默返回', freshRun.log.info.some(m => m.includes('没发请求')));

const run = makeIndex({ entries: [e1, e2, e3], setting: { decision_index_batch_size: 2 }, reply: (askNo) => linesFor(askNo === 1 ? 2 : 1) });
const progress = [];
const result = await run.mod.buildEntryIndex({ onProgress: (state) => progress.push(state) });
check('三条 / 单批条数 2 = 两次请求（字数没到顶，是条数在切），全写进去', [run.log.asks.length, result.asked, result.written, result.failed.length], [2, 3, 3, 0]);
check('默认走主 API（勾选「建索引用主 API」是默认值）', run.log.asks.map(a => a[0]), ['main', 'main']);
check('进度按批累加，最后一批 done=total', progress.map(p => [p.done, p.total, p.written]), [[2, 3, 2], [3, 3, 3]]);

// 10-13 用户选 B：真正的打包依据是字数。这三条按条数（20）根本不用切，按字数必须一条一趟
const fat = [1, 2, 3].map(uid => entry({ uid, comment: `长${uid}`, content: '字'.repeat(600) }));
const fatRun = makeIndex({ entries: fat, setting: { decision_index_batch_chars: 1, decision_index_batch_size: 20 }, reply: () => linesFor(1) });
const fatResult = await fatRun.mod.buildEntryIndex({});
check('字数到顶就先切，条数还没用满（最小夹到 500 字）', [fatRun.log.asks.length, fatResult.written, fatResult.failed.length], [3, 3, 0]);
const stored = run.setting.decision_entry_index;
check('索引落在插件设置里（不碰世界书文件）', [Object.keys(stored), stored['w1::1'].s, stored['w1::3'].t], [['w1::1', 'w1::2', 'w1::3'], '摘要1', 'character']);
truthy('每批之后都存一次盘（中途刷新只丢没跑的批次）', run.log.saved >= 2);
truthy('趟号写进设置，用来让旧缓存失效', typeof run.setting.decision_index_at === 'number' && run.setting.decision_index_at > 0);
truthy('提示词里带标题、关键词和正文', run.log.asks[0][2].includes('旧铁剑') && run.log.asks[0][2].includes('一把会说话的旧铁剑。'));
// 新插件把「查看上次 LLM 回复」也接到了建索引这一趟：跑砸了得能看到模型到底回了什么
check('每批各记一次开始／结束（两批 = 两对）', [run.log.replies.filter(r => r.kind === 'begin').length, run.log.replies.filter(r => r.kind === 'finish').length], [2, 2]);
truthy('记账时带上用途、通道和喂进去的提示词', run.log.replies[0].meta.purpose === '条目索引' && run.log.replies[0].meta.apiType === 'main' && run.log.replies[0].meta.promptText.includes('旧铁剑'));

const customApi = makeIndex({ entries: [e1], setting: { decision_index_use_main_api: false }, reply: () => linesFor(1) });
await customApi.mod.buildEntryIndex({});
check('不勾「用主 API」就走自定义独立 API 那套配置', customApi.log.asks.map(a => a[0]), ['custom']);

const refused = makeIndex({ entries: [e1, e2], reply: () => '抱歉，这段内容我没法总结。' });
const refusedResult = await refused.mod.buildEntryIndex({});
check('整批拒答：不写索引、逐条列进失败清单', [refusedResult.written, refusedResult.failed.length, Object.keys(refused.setting.decision_entry_index ?? {}).length], [0, 2, 0]);
truthy('拒答的原因要写在清单里，让用户知道下次可以再问', refusedResult.failed[0].reason.includes('解析不了'));

const crashed = makeIndex({ entries: [e1], throwOn: 1, throwMessage: '401 Unauthorized' });
const crashedResult = await crashed.mod.buildEntryIndex({});
check('请求本身失败也算失败项，不炸整趟', [crashedResult.written, crashedResult.failed[0].reason.includes('401')], [0, true]);

const tooLong = makeIndex({ entries: [entry({ uid: 5, comment: '长条', content: '字'.repeat(500) })], setting: { decision_index_content_limit: 200 }, reply: () => linesFor(1) });
const longResult = await tooLong.mod.buildEntryIndex({});
check('正文被截断的条目要出现在结果里（摘要只读了前半段）', [longResult.written, longResult.failed.map(f => `${f.label}|${f.reason}`)], [1, ['长条|正文超过 200 字，只摘了前半段']]);

const slowRun = makeIndex({ entries: [e1, e2], reply: () => new Promise(resolve => setTimeout(() => resolve(linesFor(2)), 30)) });
const firstPass = slowRun.mod.buildEntryIndex({});
await new Promise(resolve => setTimeout(resolve, 5));   // 等第一趟真的进到请求阶段（前面还要 await 一次读条目）
const runningNow = slowRun.mod.isIndexRunning();
const secondResult = await slowRun.mod.buildEntryIndex({});
check('跑的过程中按钮该变灰、第二次点直接挡掉', [runningNow, secondResult, slowRun.log.asks.length], [true, null, 1]);
truthy('双开时给一句解释', slowRun.log.warning.some(m => m.includes('已经在建索引了')));
await firstPass;
check('这一趟跑完就不算在跑了', slowRun.mod.isIndexRunning(), false);
const reRun = makeIndex({
    entries: [e1, e2],
    setting: { decision_entry_index: { 'w1::1': { s: '甲', t: 'no_such_type', h: fp(e1), at: 1 }, 'w1::2': { s: '乙', t: 'character', h: fp(e2), at: 1 } } },
    reply: () => linesFor(1),
});
const reResult = await reRun.mod.buildEntryIndex({ scope: 'reclassify' });
check('「重建失效分类」只问那一类被删掉的条目', [reResult.asked, reRun.log.asks.length, reRun.setting.decision_entry_index['w1::1'].t], [1, 1, 'character']);
const reEmpty = makeIndex({ entries: [e1], setting: { decision_entry_index: { 'w1::1': { s: '甲', t: 'character', h: fp(e1), at: 1 } } } });
check('没有失效分类时点它也不花钱', [(await reEmpty.mod.buildEntryIndex({ scope: 'reclassify' })).asked, reEmpty.log.asks.length, reEmpty.log.info.some(m => m.includes('分类失效'))], [0, 0, true]);

// ---- 「让 LLM 全填」：内容没变、甚至是手写的，也一条不跳
const allRun = makeIndex({
    entries: [e1, e2],
    setting: { decision_entry_index: { 'w1::1': { s: '我手写的摘要', t: 'item', h: fp(e1), at: 1, m: 1 } } },
    reply: () => linesFor(2),
});
const allResult = await allRun.mod.buildEntryIndex({ scope: 'all' });
check('「全填」把填好的也重问，跳过的条数写成 0', [allResult.asked, allRun.log.asks.length, allResult.skipped], [2, 1, 0]);
check('手写的会被 LLM 摘要盖掉，m 标记一起没', [allRun.setting.decision_entry_index['w1::1'].s, allRun.setting.decision_entry_index['w1::1'].m], ['摘要1', undefined]);

// ---- 「让 LLM 填勾中的」：勾了就问，没勾的一条不动
const pickRun = makeIndex({
    entries: [e1, e2],
    setting: { decision_entry_index: { 'w1::1': { s: '旧摘要', t: 'item', h: fp(e1), at: 1 }, 'w1::2': { s: '别动我', t: 'item', h: fp(e2), at: 1 } } },
    reply: () => linesFor(1),
});
const pickResult = await pickRun.mod.buildEntryIndex({ keys: ['w1::1'] });
check('勾中的即使指纹没变也重问，没勾的原样留着', [pickResult.asked, pickRun.setting.decision_entry_index['w1::1'].s, pickRun.setting.decision_entry_index['w1::2'].s], [1, '摘要1', '别动我']);
const pickGone = makeIndex({ entries: [e1], setting: {}, reply: () => linesFor(1) });
const goneResult = await pickGone.mod.buildEntryIndex({ keys: ['w1::404'] });
check('勾的那几条不在清单里了：不发请求，只说一句', [goneResult.asked, pickGone.log.asks.length, pickGone.log.info.some(m => m.includes('没发请求'))], [0, 0, true]);

// ---- 结果文案（嵌在填写弹窗里，不再是第二层弹窗）
const outcomeHtml = idx.indexOutcomeHtml({ asked: 3, written: 2, failed: [{ label: '旧铁剑', reason: '整批 3 行都解析不了（可能拒答）' }], stale: 1, skipped: 1 });
truthy('成功几条、失败几条要写在最上面', outcomeHtml.includes('这一趟问了 3 条') && outcomeHtml.includes('写入 2 条'));
truthy('失败清单逐条点名，还能折叠', outcomeHtml.includes('旧铁剑') && outcomeHtml.includes('整批 3 行都解析不了') && outcomeHtml.includes('<details>'));
truthy('内容没变的条数只在有的时候提（全填那趟不该出现「跳过 0 条」）', [idx.indexOutcomeHtml({ asked: 2, written: 2, failed: [], stale: 0, skipped: 0 }).includes('没重问'), outcomeHtml.includes('另有 1 条内容没变')], [false, true]);
truthy('条目没了留下的尾巴要提一句', outcomeHtml.includes('清理失效项'));
truthy('全没问题时不摆空表格', idx.indexOutcomeHtml({ asked: 1, written: 1, failed: [], stale: 0, skipped: 0 }).includes('失败 0 条'), true);

console.log('===== 8. 概况与清失效项 =====');
const overviewSetting = { decision_entry_index: {
    'w1::1': { s: '甲', t: 'character', h: 'x', at: 10 },
    'w1::2': { s: '乙', t: 'character', h: 'y', at: 20 },
    'w1::3': { s: '丙', t: 'removed_type', h: 'z', at: 5 },
} };
const overview = idx.indexOverview(overviewSetting);
check('概况：条数、按类计数、失效分类数、上次时间', [overview.records, overview.byType, overview.invalid, overview.lastAt],
    [3, [{ name: '人物', count: 2 }, { name: '其他', count: 1 }], 1, 20]);
check('空索引的概况', [Object.keys(idx.normalizeIndex({})).length, idx.indexOverview({}).records], [0, 0]);

const pruneRun = makeIndex({ entries: [e1], setting: { decision_entry_index: { 'w1::1': { s: '甲', t: 'item', h: 'x', at: 1 }, 'w1::9': { s: '尾巴', t: 'item', h: 'x', at: 1 } } } });
const pruned = await pruneRun.mod.pruneStaleIndex();
check('删掉的条目留下的索引能清掉', [pruned.removed, pruned.kept, Object.keys(pruneRun.setting.decision_entry_index)], [1, 1, ['w1::1']]);
const pruneIdle = makeIndex({ entries: [e1], setting: { decision_entry_index: { 'w1::1': { s: '甲', t: 'item', h: 'x', at: 1 } } } });
check('没尾巴时不动盘、只说一句', [(await pruneIdle.mod.pruneStaleIndex()).removed, pruneIdle.log.saved, pruneIdle.log.info.length], [0, 0, 1]);

console.log('===== 9. 分类编辑页（独立弹窗）与接线 =====');
const typeUi = makeTypeUi({ setting: { decision_entry_types: [], decision_entry_index: { 'w1::1': { s: '甲', t: 'character', h: 'x', at: 1 }, 'w1::2': { s: '乙', t: 'gone', h: 'y', at: 2 } } } });
const tIdx = typeUi.idx;
const builtTypes = tIdx.normalizeTypes([]);
const builtCounts = tIdx.countIndexByType(builtTypes, typeUi.setting.decision_entry_index);
check('每类的条数按分类记，认不出的并进「其他」（判定时走的就是它的问法）',
    [builtCounts.find(i => i.id === 'character').count, builtCounts.find(i => i.id === 'other').count, builtCounts.reduce((s, i) => s + i.count, 0)], [1, 1, 2]);
check('countIndexByType 的顺序跟 types 一致（行和摘要都靠这个对位）', builtCounts.map(i => i.id), builtTypes.map(i => i.id));
check('空索引全是 0，不会漏类也不会多出类', tIdx.countIndexByType(builtTypes, {}).map(i => i.count), [0, 0, 0, 0, 0, 0, 0]);

const rows = typeUi.mod.renderDecisionTypeRowsHtml(builtTypes, builtCounts);
truthy('每一类一行，名字可改、问法可编辑', rows.includes('class="decision-type-row"') && rows.includes('decision-type-name') && rows.includes('decision-type-instruction'));
truthy('每行把「这一类下几条」显示出来（搬进弹窗后得自己看得见账）', rows.includes('这一类 1 条'));
truthy('「其他」的删除按钮是禁用状态（兜底分类删不掉）', /decision-type-delete[^>]*disabled/.test(rows));
check('内置 7 类 = 7 个删除按钮', (rows.match(/decision-type-delete/g) || []).length, 7);
truthy('删除的确认就在这一行里展开（叠第二层弹窗会把这页关掉）', rows.includes('class="decision-type-confirm"'));
truthy('自定义类的问法原样显示在 textarea 里', typeUi.mod.renderDecisionTypeRowsHtml([{ id: 'x', name: '甲', instruction: '专属问法 {digest}' }], []).includes('专属问法 {digest}'));
truthy('新类 id 是时间戳打头，不会撞内置的 character/rule', /^c[0-9a-z]{6,}$/.test(tIdx.makeTypeId()));

const summary = typeUi.mod.describeDecisionTypes(builtTypes, builtCounts);
truthy('设置页那一行摘要带类名和条数', summary.includes('共 7 类') && summary.includes('人物 1') && summary.includes('其他 1'));
check('内置 7 类都写了专属问法，所以不提「没写」', summary.includes('没写专属问法'), false);
truthy('有一类留空就点出来有几类在走通用问法',
    typeUi.mod.describeDecisionTypes([{ id: 'x', name: '甲', instruction: '' }, builtTypes[6]], []).includes('1 类没写专属问法'), true);
truthy('摘要指到那颗按钮', summary.includes('点左边那颗按钮改'));
truthy('一条都没索引时不会写出「0 条」这种废话', !typeUi.mod.describeDecisionTypes(builtTypes, tIdx.countIndexByType(builtTypes, {})).includes('人物 0'));

const savedBefore = typeUi.log.saved;
truthy('改问法当场落盘', typeUi.mod.editDecisionType('character', 'instruction', '改过的问法'));
check('落了一次盘、值真的进了设置', [typeUi.log.saved - savedBefore, tIdx.normalizeTypes(typeUi.setting.decision_entry_types).find(t => t.id === 'character').instruction], [1, '改过的问法']);
truthy('名字也能改，索引记录认的是 id 所以不会失联',
    [typeUi.mod.editDecisionType('character', 'name', '主要人物'), Object.keys(typeUi.setting.decision_entry_index).length], [true, 2]);
const added = typeUi.mod.addDecisionType();
check('新增一类插在「其他」前面（兜底那类永远在最后）', tIdx.normalizeTypes(typeUi.setting.decision_entry_types).slice(-2).map(t => t.id), [added.id, 'other']);
truthy('删掉刚建的那一类', typeUi.mod.removeDecisionType(added.id).removed);
check('设置里真的没有它了', tIdx.normalizeTypes(typeUi.setting.decision_entry_types).some(t => t.id === added.id), false);
const beforeOtherTry = typeUi.log.saved;
const otherDelete = typeUi.mod.removeDecisionType('other');
check('「其他」删不掉，问法可以改', [otherDelete.removed, otherDelete.other], [false, true]);
check('删不掉的这一次没落盘，兜底那类也还在最后',
    [typeUi.log.saved - beforeOtherTry, tIdx.normalizeTypes(typeUi.setting.decision_entry_types).slice(-1)[0].id], [0, 'other']);
check('改一个不存在的 id 什么都不写', [typeUi.mod.editDecisionType('没有这一类', 'name', '甲'), typeUi.mod.removeDecisionType('没有这一类').removed], [false, false]);

const settingSrc = read('data/pluginSetting.js');
check('默认值：索引档开着、索引为空', [settingSrc.includes('decision_index_enabled: true'), settingSrc.includes('decision_entry_index: {}'), settingSrc.includes('decision_index_use_main_api: true')], [true, true, true]);
truthy('分类表默认空数组 = 用内置分类（不在这儿 import，免得绕成循环依赖）', /decision_entry_types:\s*\[\]/.test(settingSrc));

const tplSrc = read('assets/templates/index.html');
truthy('设置页有开关、四个数；走主 API 那颗并到 ④ 顶上了，索引档不再自己摆一颗',
    ['#dlb_index_enabled', '#dlb_index_summary_limit', '#dlb_index_content_limit', '#dlb_index_batch_chars', '#dlb_index_batch_size', '#dlb_llm_use_main_api']
        .every(id => tplSrc.includes(`id="${id.slice(1)}"`))
    && !tplSrc.includes('id="dlb_index_use_main_api"'));
truthy('③ 那两颗叫「条目摘要字数限制／读条目正文上限」（名字里点清读的是条目，不是聊天楼层）',
    tplSrc.includes('>条目摘要字数限制<br>') && tplSrc.includes('>读条目正文上限<br>')
    && !tplSrc.includes('>摘要字数<br>') && !tplSrc.includes('>读正文上限<br>'));
truthy('③ 打包那两颗叫「单批字数限制／单批条数上限」（字数是真正的依据，条数只是第二道硬顶）',
    tplSrc.includes('>单批字数限制<br>') && tplSrc.includes('>单批条数上限') && !tplSrc.includes('>单批条目<br>'));
check('默认值：字数 6000 当打包依据、条数 20 当硬顶、页面 max 跟代码夹一致（50）',
    [settingSrc.includes('decision_index_batch_chars: 6000'), settingSrc.includes('decision_index_batch_size: 20'),
        idx.INDEX_MAX_BATCH_SIZE, tplSrc.includes('id="dlb_index_batch_size" class="text_pole" min="1" max="50"')],
    [true, true, 50, true]);
truthy('页面上不吹没实测过的模型能力（旧的「批次大了摘要质量会掉」那句页面和注释都删干净了）',
    !tplSrc.includes('批次大了') && !read('scripts/runtime/decisionEntryIndex.js').includes('批次大了'));
truthy('三个按钮 + 分类编辑入口 + 分类摘要 + 统计位都在', ['#dlb_index_manual_button', '#dlb_index_prune_button', '#dlb_index_stats_button', '#dlb_type_edit_button', '#dlb_type_summary', '#dlb_index_stats']
    .every(id => tplSrc.includes(`id="${id.slice(1)}"`)));
truthy('分类那一长串编辑行和「添加分类」不再铺在设置页（整屏都被它撑满了）',
    !tplSrc.includes('id="dlb_type_rows"') && !tplSrc.includes('decision_type_add_button') && !tplSrc.includes('decision-type-name'), true);
truthy('发请求的两颗按钮和进度条从页面上消失了（入口只剩弹窗）',
    !tplSrc.includes('decision_index_build_button') && !tplSrc.includes('decision_index_reclassify_button') && !tplSrc.includes('decision_index_progress'));
truthy('两份提示词搬进 ⑤ 提示词档（仍在设置页），placeholder 写着留空用内置',
    tplSrc.indexOf('id="dlb_index_system_prompt"') > tplSrc.indexOf('<b>⑤ 提示词')
    && tplSrc.indexOf('id="dlb_index_template"') < tplSrc.indexOf('<b>⑥ 正文/条目作为参考时</b>')
    && tplSrc.includes('留空使用内置默认'));
truthy('文案说清「摘要只影响怎么问，强推还是发完整原文」', tplSrc.includes('摘要只影响'));
truthy('文案把「去哪儿弄索引」指到工作台那一页', tplSrc.includes('「填写条目索引」'));
truthy('默认口径写在页面上：说明里那句「这是默认打法」＋条目原文是补充那一档（那颗勾选的名字后面不再挂「默认开启」）',
    tplSrc.includes('这是默认打法') && tplSrc.includes('条目原文是补充那一档')
    && !tplSrc.includes('判条目（默认开启）'));

const typeSrc = read('scripts/runtime/decisionTypeEditor.js');
truthy('编辑页自己带那份分类行模板（id 还是那个 id，只是搬进弹窗）', typeSrc.includes('id="dlb_type_rows"') && typeSrc.includes('decision-type-add'));
truthy('原来那段「改名不会让索引失效」的说明跟着搬进弹窗', typeSrc.includes('名字随便改，改名字不会让已经建好的索引失效') && typeSrc.includes('删掉一类时'));
truthy('弹窗里一个字都不发请求（既不碰 LLM 那两个 handler，也不碰建索引那一趟）',
    !typeSrc.includes('handleMainAPIRequest') && !typeSrc.includes('handleCustomAPIRequest') && !typeSrc.includes('buildEntryIndex'));
truthy('行是重绘出来的，所以监听挂 document、关窗摘掉',
    typeSrc.includes("document.addEventListener('click', onClick, true)") && typeSrc.includes("document.removeEventListener('click', onClick, true)"));
truthy('打字即落盘，没有单独的「保存」那一步', !typeSrc.includes('decision-type-save') && typeSrc.includes("editDecisionType(target.dataset.id, 'name'"));
truthy('「其他」那颗删除钮点下去只提醒，不删', typeSrc.includes("classList.contains('disabled')") && typeSrc.includes('删不掉'));

const setSrc = read('scripts/settings/settings.js');
truthy('设置页彻底不驱动那一趟（不发请求、不锁控件）', !setSrc.includes('buildEntryIndex') && !setSrc.includes('isIndexRunning'));
truthy('开关开着但索引是空的要提醒一句', setSrc.includes('索引还是空的'));
truthy('设置页不再自己驱动分类行（绑定整个交给弹窗）',
    !setSrc.includes(".decision-type-name") && !setSrc.includes('renderDecisionTypeRowsHtml') && !setSrc.includes('makeTypeId'));
truthy('点按钮切到工作台那一页、落定后重绘摘要', setSrc.includes("openPage('types')") && setSrc.includes("$('#dlb_type_edit_button').on('click'"));
truthy('回填时数字走 readIndexNumbers、提示词空着显示内置默认', setSrc.includes('readIndexNumbers(setting)') && setSrc.includes('|| DEFAULT_INDEX_SYSTEM_PROMPT') && setSrc.includes('|| DEFAULT_INDEX_TEMPLATE'));
truthy('统计和删分类的说明都指到弹窗里那颗按钮', setSrc.includes('到「填写条目索引」里点「重建失效分类」'));

const routerSrc = read('scripts/runtime/lorebookRouter.js');
truthy('路由把材料选择器传给 buildQuestions（第 5 个参数）', /buildQuestions\([^)]*materialFor\)/.test(routerSrc));
truthy('路由的候选口径和建索引共用一个函数', routerSrc.includes('filterDecisionEntries(await getSortedEntries())') || routerSrc.includes('filterDecisionEntries(entries)'));
truthy('缓存键带趟号，刚重建过索引不会复用旧判定', routerSrc.includes('@@idx${config.indexAt}'));
truthy('开功能但一条索引都没有时要在报告里说', routerSrc.includes('index_empty') && routerSrc.includes('index_partial'));

const svcSrc = read('services/decisionApiService.js');
truthy('请求层拿到材料就用它，拿不到退回正文片段', svcSrc.includes('material?.digest || buildEntryDigest') && svcSrc.includes('material?.template || instructionTemplate'));
truthy('map 里记下这条是不是按索引判的（报告和小栏要用）', /indexed: !!material\?\.indexed/.test(svcSrc));

console.log('===== 10. 手填条目索引（逐条自己写，不发请求）=====');
const manualFillMod = makeIndex({ entries: [e1], setting: {} });
const manualSavedRecord = manualFillMod.mod.saveManualIndex(e1, '  一把会说话的旧铁剑，\n替主角挡过一次箭  ', 'character').record;
check('手填：换行压成一个空格、认分类、打上手填标记', [manualSavedRecord.s, manualSavedRecord.t, manualSavedRecord.m], ['一把会说话的旧铁剑， 替主角挡过一次箭', 'character', 1]);
truthy('指纹按「当前正文」算 = LLM 那一趟认为内容没变，不会来覆盖你写的', manualSavedRecord.h === idx.entryFingerprint(e1));
truthy('填一条就落一次盘（不用等按钮、不用跑一趟）', manualFillMod.log.saved >= 1);
check('手填记录和 LLM 摘要共用同一条判定通道（digest 一模一样）',
    idx.indexedDigest(e1, manualSavedRecord, 60), idx.indexedDigest(e1, { s: manualSavedRecord.s, t: 'character' }, 60));
const manualFillPlan = idx.planIndex([e1, e2], idx.normalizeIndex(manualFillMod.setting.decision_entry_index), idx.normalizeTypes([]));
check('手填过的那条算「已经弄好」，建索引只问没填的', [manualFillPlan.fresh, manualFillPlan.todo.map(item => item.uid)], [1, [2]]);
const editedPlan = idx.planIndex([{ ...e1, content: '正文改过了' }, e2], idx.normalizeIndex(manualFillMod.setting.decision_entry_index), idx.normalizeTypes([]));
check('改了条目正文才会重新进待办', editedPlan.todo.map(item => item.uid), [1, 2]);

const blankFill = makeIndex({ entries: [e1], setting: {} });
const blankResult = blankFill.mod.saveManualIndex(e1, '   ', 'item');
check('摘要空着不许保存：不写索引、不落盘', [blankResult.record, blankFill.setting.decision_entry_index, blankFill.log.saved], [null, undefined, 0]);
truthy('空摘要要给一句人话', blankResult.reason.includes('空的'));
const badType = makeIndex({ entries: [e1], setting: {} });
check('分类认不出就落「其他」，免得写出一个没有问法的类', badType.mod.saveManualIndex(e1, '甲', 'no_such_type').record.t, 'other');

const cleared = makeIndex({ entries: [e1], setting: {} });
cleared.mod.saveManualIndex(e1, '甲', 'item');
check('清除：删掉记录并落盘', [cleared.mod.clearIndexRecord('w1', 1), Object.keys(cleared.setting.decision_entry_index).length, cleared.log.saved], [true, 0, 2]);
check('没填过也就没什么可删的', [cleared.mod.clearIndexRecord('w1', 1), cleared.log.saved], [false, 2]);

check('规整索引时手填标记要留着（丢了就没法显示「你写的」）',
    idx.normalizeIndex({ 'w1::1': { s: '甲', t: 'item', h: 'x', at: 1, m: 1 }, 'w1::2': { s: '乙', t: 'item', h: 'y', at: 1 } }),
    { 'w1::1': { s: '甲', t: 'item', h: 'x', at: 1, m: 1 }, 'w1::2': { s: '乙', t: 'item', h: 'y', at: 1 } });
const mixedOverview = idx.indexOverview({ decision_entry_index: { 'w1::1': { s: '甲', t: 'item', h: 'x', at: 1, m: 1 }, 'w1::2': { s: '乙', t: 'item', h: 'y', at: 2 } } });
check('概况里单列出手填了几条', [mixedOverview.records, mixedOverview.manual], [2, 1]);

const guideText = idx.MANUAL_INDEX_GUIDE;
truthy('参考模板把七类各给一条范例', ['人物：', '地点：', '道具：', '事件：', '组织势力：', '设定规则：', '其他：'].every(word => guideText.includes(word)));
truthy('范例用全角｜分格，跟摘要的实际形状一致', guideText.includes('｜'));
truthy('参考模板第一句先建立认知：这句是判断「要不要注入」的唯一依据，不是剧情概括',
    guideText.startsWith('先弄清这句是干什么的：世界书原文平时不发给 AI') && guideText.includes('用处说明') && guideText.includes('不是剧情概括'));
truthy('参考模板给的顺序是「这是什么→一个主触发→状态」（用户 10-11 指定的形状）',
    guideText.includes('顺序：这是什么（类型＋名字／关系）→ 一个主触发') && guideText.includes('现在什么状态'));
truthy('参考模板拿一条人物设定当正例：内容｜触发（示例名字必须是编的，不能带用户自己的卡）',
    guideText.includes('老周的人物设定（主角的师父，两人已断绝来往）｜他登场或被提及时'));
truthy('七类范例都排成「内容｜触发」，触发一律在第二格、且只有一个',
    ['｜他登场或被提及时', '｜剧情移到海边或有人提到它时', '｜这件东西出现或被提及时', '｜谈到被搜一事或被牵连时', '｜卫兵出现或被通缉牵涉时', '｜角色入水或被印记标过时'].every(t => guideText.includes(t)));
truthy('参考模板把「罗列六种场景」写成反例并说清代价（挤掉名字和关系）',
    guideText.includes('主触发只写一个') && guideText.includes('出场、独处、被忽略、身体描写时') && guideText.includes('挤掉'));
const manualRow = idx.manualIndexRowHtml(e1, manualSavedRecord, idx.normalizeTypes([]), 60);
truthy('一行里有勾给「填勾中的」用、原文（默认收着）、摘要框、分类下拉、保存和清除',
    ['manual-index-pick', 'manual-index-content', 'manual-index-summary', 'manual-index-type', 'manual-index-save', 'manual-index-clear'].every(name => manualRow.includes(name)));
check('已有记录时摘要原样回填进输入框', /manual-index-summary[^>]*>([\s\S]*?)<\/textarea>/.exec(manualRow)?.[1], manualSavedRecord.s);
truthy('手填过的显示「你写的」，LLM 写的显示出来区分得开', manualRow.includes('已填（你写的）') && idx.manualIndexRowHtml(e1, { s: '乙', t: 'item', h: 'x', at: 1 }, idx.normalizeTypes([]), 60).includes('已填（LLM 写的）'));
truthy('没填过的行带空标记和「没填」，筛选时能单独列', idx.manualIndexRowHtml(e2, undefined, idx.normalizeTypes([]), 60).includes('manual-index-empty'));
truthy('当前分类在下拉里是选中项', new RegExp(`value="character"[^>]*selected`).test(manualRow), true);
truthy('标题、关键词、世界书名都印在行上（书名要和索引键一致）', manualRow.includes('旧铁剑') && manualRow.includes('关键词：铁剑、武器') && manualRow.includes('data-world="w1"'));
truthy('正文里的尖括号被转义，不会把弹窗结构写坏', idx.manualIndexRowHtml(entry({ content: '<img src=x onerror=alert(1)>' }), undefined, [], 60).includes('&lt;img'), true);
truthy('摘要框的占位提示就是新口径（这是什么｜一个主触发｜状态）', manualRow.includes('placeholder="这是什么（类型＋名字／关系）｜一个主触发（什么时候用它，别罗列情况）｜现在什么状态"'));

const manualSrc = read('scripts/runtime/decisionEntryIndex.js');
truthy('手填弹窗开的时候不锁死页面：关掉之后要把 document 上的监听摘掉',
    /document\.addEventListener\('click', onClick, true\)/.test(manualSrc) && /document\.removeEventListener\('click', onClick, true\)/.test(manualSrc));
truthy('建索引正在跑的时候不许插手填（两边会互相盖掉）', /isIndexRunning\(\)[\s\S]{0,160}正在建索引/.test(manualSrc));
truthy('一屏渲染有上限，超了提示缩小范围', /MANUAL_INDEX_RENDER_LIMIT/.test(manualSrc) && manualSrc.includes('请再缩小范围'));
truthy('没保存的草稿要留着，筛选重绘不能把用户刚打的字清掉', manualSrc.includes('drafts.set') && manualSrc.includes('drafts.delete'));
truthy('保存超过上限要当场说清（判定时会被截断）', manualSrc.includes('判定时只取前'));
truthy('弹窗顶部那句说明先讲机制，再给顺序和一个主触发的红线',
    /先弄清这句是干什么的：世界书原文平时并不发给 AI[\s\S]{0,200}用处说明[\s\S]{0,160}先点明这是什么[\s\S]{0,160}一个主触发[\s\S]{0,200}主触发只写一个/.test(manualSrc));

const settingSrc2 = read('data/pluginSetting.js');
const tplSrc2 = read('assets/templates/index.html');
const setSrc2 = read('scripts/settings/settings.js');
truthy('「让 LLM 自动摘要」开关整个删掉了：默认值、页面、绑定、回填一处都不留',
    !settingSrc2.includes('decision_index_auto_llm') && !tplSrc2.includes('decision_index_auto_llm')
    && !setSrc2.includes('decision_index_auto_llm') && !tplSrc2.includes('decision_index_llm_only'));
truthy('按钮改名「填写条目索引」，旧的「手动填写条目索引」不再出现', tplSrc2.includes('填写条目索引') && !tplSrc2.includes('手动填写条目索引'));
truthy('设置页说明里也讲了新口径：先点明这是什么、再给一个主触发，判的是要不要注入系统提示词',
    tplSrc2.includes('先点明这是什么') && tplSrc2.includes('一个主触发') && tplSrc2.includes('这一条的用处说明')
    && tplSrc2.includes('而不是剧情概括') && tplSrc2.includes('决策模型拿它判断') && tplSrc2.includes('只写一个'));
truthy('请求模板的提示点名了内置默认那三段（含开头的认知段），提醒自定义时别删',
    tplSrc2.includes('【这份索引之后怎么用】') && tplSrc2.includes('先点明这是什么，再给一个主触发，主触发只写一个') && tplSrc2.includes('这是在给检索做标注'));
truthy('空索引的提示改口指弹窗', setSrc2.includes('点「填写条目索引」'));
truthy('手动按钮切到工作台那一页，落定（切完页或关窗）后刷新统计',
    /#dlb_index_manual_button'\)\.on\('click', openPage\('index'\)/.test(setSrc2)
    && /const openPage = \(key\) => \(\) => openDecisionWorkbench\(key\)\.then\(\(\) => renderDecisionIndex\(\)\)/.test(setSrc2));

truthy('弹窗里有四颗让 LLM 填的按钮（勾中的 / 补没填的 / 全填 / 重建失效分类）',
    ['.manual-index-llm-picked', '.manual-index-llm-missing', '.manual-index-llm-all', '.manual-index-llm-reclassify'].every(name => manualSrc.includes(name)));
truthy('每行一个勾给「填勾中的」用，外加「全选这一屏」（控件 id 带 dlb_ 前缀，别和原插件串）',
    manualSrc.includes('manual-index-pick') && manualSrc.includes('dlb_manual_index_pick_all'));
truthy('重绘时把勾原样恢复（筛一下再筛回来不该把勾洗掉）', /row\.querySelector\('\.manual-index-pick'\)\.checked = picked\.has\(key\)/.test(manualSrc));
truthy('四颗按钮分别走 buildEntryIndex 的 keys / missing / all / reclassify 四档',
    /runLlmPass\(\{ keys: \[\.\.\.picked\] \}\)/.test(manualSrc) && /runLlmPass\(\{ scope: 'missing' \}\)/.test(manualSrc)
    && /runLlmPass\(\{ scope: 'reclassify' \}\)/.test(manualSrc) && /runLlmPass\(\{ scope: 'all' \}\)/.test(manualSrc));
truthy('「全填」先就地弹一次确认，点确认才真发请求', manualSrc.includes('armFullRefill') && manualSrc.includes('manual-index-confirm-yes'));
truthy('确认条里写清会盖掉几条手写的', manualSrc.includes('条摘要会被盖掉'));
truthy('一条都没勾就点「填勾中的」只提示、不发请求', manualSrc.includes('一条都没勾'));
truthy('跑的时候四颗按钮变灰、进度写在上面', manualSrc.includes('setLlmButtons') && manualSrc.includes('已处理'));
truthy('一趟跑完清空草稿和勾、重绘列表（LLM 的摘要已经盖在行上了）', /drafts\.clear\(\)[\s\S]{0,120}picked\.clear\(\)[\s\S]{0,120}renderRows\(\)/.test(manualSrc));
truthy('结果嵌在本弹窗里显示，不再套第二层弹窗', manualSrc.includes('indexOutcomeHtml(result)') && !manualSrc.includes('showIndexOutcome'));
truthy('文案说清「补没填的」不动手写的、只有「全填」会盖掉', manualSrc.includes('「补没填的」不会动你手写的') && manualSrc.includes('「全填」会把手写的盖掉'));

console.log('\n===== 11. 索引文件的导出 / 导入（纯本机操作，一个请求都不发）=====');
// 索引只活在 settings.json 里，不跟着世界书/角色卡文件走；这两颗按钮把它变成一份可带走的 JSON。
const fileRecords = {
    'w1::1': { s: '文件里的摘要', t: 'item', h: 'aaaa1111', at: 100 },
    'w1::2': { s: '   ', t: 'item', h: 'bbbb2222', at: 200 },
    'w9::7': { s: '别本书的条目', t: 'no_such_type', h: 'cccc3333', at: 300, m: 1 },
};
const expSetting = { decision_entry_index: { ...fileRecords, 'w1::4': { s: '甲', t: 'character', h: 'x', at: 1 } } };
const exported = idx.buildIndexExport(expSetting);
check('导出：认得出标识、带版本和分类表', [exported.kind, exported.version, exported.types.map(t => t.id)],
    ['st-memory-enhancement.decision_index', 1, ['character', 'place', 'item', 'event', 'org', 'rule', 'other']]);
check('导出的字段就这五个：不夹带条目正文，更不夹带任何密钥', Object.keys(exported).sort(),
    ['exported_at', 'index', 'kind', 'types', 'version']);
check('空摘要的记录不会被带进文件（读回来也是丢）', [Object.keys(exported.index).sort(), Object.keys(exported.index['w1::1']).sort()],
    [['w1::1', 'w1::4', 'w9::7'], ['at', 'h', 's', 't']]);
truthy('文件名带时间戳，导两次不会互相盖', /^decision-index-\d{8}-\d{6}\.json$/.test(idx.indexFileName(1760000000000)));

const parsed = idx.parseIndexFile(JSON.stringify({ kind: idx.INDEX_FILE_KIND, version: 1, index: fileRecords }));
check('读回来：一条空摘要被丢掉，count 只数真能用的', [parsed.ok, parsed.count, Object.keys(parsed.index)], [true, 2, ['w1::1', 'w9::7']]);
check('认不出来的分类原样留着（判定时才落「其他」，不在这里改口）', parsed.index['w9::7'].t, 'no_such_type');
const badJson = idx.parseIndexFile('{ 坏掉的');
check('不是 JSON：拒绝并把读不出的原因带上', [badJson.ok, /JSON/.test(badJson.reason)], [false, true]);
check('真·别的 JSON 文件：键形不对，一个字都不动', [idx.parseIndexFile('{"power_user":{"a":{"s":"甲"}}}').ok, idx.parseIndexFile('{"power_user":{"a":{"s":"甲"}}}').reason.includes('没认到它的标识')], [false, true]);
// 免费 AI 十次里有一次会漏抄 kind 那一行：形状对得上（键都是 书名::条目号）就照收，但要在概况里说清
check('没写标识、可键形就是「书名::条目号」：照收并标记 tolerant', [idx.parseIndexFile('{"w1::1":{"s":"甲","t":"item"}}').ok, idx.parseIndexFile('{"w1::1":{"s":"甲","t":"item"}}').tolerant], [true, true]);
check('AI 少写一层外壳（顶层直接就是那张映射）也认', Object.keys(idx.parseIndexFile('{"w1::1":{"s":"甲","t":"item","h":"z","at":1}}').index), ['w1::1']);
check('概况里会把「标识缺失但形状对」这句话讲给用户听',
    idx.indexImportOutcomeHtml({ added: 1, updated: 0, skipped: 0, manualConflicts: 0, foreign: 0, typesImported: false, typesSkipped: false }, { overwrite: false, fileName: 'a.txt', tolerant: true }).includes('文件名插件从来不看'), true);
// 网页 AI 基本不会只回裸 JSON：围栏和客气话都要能吃掉
truthy('```json 围栏包着的文件读得动', idx.parseIndexFile('好的，文件如下：\n```json\n{"kind":"st-memory-enhancement.decision_index","index":{"w1::1":{"s":"甲","t":"item"}}}\n```\n还要改吗？').ok);
truthy('没围栏、前后各说一句也读得动', idx.parseIndexFile('看这里 {"kind":"st-memory-enhancement.decision_index","index":{"w1::1":{"s":"甲"}}} 就这些').ok);
check('整个文件没一个大括号：拒收并说清', [idx.parseIndexFile('抱歉，我做不到。').ok, idx.parseIndexFile('抱歉，我做不到。').reason.includes('没找到一个 JSON 对象')], [false, true]);
check('extractJsonObject 只取最外层那一段', idx.extractJsonObject('前缀 {"a":1} 后缀'), '{"a":1}');
check('pickIndexMap 不吃没有 :: 的 index 字段', idx.pickIndexMap({ index: { foo: { s: '甲' } } }), null);
truthy('更插件版本导出的文件不硬读', /v2 比现在的 v1 新/.test(idx.parseIndexFile(JSON.stringify({ kind: idx.INDEX_FILE_KIND, version: 2, index: fileRecords })).reason));
check('标识对了但一条能用的都没有，也不算成功', [idx.parseIndexFile(JSON.stringify({ kind: idx.INDEX_FILE_KIND, index: { 'a::1': { s: '  ' } } })).ok, idx.parseIndexFile(JSON.stringify({ kind: idx.INDEX_FILE_KIND, index: { 'a::1': { s: '  ' } } })).reason.includes('没有一条能用的摘要')], [false, true]);

const before = { 'w1::1': { s: '我手写的', t: 'item', h: 'x', at: 1, m: 1 }, 'w1::4': { s: '本机原有的', t: 'character', h: 'y', at: 2 } };
const keep = idx.mergeImportedIndex(before, parsed.index, { knownKeys: new Set(['w1::1', 'w1::4']) });
check('默认只补空着的：本机已有的不盖，别本书的照存', [keep.added, keep.updated, keep.skipped, keep.index['w1::1'].s, keep.index['w9::7'].s], [1, 0, 1, '我手写的', '别本书的条目']);
check('冲突里「本机且手写」的单独计数，不属于当前书的算 foreign', [keep.manualConflicts, keep.foreign], [1, 1]);
const wash = idx.mergeImportedIndex({ 'w1::1': { s: '我手写的', t: 'item', h: 'x', at: 1, m: 1 } }, { 'w1::1': { s: '文件摘要', t: 'character', h: 'k', at: 9 } }, { overwrite: true });
check('「连已有的一起覆盖」：内容和手填标记都跟着文件走（盖成 LLM 版还留 m 就是撒谎）',
    [wash.updated, wash.manualConflicts, wash.index['w1::1'].s, wash.index['w1::1'].t, wash.index['w1::1'].m], [1, 1, '文件摘要', 'character', undefined]);

const aRun = makeIndex({ setting: { decision_entry_index: { 'w1::1': { s: '我手写的', t: 'item', h: 'x', at: 1, m: 1 } } } });
const applied = aRun.mod.applyImportedIndex(parsed, aRun.setting, { overwrite: false, knownKeys: new Set(['w1::1']), now: 777 });
check('落盘只存一次（不是逐条存），本机原有那条没动', [applied.added, aRun.setting.decision_entry_index['w9::7'].s, aRun.setting.decision_entry_index['w1::1'].s, aRun.log.saved], [1, '别本书的条目', '我手写的', 1]);
check('真写进了新摘要：趟号推到此刻，旧的决策缓存立刻作废', aRun.setting.decision_index_at, 777);
const noChange = makeIndex({ setting: { decision_entry_index: { 'w1::1': { s: '文件里的摘要', t: 'item', h: 'aaaa1111', at: 100 }, 'w9::7': { s: '别本书的条目', t: 'item', h: 'cccc3333', at: 300 } }, decision_index_at: 5 } });
const sameAgain = noChange.mod.applyImportedIndex(parsed, noChange.setting, { overwrite: false, now: 999 });
check('全是本机已有的：一个字没改，趟号也不动（不白废一次判定）',
    [sameAgain.added, sameAgain.updated, noChange.setting.decision_index_at], [0, 0, 5]);
truthy('全程一个请求都没发（这些函数根本拿不到请求通道）', aRun.log.asks.length === 0);
check('文件里没带分类表：本机分类保持没动过', [applied.typesImported, aRun.setting.decision_entry_types], [false, undefined]);
const withTypes = idx.parseIndexFile(JSON.stringify({ kind: idx.INDEX_FILE_KIND, version: 1, types: [{ id: 'x', name: '甲类', instruction: '甲类问法 {digest}' }], index: fileRecords }));
const cleanSetting = { decision_entry_index: {} };
check('本机从没动过分类表：文件里那套跟进来，「其他」照例补在最后',
    [idx.applyImportedIndex(withTypes, cleanSetting, {}).typesImported, cleanSetting.decision_entry_types.map(t => t.id)], [true, ['x', 'other']]);
const dirtySetting = { decision_entry_index: {}, decision_entry_types: [{ id: 'y', name: '乙类' }] };
check('本机改过分类表：文件里那套不覆盖（只提示认不出的按「其他」判）',
    [idx.applyImportedIndex(withTypes, dirtySetting, {}).typesImported, idx.applyImportedIndex(withTypes, dirtySetting, {}).typesSkipped, dirtySetting.decision_entry_types.map(t => t.id)], [false, true, ['y']]);
const defaultTypesSetting = { decision_entry_index: {} };
check('文件里的分类表就是内置那七类时不写成数组（本机继续保持「没动过」）',
    [idx.applyImportedIndex(idx.parseIndexFile(JSON.stringify({ kind: idx.INDEX_FILE_KIND, types: idx.normalizeTypes([]), index: fileRecords })), defaultTypesSetting, {}).typesImported, defaultTypesSetting.decision_entry_types], [false, undefined]);

const quietOutcome = idx.indexImportOutcomeHtml({ ...applied, typesImported: false, typesSkipped: true }, { overwrite: false, fileName: 'decision-index-20261011-150000.json' });
truthy('概况说清来自哪个文件、新增几条、已有的没动', quietOutcome.includes('decision-index-20261011-150000.json') && quietOutcome.includes('新增 1 条') && quietOutcome.includes('本机已有的 1 条没动'));
truthy('不属于当前世界书的、本机分类表改过的，都各说一句', quietOutcome.includes('不属于现在这几本世界书') && quietOutcome.includes('本机分类表你改过'));
truthy('覆盖档要把盖掉几条手写的当众说出来', idx.indexImportOutcomeHtml({ added: 0, updated: 4, skipped: 0, manualConflicts: 3, foreign: 0, typesImported: true, typesSkipped: false }, { overwrite: true }).includes('你手写的 3 条被盖掉了'));
truthy('导入完提醒判定会跟着新摘要重算', quietOutcome.includes('按新摘要重新判'));
truthy('一个字都没改时不谎称「重判」，改口说本机已经有了',
    idx.indexImportOutcomeHtml({ added: 0, updated: 0, skipped: 2, manualConflicts: 0, foreign: 0, typesImported: false, typesSkipped: false }, { overwrite: false, fileName: 'a.json' }).includes('本机都已经有了'));
const nameHtml = idx.indexImportOutcomeHtml({ added: 1, updated: 0, skipped: 0, manualConflicts: 0, foreign: 0, typesImported: false, typesSkipped: false }, { overwrite: false, fileName: '<b>&x</b>.json' });
truthy('文件名里的尖括号被转义，而且只转一层（不会显示成 &amp;lt; 那种乱码）', nameHtml.includes('&lt;b&gt;') && !nameHtml.includes('&amp;lt;'));

// downloadIndexFile 是浏览器专属那一段：临时把 document/URL 摆上，只验「写出去的内容和文件名」
const savedDocument = globalThis.document;
const savedUrl = globalThis.URL;
let clickedLink = null;
globalThis.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };
globalThis.document = { createElement: () => ({ click() { clickedLink = this; }, remove() {} }), body: { appendChild: () => {} } };
const downloadedChars = idx.downloadIndexFile(exported, 'out.json');
globalThis.document = savedDocument;
globalThis.URL = savedUrl;
check('下载挂的是 <a download>，内容是那份 JSON', [clickedLink?.download, clickedLink?.href, downloadedChars === JSON.stringify(exported, null, 2).length], ['out.json', 'blob:fake', true]);

const fileSrc = read('scripts/runtime/decisionEntryIndex.js');
truthy('弹窗里有「导出索引文件」「导入索引文件」两颗，标题都写明不发请求、不花钱',
    /manual-index-export" title="[^"]*不发请求/.test(fileSrc) && /manual-index-import" title="[^"]*不发请求/.test(fileSrc));
truthy('选文件控件是藏起来的 input[type=file]，而且不带 accept（文件名和后缀一律不参与匹配，.txt 也要能选）',
    /<input type="file" id="dlb_manual_index_file" class="manual-index-file-input" \/>/.test(fileSrc) && !/dlb_manual_index_file[^>]*accept=/.test(fileSrc));
truthy('点导入才开文件框，而且先清空 value（连着选同一个文件也能再次触发）', /fileInput\.value = '';\s*\n\s*fileInput\.click\(\);/.test(fileSrc));
truthy('文件读回来只挂 change，不自动落盘', fileSrc.includes("fileInput?.addEventListener('change', onFilePicked)"));
truthy('LLM 那一趟跑着的时候挡导入（两边写同一份索引）', /openFilePicker[\s\S]{0,260}再导入文件/.test(fileSrc));
truthy('导入前就地算账：只补空着的 / 连已有的一起覆盖 / 取消，三颗都在确认条上',
    fileSrc.includes('只补空着的（推荐）') && fileSrc.includes('连已有的一起覆盖') && /data-overwrite="false"/.test(fileSrc) && /data-overwrite="true"/.test(fileSrc) && fileSrc.includes('manual-index-import-cancel'));
truthy('确认条上的两档分别把「本机手写几条」和「不属于当前书几条」摆出来', /其中你手写 \$\{p\.manual\} 条/.test(fileSrc) && /不属于当前这几本世界书/.test(fileSrc));
truthy('分发时先认确认条的按钮，再认「导入索引文件」（否则点「只补空着的」会重新开文件框）',
    fileSrc.indexOf("closest?.('.manual-index-import-yes')") < fileSrc.indexOf("closest?.('.manual-index-import')"));
truthy('点取消要把待确认的文件内容丢掉', /manual-index-import-cancel'\)\)[\s\S]{0,60}stagedImport = null/.test(fileSrc));
truthy('真落盘走 applyImportedIndex，当前书的键用它算 foreign', fileSrc.includes('applyImportedIndex(staged,') && fileSrc.includes('knownKeys: new Set(byKey.keys())'));
truthy('只有真写进新摘要才推趟号（全是已有的不白废一批判定）',
    /if \(merged\.added \|\| merged\.updated\) setting\.decision_index_at =/.test(fileSrc));
truthy('导入之后清草稿、清勾、重绘列表，概况写在弹窗里', /runImport[\s\S]{0,900}drafts\.clear\(\)[\s\S]{0,120}picked\.clear\(\)[\s\S]{0,120}renderRows\(\)/.test(fileSrc));
truthy('索引一条都没有时导出被拦下并说清', /exportIndexFile[\s\S]{0,300}索引里一条都还没有/.test(fileSrc));
truthy('导出成功的提示报条数、点名文件名，并说明不发请求', /已导出 \$\{keys\.length\} 条摘要和分类到 \$\{fileName\}/.test(fileSrc) && fileSrc.includes('没发请求'));
truthy('弹窗底部把「索引不跟着世界书文件走，要带走用导出」讲明白', fileSrc.includes('不跟着世界书文件走'));
truthy('导入只把文件内容交给 parseIndexFile，文件名仅用于显示', fileSrc.includes('parseIndexFile(await file.text())') && !/parseIndexFile\([^)]*\.name/.test(fileSrc));

console.log('\n===== 12. 创作提示词的取材（「导出创作文件」用它，正文不进清单）=====');
const prompt = idx.buildIndexAuthoringPrompt({ entries: [e1, e2], setting: {} });
truthy('清单里每条都把 key 和指纹 h 预先算好，AI 只照抄', prompt.includes(`key="w1::1" h="${fp(e1)}"`) && prompt.includes(`key="w1::2" h="${fp(e2)}"`));
truthy('标题和关键词也在（AI 靠这两个去找正文）', prompt.includes('标题="旧铁剑"') && prompt.includes('关键词="铁剑、武器"'));
truthy('正文一个字都不进提示词（这段文字可以放心粘贴到任何网页）', !prompt.includes('一把会说话的旧铁剑。'));
truthy('更不带地址和密钥', !/sk-[A-Za-z0-9]/.test(prompt) && !/https?:\/\//.test(prompt));
truthy('要求带插件标识，摘要上限跟着本机设置走', prompt.includes('"kind": "st-memory-enhancement.decision_index"') && prompt.includes('不超过 60 个字'));
truthy('分类清单只给本机那七类的 id 和名字', prompt.includes('- item｜道具') && prompt.includes('- other｜其他'));
truthy('要求「一条都别漏」，读不到正文就省略、不许编', prompt.includes('一条都别漏') && prompt.includes('看不到条目正文') && prompt.includes('不要凭标题编造摘要'));
truthy('摘要口径=概括、不许复述细节（这份概括是给判相关性的模型读的）', prompt.includes('不要复述细节') && prompt.includes('不要带露骨描写'));
truthy('摘要口径（10-11 第二次拍板）：第 3 条把顺序写死成「这是什么→一个主触发→状态」', /3\. s = 用处说明＋摘要，不是内容概括[\s\S]{0,200}\*\*这是什么（类型＋名字／关系）→ 一个主触发 → 现在什么状态\*\*/.test(prompt));
truthy('第 3 条点名「别罗列六种场景」这个具体反例（就是他截图里那条的毛病）', /3\. s = [\s\S]{0,400}别罗列「出场、独处、被忽略、身体描写时」/.test(prompt));
truthy('摘要口径：禁空话，「相关时使用」这类判定验证不了就等于没写', /3\. s = [\s\S]{0,500}空话/.test(prompt));
truthy('骨架里 s 的示例也跟着改成「这是什么｜一个主触发｜状态」', /"s": "这是什么（类型＋名字／关系）｜一个主触发（别罗列情况）｜现在什么状态"/.test(prompt));
// 10-11 用户第二次拍板：动笔前先给 AI 建立认知（条目是注入系统提示词的背景资料/写作规范，要写的是类型用处说明）
truthy('创作提示词第一段就把机制讲清：原文平时不注入，判「该不该注入」只看这句',
    prompt.startsWith('【这份索引拿来干什么（先看这段再动笔）】')
    && prompt.includes('每轮挑出该用的那几条注入系统提示词，当作背景设定或写作规范')
    && prompt.includes('你为条目写的这句 s 会被一个模型用来判断是否需要注入系统提示词')
    && prompt.includes('看不到条目原文，也不知道这些设定出自哪部作品'));
truthy('认知段把两个毛病都点出来：纯剧情概括＝模型自己反推；罗列情况＝挤掉名字和关系',
    prompt.includes('两个毛病都别犯') && prompt.includes('判断模型得自己反推相关性')
    && prompt.includes('名字和关系就被挤掉了') && prompt.includes('一个主触发够了'));
truthy('【你要做什么】只交代产出什么，机制不在两处重复讲', /【你要做什么】\n把最后【条目清单】里每一条的 s（用处说明）和 t（分类）写出来/.test(prompt));
truthy('分类那条也讲清后果：它决定这一类以后用哪种问法判，不是贴标签',
    /5\. t = 分类[\s\S]{0,200}这一类自己的问法[\s\S]{0,120}按它的用处挑/.test(prompt)
    && idx.DEFAULT_INDEX_TEMPLATE.includes('分类不是标签') && idx.DEFAULT_INDEX_TEMPLATE.includes('按用处选'));
truthy('说清文件名和后缀随便写：导入只看内容，不看文件名', prompt.includes('导入只看内容'));
truthy('点明骨架只画一条、清单里每条都要写成一项（不然 AI 会只回一条）', prompt.includes('这个骨架只画了一条') && prompt.includes('每一条都写成 index 下的一项'));
truthy('禁止分段偷懒（免费 AI 长清单最爱来一句「篇幅所限先给一部分」）', prompt.includes('篇幅所限先给一部分') && prompt.includes('宁可摘要短，也别漏条目'));
const skeletonText = /把示例值换成真的（键、h、t 的写法都照骨架）：\n\n([\s\S]*?)\n\n【硬性规则】/.exec(prompt)?.[1];
const skeletonParse = idx.parseIndexFile(skeletonText ?? '');
check('骨架本身就能被导入（AI 照抄形状不会翻车）', [!!skeletonText, skeletonParse.ok, Object.keys(skeletonParse.index ?? {})], [true, true, ['w1::1']]);
check('照抄的 h 就是当前正文的指纹：以后点「补没填的」不会重问这条', idx.planIndex([e1], skeletonParse.index, idx.normalizeTypes([])).todo.length, 0);
const emptyPrompt = idx.buildIndexAuthoringPrompt({ entries: [], setting: {} });
truthy('清单为空也不产出一份没条目的假提示词', emptyPrompt.includes('（这一屏没有需要写的条目）') && emptyPrompt.includes('共 0 条'));
const customPrompt = idx.buildIndexAuthoringPrompt({ entries: [e1], setting: { decision_entry_types: [{ id: 'x', name: '甲类', instruction: '甲类问法 {digest}' }] } });
truthy('本机分类表改过时：骨架里带上 types，并要 AI 原样抄回去', customPrompt.includes('"types": [') && customPrompt.includes('请把骨架中那段 types 一并带上'));
check('内置那七类不进 types（省一大段抄写，也少一处出错）', prompt.includes('"types"'), false);
// 2026-10-13：读这些文字的模型没有 SillyTavern 的认知，「世界书／插件／这张卡」对它都是陌生名词。
// 只钉内置那两份常量；用户自己改的提示词插件一律不检查、不拦（生成串里还混着条目标题和你的分类表，不该拿用户数据去验）。
truthy('建索引那两份内置提示词不提 SillyTavern 的名词，只说这句摘要之后被谁拿去干什么',
    !/世界书|插件|SillyTavern|这张卡/.test(idx.DEFAULT_INDEX_SYSTEM_PROMPT)
    && !/世界书|插件|SillyTavern|这张卡/.test(idx.DEFAULT_INDEX_TEMPLATE));

// 10-12 拍板：「复制创作提示词」这一整条路删掉了——它和「导出创作文件」是同一件事，
// 而网页端粘贴长文本会被内容审核拦下来，只有文件那条路走得通。下面这两颗钉子防它被哪次改动又带回来。
truthy('复制创作提示词那颗按钮和它的两个函数都删干净了',
    !fileSrc.includes('manual-index-copy-prompt') && !fileSrc.includes('copyPromptText')
    && !fileSrc.includes('indexAuthoringOutcomeHtml') && !fileSrc.includes('复制创作提示词'));
truthy('导出创作文件仍在（删的是复制那条路，不是这条）',
    /class="menu_button menu_button_icon manual-index-authoring-file" title="[^"]*不发请求/.test(fileSrc)
    && /manual-index-authoring-file'\)\)[\s\S]{0,120}exportAuthoringFile\(\)/.test(fileSrc)
    && /const built = buildIndexAuthoringFile\(/.test(fileSrc));
truthy('取材是 authoringEntries()：没勾=整个候选集，不是当前那一屏（渲染上限不该截断 AI 的活）',
    /const authoringEntries = \(\) => \(picked\.size \? entries\.filter/.test(fileSrc) && !/entries: shown/.test(fileSrc));
truthy('tolerant 标记一路带到概况', fileSrc.includes('tolerant: !!staged.tolerant'));
truthy('说明文字里点名了「免费 AI 写索引」这条不花钱的路', fileSrc.includes('就把这活交给任意网页端免费 AI'));

console.log('\n===== 13. 导出创作文件 = 提示词 + 完整正文，一个文件发过去就够 =====');
const withBodies = idx.buildIndexAuthoringPrompt({ entries: [e1, e2], setting: {}, withBodies: true });
truthy('带正文那一版让 AI 只看文件末尾那一节，不再叫它去解角色卡', withBodies.includes('【正文 N】') && withBodies.includes('我这次没有另外附角色卡文件') && !withBodies.includes('data.character_book.entries'));
truthy('带正文那一版的「读不到」说法跟着改', withBodies.includes('看不到条目正文') && !withBodies.includes('看不到世界书正文'));
truthy('复制那一版照旧不带正文（同一段文字两种用途，别互相污染）', !prompt.includes('【正文 1】') && prompt.includes('data.character_book.entries'));
truthy('输出形式要求 markdown 代码块（网页端能直接复制/下载整块）', prompt.includes('```json') && prompt.includes('代码块外面一个字都别写'));
truthy('后缀清单里补上了 .md', prompt.includes('.json、.txt、.md 都行'));
const bodies = idx.buildIndexAuthoringBodies([e1, entry({ uid: 9, comment: '空条', content: '  ' })]);
truthy('正文按「【正文 N】」逐条摊开，编号跟清单对得上', [bodies.includes('【正文 1】标题：旧铁剑｜关键词：铁剑、武器\n一把会说话的旧铁剑。'), bodies.includes('【正文 2】标题：空条'), bodies.includes('（这一条没有正文）')], [true, true, true]);
check('没有条目时不产出一节空的正文', idx.buildIndexAuthoringBodies([]), '');
truthy('完整正文不截断（整份文件的存在理由就是不必让 AI 去解 PNG）',
    idx.buildIndexAuthoringBodies([entry({ uid: 7, content: '字'.repeat(3000) })]).includes('字'.repeat(3000)));

const authored = idx.buildIndexAuthoringFile({ entries: [e1, e2], setting: {} });
truthy('一份文件里认知段在最前、要求在前、正文在后，末尾那条正文真的在文件里', [authored.text.startsWith('【这份索引拿来干什么'), authored.text.indexOf('【你要做什么】') > authored.text.indexOf('【这份索引拿来干什么'), authored.text.includes('【条目正文】'), authored.text.includes('一把会说话的旧铁剑。'), authored.count], [true, true, true, true, 2]);
check('字数账算得出来（弹窗要说「整份约 N 字」）', [authored.chars === authored.text.length, authored.bodies > 0], [true, true]);
truthy('文件里那份要求用的就是带正文那一版', /我这次没有另外附角色卡文件/.test(authored.text) && !/data\.character_book\.entries/.test(authored.text));
truthy('文件名带时间戳、后缀 .md（内容才是唯一凭据）', /^decision-index-authoring-\d{8}-\d{6}\.md$/.test(idx.authoringFileName(1760000000000)));
const emptyAuthored = idx.buildIndexAuthoringFile({ entries: [], setting: {} });
truthy('候选为空也不产出一份假文件（照样写清没有正文）', emptyAuthored.text.includes('（这一份里没有条目正文）') && emptyAuthored.text.includes('共 0 条'));

// AI 照这份文件的骨架回一个 fenced 代码块，导回来必须收（这才叫「导入就能使用」）
const fenced = '好的，下面是你要的索引：\n```json\n' + JSON.stringify({
    kind: idx.INDEX_FILE_KIND, version: 1,
    index: { 'w1::1': { s: '一把会说话的旧铁剑', t: 'item', h: fp(e1), at: 1 } },
}) + '\n```\n需要我再补别的吗？';
const fencedParsed = idx.parseIndexFile(fenced);
check('AI 回复里的 ```json 块 + 前后客气话：照样读得出来', [fencedParsed.ok, Object.keys(fencedParsed.index), fencedParsed.tolerant], [true, ['w1::1'], false]);
check('照这份文件的 h 导进去以后，「补没填的」不会重问（不二次花钱）', idx.planIndex([e1], fencedParsed.index, idx.normalizeTypes([])).todo.length, 0);

const fileHtml = idx.indexAuthoringFileOutcomeHtml({ count: 5, chars: 8123, bodies: 7000, fileName: 'a b.md', exported: true });
truthy('导出成功报文件名、条数、正文和整份的字数', fileHtml.includes('a b.md') && fileHtml.includes('5 条条目') && fileHtml.includes('8123 字'));
truthy('说清「只传这一个文件」和回来怎么导', fileHtml.includes('这一个文件') && fileHtml.includes('导入索引文件'));
truthy('提醒正文没截、太长就勾一部分分几轮', fileHtml.includes('一个字没截') && fileHtml.includes('分几轮'));
truthy('浏览器拦下载时改口，不假装成功', /没能存出去/.test(idx.indexAuthoringFileOutcomeHtml({ count: 1, chars: 2, bodies: 1, fileName: 'x.md', exported: false })));

const savedDoc = globalThis.document;
const savedUrl2 = globalThis.URL;
let textLink = null;
globalThis.URL = { createObjectURL: () => 'blob:t', revokeObjectURL: () => {} };
globalThis.document = { createElement: () => ({ click() { textLink = this; }, remove() {} }), body: { appendChild: () => {} } };
const textChars = idx.downloadTextFile('甲乙丙', 'note.md', 'text/markdown');
const textName = textLink?.download;
// downloadIndexFile 现在只是 downloadTextFile 的一层皮：JSON 那一路的字数账不能变
const jsonChars = idx.downloadIndexFile({ a: 1 }, 'out.json');
globalThis.document = savedDoc;
globalThis.URL = savedUrl2;
check('纯文本也走同一个下载口子（挂 <a download>，字符数照实返回）', [textName, textChars], ['note.md', 3]);
truthy('JSON 那一路还是 stringify 后的长度，文件名也没串', jsonChars === JSON.stringify({ a: 1 }, null, 2).length && textLink?.download === 'out.json');

truthy('弹窗里有第四颗按钮「导出创作文件」，标题写明不发请求、不花钱', /manual-index-authoring-file" title="[^"]*不发请求/.test(fileSrc));
truthy('点它走 buildIndexAuthoringFile + downloadTextFile，概况嵌在弹窗里',
    /manual-index-authoring-file'\)\)[\s\S]{0,60}exportAuthoringFile\(\)/.test(fileSrc)
    && /exportAuthoringFile[\s\S]{0,600}buildIndexAuthoringFile\(\{ entries: list/.test(fileSrc)
    && /outcomeHost\.innerHTML = indexAuthoringFileOutcomeHtml\(/.test(fileSrc));
truthy('导出创作文件不碰设置、不发请求（一个 asks 都没记）', !/exportAuthoringFile[\s\S]{0,700}(saveSettings|handleMainAPIRequest|handleCustomAPIRequest)/.test(fileSrc));
truthy('下载抛错也只改口不炸弹窗（exported=false 那条路）', /catch \(error\) \{\s*\n\s*exported = false;/.test(fileSrc));
truthy('一条都挑不出来说清，不悄悄产空文件', /exportAuthoringFile[\s\S]{0,220}没有可带的条目/.test(fileSrc));

console.log('\n===== 14. 设置页那颗「填写条目索引」（本插件只有这一个入口）=====');
truthy('按钮标题写明它自己不发请求——花钱的是那一页里那几颗「让 LLM…」',
    /id="dlb_index_manual_button"[^>]*title="[^"]*不发请求/.test(tplSrc)
    && /那几颗「让 LLM…」才会发请求、会消耗 token/.test(fileSrc));
truthy('点它切到工作台第一页，页面本体由运行模块提供（不复制粘贴一套）',
    /import \{[^}]*\bcreateManualIndexPage\b[^}]*\} from '\.\/decisionEntryIndex\.js'/.test(read('scripts/runtime/decisionWorkbench.js'))
    && setSrc.includes("openDecisionWorkbench('index')") && !setSrc.includes('showManualIndexEditor'));
truthy('切完页或关窗后立刻重绘统计（手填是逐条落盘的，不刷新一路显示旧数字）',
    /openDecisionWorkbench\(key\)\.then\(\(\) => renderDecisionIndex\(\)\)/.test(setSrc));
truthy('索引这一页认得「没加载世界书」：列空区块而不是拒绝打开',
    fileSrc.includes('manual-index-blank') && !/if \(!entries\.length\) return;/.test(fileSrc));
truthy('这时候点 LLM 那几颗只给一句提示，不发请求',
    /const noEntries = \(\) =>/.test(fileSrc) && /if \(!entries\.length\) \{\s*noEntries\(\);/.test(fileSrc));

console.log(`\n${fail ? 'FAILED' : 'OK'}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);



