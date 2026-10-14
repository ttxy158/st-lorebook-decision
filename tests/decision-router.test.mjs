// decision-router.test.mjs
// 决策模型接管世界书注入的回归测试：请求层纯函数 + 路由层编排（候选采集/三态/按轮复用/失败弹窗）
// 运行：node tests/decision-router.test.mjs
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

// ============================================================ 1. 请求层（无依赖，直接跑真代码）
console.log('===== 1. decisionApiService =====');
const svc = toFactory('services/decisionApiService.js', {
    __exports: ['DECISION_DEFAULT_MODEL', 'DECISION_MAX_QUESTIONS', 'DECISION_MAX_IN_FLIGHT', 'DEFAULT_INSTRUCTION_TEMPLATE', 'DEFAULT_PENDING_NOTE', 'DEFAULT_DECISION_TASK_BRIEFING', 'DEFAULT_BASIS_SYSTEM_PROMPT', 'DEFAULT_BASIS_TEMPLATE', 'resolveTaskBriefing', 'renderInstruction', 'entryTitle', 'buildEntryDigest', 'buildQuestions', 'buildState', 'buildDigestState', 'isModerationRejection', 'chunk', 'mergeAnswers', 'parseAnswers', 'applyInjectQuota', 'resolveEndpoint', 'requestDecision'],
    fetch: (...args) => globalThis.__fakeFetch(...args),
    AbortController: globalThis.AbortController,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    console,
});

// 条目摘要索引：路由要用它的同一份口径和材料选择器，所以这里也跑真代码
// （建索引那一趟要发请求，用例都在 decision-index.test.mjs 里；这儿只用纯函数）
const idx = toFactory('scripts/runtime/decisionEntryIndex.js', {
    __exports: ['DECISION_OTHER_TYPE_ID', 'normalizeTypes', 'normalizeIndex', 'readIndexNumbers', 'createMaterialResolver', 'filterDecisionEntries', 'indexedDigest', 'entryFingerprint', 'fnv1aHex', 'indexKey'],
    EDITOR: { info: () => {}, warning: () => {}, success: () => {}, error: () => {} },
    USER: { store: {}, saveSettings: () => {} },
    getSortedEntries: async () => [],
    handleMainAPIRequest: async () => '',
    handleCustomAPIRequest: async () => '',
    beginReply: () => {},
    finishReply: () => {},
    entryTitle: svc.entryTitle,
    console,
});

const entry = (over = {}) => ({
    uid: 1, world: 'w1', comment: '旧铁剑', key: ['铁剑', '武器'], keysecondary: [],
    content: '一把会说话的旧铁剑，剑身有裂纹。'.repeat(50),
    disable: false, constant: false, decorators: [], ...over,
});

const longBody = '一把会说话的旧铁剑，剑身有裂纹。'.repeat(50).replace(/\s+/g, ' ').trim();
check('摘要格式：标题｜关键词｜内容截断',
    svc.buildEntryDigest(entry(), 20),
    `旧铁剑｜关键词：铁剑、武器｜${longBody.slice(0, 20)}…`);
check('无标题时退回条目号', svc.buildEntryDigest({ uid: 7, content: '' }, 10), '条目7');check('关键词全空时不出现「关键词：」', svc.buildEntryDigest({ uid: 8, comment: '甲', content: '乙' }, 10), '甲｜乙');

// 总结表同步进来的条目：机器标记在 extensions.memTab，comment 保持可读，可以直接当标题
const syncedEntry = { uid: 21, world: '记忆总结表 · 荒岛', comment: '【剧情记录表格】天台看烟花', key: ['天台', '烟花'], content: '【剧情记录表格】天台看烟花\n时间：傍晚', extensions: { memTab: 'sheet_A|abc123' } };
check('同步条目的标题直接用可读 comment', svc.entryTitle(syncedEntry), '【剧情记录表格】天台看烟花');
check('摘要里不出现机器标记', svc.buildEntryDigest(syncedEntry, 40).includes('memTab'), false);
check('候选表里的 label 也是可读标题', svc.buildQuestions([syncedEntry], 40).map[0].label, '【剧情记录表格】天台看烟花');
check('没标题的条目退回条目号', svc.entryTitle({ uid: 9, comment: '', content: 'x' }), '条目9');
check('普通条目的 comment 原样当标题', svc.entryTitle({ uid: 3, comment: '我自己写的说明', content: 'x' }), '我自己写的说明');

const built = svc.buildQuestions([entry({ uid: 1 }), entry({ uid: 2, comment: '乙' })], 30);
check('问题 id 依次是 q0/q1', Object.keys(built.questions), ['q0', 'q1']);
check('全部是 noul 类型', built.questions.q0.type, 'noul');
check('模板留空时用默认相关性问法', built.questions.q0.instructions,
    svc.DEFAULT_INSTRUCTION_TEMPLATE.replace('{digest}', svc.buildEntryDigest(entry(), 30)));
truthy('默认问法问的是否涉及/在场，不是主观续写需求', /是否涉及/.test(svc.DEFAULT_INSTRUCTION_TEMPLATE) && !/需要/.test(svc.DEFAULT_INSTRUCTION_TEMPLATE));
check('映射表带 world/uid/label', built.map.map(m => `${m.id}:${m.world}.${m.uid}:${m.label}`), ['q0:w1.1:旧铁剑', 'q1:w1.2:乙']);

// ---- 可编辑的判定问法模板
const digest = '旧铁剑｜关键词：铁剑｜一把会说话的剑';
check('{digest} 代入条目摘要', svc.renderInstruction('问：{digest}', { digest, label: '甲' }), `问：${digest}`);
check('四种占位符各自代入', svc.renderInstruction('{label}/{keys}/{content}', { digest, label: '旧铁剑', keys: '铁剑、武器', content: '正文' }), '旧铁剑/铁剑、武器/正文');
truthy('全空白模板退回默认问法', svc.renderInstruction('   ', { digest }).startsWith('本段剧情是否涉及'));
check('模板里一个占位符都没写时自动补 {digest}', svc.renderInstruction('这条是否在场？', { digest }), `这条是否在场？${digest}`);
check('写错的占位符原样留着，方便发现', svc.renderInstruction('问：{digset} {digest}', { digest }), `问：{digset} ${digest}`);
const customBuilt = svc.buildQuestions([entry({ uid: 1, comment: '甲', key: ['铁剑'], content: '正文内容' })], 120, '这段是否提到{label}？');
check('自定义模板生效', customBuilt.questions.q0.instructions, '这段是否提到甲？');
check('自定义模板下摘要仍随 map 保存', customBuilt.map[0].digest, '甲｜关键词：铁剑｜正文内容');

// ---- 条目摘要索引：有索引的条目换摘要当材料、换这一类的问法
const idxTypes = idx.normalizeTypes([]);
const idxResolver = idx.createMaterialResolver({
    enabled: true,
    index: { 'w1::1': { s: '一把会说话的旧铁剑，剑身有裂纹', t: 'item', h: 'x', at: 1 } },
    types: idxTypes,
    summaryLimit: 60,
});
const indexedBuilt = svc.buildQuestions([entry({ uid: 1 }), entry({ uid: 2, comment: '乙' })], 30, '通用问法：{digest}', 0, idxResolver);
truthy('命中索引的那条用的是「道具」这一类的问法', indexedBuilt.questions.q0.instructions.includes('这件东西是否被使用'));
check('命中索引的那条材料是摘要，不是正文片段', indexedBuilt.map[0].digest, '旧铁剑｜关键词：铁剑、武器｜一把会说话的旧铁剑，剑身有裂纹');
check('没索引的那条照旧：通用问法 + 正文片段', indexedBuilt.questions.q1.instructions, `通用问法：${svc.buildEntryDigest(entry({ uid: 2, comment: '乙' }), 30)}`);
check('map 里记好哪条按索引判的', indexedBuilt.map.map(m => `${m.id}:${m.indexed}:${m.typeId}`), ['q0:true:item', 'q1:false:']);
const idxOffset = svc.buildQuestions([entry({ uid: 7, comment: '庚' })], 30, '通用：{digest}', 5, idxResolver);
check('分批偏移量不影响索引命中（这条本来就没索引）', [Object.keys(idxOffset.questions), idxOffset.map[0].id], [['q5'], 'q5']);
const offResolver = idx.createMaterialResolver({ enabled: false, index: { 'w1::1': { s: '甲', t: 'item', h: 'x', at: 1 } }, types: idxTypes });
const offBuilt = svc.buildQuestions([entry({ uid: 1 })], 30, '通用：{digest}', 0, offResolver);
check('开关关着时材料、问法都和以前一样', [offBuilt.map[0].indexed, offBuilt.map[0].digest], [false, svc.buildEntryDigest(entry({ uid: 1 }), 30)]);

// ---- 任务认知（工作认知）：拼在 state 最前面，设置页可直接改；两条依据路径都要有
const BRIEF = svc.DEFAULT_DECISION_TASK_BRIEFING;
/** 剥掉最前面的任务说明，后面的断言照旧只读「场景/角色/对话」那几行；没拼上就留个显眼的标记 */
const bodyOf = (state) => (String(state).startsWith(`${BRIEF}\n`) ? String(state).slice(BRIEF.length + 1) : `@@任务说明没拼在最前面@@${state}`);
truthy('任务说明以【你的任务】开头（一眼看出这是交代工作，不是剧情内容）', BRIEF.startsWith('【你的任务】'));
truthy('任务说明点明判的是「这条设定用不用得上」（用它认识的词）', BRIEF.includes('用得上') && BRIEF.includes('马上要用上'));
truthy('任务说明里不再出现流水线黑话（判别式模型的语料里没有「注入系统提示词／概率」这套用语）', !BRIEF.includes('系统提示词') && !BRIEF.includes('概率'));
truthy('任务说明不提 SillyTavern 的名词：判别模型不认识「世界书」「插件」，只认「备用的背景设定」', !/世界书|插件|SillyTavern/.test(BRIEF) && BRIEF.includes('备用的背景设定'));
truthy('任务说明给了「不算用得上」的反面标准（只是提到名字／以后可能用得上）', BRIEF.includes('只是提到了它的名字') && BRIEF.includes('都算用不上'));
truthy('任务说明提醒摘要短不等于低分（索引那层的短摘要会被压分）', BRIEF.includes('别因为简介短就压分'));
truthy('任务说明要求别回避尺度（决策模型会因露骨描写整批拒答）', BRIEF.includes('不管情节尺度'));
check('任务说明控制在 200 字内（每批请求都要重发一份）', [...BRIEF].length <= 200, true);
truthy('复用键里带任务说明，改这段会当场作废旧判定（它只进 state、不进问题，所以得单独拼进去）',
    /function buildReuseKey[\s\S]{0,320}brief\$\{config\.taskBriefing\}/.test(read('scripts/runtime/lorebookRouter.js')));
truthy('设置页把这段摊成一个可直接编辑的框（不是 placeholder 糊过去）',
    /id="dlb_task_briefing"[\s\S]{0,260}id="dlb_reset_task_briefing"/.test(read('assets/templates/index.html')));
truthy('框下面说清「整框清空就是不要这段」', read('assets/templates/index.html').includes('整框清空就是不要这段'));
truthy('固定背景那句不再声称任务是内置的（认知归认知、场景归场景）',
    !read('assets/templates/index.html').includes('写死在代码里') && read('assets/templates/index.html').includes('交代任务该改上面那段「工作认知」'));
check('没改过（老存档根本没这个键）= 默认那段', svc.resolveTaskBriefing(undefined), BRIEF);
check('改成自己的话就用你的话', svc.resolveTaskBriefing('只判这个人现在在不在场。'), '只判这个人现在在不在场。');
check('整框清空就是真的不要这段（空串不能顶回默认）', svc.resolveTaskBriefing(''), '');
check('改过的文案照旧拼在第一行', svc.buildState({ userName: '阿明', messages: [], taskBriefing: '只判这个人现在在不在场。' }).split('\n')[0], '只判这个人现在在不在场。');
check('摘要依据路径也认这份文案', svc.buildDigestState({ userName: '阿明', digest: '两人在灯塔上，阿明要看海图。', taskBriefing: '只判这个人现在在不在场。' }).split('\n')[0], '只判这个人现在在不在场。');
check('清空之后第一行就是场景／角色，不多一个空行',
    svc.buildState({ userName: '阿明', sceneNote: '海边', messages: [], taskBriefing: '' }), '当前场景：海边\n角色：AI 与 阿明');
truthy('两条依据路径都从设置取这段（不是只接了一条）',
    /taskBriefing: config\.taskBriefing/.test(read('scripts/runtime/lorebookRouter.js'))
    && /taskBriefing: resolveTaskBriefing\(setting\.decision_task_briefing\)/.test(read('scripts/runtime/lorebookRouter.js')));
check('正文依据路径：任务说明就是 state 的第一行', svc.buildState({ userName: '阿明', messages: [] }).split('\n')[0], BRIEF);
check('摘要依据路径：任务说明就是 state 的第一行', svc.buildDigestState({ userName: '阿明', digest: '两人在灯塔上。' }).split('\n')[0], BRIEF);

check('state 含角色与最近对话', bodyOf(svc.buildState({
    userName: '阿明', characterName: '小蓝',
    messages: [{ isUser: true, text: '你好' }, { isUser: false, name: '小蓝', text: '你也好' }],
})), '角色：小蓝 与 阿明\n最近对话：\n阿明：你好\n小蓝：你也好');
truthy('state 会截断超长消息', svc.buildState({ messages: [{ isUser: true, text: '字'.repeat(900) }] }, 600).endsWith('…'));
// 保头去尾砍掉的正是「此刻在发生什么」那一段，所以末尾几条要整段带过去，更早的只当背景、照旧截
const longPair = [
    { isUser: false, name: '小蓝', text: '前'.repeat(900) },
    { isUser: true, text: '后'.repeat(900) },
];
const dialogLines = (state) => bodyOf(state).split('\n').slice(-2);
truthy('不传完整条数＝每条照旧截（老行为还在，用户填 0 就是这个）', dialogLines(svc.buildState({ messages: longPair }, 600)).every(line => line.endsWith('…')));
check('完整条数 1＝末尾那条整段带、前面那条照旧截',
    (() => { const [older, newer] = dialogLines(svc.buildState({ messages: longPair }, 600, 1)); return [older.endsWith('…'), newer.includes('后'.repeat(900)) && !newer.endsWith('…')]; })(),
    [true, true]);
truthy('完整条数 2＝两条都整段带', dialogLines(svc.buildState({ messages: longPair }, 600, 2)).every(line => !line.endsWith('…')));
check('完整条数 0 与不传一模一样', svc.buildState({ messages: longPair }, 600, 0), svc.buildState({ messages: longPair }, 600));
check('固定背景紧跟在任务说明后面，早于角色行', bodyOf(svc.buildState({
    sceneNote: '现代都市日常', userName: '阿明', characterName: '小蓝', messages: [],
})), '当前场景：现代都市日常\n角色：小蓝 与 阿明');
check('待发送输入默认带标注', bodyOf(svc.buildState({
    userName: '阿明', messages: [{ isUser: true, text: '开门', pending: true }],
})), '角色：AI 与 阿明\n最近对话：\n阿明：开门' + svc.DEFAULT_PENDING_NOTE);
check('标注清空后真的不加（空串不能退回默认）', bodyOf(svc.buildState({
    userName: '阿明', pendingNote: '', messages: [{ isUser: true, text: '开门', pending: true }],
})), '角色：AI 与 阿明\n最近对话：\n阿明：开门');
check('非 pending 的消息不带标注', svc.buildState({ userName: '阿明', messages: [{ isUser: true, text: '开门' }] }).includes('尚未写入记录'), false);

// ---- 依据换成 LLM 摘要：正文里那些露骨描写不进请求（拒答就是被它们触发的）
check('摘要整块拼进 state，并标它是改写过的概括', bodyOf(svc.buildDigestState({
    userName: '阿明', characterName: '小蓝', digest: '两人在灯塔上，阿明想要那张海图。',
})), '角色：小蓝 与 阿明\n剧情要点（由上一个模型改写的概括，不含细节描写）：\n两人在灯塔上，阿明想要那张海图。');
truthy('摘要依据不再出现「最近对话」，也不带正文标题', !svc.buildDigestState({ digest: '甲', messages: [] }).includes('最近对话'));
check('摘要滞后一轮，所以本轮要发的那句照样附上并标注', bodyOf(svc.buildDigestState({
    userName: '阿明', digest: '两人在灯塔上。', messages: [{ isUser: true, text: '把灯关掉', pending: true }],
})), '角色：AI 与 阿明\n剧情要点（由上一个模型改写的概括，不含细节描写）：\n两人在灯塔上。\n本轮正要发出的话：\n阿明：把灯关掉' + svc.DEFAULT_PENDING_NOTE);
check('固定背景仍紧跟任务说明之后', svc.buildDigestState({ sceneNote: '海边小镇', digest: '甲' }).split('\n')[1] === '当前场景：海边小镇', true);
check('摘要还是空的整段不出现（第一轮就长这样，路由那边会退回正文）', bodyOf(svc.buildDigestState({ userName: '阿明', digest: '   ' })), '角色：AI 与 阿明');
truthy('完整条数 0 时那句超长照样按字数上限截（与正文路径同一套规则）', svc.buildDigestState({ userName: '阿明', digest: '甲', messages: [{ isUser: true, text: '字'.repeat(900), pending: true }] }, 100).includes(`${'字'.repeat(100)}…`));
truthy('默认那句本轮要发的话整段带——它正是最新意图，砍尾巴等于砍判断依据', !svc.buildDigestState({ userName: '阿明', digest: '甲', messages: [{ isUser: true, text: '字'.repeat(900), pending: true }] }, 100, 1).includes(`${'字'.repeat(100)}…`));

// ---- 分轮：切分与合并
check('按大小切分', svc.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
check('大小大于长度时只有一段', svc.chunk([1, 2], 60), [[1, 2]]);
check('空数组切成 0 段', svc.chunk([], 3), []);
check('大小非法时按 1 处理', svc.chunk([1, 2], 0), [[1], [2]]);
const batchA = svc.buildQuestions([entry({ uid: 1, comment: '甲' })], 120, '', 0);
const batchB = svc.buildQuestions([entry({ uid: 2, comment: '乙' }), entry({ uid: 3, comment: '丙' })], 120, '', 1);
check('第二轮的 id 接着前面编号，不会撞键', [Object.keys(batchA.questions), Object.keys(batchB.questions)], [['q0'], ['q1', 'q2']]);
check('合并各轮 answers 后每条都还在',
    Object.keys(svc.mergeAnswers([{ q0: { noul: 0.9 } }, { q1: { noul: 0.2 }, q2: { noul: 0.5 } }])), ['q0', 'q1', 'q2']);
const mergedMap = [...batchA.map, ...batchB.map];
check('合并结果能喂给三态判定',
    svc.parseAnswers(svc.mergeAnswers([{ q0: { noul: 0.97 } }, { q1: { noul: 0.1 }, q2: { noul: 0.4 } }]), mergedMap, { suppressEnabled: true }).force.map(f => f.uid),
    [1]);

const answers = { a: { noul: 0.97 }, b: { noul: 0.2 }, c: { noul: 0.5 }, d: { noul: 'abc' }, e: {} };
const map = [
    { id: 'a', world: 'w1', uid: 1, label: '甲' },
    { id: 'b', world: 'w1', uid: 2, label: '乙' },
    { id: 'c', world: 'w1', uid: 3, label: '丙' },
    { id: 'd', world: 'w1', uid: 4, label: '丁' },
    { id: 'e', world: 'w1', uid: 5, label: '戊' },
];
check('默认只强推，不压制', svc.parseAnswers(answers, map, { forceThreshold: 0.85, suppressThreshold: 0.25 }),
    {
        force: [{ world: 'w1', uid: 1 }], suppress: [],
        scores: {
            a: { uid: 1, world: 'w1', label: '甲', probability: 0.97 },
            b: { uid: 2, world: 'w1', label: '乙', probability: 0.2 },
            c: { uid: 3, world: 'w1', label: '丙', probability: 0.5 },
        },
        missing: [{ id: 'd', world: 'w1', uid: 4, label: '丁' }, { id: 'e', world: 'w1', uid: 5, label: '戊' }],
    });
check('开压制后低概率进 suppress',
    svc.parseAnswers(answers, map, { forceThreshold: 0.85, suppressThreshold: 0.25, suppressEnabled: true }).suppress,
    [{ world: 'w1', uid: 2 }]);
check('中间带既不强推也不压制',
    svc.parseAnswers(answers, map, { forceThreshold: 0.85, suppressThreshold: 0.25, suppressEnabled: true }).force.map(f => f.uid),
    [1]);
check('无返回的条目不算强推',
    svc.parseAnswers({ a: { noul: 1 } }, map, {}).force.map(f => f.uid), [1]);
// ST 会把 WORLDINFO_FORCE_ACTIVATE 收到的对象原样当作激活条目，所以强推必须带完整条目
const fullBuilt = svc.buildQuestions([entry({ uid: 11, comment: '甲', content: '完整内容正文。' })], 120);
const fullForced = svc.parseAnswers({ q0: { noul: 0.9 } }, fullBuilt.map, {});
check('强推项带完整条目内容', fullForced.force.map(f => f.content), ['完整内容正文。']);
truthy('强推项保留注入所需的其余字段', fullForced.force[0].world === 'w1' && fullForced.force[0].uid === 11 && Array.isArray(fullForced.force[0].key));
check('压制项只需定位键', svc.parseAnswers({ q0: { noul: 0.1 } }, fullBuilt.map, { suppressEnabled: true }).suppress, [{ world: 'w1', uid: 11 }]);

// ---- 本轮注入名额上限：只截强推清单，概率高的先占名额 ----
const quotaForce = [
    { world: 'w1', uid: 11, content: '甲'.repeat(100) },
    { world: 'w1', uid: 12, content: '乙'.repeat(30) },
    { world: 'w1', uid: 13, content: '丙'.repeat(10) },
];
const quotaScores = {
    q0: { uid: 11, world: 'w1', probability: 0.9 },
    q1: { uid: 12, world: 'w1', probability: 0.97 },
    q2: { uid: 13, world: 'w1', probability: 0.88 },
};
check('两个数都填 0＝不限，连注入顺序都不动（不能让关着的功能悄悄改了次序）',
    svc.applyInjectQuota(quotaForce, quotaScores, {}), { kept: quotaForce, squeezed: [], keptChars: 140 });
check('条数限制按概率从高到低占名额', svc.applyInjectQuota(quotaForce, quotaScores, { maxEntries: 2 }).kept.map(f => f.uid), [12, 11]);
check('被挤掉的要点名（它不是「判成不相关」，是这一轮塞不下）', svc.applyInjectQuota(quotaForce, quotaScores, { maxEntries: 2 }).squeezed.map(f => f.uid), [13]);
check('字数限制下装得下的照样注入', svc.applyInjectQuota(quotaForce, quotaScores, { maxChars: 40 }).kept.map(f => f.uid), [12, 13]);
check('字数限制再小也留最相关那一条（一个名额都不给等于把这轮判定整个扔掉）',
    svc.applyInjectQuota(quotaForce, quotaScores, { maxChars: 5 }),
    { kept: [quotaForce[1]], squeezed: [quotaForce[0], quotaForce[2]], keptChars: 30 });
check('两条线谁先到算谁', svc.applyInjectQuota(quotaForce, quotaScores, { maxEntries: 2, maxChars: 40 }).kept.map(f => f.uid), [12, 13]);
check('没有概率（手动挑的那批）按原条目顺序取', svc.applyInjectQuota(quotaForce, {}, { maxEntries: 1 }).kept.map(f => f.uid), [11]);
check('名额只截强推，够不到限制就不动', svc.applyInjectQuota(quotaForce, quotaScores, { maxEntries: 9, maxChars: 9999 }).squeezed, []);

check('地址自动补 /systemone', svc.resolveEndpoint('https://x.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', false),
    'https://x.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone');
check('已带 /systemone 不重复', svc.resolveEndpoint('https://a/v1/systemone/', false), 'https://a/v1/systemone');
check('默认套同源转发前缀', svc.resolveEndpoint('https://a/v1', true), '/proxy/https://a/v1/systemone');
let threwEmpty = false;
try { svc.resolveEndpoint('', true); } catch { threwEmpty = true; }
truthy('空地址直接抛错', threwEmpty);

// ---- 传输层：假 fetch
async function captureFetch(impl) {
    const seen = {};
    globalThis.__fakeFetch = async (url, options) => {
        seen.url = url;
        seen.options = options;
        return impl(url, options);
    };
    try {
        const result = await svc.requestDecision({
            endpoint: 'https://a/v1', apiKey: 'sk-test', model: 'decision-model-preview',
            state: 'S', questions: { q0: { type: 'noul', instructions: 'x' } }, useProxy: true, timeoutMs: 5000,
        });
        return { seen, result };
    } catch (error) {
        return { seen, error };
    }
}
const okJson = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });

let cap = await captureFetch(() => okJson({ answers: { q0: { noul: 0.9 } }, usage: { input_tokens: 12 }, latency_ms: 40 }));
check('走 /proxy 同源地址', cap.seen.url, '/proxy/https://a/v1/systemone');
check('带上 Bearer 认证头', cap.seen.options.headers.Authorization, 'Bearer sk-test');
check('POST + JSON', [cap.seen.options.method, cap.seen.options.headers['Content-Type']], ['POST', 'application/json']);
check('请求体是 model/state/questions', Object.keys(JSON.parse(cap.seen.options.body)), ['model', 'state', 'questions']);
check('正常返回完整响应', cap.result.answers.q0.noul, 0.9);

cap = await captureFetch(() => ({ ok: false, status: 500, text: async () => 'gateway blew up' }));
truthy('HTTP 错误可读化', /决策模型返回 HTTP 500：gateway blew up/.test(cap.error?.message || ''));
cap = await captureFetch(() => ({ ok: true, status: 200, text: async () => '<html>not json</html>' }));
truthy('非 JSON 报错', /不是 JSON/.test(cap.error?.message || ''));
cap = await captureFetch(() => okJson({ model: 'decision-model-preview' }));
truthy('缺 answers 报错', /没有 answers 字段/.test(cap.error?.message || ''));
cap = await captureFetch(async () => { const e = new Error('signal aborted'); e.name = 'AbortError'; throw e; });
truthy('超时转成中文提示', /请求超时（5 秒）/.test(cap.error?.message || ''));

// ---- 「内容被对端过滤」的识别：只有这一类失败才值得劝「改用摘要再判一次」
// 左边这条是用户屏幕上的原文（2026-10-12，阿里云百炼），后面几条是必须不被误判的邻居
const MODERATED = '决策模型返回 HTTP 400：{"code":"DataInspectionFailed","message":"<400> InternalError.Algo.DataInspectionFailed: Input text data may contain inappropriate content. (Input data may contain inappropriate content.)","request_id":"abc-123"}';
check('真机那句拒答认得出来', svc.isModerationRejection(MODERATED), true);
check('同一层的 ValidationError（questions 超 16 条）也是 400，但不算拒答',
    svc.isModerationRejection('决策模型返回 HTTP 400：{"code":"ValidationError","message":"<400> InternalError.Algo.InvalidParameter: questions: 60 exceeds the limit of 16"}'), false);
check('超时不算拒答（换依据也没用）', svc.isModerationRejection('决策模型请求超时（15 秒）'), false);
check('断网不算拒答', svc.isModerationRejection('Failed to fetch'), false);
check('网关 5xx 不算拒答', svc.isModerationRejection('决策模型返回 HTTP 502：Bad Gateway'), false);
check('响应不是 JSON 不算拒答', svc.isModerationRejection('决策模型返回的不是 JSON：<html>login</html>'), false);
check('中文站的「敏感内容」也认', svc.isModerationRejection('决策模型返回 HTTP 400：{"message":"输入内容包含敏感信息"}'), true);
check('必须先有「返回 HTTP 状态码」：光在别处出现 inappropriate content 不算',
    svc.isModerationRejection('我在 inappropriate content 相关设置里报了个错'), false);
check('空值不炸', svc.isModerationRejection(undefined), false);

// ============================================================ 1.5 密钥可用性校验
console.log('\n===== 1.5 isUsableSecret =====');
const util = toFactory('utils/utility.js', {
    __exports: ['isUsableSecret', 'SECRET_UNUSABLE_HINT'],
    console, document: { head: { appendChild: () => {} } },
});
truthy('正常 key 通过', util.isUsableSecret('sk-wsABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'));
truthy('逗号分隔的多 key 也算合法（存之前就按逗号去重）', util.isUsableSecret('sk-aaa,sk-bbb'));
check('空串不合法', util.isUsableSecret(''), false);
check('null 不合法', util.isUsableSecret(null), false);
check('非字符串不合法', util.isUsableSecret(undefined), false);
check('带换行不合法', util.isUsableSecret('sk-abc\n'), false);
check('带空格不合法（含中间的空格）', util.isUsableSecret('sk-abc def'), false);
// 带控制字符的值进 Authorization 头，浏览器只会报一句看不懂的 Invalid value
check('混进控制字符要拦住', util.isUsableSecret('sk-\u0014\u0009\u0015abc'), false);
truthy('提示语指到「重新粘贴」这个动作上', /重新粘贴/.test(util.SECRET_UNUSABLE_HINT));

// ============================================================ 1.6 明文密钥的存取
console.log('\n===== 1.6 明文密钥 =====');

function makeApiStore(over = {}) {
    const log = { successes: [], warnings: [], errors: [], saved: 0 };
    const privacy = { ...(over.privacy ?? {}) };
    const presets = { ...(over.presets ?? {}) };
    const USER = {
        privacy: privacy,
        store: { custom_api_presets: presets },
        saveSettings: () => { log.saved++; },
    };
    const EDITOR = {
        success: (m) => log.successes.push(String(m)),
        warning: (m) => log.warnings.push(String(m)),
        error: (m) => log.errors.push(String(m)),
        POPUP_TYPE: { CONFIRM: 'confirm' },
    };
    const api = toFactory('scripts/settings/standaloneAPI.js', {
        __exports: ['processApiKey', 'getPrivacyKey', 'getCustomApiKey'],
        USER, EDITOR, console,
        isUsableSecret: util.isUsableSecret,
        SECRET_UNUSABLE_HINT: util.SECRET_UNUSABLE_HINT,
    });
    return { api, privacy, presets, log };
}

const tidy = makeApiStore();
check('逗号分隔：去空白 + 去重复 + 报数', (() => {
    const r = tidy.api.processApiKey(' sk-a , sk-b,sk-a , ');
    return [r.keyString, r.totalKeys, r.remainingKeys, r.duplicatesRemoved, r.invalidKeysCount];
})(), ['sk-a,sk-b', 4, 2, 1, 1]);
check('单个 key 原样整理', tidy.api.processApiKey('  sk-abcdef  ').keyString, 'sk-abcdef');

const plain = makeApiStore({ privacy: { custom_api_key: 'sk-plainvalue', decision_api_key: 'sk-bad value' } });
check('读：存的是什么就返回什么（不再有解密这一步）', plain.api.getPrivacyKey('custom_api_key'), 'sk-plainvalue');
check('读：自定义 key 用同一个入口', plain.api.getCustomApiKey(), 'sk-plainvalue');
check('读：值里混了空格时返回 null，不把它发出去', plain.api.getPrivacyKey('decision_api_key'), null);
check('读：没填过返回 null', plain.api.getPrivacyKey('custom_model_name'), null);

// 独立版不带「旧版本用设备ID XOR 加密过的密钥」那段迁移：那是上游表格插件存的数据，
// 两个插件并存时去动别人的存档只会出事，所以这里钉的是「压根没有这段代码」。
const apiSrcForKeys = read('scripts/settings/standaloneAPI.js');
truthy('没有加密/解密的痕迹', !/encryptXor|decryptXor|getDecrypted|api_key_storage/.test(apiSrcForKeys));
truthy('不读 localStorage 里的设备ID', !/localStorage/.test(apiSrcForKeys));
// 旧版迁移会把「恰好全是十六进制的明文 Key」当密文清掉；独立版原样读出来就是对的
const hexPlain = makeApiStore({ privacy: { custom_api_key: '0123456789abcdef0123456789abcdef' } });
check('全是十六进制的明文 Key 照样能用（不会被当成密文清掉）',
    hexPlain.api.getPrivacyKey('custom_api_key'), '0123456789abcdef0123456789abcdef');
// 混进控制字符的存量值（旧密文落盘的那种形状）读不出来也不发，只能重贴
const junk = makeApiStore({ privacy: { custom_api_key: 'deadbeef0a1b2c3d4e5f\u0014' } });
check('存量值混了控制字符时返回 null', junk.api.getPrivacyKey('custom_api_key'), null);
const fresh = makeApiStore({ privacy: {} });
check('没填过 Key 不弹提示', fresh.log.warnings.length, 0);

// ============================================================ 2. 路由层编排
console.log('\n===== 2. lorebookRouter =====');

/**
 * 造一个只支持「查勾选框」的假 dlg
 * @description 从清单 HTML 里按 data-world/data-uid 还原条目，只有 over.pick 里的 uid 算被勾中，
 * @description 这样 readPickedEntries 的取属性方式（dataset.world / dataset.uid）也一起被测到。
 */
function pickerDom(html, pickedUids) {
    const boxes = [];
    const re = /data-world="([^"]*)"\s+data-uid="([^"]*)"/g;
    let hit;
    while ((hit = re.exec(html))) {
        if (pickedUids.includes(hit[2])) boxes.push({ dataset: { world: hit[1], uid: hit[2] } });
    }
    return {
        querySelectorAll: (selector) => (selector === 'input.decision-pick:checked' ? boxes.slice() : []),
    };
}

/**
 * ST 的 Popup 用数字结果区分按钮（自定义按钮的 result 必须是数字），
 * 失败弹窗和条目清单都走它，所以假 Popup 要按按钮回数字，
 * 并且像真的一样把勾选状态留在 dlg 上供事后读取。
 */
const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null, CUSTOM1: 1001, CUSTOM2: 1002, CUSTOM3: 1003 };
const POPUP_TYPE = { TEXT: 'text', CONFIRM: 'confirm' };

function makeRouter(over = {}) {
    const log = { warnings: [], errors: [], successes: [], infos: [], emitted: [], popups: [], failPopups: [], pickPopups: [], props: [], basisCalls: [], metadataSaves: 0 };
    const setting = {
        decision_router_enabled: true, decision_api_url: 'https://a/v1', decision_model: 'decision-model-preview',
        decision_use_proxy: true, decision_force_threshold: 0.85, decision_suppress_threshold: 0.25,
        decision_max_candidates: 60, decision_digest_limit: 120, decision_context_messages: 4,
        decision_inject_max_entries: 0, decision_inject_max_chars: 0,
        decision_context_chars: 600, decision_timeout_ms: 15000, decision_reuse_rounds: 0,
        decision_batch_size: 60, decision_multi_round: false,
        // 与 data/pluginSetting.js 的默认值保持一致：真实的 tableBaseSetting 会从默认值兜底，
        // 测试里的假 setting 必须也带上，否则测的是「用户改过」而不是「用户没动过」的行为
        decision_instruction_template: svc.DEFAULT_INSTRUCTION_TEMPLATE,
        decision_state_note: '',
        decision_pending_note: svc.DEFAULT_PENDING_NOTE,
        decision_basis_mode: 'chat', decision_basis_use_main_api: true, decision_basis_char_limit: 800,
        decision_basis_system_prompt: svc.DEFAULT_BASIS_SYSTEM_PROMPT, decision_basis_template: svc.DEFAULT_BASIS_TEMPLATE,
        decision_timing_mode: 'every_round', decision_every_n_rounds: 2,
        ...over.setting,
    };
    delete over.setting;
    const calls = { request: 0, questionIds: [], inFlight: 0, maxInFlight: 0 };
    const entries = over.entries ?? [
        entry({ uid: 1, comment: '相关条目', disable: false }),
        entry({ uid: 2, comment: '无关条目' }),
        entry({ uid: 3, comment: '常驻', constant: true }),
        entry({ uid: 4, comment: '已关闭', disable: true }),
        entry({ uid: 5, comment: '无关键词', key: [] }),
        entry({ uid: 6, comment: '手动钉住', decorators: ['activate'] }),
    ];
    const chat = over.chat ?? [
        { mes: '系统消息', is_system: true },
        { mes: '我拔出了旧铁剑', is_user: true, name: '阿明' },
        { mes: '剑身轻轻一颤', is_user: false, name: '小蓝' },
    ];
    // 决策摘要存在当前聊天的 chat_metadata 里，所以假 context 也要带一个可写的对象
    const chatMetadata = {};
    if (over.basisState) chatMetadata.dlb_decision_basis = over.basisState;
    const USER = {
        privacy: over.privacy ?? {},
        store: setting,
        getContext: () => ({ name1: '阿明', name2: '小蓝', chat, chatMetadata, saveMetadata: async () => { log.metadataSaves++; } }),
        saveSettings: () => {},
    };
    // ST 的 Popup 用数字结果区分按钮（自定义按钮的 result 必须是数字），失败弹窗和条目清单都走它，
    // 所以假 Popup 要按按钮回数字，并且像真的一样把勾选状态留在 dlg 上供事后读取。
    const failChoices = Array.isArray(over.failChoice) ? over.failChoice : [over.failChoice];
    let failOpened = 0;
    const EDITOR = {
        warning: (m) => log.warnings.push(String(m)),
        error: (m) => log.errors.push(String(m)),
        success: (m) => log.successes.push(String(m)),
        info: (m) => log.infos.push(String(m)),
        POPUP_TYPE,
        Popup: function (html, type, _text, options = {}) {
            log.popupHtml = String(html);
            log.popupOpens = (log.popupOpens || 0) + 1;
            const kind = type === POPUP_TYPE.CONFIRM ? 'fail'
                : String(options.okButton || '') === '注入这些条目' ? 'pick' : 'report';
            (log.popupKinds = log.popupKinds || []).push({ kind, options });
            if (kind === 'fail') log.failPopups.push(String(html));
            if (kind === 'pick') log.pickPopups.push(String(html));
            const self = this;
            this.show = async () => {
                if (kind === 'fail') {
                    const choice = failChoices[Math.min(failOpened, failChoices.length - 1)] ?? 'keyword';
                    failOpened++;
                    // 只有一组选项时按 choice 映射；没给就是「按原关键词注入」，免得用例写成死循环
                    return {
                        retry: POPUP_RESULT.AFFIRMATIVE,
                        keyword: POPUP_RESULT.NEGATIVE,
                        pick: POPUP_RESULT.CUSTOM1,
                        reuse: POPUP_RESULT.CUSTOM2,
                        basis: POPUP_RESULT.CUSTOM3,
                    }[choice];
                }
                if (kind === 'pick') {
                    if (over.pickDismiss) return POPUP_RESULT.NEGATIVE;
                    // 真弹窗是先渲染 checkbox、用户勾了才 resolve，读的是 popup.dlg 上的勾选
                    self.dlg = pickerDom(String(html), (over.pick || []).map(String));
                    return POPUP_RESULT.AFFIRMATIVE;
                }
                return true;
            };
        },
    };
    // 决策依据（正文／LLM 摘要）与决策时机：跑 decisionBasis.js 真模块，且和路由共用同一个 USER，
    // 这样「自动摘要写进 chat_metadata → 下一轮决策读出来当依据」这条链在测试里也是真走的
    const basis = toFactory('scripts/runtime/decisionBasis.js', {
        __exports: ['BASIS_MODES', 'BASIS_STATE_KEY', 'BASIS_CHAR_LIMIT_DEFAULT', 'DEFAULT_BASIS_SYSTEM_PROMPT', 'DEFAULT_BASIS_TEMPLATE', 'resolveBasisMode', 'resolveTiming', 'effectiveReuseRounds', 'decideTiming', 'skipsAfterDecision', 'renderBasisPrompt', 'cleanBasis', 'capBasis', 'floorToLine', 'pickNewFloors', 'markerOf', 'readBasisState', 'writeBasisState', 'basisDigest', 'dropBasis', 'basisConfig', 'summarizeBasis', 'refreshBasisAfterGeneration'],
        EDITOR, USER,
        DEFAULT_BASIS_SYSTEM_PROMPT: svc.DEFAULT_BASIS_SYSTEM_PROMPT,
        DEFAULT_BASIS_TEMPLATE: svc.DEFAULT_BASIS_TEMPLATE,
        fnv1aHex: idx.fnv1aHex,
        handleMainAPIRequest: async (system, prompt) => {
            log.basisCalls.push({ channel: 'main', system, prompt });
            if (over.basisFail) throw new Error(over.basisFail);
            return over.basisText ?? '阿明和小蓝上了灯塔，阿明想要那张海图。';
        },
        handleCustomAPIRequest: async (system, prompt) => {
            log.basisCalls.push({ channel: 'custom', system, prompt });
            if (over.basisFail) throw new Error(over.basisFail);
            return over.basisText ?? '阿明和小蓝上了灯塔，阿明想要那张海图。';
        },
        // 「上次 LLM 回复」查看器：摘要这一趟也得记账，否则跑失败了用户只看到没动静
        beginReply: (meta) => { log.replies = log.replies || []; log.replies.push({ kind: 'begin', meta }); },
        finishReply: (patch) => { log.replies = log.replies || []; log.replies.push({ kind: 'finish', patch }); },
        console,
    });
    const APP = {
        eventSource: { on: (t, fn) => { log.emitted.push(`on:${t}`); (log.handlers = log.handlers || {})[t] = fn; }, emit: async (t, payload) => log.emitted.push([t, payload]) },
        event_types: { GENERATION_STARTED: 'start', GENERATION_ENDED: 'end', WORLDINFO_ENTRIES_LOADED: 'loaded', WORLDINFO_FORCE_ACTIVATE: 'force', CHAT_CHANGED: 'chat' },
    };
    const router = toFactory('scripts/runtime/lorebookRouter.js', {
        __exports: ['armForGeneration', 'applyToLoadedEntries', 'disarm', 'getLastReport', 'showDecisionReport', 'testDecisionConnection', 'initLorebookRouter', 'readConfig', 'collectCandidates', 'buildEntryPickerHtml', 'readPickedEntries', 'buildManualPending', 'describeBasis', 'getDecisionStatus', 'armManualDecision', 'getInjectView'],
        APP, EDITOR, USER,
        POPUP_RESULT,
        getSortedEntries: async () => entries,
        buildQuestions: svc.buildQuestions,
        buildState: svc.buildState,
        buildDigestState: svc.buildDigestState,
        isModerationRejection: svc.isModerationRejection,
        resolveTaskBriefing: svc.resolveTaskBriefing,
        entryTitle: svc.entryTitle,
        // 依据来源与时机：默认「正文 + 每轮都判」，各用例用 over.setting 单独改档
        basisConfig: basis.basisConfig,
        basisDigest: basis.basisDigest,
        readBasisState: basis.readBasisState,
        resolveBasisMode: basis.resolveBasisMode,
        resolveTiming: basis.resolveTiming,
        effectiveReuseRounds: basis.effectiveReuseRounds,
        decideTiming: basis.decideTiming,
        skipsAfterDecision: basis.skipsAfterDecision,
        summarizeBasis: basis.summarizeBasis,
        refreshBasisAfterGeneration: basis.refreshBasisAfterGeneration,
        buildEntryDigest: svc.buildEntryDigest,
        renderInstruction: svc.renderInstruction,
        // 条目摘要索引：候选口径和材料选择器都取自真模块，两边认的必须是同一批条目
        filterDecisionEntries: idx.filterDecisionEntries,
        createMaterialResolver: idx.createMaterialResolver,
        normalizeTypes: idx.normalizeTypes,
        normalizeIndex: idx.normalizeIndex,
        readIndexNumbers: idx.readIndexNumbers,
        chunk: svc.chunk,
        mergeAnswers: svc.mergeAnswers,
        parseAnswers: svc.parseAnswers,
        applyInjectQuota: svc.applyInjectQuota,
        DECISION_DEFAULT_MODEL: svc.DECISION_DEFAULT_MODEL,
        DECISION_MAX_QUESTIONS: svc.DECISION_MAX_QUESTIONS,
        DECISION_MAX_IN_FLIGHT: svc.DECISION_MAX_IN_FLIGHT,
        resolveEndpoint: svc.resolveEndpoint,
        requestDecision: async (options) => {
            calls.request++;
            // 在途计数：进函数就 +1，出口 -1。并发时同一批的多个请求会同时被计进去，
            // 串行则永远只有 1 —— 这是判断「到底有没有并发」最直接的证据
            calls.inFlight++;
            calls.maxInFlight = Math.max(calls.maxInFlight || 0, calls.inFlight);
            calls.last = options;
            calls.questionIds.push(Object.keys(options.questions));
            const sig = calls.questionIds[calls.questionIds.length - 1].join('+');
            calls.seen = calls.seen || {};
            calls.seen[sig] = (calls.seen[sig] || 0) + 1;
            try {
                // over.fail 也可以是函数：按这一次请求的样子决定成不成（「正文会被过滤、摘要不会」就是这么演的）
                const failed = typeof over.fail === 'function' ? !!over.fail(options) : (over.fail ? true : (over.failOnRound === calls.request || (over.failFirstFor || []).includes(sig) && calls.seen[sig] === 1));
                // 必须真的等一拍：不然 Promise.all 里的每个请求都在同一个同步段里跑完，看不出并发
                await new Promise(resolve => setTimeout(resolve, over.latencyMs || 0));
                if (failed) throw new Error(typeof over.fail === 'string' ? over.fail : (over.failMessage || 'boom'));
                const noul = over.noul ?? ((id) => (id === 'q0' ? 0.96 : 0.11));
                const answers = {};
                for (const item of options.map ?? Object.keys(options.questions).map(id => ({ id }))) answers[item.id] = { noul: typeof noul === 'function' ? noul(item.id) : noul };
                if (over.noAnswersFor) {
                    for (const id of over.noAnswersFor) delete answers[id];
                }
                return { answers, usage: { input_tokens: 300 }, latency_ms: 50 };
            } finally {
                calls.inFlight--;
            }
        },
        getPrivacyKey: () => (over.key === undefined ? 'sk-test' : over.key),
        newPopupConfirm: async (message) => {
            const text = String(message);
            log.popups.push(text);
            // 现在只剩「要不要分轮」走这个组件；失败重试改成了三颗按钮的 ST Popup，由 over.failChoice 控制
            if (text.includes('单批上限')) return over.splitAnswer ?? false;
            return over.popupAnswer ?? true;
        },
        // 复用键用的就是索引那套同步 FNV-1a：真模块拿过来，不再碰 crypto.subtle
        fnv1aHex: idx.fnv1aHex,
        SECRET_UNUSABLE_HINT: util.SECRET_UNUSABLE_HINT,
        $: (selector) => ({
            val: () => (selector === '#send_textarea' ? (over.draft ?? '') : ''),
            prop: (name, value) => { log.props.push(`${selector}.${name}=${value}`); return undefined; },
        }),
        console,
    });
    // entries / chat 暴露出来：按轮复用的用例要能改条目正文、推进剧情，看键到底认不认这些变化
    return { router, basis, log, calls, USER, setting, entries, chat, chatMetadata };
}

// 故意让 requestDecision 拿不到 map：用 options.questions 的键兜底
const { router, log, calls } = makeRouter();
check('常驻/已关闭/无关键词/@@activate 都不接管',
    (await router.collectCandidates({ maxCandidates: 60 })).list.map(e => e.uid), [1, 2]);
check('采集返回总数供截断判断', (await router.collectCandidates({ maxCandidates: 1 })).total, 2);

const config = router.readConfig();
check('默认阈值：强推 0.85 / 压制 0.25', [config.forceThreshold, config.suppressThreshold], [0.85, 0.25]);
check('压制默认关闭', config.suppressEnabled, false);
check('默认走 /proxy', config.useProxy, true);

const payload = () => ({
    globalLore: [
        { world: 'w1', uid: 1, disable: false, comment: '相关条目' },
        { world: 'w1', uid: 2, disable: false, comment: '无关条目' },
    ],
    characterLore: [], chatLore: [], personaLore: [],
});

// ---- 未开启 / dryRun / 缺参数 都不该花钱
const off = makeRouter({ setting: { decision_router_enabled: false } });
let p = payload();
await off.router.armForGeneration('normal', {}, false);
await off.router.applyToLoadedEntries(p);
check('关掉开关时不发请求也不改条目', [off.calls.request, p.globalLore[0].disable, off.log.emitted.length], [0, false, 0]);

// 用户报的那一屏：接管没开却勾了「关闭关键词触发注入」——该照常注入，不是 bug
const offBlocked = makeRouter({ setting: { decision_router_enabled: false, decision_block_keyword: true } });
const pOff = payload();
await offBlocked.router.armForGeneration('normal', {}, false);
await offBlocked.router.applyToLoadedEntries(pOff);
check('接管关着时那颗勾一个字都不改：不发请求、不压制、不强推',
    [offBlocked.calls.request, pOff.globalLore.map(e => e.disable), offBlocked.log.emitted.length],
    [0, [false, false], 0]);
truthy('接管关着时那颗勾连提示都不发（免得每轮刷屏）', offBlocked.log.warnings.length === 0);

const dry = makeRouter();
await dry.router.armForGeneration('normal', {}, true);
check('dryRun 试算不发请求', dry.calls.request, 0);
const skip = makeRouter();
await skip.router.armForGeneration('normal', { skipWIAN: true }, false);
check('勾选忽略世界书时不发请求', skip.calls.request, 0);

const noUrl = makeRouter({ setting: { decision_api_url: '' } });
await noUrl.router.armForGeneration('normal', {}, false);
check('地址为空：提醒并退回关键词注入', [noUrl.calls.request, noUrl.log.warnings.length], [0, 1]);
const noKey = makeRouter({ key: '' });
await noKey.router.armForGeneration('normal', {}, false);
check('Key 为空：提醒且不发请求', [noKey.calls.request, noKey.log.warnings.length], [0, 1]);
truthy('Key 不可用时直接说怎么办：清空后重新粘贴', noKey.log.warnings[0].includes('重新粘贴'));

// 一个候选都没有（世界书没开、条目全是常驻/已关闭）：不发请求，但必须说一句。
// 闷声退回关键词注入和「决策开关没生效」是同一种症状，排查时看不出到底卡在哪一步。
const noCandidates = makeRouter({ entries: [] });
await noCandidates.router.armForGeneration('normal', {}, false);
check('一条候选都没有：不发请求', noCandidates.calls.request, 0);
truthy('一条候选都没有：警告说清是没找到带关键词的条目', noCandidates.log.warnings.some(w => /带关键词/.test(w)));

// ---- 本次正要发送的输入：GENERATION_STARTED 时它还没进 chat，必须单独从输入框取
const withDraft = makeRouter({ draft: '我提上火把推开石门的铁环。' });
await withDraft.router.armForGeneration('normal', {}, false);
truthy('输入框里的这句被拼进 state 并标注未入列', /阿明：我提上火把推开石门的铁环。（这句正要发出，尚未写入记录）/.test(withDraft.calls.last.state));
truthy('历史消息仍在 state 里', /我拔出了旧铁剑/.test(withDraft.calls.last.state));

const regenerate = makeRouter({ draft: '这段草稿不该出现' });
await regenerate.router.armForGeneration('regenerate', {}, false);
check('regenerate 时不带上输入框草稿', /不该出现/.test(regenerate.calls.last.state), false);

const dupDraft = makeRouter({ draft: '剑身轻轻一颤' });
await dupDraft.router.armForGeneration('normal', {}, false);
check('草稿与最后一条记录相同时不重复', (dupDraft.calls.last.state.match(/剑身轻轻一颤/g) || []).length, 1);

const longDraft = makeRouter({ draft: '一'.repeat(500), setting: { decision_context_chars: 100 } });
await longDraft.router.armForGeneration('normal', {}, false);
truthy('默认最新那条整段带，上下文字数砍不到它（砍头会把此刻的处境砍掉）', longDraft.calls.last.state.includes('一'.repeat(500)));
check('readConfig 里完整条数默认 1', longDraft.router.readConfig().contextFullMessages, 1);

const shortChars = makeRouter({ draft: '一'.repeat(500), setting: { decision_context_chars: 100, decision_context_full_messages: 0 } });
await shortChars.router.armForGeneration('normal', {}, false);
check('完整条数填 0 就退回每条都截的老行为', shortChars.calls.last.state.includes(`${'一'.repeat(100)}…`), true);
check('完整条数为空框时回到默认 1（不是 0）', makeRouter({ setting: { decision_context_full_messages: '' } }).router.readConfig().contextFullMessages, 1);
const srcForChars = read('scripts/runtime/lorebookRouter.js');
const htmlForChars = read('assets/templates/index.html');
truthy('上下文字数只管超出「消息保留完整字数条数」的那几条（两颗的说明说清了这个分工）', /超出「消息保留完整字数条数」的消息每条带多少字/.test(htmlForChars) && /末尾几条整段带过去、不截字数/.test(htmlForChars));
truthy('两条依据路径都把完整条数传进去了（漏一条就等于那条路照旧砍尾巴）',
    /buildDigestState\(\{[\s\S]{0,400}\}, config\.contextChars, config\.contextFullMessages\)/.test(srcForChars)
    && /buildState\(\{ \.\.\.shared, messages: recent \}, config\.contextChars, config\.contextFullMessages\)/.test(srcForChars));

// ---- 提示词可编辑：设置里的三段文字必须原样出现在真实请求里
const customPrompt = makeRouter({ setting: { decision_instruction_template: '本段是否提到了{label}（{keys}）？' } });
await customPrompt.router.armForGeneration('normal', {}, false);
check('自定义判定问法发给了模型', Object.values(customPrompt.calls.last.questions).map(q => q.instructions),
    ['本段是否提到了相关条目（铁剑、武器）？', '本段是否提到了无关条目（铁剑、武器）？']);

const blankTemplate = makeRouter({ setting: { decision_instruction_template: '这条和当前剧情有关吗？' } });
await blankTemplate.router.armForGeneration('normal', {}, false);
truthy('模板没写占位符时自动补摘要，避免所有条目问同一句',
    new Set(Object.values(blankTemplate.calls.last.questions).map(q => q.instructions)).size === 2);

const sceneNote = makeRouter({ setting: { decision_state_note: '现代都市日常，奇幻设定只在梦里出现' } });
await sceneNote.router.armForGeneration('normal', {}, false);
check('固定背景紧跟在任务说明之后（第二行）', sceneNote.calls.last.state.split('\n')[1], '当前场景：现代都市日常，奇幻设定只在梦里出现');

const noNote = makeRouter({ draft: '我提上火把。', setting: { decision_pending_note: '' } });
await noNote.router.armForGeneration('normal', {}, false);
truthy('标注清空后只留句子本身', /阿明：我提上火把。$/.test(noNote.calls.last.state.trim()) && !/尚未写入记录/.test(noNote.calls.last.state));
check('readConfig 不会把清空当成默认值', noNote.router.readConfig().pendingNote, '');

const reportTemplate = makeRouter();
await reportTemplate.router.armForGeneration('normal', {}, false);
check('决策报告记住本轮用的问法', reportTemplate.router.getLastReport().instructionTemplate, svc.DEFAULT_INSTRUCTION_TEMPLATE);

// ---- 正常路径：只强推
p = payload();
await router.armForGeneration('normal', {}, false);
check('发了一次批量请求', calls.request, 1);
check('state 带角色与最近对话（不含系统消息）', /角色：小蓝 与 阿明/.test(calls.last.state) && !/系统消息/.test(calls.last.state), true);
check('一次问完所有候选', Object.keys(calls.last.questions).length, 2);
check('走 /proxy 且带密钥', [calls.last.useProxy, calls.last.apiKey], [true, 'sk-test']);
await router.applyToLoadedEntries(p);
check('高概率条目被强推（带完整条目）', log.emitted.filter(e => Array.isArray(e) && e[0] === 'force').map(e => e[1].map(x => `${x.world}.${x.uid}:${x.content.slice(0, 4)}`)), [['w1.1:一把会说']]);
check('压制未开时不改 disable', p.globalLore.map(e => e.disable), [false, false]);
const report = router.getLastReport();check('报告记录了候选数', report.candidateCount, 2);
check('报告记录了中间带', Object.values(report.scores).length, 2);
check('报告记录 token 与耗时', [report.inputTokens, report.latencyMs], [300, 50]);

// ---- 本轮注入名额上限：判多少条是「候选上限」管，实际塞多少条归这两个数管
const quotaEntries = [
    entry({ uid: 1, comment: '长条目', content: '甲'.repeat(100) }),
    entry({ uid: 2, comment: '短条目', content: '乙'.repeat(10) }),
];
// 两条都过强推线，但 2 号概率更高 → 只给一个名额时留下的是 2 号
const quotaNoul = (id) => (id === 'q0' ? 0.9 : 0.95);
const quotaPayload = () => ({
    globalLore: quotaEntries.map(e => ({ world: 'w1', uid: e.uid, content: e.content, disable: false })),
    characterLore: [], chatLore: [], personaLore: [],
});
const forcedUids = (instance) => instance.log.emitted.filter(e => Array.isArray(e) && e[0] === 'force').map(e => e[1].map(x => x.uid));
check('名额默认 0＝不限', makeRouter().router.readConfig().injectMaxEntries, 0);

const quotaOne = makeRouter({ entries: quotaEntries, noul: quotaNoul, setting: { decision_inject_max_entries: 1 } });
await quotaOne.router.armForGeneration('normal', {}, false);
let qPayload = quotaPayload();
await quotaOne.router.applyToLoadedEntries(qPayload);
check('名额 1 条：只注入概率最高的那条', forcedUids(quotaOne), [[2]]);
check('没占上名额的那条不改 disable（关着关键词注入时它照旧走关键词规则）', qPayload.globalLore.map(e => e.disable), [false, false]);
check('报告里的强推数是截断以后的，被挤掉的另列', quotaOne.router.getInjectView(quotaOne.router.getLastReport()).squeezed.map(f => f.uid), [1]);
await quotaOne.router.showDecisionReport();
truthy('报告点名「本轮被注入名额挤掉的」这一档', /本轮被注入名额挤掉的/.test(quotaOne.log.popupHtml));
truthy('报告写出名额与实际注入几条几字', /本轮注入名额：最多 1 条/.test(quotaOne.log.popupHtml) && /实际注入 1 条 \/ 10 字/.test(quotaOne.log.popupHtml));
truthy('挤掉的没有混进中间带那张表', (quotaOne.log.popupHtml.match(/长条目/g) || []).length === 1);

const quotaBlock = makeRouter({ entries: quotaEntries, noul: quotaNoul, setting: { decision_inject_max_entries: 1, decision_block_keyword: true } });
await quotaBlock.router.armForGeneration('normal', {}, false);
qPayload = quotaPayload();
await quotaBlock.router.applyToLoadedEntries(qPayload);
check('全接管时名额挤掉的这一轮不注入（这才是「本轮最多注入 1 条」的意思）', [forcedUids(quotaBlock), qPayload.globalLore.map(e => e.disable)], [[[2]], [true, false]]);

const quotaChars = makeRouter({ entries: quotaEntries, noul: () => 0.9, setting: { decision_inject_max_chars: 50 } });
await quotaChars.router.armForGeneration('normal', {}, false);
await quotaChars.router.applyToLoadedEntries(quotaPayload());
check('字数名额：第一条无论如何留（不然 100 字的条目谁都注入不了），后面那条装不下就挤掉', forcedUids(quotaChars), [[1]]);

const quotaReuse = makeRouter({ entries: quotaEntries, noul: quotaNoul, setting: { decision_reuse_rounds: 1, decision_inject_max_entries: 2 } });
await quotaReuse.router.armForGeneration('normal', {}, false);
await quotaReuse.router.applyToLoadedEntries(quotaPayload());
quotaReuse.setting.decision_inject_max_entries = 1;
await quotaReuse.router.armForGeneration('normal', {}, false);
await quotaReuse.router.applyToLoadedEntries(quotaPayload());
check('名额改了就当场生效：用的还是上面那次判定，一个请求都没多花', [quotaReuse.calls.request, quotaReuse.router.getLastReport().cached], [1, true]);
check('生效值当场变（它不进判定、也不进复用键）', forcedUids(quotaReuse), [[2, 1], [2]]);
check('手动挑的那一批不占名额：那是一条条点出来的，再被名额丢掉比多注入一条更难查',
    quotaOne.router.getInjectView({ manual: true, force: quotaEntries, scores: {} }).kept.map(e => e.uid), [1, 2]);

// ---- 按轮复用（「结果复用（秒）」整个换掉：那个键带正文，每轮都失效，等于没有）
await router.armForGeneration('normal', {}, false);
check('复用轮数 0（默认）＝每一轮都重新问，保持老行为', [calls.request, router.getLastReport().cached], [2, false]);

const reused = makeRouter({ setting: { decision_reuse_rounds: 1 } });
await reused.router.armForGeneration('normal', {}, false);
check('判定那一轮照旧花钱，并记下还能白嫖几轮', [reused.calls.request, reused.router.getLastReport().reuseLeft], [1, 1]);
await reused.router.armForGeneration('normal', {}, false);
check('复用轮数 1：下一轮一个请求都不发，直接拿上次判定', [reused.calls.request, reused.router.getLastReport().cached], [1, true]);
check('复用那一轮报告写「还剩 0 轮」', reused.router.getLastReport().reuseLeft, 0);
await reused.router.armForGeneration('normal', {}, false);
check('窗口用完就重新问，不是永久白嫖', [reused.calls.request, reused.router.getLastReport().cached], [2, false]);
check('重新问过又开一个新窗口', reused.router.getLastReport().reuseLeft, 1);
check('复用轮数为空框时回到默认 0（每轮都问）', makeRouter({ setting: { decision_reuse_rounds: '' } }).router.readConfig().reuseRounds, 0);

// 剧情推进不再让缓存作废——这正是省钱的根据，也是它的代价：白嫖期间判定是旧的
const moved = makeRouter({ setting: { decision_reuse_rounds: 5 } });
await moved.router.armForGeneration('normal', {}, false);
moved.chat.push({ mes: '剑断了，两个人退到巷口', is_user: false, name: '小蓝' });
await moved.router.armForGeneration('normal', {}, false);
check('正文换了也不重问（复用键里刻意不含正文）', [moved.calls.request, moved.router.getLastReport().cached], [1, true]);
// 但换聊天必须作废：同一个角色+同一本世界书时键是完全一样的，不清就会拿上一个聊天的判定开新剧情
moved.router.initLorebookRouter();
moved.log.handlers.chat();
await moved.router.armForGeneration('normal', {}, false);
check('换聊天后重新问，旧聊天的判定不跨聊天用', [moved.calls.request, moved.router.getLastReport().cached], [2, false]);
moved.setting.decision_router_enabled = false;
await moved.router.armForGeneration('normal', {}, false);
moved.setting.decision_router_enabled = true;
await moved.router.armForGeneration('normal', {}, false);
check('接管拨回去再拨开也不接着白嫖（关掉之前那份不算数）', [moved.calls.request, moved.router.getLastReport().cached], [3, false]);
truthy('复用键里确实没有 state（带 state 就是旧那把废钥匙）',
    /buildReuseKey\(batches, config\)[\s\S]{0,260}fnv1aHex\(`\$\{asked\}@@idx/.test(read('scripts/runtime/lorebookRouter.js'))
    && !/fnv1aHex\(`\$\{state\}/.test(read('scripts/runtime/lorebookRouter.js')));

// 该当场作废的四种变化：条目正文、判定问法、工作认知、固定背景
const stale = makeRouter({ setting: { decision_reuse_rounds: 5 } });
await stale.router.armForGeneration('normal', {}, false);
stale.entries[0].content = '这把剑改过了，现在会骂人';
await stale.router.armForGeneration('normal', {}, false);
check('条目正文改了：当场重问，不拿旧摘要判的结果凑数', [stale.calls.request, stale.router.getLastReport().cached], [2, false]);
stale.setting.decision_instruction_template = '这条设定跟当前剧情搭吗？{digest}';
await stale.router.armForGeneration('normal', {}, false);
check('判定问法改了：当场重问', [stale.calls.request, stale.router.getLastReport().cached], [3, false]);
stale.setting.decision_task_briefing = '只判这个人现在在不在场。';
await stale.router.armForGeneration('normal', {}, false);
check('工作认知改了：当场重问（任务说明只进 state，所以要单独拼进复用键）', [stale.calls.request, stale.router.getLastReport().cached], [4, false]);
stale.setting.decision_state_note = '现代都市日常';
await stale.router.armForGeneration('normal', {}, false);
check('固定背景改了：当场重问', [stale.calls.request, stale.router.getLastReport().cached], [5, false]);

// 新增/删除条目 = 候选清单变了，旧判定盖不住新条目，必须重问
const added = makeRouter({ setting: { decision_reuse_rounds: 5 } });
await added.router.armForGeneration('normal', {}, false);
added.entries.push(entry({ uid: 7, comment: '新加的邻居', content: '住在二楼的裁缝' }));
await added.router.armForGeneration('normal', {}, false);
check('世界书加了条目：当场重问，新条目不会被旧窗口盖住', [added.calls.request, Object.keys(added.calls.last.questions).length], [2, 3]);

// 这个数改小要当场收口，不然「填 0 想立刻重判」还得等旧窗口自己走完
const shrink = makeRouter({ setting: { decision_reuse_rounds: 5 } });
await shrink.router.armForGeneration('normal', {}, false);
check('判定那轮开了 5 轮的窗口', shrink.router.getLastReport().reuseLeft, 5);
shrink.setting.decision_reuse_rounds = 2;
await shrink.router.armForGeneration('normal', {}, false);
check('改成 2 就按 2 收口（旧窗口剩 4 也不给）', shrink.router.getLastReport().reuseLeft, 1);
shrink.setting.decision_reuse_rounds = 0;
await shrink.router.armForGeneration('normal', {}, false);
check('改成 0：下一轮立刻重新问，不等旧窗口走完', [shrink.calls.request, shrink.router.getLastReport().cached], [2, false]);
shrink.setting.decision_reuse_rounds = 3;
await shrink.router.armForGeneration('normal', {}, false);
check('再改成 3 也不继承旧窗口（按新数重开一个）', [shrink.calls.request, shrink.router.getLastReport().reuseLeft], [3, 3]);
await shrink.router.armForGeneration('normal', {}, false);
check('新窗口照常白嫖', [shrink.calls.request, shrink.router.getLastReport().reuseLeft], [3, 2]);

// ---- 条目摘要索引接到路由上
const idxOn = makeRouter({ setting: {
    decision_index_enabled: true,
    decision_entry_index: { 'w1::1': { s: '一把会说话的旧铁剑，剑身有裂纹', t: 'item', h: 'x', at: 1 } },
} });
await idxOn.router.armForGeneration('normal', {}, false);
truthy('有索引的候选按「道具」这一类的问法问', idxOn.calls.last.questions.q0.instructions.includes('这件东西是否被使用'));
check('没索引的候选照旧用通用问法 + 正文片段', idxOn.calls.last.questions.q1.instructions,
    svc.DEFAULT_INSTRUCTION_TEMPLATE.replace('{digest}', svc.buildEntryDigest(entry({ uid: 2, comment: '无关条目' }), 120)));
check('报告记下本轮几条是按摘要判的', [idxOn.router.getLastReport().indexedCount, idxOn.router.getLastReport().candidateCount], [1, 2]);
await idxOn.router.showDecisionReport();
truthy('报告里写清算得清', (idxOn.log.popupHtml || '').includes('摘要索引 1/2 条'));
truthy('只索引了一部分时要提醒（不是静默按老办法判）', idxOn.log.warnings.some(w => w.includes('摘要索引') || w.includes('没有索引')));

const idxEmpty = makeRouter({ setting: { decision_index_enabled: true } });
await idxEmpty.router.armForGeneration('normal', {}, false);
truthy('开着功能但索引是空的：照样判，但要说明本轮用的是老办法',
    idxEmpty.log.warnings.some(w => w.includes('一条都没有索引记录')));

// 索引重建过之后不能接着白嫖（复用键带趟号；漏了 await 时这里会变成「复用判定、只发 1 次」）
const idxCache = makeRouter({ setting: { decision_index_enabled: true, decision_index_at: 1, decision_reuse_rounds: 5 } });
await idxCache.router.armForGeneration('normal', {}, false);
await idxCache.router.armForGeneration('normal', {}, false);
check('同一趟索引内还在窗口里：接着白嫖', [idxCache.calls.request, idxCache.router.getLastReport().cached], [1, true]);
idxCache.setting.decision_index_at = 2;
await idxCache.router.armForGeneration('normal', {}, false);
check('刚重建过索引就重新问，不拿旧摘要的判定凑数', [idxCache.calls.request, idxCache.router.getLastReport().cached], [2, false]);

// 手填一条摘要不改「趟号」，所以趟号取的是记录上最新的写入时间——不然刚填完还得吃旧摘要判出来的判定
const idxManual = makeRouter({ setting: {
    decision_index_enabled: true, decision_index_at: 1, decision_reuse_rounds: 5,
    decision_entry_index: { 'w1::1': { s: '旧摘要', t: 'item', h: 'x', at: 1 } },
} });
await idxManual.router.armForGeneration('normal', {}, false);
await idxManual.router.armForGeneration('normal', {}, false);
check('什么都没改时照常白嫖（手填不该把每一轮都变成新请求）', [idxManual.calls.request, idxManual.router.getLastReport().cached], [1, true]);
idxManual.setting.decision_entry_index['w1::1'] = { s: '刚手填的摘要', t: 'item', h: 'x', at: 2 };
await idxManual.router.armForGeneration('normal', {}, false);
check('手填之后立刻重新问，不拿旧摘要判出来的结果凑数', [idxManual.calls.request, idxManual.router.getLastReport().cached], [2, false]);

// 手填和让 LLM 填都收在同一个弹窗里，提醒只指一个入口
const idxHint = makeRouter({ setting: { decision_index_enabled: true } });
await idxHint.router.armForGeneration('normal', {}, false);
truthy('空索引的提醒指「填写条目索引」', idxHint.log.warnings.some(w => w.includes('填写条目索引')));
truthy('旧的「建立/更新条目索引」按钮已经不在页面上，提醒不能再指它', !idxHint.log.warnings.some(w => w.includes('建立/更新条目索引')));

// ---- 压制打开
const sup = makeRouter({ setting: { decision_suppress_enabled: true } });
p = payload();
await sup.router.armForGeneration('normal', {}, false);
await sup.router.applyToLoadedEntries(p);
check('压制开启后低概率条目本次禁用', p.globalLore.map(e => e.disable), [false, true]);
check('被压制的条目不会被同时强推', sup.router.getLastReport().force.map(f => f.uid), [1]);

// ---- 关闭关键词触发注入（完全以决策模型为准）
const payloadWide = () => ({
    globalLore: [
        { world: 'w1', uid: 1, disable: false, comment: '相关条目' },
        { world: 'w1', uid: 2, disable: false, comment: '无关条目' },
        { world: 'w1', uid: 3, disable: false, constant: true, comment: '常驻' },
        { world: 'w1', uid: 5, disable: false, key: [], comment: '无关键词' },
        { world: 'w1', uid: 6, disable: false, decorators: ['activate'], comment: '手动钉住' },
    ],
    characterLore: [], chatLore: [], personaLore: [],
});
check('关键词注入开关默认关闭', router.readConfig().blockKeyword, false);
check('勾选后 readConfig 读到 true', makeRouter({ setting: { decision_block_keyword: true } }).router.readConfig().blockKeyword, true);

const blk = makeRouter({ setting: { decision_block_keyword: true } });
p = payloadWide();
await blk.router.armForGeneration('normal', {}, false);
await blk.router.applyToLoadedEntries(p);
check('关掉关键词注入后中间带/低概率条目也不注入', p.globalLore.filter(e => e.uid === 1 || e.uid === 2).map(e => e.disable), [false, true]);
check('强推条目不会被这一步误杀', blk.log.emitted.filter(e => Array.isArray(e) && e[0] === 'force').map(e => e[1].map(x => x.uid)), [[1]]);
check('常驻/无关键词/@@钉住的条目完全不受影响', p.globalLore.filter(e => e.uid === 3 || e.uid === 5 || e.uid === 6).map(e => e.disable), [false, false, false]);
check('报告记下本轮是「以决策为准」', blk.router.getLastReport().blockKeyword, true);
await blk.router.showDecisionReport();
truthy('报告里写明关键词注入已关闭', /关键词注入：已关闭（判过 2 条，只有强推的 1 条会注入）/.test(blk.log.popupHtml || ''));
truthy('报告里中间带的标题跟着改口', blk.log.popupHtml.includes('中间带（关键词注入已关闭，本轮不注入）'));

const blkMissing = makeRouter({ noAnswersFor: ['q1'], setting: { decision_block_keyword: true } });
p = payload();
await blkMissing.router.armForGeneration('normal', {}, false);
await blkMissing.router.applyToLoadedEntries(p);
check('模型没返回的条目不被关掉，仍按关键词注入', p.globalLore.map(e => e.disable), [false, false]);
truthy('没判到的条目会明确提醒，而不是静默少注入', blkMissing.log.warnings.some(w => /已关闭关键词注入.*1 条没拿到判定/s.test(w)));

const fivePayload = () => ({
    globalLore: [1, 2, 3, 4, 5].map(uid => ({ world: 'w1', uid, disable: false, comment: `条目${uid}` })),
    characterLore: [], chatLore: [], personaLore: [],
});
const blkTruncated = makeRouter({
    entries: [1, 2, 3, 4, 5].map(uid => entry({ uid, comment: `条目${uid}` })),
    splitAnswer: false,
    setting: { decision_block_keyword: true, decision_batch_size: 2 },
});
p = fivePayload();
await blkTruncated.router.armForGeneration('normal', {}, false);
await blkTruncated.router.applyToLoadedEntries(p);
check('只问第一批时，问到的按决策处置（q0 强推 / q1 关掉关键词）', p.globalLore.slice(0, 2).map(e => e.disable), [false, true]);
check('没问到的三条保持关键词原样', p.globalLore.slice(2).map(e => e.disable), [false, false, false]);

// 白嫖期间改处置策略（这颗勾就是最典型的）：复用的是判定，策略每轮现读
const flip = makeRouter({ setting: { decision_reuse_rounds: 3 } });
await flip.router.armForGeneration('normal', {}, false);
flip.setting.decision_block_keyword = true;
await flip.router.armForGeneration('normal', {}, false);
check('复用判定时只复用判定，处置策略看本轮设置', [flip.router.getLastReport().cached, flip.router.getLastReport().blockKeyword], [true, true]);
check('复用判定时不编造每轮耗时（上一次请求的记录不该算到这一次头上）', flip.router.getLastReport().roundStats, []);
p = payload();
await flip.router.applyToLoadedEntries(p);
check('刚勾上开关下一轮就生效，不用等复用窗口用完', p.globalLore.map(e => e.disable), [false, true]);

// ---- 超过单批上限：分轮问完
const fiveEntries = [1, 2, 3, 4, 5].map(uid => entry({ uid, comment: `条目${uid}` }));
const byId = (id) => ({ q0: 0.95, q1: 0.9, q2: 0.5, q3: 0.2, q4: 0.1 }[id] ?? 0.5);

const rounds = makeRouter({ entries: fiveEntries, noul: byId, setting: { decision_batch_size: 2, decision_multi_round: true } });
await rounds.router.armForGeneration('normal', {}, false);
check('超过单批上限就分多次请求', [rounds.calls.request, rounds.router.getLastReport().rounds], [3, 3]);
check('3 轮在默认并发下同一批发出去', [rounds.calls.maxInFlight, rounds.router.getLastReport().waves], [3, 1]);
check('每轮的问题 id 全局连续，不会互相覆盖', rounds.calls.questionIds.map(ids => ids.join('+')), ['q0+q1', 'q2+q3', 'q4']);
check('各轮结果合并后每条都有分数', Object.keys(rounds.router.getLastReport().scores).length, 5);
check('跨轮判定照常生效', rounds.router.getLastReport().force.map(f => f.uid), [1, 2]);
check('多轮时 token 累加', rounds.router.getLastReport().inputTokens, 900);
check('多轮时问法模板对每一轮都生效', rounds.calls.last.questions.q4.instructions.includes('条目5'), true);

// ---- 分轮之间并发（实测 80 条 = 5 轮：串行 1.15s，4 路并发 0.3~0.5s，token 不变）
const nineEntries = Array.from({ length: 9 }, (_, i) => entry({ uid: i + 1, comment: `条目${i + 1}` }));
const wave = makeRouter({ entries: nineEntries, noul: () => 0.95, setting: { decision_batch_size: 2, decision_multi_round: true } });
await wave.router.armForGeneration('normal', {}, false);
check('5 轮按 4 路切成两批', [wave.calls.request, wave.calls.maxInFlight, wave.router.getLastReport().waves], [5, 4, 2]);
check('并发不改变轮数', wave.router.getLastReport().rounds, 5);
check('并发下每轮各自记了耗时', wave.router.getLastReport().roundStats.length, 5);
check('并发下 token 仍然累加', wave.router.getLastReport().inputTokens, 1500);

const serial = makeRouter({ entries: nineEntries, noul: () => 0.95, setting: { decision_batch_size: 2, decision_multi_round: true, decision_in_flight: 1 } });
await serial.router.armForGeneration('normal', {}, false);
check('填 1 就退回一轮一轮排队', [serial.calls.maxInFlight, serial.router.getLastReport().waves], [1, 5]);

check('并发路数被夹在 1~4（接口 8 路不限流，但浏览器同源只有 6 个连接）',
    [serial.router.readConfig().inFlight,
     makeRouter({ setting: { decision_in_flight: 99 } }).router.readConfig().inFlight,
     makeRouter({ setting: { decision_in_flight: 0 } }).router.readConfig().inFlight], [1, 4, 1]);

await rounds.router.showDecisionReport();
truthy('报告写清几路并发切成几批', /4 路并发 → 1 批/.test(rounds.log.popupHtml));
truthy('报告逐轮列出耗时，并发下总耗时不等于相加', /每轮 第1轮 \d+ms　第2轮 \d+ms　第3轮 \d+ms/.test(rounds.log.popupHtml));

// 接口硬上限 16 条（2026-10-03 实测 400：questions: 60 exceeds the limit of 16）：
// 老存档里躺着的 60 必须在读配置时被夹住，否则每次生成都弹窗报错
check('并发上限 4：接口 8 路实测不限流，是浏览器同源只有 6 个连接', svc.DECISION_MAX_IN_FLIGHT, 4);
const twentyEntries = Array.from({ length: 20 }, (_, i) => entry({ uid: i + 1, comment: `条目${i + 1}` }));
const clamp = makeRouter({ entries: twentyEntries, noul: () => 0.95, setting: { decision_batch_size: 60, decision_multi_round: true, decision_max_candidates: 60 } });
await clamp.router.armForGeneration('normal', {}, false);
check('单批上限被夹到 16', Math.max(...clamp.calls.questionIds.map(ids => ids.length)), 16);
check('20 条被夹住后分两轮问完', [clamp.calls.request, clamp.router.getLastReport().rounds], [2, 2]);
check('夹住上限不影响判到的条数', Object.keys(clamp.router.getLastReport().scores).length, 20);

const asked = makeRouter({ entries: fiveEntries, noul: byId, splitAnswer: true, setting: { decision_batch_size: 2, decision_multi_round: false } });
await asked.router.armForGeneration('normal', {}, false);
truthy('装不下时先问用户要不要分轮', /分轮问完/.test(asked.log.popups[0]));
check('选「分轮问完」顺手写进设置，以后不再问', asked.setting.decision_multi_round, true);
check('同步抽屉里的勾选框，免得设置和界面各说各话', asked.log.props, ['#dlb_multi_round.checked=true']);
check('本轮立即分轮问完', asked.calls.request, 3);

const declined = makeRouter({ entries: fiveEntries, noul: () => 0.95, splitAnswer: false, setting: { decision_batch_size: 2 } });
await declined.router.armForGeneration('normal', {}, false);
check('选「只问第一批」时只发一次请求', declined.calls.request, 1);
check('只问第一批：报告标记截断并记下总数', [declined.router.getLastReport().candidateCount, declined.router.getLastReport().truncated, declined.router.getLastReport().totalCandidates], [2, true, 5]);
truthy('超出上限时 toast 提醒，而不是默默少判', declined.log.warnings.some(w => /本轮只判前 2 条/.test(w)));
check('用户拒绝分轮时不擅自改设置', declined.setting.decision_multi_round, false);
await declined.router.armForGeneration('normal', {}, false);
check('同样的截断提醒不刷屏', declined.log.warnings.filter(w => /本轮只判前/.test(w)).length, 1);

const mid = makeRouter({ entries: fiveEntries, noul: byId, failOnRound: 2, failChoice: 'keyword', setting: { decision_batch_size: 2, decision_multi_round: true } });
await mid.router.armForGeneration('normal', {}, false);
// 并发下同批的其他轮次已经在路上了，拒绝重试只能作废整批，钱照花
check('某轮失败时只停下来问一次，且并发下同批其他轮已经发出', [mid.calls.request, mid.calls.maxInFlight, mid.log.failPopups.length], [3, 3, 1]);
truthy('弹窗说明是第几轮出的问题', /第 2\/3 轮/.test(mid.log.failPopups[0]));
check('放弃重试就整批作废，不用半截结果', [mid.router.getLastReport(), mid.log.emitted.length], [null, 0]);
truthy('作废时给可读警告', mid.log.warnings.some(w => /本次按原关键词注入/.test(w)));

const midRetry = makeRouter({ entries: fiveEntries, noul: byId, failOnRound: 2, failChoice: 'retry', setting: { decision_batch_size: 2, decision_multi_round: true } });
await midRetry.router.armForGeneration('normal', {}, false);
check('重试这一轮成功后继续问完剩下的轮', [midRetry.calls.request, midRetry.router.getLastReport().rounds], [4, 3]);
check('重试成功后照常强推', midRetry.router.getLastReport().force.map(f => f.uid), [1, 2]);
check('重试成功时报告留下「含重试」和重试标记', [midRetry.router.getLastReport().retried, midRetry.router.getLastReport().waves], [true, 2]);

// 并发最坏的一面：同一批里好几轮一起失败，必须合并成一次询问，不能一轮一个弹窗轰炸
const manyFail = makeRouter({ entries: fiveEntries, noul: byId, failFirstFor: ['q0+q1', 'q2+q3'], failChoice: 'keyword', setting: { decision_batch_size: 2, decision_multi_round: true } });
await manyFail.router.armForGeneration('normal', {}, false);
check('一批里多轮同时失败也只弹一次窗', [manyFail.calls.request, manyFail.log.failPopups.length], [3, 1]);
truthy('弹窗把失败的轮次一次列全', /第 1 轮、第 2 轮/.test(manyFail.log.failPopups[0]));
truthy('作废警告说明缺的是哪几轮', manyFail.log.warnings.some(w => /第 1、2 轮（共 2 轮）没结果/.test(w)));

const manyRetry = makeRouter({ entries: fiveEntries, noul: byId, failFirstFor: ['q0+q1', 'q2+q3'], failChoice: 'retry', setting: { decision_batch_size: 2, decision_multi_round: true } });
await manyRetry.router.armForGeneration('normal', {}, false);
check('选重试就把失败的两轮一起补问', [manyRetry.calls.request, manyRetry.router.getLastReport().rounds], [5, 3]);
check('补问成功后判定照常生效', manyRetry.router.getLastReport().force.map(f => f.uid), [1, 2]);

const silentMulti = makeRouter({ entries: fiveEntries, noul: byId, failOnRound: 2, setting: { decision_batch_size: 2, decision_multi_round: true, decision_fail_silent: true } });
await silentMulti.router.armForGeneration('normal', {}, false);
// 静默也要等 3 轮：同批的 3 路是同时发出去的，第 2 轮失败时另外两轮已经在路上，收完才作废
check('静默模式下某轮失败也不弹窗、整批作废', [silentMulti.log.failPopups.length, silentMulti.calls.request, silentMulti.router.getLastReport()], [0, 3, null]);

// ---- 失败弹窗：可无限重试 / 自己挑条目 / 放弃
// 老行为是「只问一次，第二次失败就自己替你放弃了」，现在只有用户点「按原关键词注入」才停
const retryYes = makeRouter({ fail: '网络不通', failChoice: ['retry', 'keyword'] });
await retryYes.router.armForGeneration('normal', {}, false);
check('失败后弹窗询问，选重试则再问一次', [retryYes.calls.request, retryYes.log.failPopups.length], [2, 2]);
truthy('弹窗文案给出「按原关键词注入」退路', /按原关键词注入/.test(retryYes.log.failPopups[0]));
truthy('弹窗文案说清可以一直重试', /可以一直重试/.test(retryYes.log.failPopups[0]));
truthy('第二次弹窗记下已经重试过几次', /已经重试 1 次/.test(retryYes.log.failPopups[1] || ''));
check('用户点「按原关键词注入」才提示并放弃接管', [retryYes.router.getLastReport(), retryYes.log.warnings.length > 0], [null, true]);
await retryYes.router.applyToLoadedEntries(payload());
check('没有决策结果时条目原样不动', retryYes.log.emitted.length, 0);

const thrice = makeRouter({ fail: '网络不通', failChoice: ['retry', 'retry', 'retry', 'keyword'] });
await thrice.router.armForGeneration('normal', {}, false);
check('连点三次重试就真发三次请求，没有次数上限', [thrice.calls.request, thrice.log.failPopups.length], [4, 4]);

const retryNo = makeRouter({ fail: '网络不通', failChoice: 'keyword' });
await retryNo.router.armForGeneration('normal', {}, false);
check('用户选放弃时不再重试', [retryNo.calls.request, retryNo.router.getLastReport()], [1, null]);

const silent = makeRouter({ fail: '网络不通', setting: { decision_fail_silent: true } });
await silent.router.armForGeneration('normal', {}, false);
check('静默兜底：不弹窗，只警告一次', [silent.log.failPopups.length, silent.calls.request, silent.log.warnings.length], [0, 1, 1]);

// ---- 失败弹窗第三颗按钮：自己挑注入条目
const picked = makeRouter({ fail: '网络不通', failChoice: 'pick', pick: [1] });
await picked.router.armForGeneration('normal', {}, false);
check('选「我自己挑」后不再多发决策请求', picked.calls.request, 1);
truthy('清单列的是本轮候选（带关键词、未关闭）', /旧铁剑/.test(picked.log.pickPopups[0] || '') && /无关条目/.test(picked.log.pickPopups[0] || ''));
truthy('清单不会把已关闭/常驻条目放进来', !/已关闭|常驻|无关键词|手动钉住/.test(String((picked.log.pickPopups[0] || '').match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] || '')));
check('勾中的条目成为本轮强制注入项', picked.router.getLastReport().force.map(f => f.uid), [1]);
check('手动结果标明是用户判的、本轮没判定', [picked.router.getLastReport().manual, Object.keys(picked.router.getLastReport().scores).length], [true, 0]);
// 本轮一条都没判定，拿「关闭关键词注入」去禁条目会把没勾的一起杀掉
check('手动这一轮不关关键词注入', picked.router.getLastReport().blockKeyword, false);
truthy('手动注入用 toast 说明来路', picked.log.infos.some(t => /你自己勾选的 1 条/.test(t)));
p = payload();
await picked.router.applyToLoadedEntries(p);
check('只强制注入勾中的那条，另一条不动', [p.globalLore[0].disable, p.globalLore[1].disable, picked.log.emitted.filter(e => String(e[0]).startsWith('force')).length], [false, false, 1]);

// 手动结果不开复用窗口：不然接下来几轮会白拿这一轮的勾选，用户根本不知道判了什么
const pickAgain = makeRouter({ setting: { decision_reuse_rounds: 5 }, fail: '网络不通', failChoice: ['pick', 'keyword'], pick: [1] });
await pickAgain.router.armForGeneration('normal', {}, false);
check('第一轮的勾选确实成了手动结果', [pickAgain.router.getLastReport().manual, pickAgain.router.getLastReport().force.map(f => f.uid)], [true, [1]]);
check('手动那一轮报告里窗口是 0（没开）', pickAgain.router.getLastReport().reuseLeft, undefined);
await pickAgain.router.armForGeneration('normal', {}, false);
check('下一轮生成照常再问模型（手动结果没开窗口）', pickAgain.calls.request, 2);

const pickNone = makeRouter({ fail: '网络不通', failChoice: 'pick', pick: [] });
await pickNone.router.armForGeneration('normal', {}, false);
check('一条都没勾等于放弃：不注入任何东西', [pickNone.router.getLastReport(), pickNone.log.emitted.length], [null, 0]);

const pickCancel = makeRouter({ fail: '网络不通', failChoice: 'pick', pickDismiss: true });
await pickCancel.router.armForGeneration('normal', {}, false);
check('清单里点「按原关键词注入」等于放弃', [pickCancel.router.getLastReport(), pickCancel.calls.request], [null, 1]);

// ---- 失败弹窗的三颗按钮怎么接线
const failOptions = picked.log.popupKinds.find(item => item.kind === 'fail')?.options || {};
// 这颗用的必须是 customButtons：ST 的 Popup 只读这个名字（public/scripts/popup.js:206），
// 写成 buttons 会被整个丢掉——「我自己挑」当年就是这么凭空消失的，弹窗里永远只有重试/取消。
check('自定义按钮用 customButtons，且 result 是数字（ST 的要求）', failOptions.customButtons, [{ text: '我自己挑注入条目', result: POPUP_RESULT.CUSTOM1 }]);
check('回车/ESC 落在「按原关键词注入」上，不是「再发一次请求」', failOptions.defaultResult, POPUP_RESULT.NEGATIVE);
check('那个没人读的 buttons 字段不再出现', failOptions.buttons, undefined);
truthy('失败弹窗是确认型（有 ok/cancel 两颗）', picked.log.popupKinds.some(item => item.kind === 'fail'));
truthy('重试没有次数上限，只有用户选放弃才停', !/只问一次|只能重试一次/.test(read('scripts/runtime/lorebookRouter.js').match(/async function askRetry[\s\S]*?\n}/)?.[0] || ''));
truthy('候选为空时不挂第三颗按钮（没条目可挑）', /if \(candidateCount > 0\)/.test(read('scripts/runtime/lorebookRouter.js')));

// ---- 手动报告的文案：不能看起来像模型判出来的
await picked.router.showDecisionReport();
truthy('手动报告写清是重试失败后改的', /重试 \d+ 次仍未成功，改为你手动勾选的 1 条/.test(picked.log.popupHtml || ''));
truthy('手动报告不报 token（一次都没成功，报 0 会误导）', !/输入 \d+ token/.test(picked.log.popupHtml || ''));
truthy('手动报告说这份只对本次生成有效', /只对本次生成有效/.test(picked.log.popupHtml || ''));

// ---- 清单/回填/手动结果：纯函数
const pickerEntries = [
    entry({ uid: 11, comment: '铁剑的来历', key: ['铁剑'], content: '剑身刻着一行小字。' }),
    entry({ uid: 12, comment: '飞船坐标', key: [], content: '<b>危险</b>标记' }),
];
const pickerHtml = router.buildEntryPickerHtml(pickerEntries, 20);
check('清单每行一个勾选框，带上 world/uid 供回填', (pickerHtml.match(/class="decision-pick"/g) || []).length, 2);
truthy('清单里标题、关键词、正文开头都在', /铁剑的来历/.test(pickerHtml) && /<td>铁剑<\/td>/.test(pickerHtml) && /剑身刻着一行小字/.test(pickerHtml));
truthy('没有关键词的条目这一列留空', /<td><\/td>/.test(pickerHtml));
truthy('正文里的尖括号转义，不会当 HTML 注入', pickerHtml.includes('&lt;b&gt;危险&lt;/b&gt;'));
truthy('清单说明没勾中的照关键词走', /没勾中的照关键词规则/.test(pickerHtml));
const back = router.readPickedEntries({ dlg: pickerDom(pickerHtml, ['12']) }, pickerEntries);
check('按 data-uid 回填只认勾中的那条', back.map(e => e.uid), [12]);
check('dlg 不存在（弹窗没渲染）时不炸', router.readPickedEntries({}, pickerEntries), []);
const manualPending = router.buildManualPending({
    candidates: pickerEntries, picked: [pickerEntries[0]], totalCandidates: 99,
    config: { model: 'm', digestLimit: 120, instructionTemplate: 'x', batchSize: 16, inFlight: 4, forceThreshold: 0.85, suppressThreshold: 0.25, suppressEnabled: false },
    state: 'S', stateSource: 'summary', stateRows: 3, stateChars: 120, stateFallback: false, attempts: 2, startedAt: Date.now(),
});
check('手动结果：强推=勾中的、压制与判定全空', [manualPending.manual, manualPending.force.map(e => e.uid), manualPending.suppress, Object.keys(manualPending.scores).length], [true, [11], [], 0]);
check('手动结果不关关键词注入', manualPending.blockKeyword, false);
check('手动结果记下重试过几次', [manualPending.rounds, manualPending.retried, manualPending.inputTokens], [2, true, 0]);
check('候选多于清单范围时仍标记截断', [manualPending.truncated, manualPending.totalCandidates], [true, 99]);
check('手动结果照样带着依据来源，栏上才说得清判的是摘要还是正文', [manualPending.stateSource, manualPending.stateChars], ['summary', 120]);

// ---- 缺答案的条目
const missing = makeRouter({ noAnswersFor: ['q1'] });
await missing.router.armForGeneration('normal', {}, false);
check('模型没答的条目既不强推也不压制', [missing.router.getLastReport().missing, missing.router.getLastReport().force.map(f => f.uid)], [['无关条目'], [1]]);

// ---- 生成结束清空本轮状态
const ended = makeRouter();
await ended.router.armForGeneration('normal', {}, false);
ended.router.disarm();
p = payload();
await ended.router.applyToLoadedEntries(p);
check('GENERATION_ENDED 后不再影响下一次扫描', [p.globalLore.map(e => e.disable), ended.log.emitted.length], [[false, false], 0]);

// ---- 事件注册 + 测试按钮
const init = makeRouter();
init.router.initLorebookRouter();
check('挂上四个事件（换聊天要清掉按轮复用的窗口）', init.log.emitted, ['on:start', 'on:loaded', 'on:end', 'on:chat']);
const tested = makeRouter();
await tested.router.testDecisionConnection();
check('测试按钮只发一次小请求', tested.calls.request, 1);
check('测试请求带两个对照问题', Object.keys(tested.calls.last.questions), ['a', 'b']);
const testedNoUrl = makeRouter({ setting: { decision_api_url: '' } });
await testedNoUrl.router.testDecisionConnection();
check('测试前校验地址', [testedNoUrl.calls.request, testedNoUrl.log.errors.length], [0, 1]);
const testedCustom = makeRouter({ setting: { decision_instruction_template: '是否提到了{label}？' } });
await testedCustom.router.testDecisionConnection();
check('连通测试也按你写的问法发，不然测的是默认措辞',
    Object.values(testedCustom.calls.last.questions).map(q => q.instructions),
    ['是否提到了测试条目甲？', '是否提到了测试条目乙？']);

// ---- showDecisionReport 不炸
await router.showDecisionReport();
await missing.router.armForGeneration('normal', {}, false);
await missing.router.showDecisionReport();
truthy('报告弹窗渲染不抛错', true);

// ============================================================ 3. 设置接线
// ---- 决策跑完自动弹报告（设置项控制，默认关）
const autoOn = makeRouter({ noul: byId, setting: { decision_auto_popup: true, decision_reuse_rounds: 3 } });
await autoOn.router.armForGeneration('normal', {}, false);
truthy('开了开关就当场弹报告', /候选 \d+ 条/.test(autoOn.log.popupHtml || ''));
await autoOn.router.armForGeneration('normal', {}, false);
check('白嫖那一轮不重复弹（报告还是同一份，每轮关一次窗太烦），小栏随时能点开', autoOn.log.popupOpens, 1);
truthy('白嫖那一轮的报告写清本轮没问模型、还剩几轮',
    /本轮没问模型，用的是上面那次判定，还能这样省 \$\{report\.reuseLeft\} 轮/.test(read('scripts/runtime/lorebookRouter.js')));

const autoOff = makeRouter({ noul: byId });
await autoOff.router.armForGeneration('normal', {}, false);
check('默认不弹（弹窗要手动关，不能强加给每轮生成）', [autoOff.log.popupOpens || 0, !!autoOff.router.getLastReport()], [0, true]);

// ---- 聊天页的快捷查看入口
const barSrc = read('scripts/runtime/decisionStatusBar.js');
const indexSrc = read('index.js');
truthy('小栏只在决策路由开启时出现，关掉就把自己摘掉', /decision_router_enabled !== true[\s\S]{0,120}\$\(`#\$\{BAR_ID\}`\)\.remove\(\)/.test(barSrc));
truthy('小栏贴在输入框上方', barSrc.includes("insertBefore('#form_sheld')"));
truthy('按钮点击走事件委托（小栏每轮重画，直接绑会越叠越多）', /document\)\.on\('click', '#dlb_report_click'/.test(barSrc) && /document\)\.on\('click', '#dlb_manual_arm_click'/.test(barSrc));
truthy('栏上直接给出本轮判定概况', /强推 \$\{forced\}[\s\S]{0,200}压制 \$\{suppressed\}[\s\S]{0,200}中间带 \$\{middle\}/.test(barSrc));
truthy('没问到多少条也写在栏上', barSrc.includes('条没问到'));
truthy('按钮点开的是同一份完整报告', barSrc.includes('showDecisionReport()'));
// 手动挑条目那一轮一条都没判过，栏上写「强推 N」会让人以为模型判过了
truthy('手动那一轮栏上说「你手动挑了 N 条」而不是「强推」', /report\.manual[\s\S]{0,200}你手动挑了 \$\{forced\} 条[\s\S]{0,60}本轮没问模型/.test(barSrc));
truthy('还没跑过决策时按钮是灰的，点了不会弹空窗', barSrc.includes("prop('disabled', !info.usable)"));
// 按轮复用最容易让人误判的就是「这一轮到底判过没有」，所以栏上必须说得出来
truthy('白嫖那一轮栏上写「复用旧判定 + 还能省几轮」（前面那个时间就是判定那轮的，不假装刚判过）',
    /report\.cached[\s\S]{0,160}复用旧判定[\s\S]{0,80}还能这样省 \$\{report\.reuseLeft\} 轮/.test(barSrc));
truthy('判定那一轮就把窗口写在栏上（接下来的几轮不花钱）',
    /reuseLeft > 0[\s\S]{0,100}接下来 \$\{report\.reuseLeft\} 轮不再问模型/.test(barSrc));
truthy('index.js 挂上了小栏（init 自己会画第一遍，开页面就能看到）', indexSrc.includes('initDecisionStatusBar()') && /export function initDecisionStatusBar\(\)[\s\S]*renderDecisionStatusBar\(\);\s*\}/.test(barSrc));
truthy('换聊天/删改/滑动都会重画小栏', ['CHARACTER_MESSAGE_RENDERED', 'CHAT_CHANGED', 'MESSAGE_DELETED', 'MESSAGE_EDITED', 'MESSAGE_SWIPED']
    .filter(type => !barSrc.includes(`types.${type}`)), []);
truthy('开关一拨小栏就跟着显隐', read('scripts/settings/settings.js').includes('renderDecisionStatusBar();'));

console.log('\n===== 3. 默认值 / UI / 回填 =====');
const routerSrc = read('scripts/runtime/lorebookRouter.js');
const defaultsSrc = read('data/pluginSetting.js');
const htmlSrc = read('assets/templates/index.html');
const settingSrc = read('scripts/settings/settings.js');
/**
 * 数抽屉最多套了几层：设置页只许 ①–⑤ 那一层，里面再套抽屉就要点三次才看到控件。
 * @param {string} html
 */
function maxDrawerNesting(html) {
    const VOID = new Set(['input', 'br', 'img', 'hr', 'source', 'link', 'meta']);
    const stack = [];
    let insideDrawer = 0, deepest = 0;
    for (const match of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g)) {
        const [, closing, rawTag, selfClosed] = match;
        const tag = rawTag.toLowerCase();
        if (selfClosed || VOID.has(tag)) continue;
        if (closing) {
            if (stack.pop() === 'drawer') insideDrawer--;
            continue;
        }
        const isDrawer = tag === 'div' && /class="inline-drawer wide100p"/.test(match[0]);
        stack.push(isDrawer ? 'drawer' : 'open');
        if (isDrawer) deepest = Math.max(deepest, ++insideDrawer);
    }
    return [deepest, stack.length];
}
// 新插件的 DOM id 换成 dlb_ 前缀（和原插件同页共存不撞车），设置键仍叫 decision_*：换桶不换字段名。
const domId = (k) => `dlb_${String(k).replace(/^decision_/, '')}`;
const resetDomId = (k) => `dlb_reset_${String(k).replace(/^decision_/, '')}`;
// ⑤ 那一档的边界：从它自己的标题到⑥的标题之间，用来核对提示词框到底收在哪一档
const withinPromptDrawer = (needle) => htmlSrc
    .slice(htmlSrc.indexOf('<b>⑤ 提示词'), htmlSrc.indexOf('<b>⑥ 正文/条目作为参考时'))
    .includes(needle);
// 新增设置却忘了任何一处接线是这类功能最常见的破法：缺默认值会让代理报「未在默认设置中找到」，
// 缺控件则永远改不动，所以按源码里真正读到的键逐个核对，而不是手写一份清单。
const wiredKeys = [...new Set([...routerSrc.matchAll(/setting\.(\w+)/g)].map(m => m[1]))].filter(k => k.startsWith('decision_'));
truthy('读到了足够多的决策设置键', wiredKeys.length >= 15);
check('每个键都在 pluginSetting.js 里有默认值', wiredKeys.filter(k => !new RegExp(`^\\s*${k}:`, 'm').test(defaultsSrc)), []);
// 这三个键是「插件自己写的数据」，不是一个输入框：分类表渲染成可增删改的一行行列，
// 索引本体和趟号只有建索引那一趟会写。它们没有 id="..." 控件属于设计，不是漏接线。
const indexStoreKeys = ['decision_entry_types', 'decision_entry_index', 'decision_index_at'];
check('每个键在设置抽屉里都有控件', wiredKeys.filter(k => !indexStoreKeys.includes(k) && !htmlSrc.includes(`id="${domId(k)}"`)), []);
check('每个键都有回填（打开抽屉能看到当前值）', wiredKeys.filter(k => !indexStoreKeys.includes(k) && !settingSrc.includes(`setting.${k}`)), []);
truthy('分类表摊到工作台「分类编辑」那一页改（设置页只剩一颗入口和一行摘要）',
    read('scripts/runtime/decisionTypeEditor.js').includes('export function createDecisionTypePage')
    && settingSrc.includes("openPage('types')")
    && htmlSrc.includes('id="dlb_type_edit_button"') && !htmlSrc.includes('id="dlb_type_rows"'));
truthy('索引本体和趟号由建索引那一趟写进设置', read('scripts/runtime/decisionEntryIndex.js').includes('USER.store.decision_entry_index = index'));
// 「不启用接管却勾了关闭关键词注入」是不起效的（上面那组行为断言钉的就是这件事），
// 所以页面上必须当场说得出来：那两颗置灰 + 一行带 id 的状态行（带 id 才不会被长说明折叠藏掉）。
truthy('两颗勾后面有一行状态行（带 id）', htmlSrc.includes('id="dlb_injection_gate_hint"'));
truthy('接管没开时那两颗置灰', /function renderDecisionInjectionGate\(\)[\s\S]{0,320}\$\('#dlb_suppress_enabled, #dlb_block_keyword'\)\.prop\('disabled', !enabled\)/.test(settingSrc));
truthy('只灰这两颗：地址/Key/阈值那些开着要用的东西不跟着灰',
    !/function renderDecisionInjectionGate\(\)[\s\S]{0,420}(decision_api_url|decision_api_key|decision_force_threshold|decision_batch_size)/.test(settingSrc));
truthy('说清「勾了什么都不会变」而不是只说要先开启', /renderDecisionInjectionGate[\s\S]{0,700}这两颗勾了什么都不会变/.test(settingSrc));
truthy('拨开关当场重算（不用重进设置页）', /#dlb_router_enabled'\)\.change[\s\S]{0,320}renderDecisionInjectionGate\(\);/.test(settingSrc));
truthy('进设置页时也算一次', /renderDecisionInjectionGate\(\);\s*\n\s*renderDecisionIndex\(\);/.test(settingSrc));
check('四段可编辑提示词都有重置按钮', ['decision_task_briefing', 'decision_instruction_template', 'decision_state_note', 'decision_pending_note']
    .filter(k => !htmlSrc.includes(`id="${resetDomId(k)}"`) || !settingSrc.includes(`'#${resetDomId(k)}'`)), []);
// 这一条是「决策整轮静默死掉」的回归：utils/utility.js 的 calculateStringHash 走 crypto.subtle 的 MD5，
// 浏览器不支持（实测 NotSupportedError），而它原来被调用的位置在 try 之外——异常冒到 ST 的发射器里只留一行
// console.error，症状正是「没有决策过程、没有结果弹窗、世界书照旧按关键词注入」。
truthy('缓存键不再用 crypto.subtle 那个哈希', !/calculateStringHash\s*\(/.test(routerSrc) && routerSrc.includes('fnv1aHex(`'));
// ---- 按轮复用的四处接线（旧的「结果复用（秒）」必须彻底消失：那个键带正文，每轮都失效）
truthy('秒级复用删干净了（源码/默认值/页面/绑定四处都不留）',
    !/decision_cache_seconds|cacheTtlMs|CACHE_MAX|cacheGet|cacheSet/.test(`${routerSrc}${defaultsSrc}${htmlSrc}${settingSrc}`));
truthy('命中窗口才白嫖：键对得上且还剩轮数，否则照旧发请求',
    /reuse\.key === reuseKey && reuse\.roundsLeft > 0/.test(routerSrc));
truthy('判定成功后按设置开窗口（填 0 就是下一轮重新问）',
    /reuse = \{ key: reuseKey, result: pending, roundsLeft: config\.reuseRounds \}/.test(routerSrc));
truthy('换聊天当场清掉窗口：新剧情不许拿上一个聊天的判定凑数',
    /CHAT_CHANGED[\s\S]{0,120}reuse = null/.test(routerSrc));
truthy('接管拨回去再拨开也清窗口', /if \(!config\.enabled\)[\s\S]{0,120}reuse = null;/.test(routerSrc));
truthy('复用窗口里报告仍带旧判定的条目清单（注入侧不用分叉）',
    /pending = \{ \.\.\.reuse\.result, cached: true/.test(routerSrc));
truthy('监听器自己接住异常：半路抛了要当场说，不能只留 console.error',
    /armForGeneration\(type, args, dryRun\)\.catch/.test(routerSrc) && routerSrc.includes('这一趟没跑起来'));
truthy('候选为空不再静默返回', /if \(!candidates\.length\)[\s\S]{0,200}noticeOnce/.test(routerSrc));
// Key 现在是「界面上掩码、存的是明文」：读的时候只校验可用性，写的时候先整理再存，
// 小眼睛负责查看和复制。这几条接线全靠源码核对，漏一处就会退回以前那种「框里显示密文、再改一次就双重加密」的坑。
const apiSrc = read('scripts/settings/standaloneAPI.js');
truthy('读：返回前先校验字符可用性，不合法就不发出去', apiSrc.includes('isUsableSecret(stored)'));
truthy('读：加密和解密的调用已经全部消失', !/encryptXor|decryptXor|getDecrypted/.test(apiSrc));
truthy('写：存 key 前校验每个逗号分段是否可用', settingSrc.includes("result.keyString.split(',').every(isUsableSecret)"));
truthy('写：整理过的结果回填输入框，看到的就等于存下的', /USER\.privacy\[field\] = result\.keyString;\s*\n\s*USER\.saveSettings[\s\S]{0,120}\$\(selector\)\.val\(result\.keyString\);/.test(settingSrc));
check('写：两个 key 框共用同一套绑定', [['#dlb_custom_api_key', 'custom_api_key'], ['#dlb_api_key', 'decision_api_key']]
    .filter(([selector, field]) => !settingSrc.includes(`bindSecretInput('${selector}'`) || !settingSrc.includes(`'${field}'`)), []);
truthy('这个插件没有「旧密文」可迁：加载流程里不挂一次性密钥迁移', !/migrateLegacyEncryptedKeys|api_key_storage/.test(`${settingSrc}${read('scripts/settings/standaloneAPI.js')}`));
check('两个密钥框都有小眼睛和复制按钮', ['#dlb_custom_api_key', '#dlb_api_key']
    .filter(sel => !htmlSrc.includes(`data-target="${sel}"`)
        || htmlSrc.split(`data-target="${sel}"`).length - 1 !== 2), []);
truthy('密钥框不再承诺「加密保存」这种做不到的事', !/XOR 加密保存|不会明文落盘/.test(htmlSrc));
// 失败弹窗现在有三颗按钮，抽屉里就得说清每颗干什么 —— 这是会花付费请求的入口
truthy('抽屉讲明三颗按钮各自的后果', ['我自己挑注入条目', '按原关键词注入', '没有次数上限'].filter(t => !htmlSrc.includes(t)), []);
truthy('抽屉说明回车/ESC 不会误发请求', /回车和 ESC 走的是「按原关键词注入」/.test(htmlSrc));
truthy('抽屉提醒已关闭的条目挑不到', /已关闭<\/b>的条目不在候选范围内/.test(htmlSrc));

// ============================================================ 4. 决策依据（正文／LLM 摘要）与决策时机
console.log('\n===== 4. 决策依据与时机 =====');
const DIGEST = '阿明和小蓝上了灯塔，阿明想要那张海图。';

/** 决策依据／时机的独立实例：纯函数用例用它，路由那边也跑同一个模块，两边认的必须是同一套口径 */
function makeBasis(over = {}) {
    const log = { warnings: [], errors: [], infos: [], successes: [], calls: [], metadataSaves: 0 };
    const setting = { decision_router_enabled: true, decision_basis_mode: 'summary', ...over.setting };
    const chat = over.chat ?? [
        { mes: '我拔出了旧铁剑', is_user: true, name: '阿明' },
        { mes: '剑身轻轻一颤', is_user: false, name: '小蓝' },
    ];
    const chatMetadata = over.metadata ?? {};
    const USER = {
        privacy: over.privacy ?? {},
        store: setting,
        getContext: () => ({ name1: '阿明', name2: '小蓝', chat, chatMetadata, saveMetadata: async () => { log.metadataSaves++; } }),
    };
    const EDITOR = {
        warning: (m) => log.warnings.push(String(m)),
        error: (m) => log.errors.push(String(m)),
        info: (m) => log.infos.push(String(m)),
        success: (m) => log.successes.push(String(m)),
    };
    const call = (channel) => async (system, prompt) => {
        log.calls.push({ channel, system, prompt });
        if (over.basisDelay) await new Promise(resolve => setTimeout(resolve, over.basisDelay));
        if (over.basisFail) throw new Error(over.basisFail);
        return over.basisText ?? DIGEST;
    };
    const mod = toFactory('scripts/runtime/decisionBasis.js', {
        __exports: ['BASIS_MODES', 'BASIS_STATE_KEY', 'BASIS_CHAR_LIMIT_DEFAULT', 'DEFAULT_BASIS_SYSTEM_PROMPT', 'DEFAULT_BASIS_TEMPLATE', 'resolveBasisMode', 'resolveTiming', 'effectiveReuseRounds', 'decideTiming', 'skipsAfterDecision', 'renderBasisPrompt', 'cleanBasis', 'capBasis', 'floorToLine', 'pickNewFloors', 'markerOf', 'readBasisState', 'writeBasisState', 'basisDigest', 'dropBasis', 'basisConfig', 'summarizeBasis', 'refreshBasisAfterGeneration'],
        EDITOR, USER,
        DEFAULT_BASIS_SYSTEM_PROMPT: svc.DEFAULT_BASIS_SYSTEM_PROMPT,
        DEFAULT_BASIS_TEMPLATE: svc.DEFAULT_BASIS_TEMPLATE,
        fnv1aHex: idx.fnv1aHex,
        handleMainAPIRequest: call('main'),
        handleCustomAPIRequest: call('custom'),
        beginReply: () => {},
        finishReply: () => {},
        console,
    });
    return { mod, log, setting, chat, chatMetadata };
}

// ---- 依据来源与时机各认各的档，读不懂的一律退回默认（不能因为设置里躺了个陌生值就整轮不判）
const basisFn = makeBasis({ setting: {} });
check('依据来源默认正文（现行做法）', basisFn.mod.resolveBasisMode({}), 'chat');
check('选了摘要档才是 summary', basisFn.mod.resolveBasisMode({ decision_basis_mode: 'summary' }), 'summary');
check('旧存档里那个「以表代正文」不再参与判断，一律退回正文',
    basisFn.mod.resolveBasisMode({ decision_basis_mode: 'table', decision_table_state_enabled: true }), 'chat');
check('时机默认每轮都判', basisFn.mod.resolveTiming({}), { mode: 'every_round', everyN: 1 });
check('「每 n 轮」把 n 读出来', basisFn.mod.resolveTiming({ decision_timing_mode: 'every_n', decision_every_n_rounds: 3 }), { mode: 'every_n', everyN: 3 });
check('n 填 0／负数／小数／非数字都按 1 起（1 就是每轮都判）',
    [0, -5, 2.7, '', 'abc'].map(v => basisFn.mod.resolveTiming({ decision_timing_mode: 'every_n', decision_every_n_rounds: v }).everyN),
    [1, 1, 2, 1, 1]);
check('认不出的档位退回每轮都判', basisFn.mod.resolveTiming({ decision_timing_mode: 'weekly' }).mode, 'every_round');
check('只有「每 n 轮」这一档带 n，别的档不带着', basisFn.mod.resolveTiming({ decision_timing_mode: 'manual', decision_every_n_rounds: 5 }).everyN, 1);

// ---- 复用轮数 ≥ n：抬的是生效值，他填的那个数一个字节都不改
check('「每 n 轮」把复用窗口至少抬到 n（否则间隔里那些轮没判定，会悄悄退回关键词）',
    basisFn.mod.effectiveReuseRounds(0, { mode: 'every_n', everyN: 3 }), 3);
check('填的比 n 大就照填的', basisFn.mod.effectiveReuseRounds(5, { mode: 'every_n', everyN: 3 }), 5);
check('别的档一概不抬', [basisFn.mod.effectiveReuseRounds(2, { mode: 'every_round', everyN: 1 }), basisFn.mod.effectiveReuseRounds(2, { mode: 'manual', everyN: 1 })], [2, 2]);

// ---- 到点到哪一轮：计的是「还剩几轮不问」，不是「已过几轮」
const timingN3 = { mode: 'every_n', everyN: 3 };
check('n=3 判完先歇 2 轮', basisFn.mod.skipsAfterDecision(timingN3), 2);
check('歇满才到点：还剩 2、1 轮都不问', [basisFn.mod.decideTiming(timingN3, 2, false).due, basisFn.mod.decideTiming(timingN3, 1, false).due], [false, false]);
check('还剩 0 轮就问', basisFn.mod.decideTiming(timingN3, 0, false).due, true);
check('没到点时说得清还有几轮到点（栏上那句要靠它）', basisFn.mod.decideTiming(timingN3, 2, false).reason, '每 3 轮判一次，还有 2 轮到点');
check('n=1 就是现行的每轮都判', [basisFn.mod.skipsAfterDecision({ mode: 'every_n', everyN: 1 }), basisFn.mod.decideTiming({ mode: 'every_n', everyN: 1 }, 0, false).due], [0, true]);
check('每轮都判那档永远到点，也不歇', [basisFn.mod.decideTiming({ mode: 'every_round' }, 9, false).due, basisFn.mod.skipsAfterDecision({ mode: 'every_round' })], [true, 0]);
check('自主启动：没点按钮就不问', [basisFn.mod.decideTiming({ mode: 'manual' }, 0, false).due, basisFn.mod.decideTiming({ mode: 'manual' }, 0, true).due], [false, true]);
truthy('点了按钮要说清是点的（免得看着像自动判的）', basisFn.mod.decideTiming({ mode: 'manual' }, 0, true).reason.includes('你点了「本轮进行决策」'));
truthy('没点时理由说的是「自主启动」这一档，不是「坏了」', basisFn.mod.decideTiming({ mode: 'manual' }, 0, false).reason.includes('自主启动'));

// ---- 摘要提示词：三份占位符、缺 {new} 兜底、清洗、截断
check('三份占位符各自代入', basisFn.mod.renderBasisPrompt('旧:{old}|新:{new}|上限:{limit}', { oldText: '甲', newLines: '乙', limit: 500 }), '旧:甲|新:乙|上限:500');
truthy('模板里没写 {new} 就自动补在末尾（否则新剧情根本没喂进去）', basisFn.mod.renderBasisPrompt('旧：{old}', { oldText: '甲', newLines: '乙' }).includes('乙'));
truthy('补的那段有标题，模型不会把新剧情当成已有摘要', basisFn.mod.renderBasisPrompt('旧：{old}', { oldText: '甲', newLines: '乙' }).includes('【新增剧情】'));
check('空模板用默认那份，且真的带上了新剧情和上限', (() => {
    const out = basisFn.mod.renderBasisPrompt('', { oldText: '甲', newLines: '乙', limit: 300 });
    return [out.includes('乙'), out.includes('300'), /\{\w+\}/.test(out)];
})(), [true, true, false]);
check('写错的占位符原样留着，方便发现', basisFn.mod.renderBasisPrompt('{oldd} {new}', { newLines: '乙' }), '{oldd} 乙');
truthy('已有摘要是空的就把那一段整块摘掉，不留一个空标题',
    [['', '乙'], ['甲', '乙']].map(([oldText, newLines]) => basisFn.mod.renderBasisPrompt('【已有摘要】\n{old}\n【新增剧情】\n{new}', { oldText, newLines }).includes('【已有摘要】')),
    [false, true]);
check('剥掉代码围栏和「摘要：」前缀（模型爱加，留着会一路传进决策请求）', basisFn.mod.cleanBasis('```text\n摘要：甲\n```'), '甲');
check('正常文本一个字都不改', basisFn.mod.cleanBasis(DIGEST), DIGEST);
check('没超长就不截、也不声明截过', basisFn.mod.capBasis('短摘要', 300), { text: '短摘要', truncated: false });
check('超长截到上限并明写截断了（不许静默裁）', (() => {
    const out = basisFn.mod.capBasis('字'.repeat(400), 300);
    return [out.truncated, out.text.startsWith('字'.repeat(300)), out.text.includes('摘要超长已截断')];
})(), [true, true, true]);
check('上限本身非法时退回默认 800，下限夹到 100',
    [basisFn.mod.capBasis('字'.repeat(900), '').text.length, basisFn.mod.capBasis('字'.repeat(200), 5).text.length], [810, 110]);
check('楼层写成「谁：说了什么」，多余空白收掉',
    [basisFn.mod.floorToLine({ isUser: true, mes: '你好' }, '阿明', '小蓝'), basisFn.mod.floorToLine({ isUser: false, name: '小蓝', mes: ' 你  好 ' }, '阿明', '小蓝')],
    ['阿明：你好', '小蓝：你 好']);
check('摘要吃的是 ST 原样楼层（is_user）：用户那句不能挂上角色的名字',
    basisFn.mod.floorToLine({ is_user: true, name: '', mes: '我拔出了剑' }, '阿明', '小蓝'), '阿明：我拔出了剑');

// ---- 摘要到哪了怎么记：整段重摘、增量、重新生成都要分得清
const floors = [{ mes: '一楼' }, { mes: '二楼' }, { mes: '三楼' }];
check('还没摘要过：整段都要摘', basisFn.mod.pickNewFloors(floors, null).map(m => m.mes), ['一楼', '二楼', '三楼']);
check('只摘没覆盖过的那几楼', basisFn.mod.pickNewFloors(floors, { covered: 1, marker: 'x' }).map(m => m.mes), ['二楼', '三楼']);
check('楼层没涨、最后一条也没变：一趟都不发（最常见的空跑，不能白花钱）',
    basisFn.mod.pickNewFloors(floors, { covered: 3, marker: basisFn.mod.markerOf(floors) }), []);
check('楼层没涨但最后一条被重新生成／编辑过：重摘那一条，摘要才追得上剧情',
    basisFn.mod.pickNewFloors(floors, { covered: 3, marker: '过期' }).map(m => m.mes), ['三楼']);
check('删过消息（covered 比楼层数还大）不会切片越界',
    basisFn.mod.pickNewFloors(floors, { covered: 9, marker: basisFn.mod.markerOf(floors) }), []);
truthy('标记只看楼层数和最后一条，改更早的楼层不会重摘',
    basisFn.mod.markerOf(floors) === basisFn.mod.markerOf(floors.slice()) && basisFn.mod.markerOf(floors) !== basisFn.mod.markerOf(floors.slice(0, 2)));

// ---- 元数据存取：形状不认识、空的、不能写，都得说成「没有摘要」而不是猜
const meta = (obj) => ({ chatMetadata: obj });
check('元数据里没有就是没摘要过', basisFn.mod.readBasisState(meta({})), null);
check('别的插件写的陌生形状一律当没摘要过', basisFn.mod.readBasisState(meta({ dlb_decision_basis: '一段字符串' })), null);
check('摘要文本是空的也算没摘要过', basisFn.mod.readBasisState(meta({ dlb_decision_basis: { text: '  ', covered: 3 } })), null);
check('认得的形状才读出 covered 数字', basisFn.mod.readBasisState(meta({ dlb_decision_basis: { text: '甲', covered: '3' } })).covered, 3);
check('basisDigest 就是那份文本，没有就空串', [basisFn.mod.basisDigest(meta({ dlb_decision_basis: { text: '甲', covered: 1 } })), basisFn.mod.basisDigest(meta({}))], ['甲', '']);
check('当前聊天没有可读写元数据时如实报失败，不假装存好了', basisFn.mod.writeBasisState({ text: '甲' }, {}), false);
let savedCount = 0;
const dropCtx = { chatMetadata: { dlb_decision_basis: { text: '甲', covered: 1 } }, saveMetadata: async () => { savedCount++; } };
check('清除摘要真的从元数据里删掉并落盘（改了提示词想立刻见效用的）',
    [await basisFn.mod.dropBasis(dropCtx), dropCtx.chatMetadata.dlb_decision_basis, savedCount], [true, undefined, 1]);
check('本来就没有摘要时 dropBasis 不谎报成功', await basisFn.mod.dropBasis({ chatMetadata: {} }), false);

// ---- 摘要这一趟用哪个模型、说什么话
const b3off = makeBasis({ setting: { decision_basis_use_main_api: false } });
await b3off.mod.summarizeBasis({ floors: b3off.chat }, b3off.mod.basisConfig(b3off.setting));
check('摘要默认走主 API，不勾就走「自定义独立 API」那套', b3off.log.calls[0].channel, 'custom');
check('提示词留空时退回默认那份摘要器系统提示词', basisFn.mod.basisConfig({}).basisSystemPrompt, svc.DEFAULT_BASIS_SYSTEM_PROMPT);
check('系统提示词整框清空也退回默认（空串不能真的不发）',
    basisFn.mod.basisConfig({ decision_basis_system_prompt: '   ' }).basisSystemPrompt, svc.DEFAULT_BASIS_SYSTEM_PROMPT);
check('摘要字数上限夹住：空框回默认 800、过小按 100',
    [basisFn.mod.basisConfig({}).basisCharLimit, basisFn.mod.basisConfig({ decision_basis_char_limit: 5 }).basisCharLimit], [800, 100]);
const noNew = makeBasis();
const kept = await noNew.mod.summarizeBasis({ oldText: '旧摘要', floors: [] }, noNew.mod.basisConfig(noNew.setting));
check('没有新楼层就不发请求，把旧摘要原样还回去', [kept.text, kept.error, noNew.log.calls.length], ['旧摘要', '', 0]);
const fence = makeBasis({ basisText: '```\n剧情摘要：' + DIGEST + '\n```' });
const fenced = await fence.mod.summarizeBasis({ floors: fence.chat }, fence.mod.basisConfig(fence.setting));
check('模型包了围栏、加了标题也洗干净再存', fenced.text, DIGEST);
const emptyModel = makeBasis({ basisText: '   ' });
const noReturn = await emptyModel.mod.summarizeBasis({ floors: emptyModel.chat }, emptyModel.mod.basisConfig(emptyModel.setting));
check('摘要模型空返回时报错，不存一份空摘要', noReturn.error.includes('没有返回内容'), true);

// ---- 模式 2 的挂点：每轮生成结束就把新剧情并进摘要，下一轮决策才用得上
const auto = makeBasis();
const ranOnce = await auto.mod.refreshBasisAfterGeneration();
check('摘要档：生成结束后发一次摘要请求，楼层全部并进', [ranOnce.ran, ranOnce.floors, auto.log.calls.length], [true, 2, 1]);
check('摘要存进当前聊天的元数据并落盘一次',
    [auto.chatMetadata.dlb_decision_basis.text, auto.chatMetadata.dlb_decision_basis.covered, auto.log.metadataSaves], [DIGEST, 2, 1]);
truthy('送给摘要模型的话里有本轮那几楼', /小蓝：剑身轻轻一颤/.test(auto.log.calls[0].prompt));
check('摘要默认走主 API（B3 那颗勾的默认状态）', auto.log.calls[0].channel, 'main');
await auto.mod.refreshBasisAfterGeneration();
check('剧情没往前就不重复发请求（每轮都白花钱就是这个挂点最容易犯的错）', [auto.log.calls.length, auto.log.metadataSaves], [1, 1]);
auto.chat[1].mes = '剑身轻轻一颤，这一楼改过了';
const reRan = await auto.mod.refreshBasisAfterGeneration();
check('重新生成／编辑最后一条会重摘那一条', [reRan.floors, auto.log.calls.length], [1, 2]);
const chatBasis = makeBasis({ setting: { decision_basis_mode: 'chat' } });
check('正文档不自动摘要：一次请求都不发',
    [await chatBasis.mod.refreshBasisAfterGeneration(), chatBasis.log.calls.length], [{ ran: false, reason: 'off' }, 0]);
const routerOff = makeBasis({ setting: { decision_router_enabled: false } });
check('接管整个没开也不摘要', (await routerOff.mod.refreshBasisAfterGeneration()).reason, 'off');
const broken = makeBasis({ basisFail: '主 API 没配置好' });
const failedRun = await broken.mod.refreshBasisAfterGeneration();
check('摘要失败不推进覆盖楼层：下一轮把这几楼补上，剧情不会静默丢掉',
    [failedRun.ran, failedRun.reason, broken.chatMetadata.dlb_decision_basis], [false, 'failed', undefined]);
truthy('摘要失败要弹一句，不能什么都没说', broken.log.warnings.some(w => /下一轮再补/.test(w)));
const tooLong = makeBasis({ basisText: '字'.repeat(1000), setting: { decision_basis_char_limit: 300 } });
const cappedRun = await tooLong.mod.refreshBasisAfterGeneration();
check('摘要超上限：截断并明说，同时提醒调高上限',
    [cappedRun.ran, tooLong.chatMetadata.dlb_decision_basis.text.startsWith('字'.repeat(300)), tooLong.log.warnings.some(w => /摘要超过/.test(w))],
    [true, true, true]);
const slow = makeBasis({ basisDelay: 15 });
const two = await Promise.all([slow.mod.refreshBasisAfterGeneration(), slow.mod.refreshBasisAfterGeneration()]);
check('自动挂点和弹窗那颗按钮撞车时只跑一趟', [two[1].reason, slow.log.calls.length], ['running', 1]);

// ---- 路由侧：摘要档送的是摘要，正文档送的是正文
const sumOn = makeRouter({
    setting: { decision_basis_mode: 'summary' },
    basisState: { text: DIGEST, covered: 5, at: 1, marker: 'x' },
    draft: '我把门推开',
});
await sumOn.router.armForGeneration('normal', {}, false);
truthy('摘要档：state 里是上一模型写好的概括', sumOn.calls.last.state.includes(`剧情要点（由上一个模型改写的概括，不含细节描写）：\n${DIGEST}`));
check('摘要档：正文楼层一个字都不进请求（拒答就是被它们触发的）', /我拔出了旧铁剑/.test(sumOn.calls.last.state), false);
truthy('摘要滞后一轮，本轮正在输入的那句照样带上并标注', /本轮正要发出的话：\n阿明：我把门推开（这句正要发出，尚未写入记录）/.test(sumOn.calls.last.state));
const sumReport = sumOn.router.getLastReport();
check('报告记下依据是摘要、覆盖到第几楼、多少字',
    [sumReport.stateSource, sumReport.stateRows, sumReport.stateChars, sumReport.stateFallback, sumReport.basisEmergency],
    ['summary', 5, DIGEST.length, false, false]);
check('报告上的话术说清是「每轮自动摘要」', sumOn.router.describeBasis(sumReport), `摘要 ${DIGEST.length} 字（已覆盖 5 楼）`);
truthy('这条路和填表彻底无关：假设置里没有任何填表键，摘要照样生效', sumOn.calls.request === 1 && sumOn.log.warnings.length === 0);

const noDigest = makeRouter({ setting: { decision_basis_mode: 'summary' } });
await noDigest.router.armForGeneration('normal', {}, false);
check('摘要档但这个聊天还没攒出摘要：退回正文判，不能整轮不判',
    [noDigest.calls.request, /我拔出了旧铁剑/.test(noDigest.calls.last.state)], [1, true]);
truthy('退回正文要说一句：依据换了档，判出来的概率不是一回事', noDigest.log.warnings.some(w => /本轮先改用最近几楼正文/.test(w)));
check('退回也要在报告里标出来', [noDigest.router.getLastReport().stateSource, noDigest.router.getLastReport().stateFallback], ['chat', true]);
await noDigest.router.armForGeneration('normal', {}, false);
check('同一句提醒不刷屏（每轮弹一次就成了新毛病）', noDigest.log.warnings.filter(w => /本轮先改用最近几楼正文/.test(w)).length, 1);
check('正文档：不提示、报告不带退档标记', (() => {
    const offBasis = makeRouter({});
    return offBasis.router.readConfig().basisSummary;
})(), false);

// ---- 模式 2 的整条链：生成结束写摘要 → 下一轮决策读摘要
const chain = makeRouter({ setting: { decision_basis_mode: 'summary' } });
chain.router.initLorebookRouter();
await chain.router.armForGeneration('normal', {}, false);
check('第一轮没有摘要，按正文判', [chain.calls.request, /我拔出了旧铁剑/.test(chain.calls.last.state)], [1, true]);
chain.log.handlers.end();
await new Promise(resolve => setTimeout(resolve, 5));
check('生成结束这一趟自动补摘要（发的是摘要请求，不是决策请求）',
    [chain.log.basisCalls.length, chain.calls.request, !!chain.chatMetadata.dlb_decision_basis], [1, 1, true]);
await chain.router.armForGeneration('normal', {}, false);
truthy('下一轮决策的依据就是刚写出来的那份摘要', chain.calls.last.state.includes(DIGEST) && !/我拔出了旧铁剑/.test(chain.calls.last.state));
const chainChat = makeRouter({});
chainChat.router.initLorebookRouter();
chainChat.log.handlers.end();
await new Promise(resolve => setTimeout(resolve, 5));
check('正文档时生成结束后一个字都不多问（默认档不能悄悄加钱）', chainChat.log.basisCalls.length, 0);

// ---- 拒答才多给两颗：超时／断网／格式错都还是原来那三颗
const firstReject = makeRouter({ fail: MODERATED, failChoice: 'keyword' });
await firstReject.router.armForGeneration('normal', {}, false);
truthy('被对端过滤时给「本轮使用正文摘要」', firstReject.log.failPopups[0].includes('本轮使用正文摘要'));
truthy('这个聊天还一次都没判过，所以不给「复用上轮结果」（没得复用）', !firstReject.log.failPopups[0].includes('全部复用上轮结果'));
truthy('拒答弹窗要说明这不是网络问题', /内容被对端过滤/.test(firstReject.log.failPopups[0]));
const netFail = makeRouter({ fail: '决策模型请求超时（15 秒）', failChoice: 'keyword' });
await netFail.router.armForGeneration('normal', {}, false);
check('超时：两颗都不给，弹窗和以前一模一样',
    [netFail.log.failPopups[0].includes('本轮使用正文摘要'), netFail.log.failPopups[0].includes('全部复用上轮结果')], [false, false]);
const limitFail = makeRouter({ fail: '决策模型返回 HTTP 400：{"code":"ValidationError","message":"questions: 60 exceeds the limit of 16"}', failChoice: 'keyword' });
await limitFail.router.armForGeneration('normal', {}, false);
check('同为 400 的「超过 16 条」不是拒答，别把它说成内容问题', limitFail.log.failPopups[0].includes('本轮使用正文摘要'), false);

const seqOpts = { failChoice: ['keyword'] };
const seq = makeRouter(seqOpts);
await seq.router.armForGeneration('normal', {}, false);
seqOpts.fail = MODERATED;
await seq.router.armForGeneration('normal', {}, false);
truthy('有过一次成功判定之后，拒答弹窗才多出「全部复用上轮结果」', seq.log.failPopups[0].includes('全部复用上轮结果'));
const reuseOpts = { failChoice: ['reuse'] };
const reusedByHand = makeRouter(reuseOpts);
await reusedByHand.router.armForGeneration('normal', {}, false);
reuseOpts.fail = MODERATED;
await reusedByHand.router.armForGeneration('normal', {}, false);
check('点「全部复用上轮结果」：除了刚失败那一趟不再多发请求，拿上次判定当本轮判定',
    [reusedByHand.calls.request, reusedByHand.router.getLastReport().cached, reusedByHand.router.getLastReport().reusedByUser], [2, true, true]);
truthy('栏上/报告要说清这是点的，不是到点重判的', reusedByHand.router.getLastReport().skipReason.includes('全部复用上轮结果'));
truthy('复用那一轮也给 toast 说明来路', reusedByHand.log.infos.some(t => /没有再问决策模型/.test(t)));

const emoOpts = { failChoice: ['basis', 'keyword'] };
const emo = makeRouter(emoOpts);
await emo.router.armForGeneration('normal', {}, false);
// 拒答只对「带露骨描写的正文」成立：换成摘要依据就该判得动，这才叫救场成功
emoOpts.fail = (options) => !options.state.includes(DIGEST);
emoOpts.failMessage = MODERATED;
await emo.router.armForGeneration('normal', {}, false);
check('点「本轮使用正文摘要」：先摘要、再拿摘要只重问失败那批一次',
    [emo.log.basisCalls.length, emo.calls.request, emo.router.getLastReport().stateSource, emo.router.getLastReport().basisEmergency], [1, 3, 'summary', true]);
truthy('换成摘要依据后就赢了：只弹一次窗，不再问第二遍', emo.log.failPopups.length === 1);
truthy('重问时送出去的依据就是那份摘要，正文一个字都没再发', emo.calls.last.state.includes(DIGEST) && !/我拔出了旧铁剑/.test(emo.calls.last.state));
check('临时改用摘要只算本轮，报告里要和「每轮自动摘要」分得开',
    emo.router.describeBasis(emo.router.getLastReport()), `摘要 ${DIGEST.length} 字（被拒答后临时改写，只本轮）`);
const alreadySummary = makeRouter({ setting: { decision_basis_mode: 'summary' }, fail: MODERATED, failChoice: 'keyword' });
await alreadySummary.router.armForGeneration('normal', {}, false);
check('已经是摘要档还遇拒答：不给「本轮使用正文摘要」（再摘一遍也没用），复用上轮照样给',
    [alreadySummary.log.basisCalls.length, alreadySummary.log.failPopups[0].includes('本轮使用正文摘要')], [0, false]);
const basisFail = makeRouter({ fail: MODERATED, failChoice: ['basis', 'keyword'], basisFail: '主 API 没配置好' });
await basisFail.router.armForGeneration('normal', {}, false);
check('摘要自己失败：说清原因，仍拿原依据重试，不许假装换了',
    [basisFail.log.errors.some(e => /正文摘要没写出来/.test(e)), basisFail.calls.last.state.includes(DIGEST)], [true, false]);
const twoReject = makeRouter({ fail: MODERATED, failChoice: ['basis', 'keyword'] });
await twoReject.router.armForGeneration('normal', {}, false);
check('一轮里摘要只做一次：试过了还被拒就说明不是露骨描写的事，不能圈着钱反复摘',
    [twoReject.log.basisCalls.length, twoReject.log.failPopups[1].includes('本轮使用正文摘要')], [1, false]);

// ---- 决策时机接到路由上：问、歇、歇、问
const everyN = makeRouter({ setting: { decision_timing_mode: 'every_n', decision_every_n_rounds: 3 } });
const nMarks = [];
for (let i = 0; i < 4; i++) {
    await everyN.router.armForGeneration('normal', {}, false);
    nMarks.push([everyN.calls.request, !!everyN.router.getLastReport()?.cached]);
}
check('每 3 轮：第 1 轮问，2、3 轮不花钱，第 4 轮才再问一次', nMarks, [[1, false], [1, true], [1, true], [2, false]]);
check('D1 的核心：n=3 时复用窗口至少 3 轮，填 0 也一样（抬的是生效值）', everyN.router.readConfig().reuseRounds, 3);
check('读配置时他存的数还在（我们不改他的设置）', everyN.setting.decision_reuse_rounds, 0);
const nOne = makeRouter({ setting: { decision_timing_mode: 'every_n', decision_every_n_rounds: 1 } });
for (let i = 0; i < 3; i++) await nOne.router.armForGeneration('normal', {}, false);
check('每 n 轮填 1 就是现行的每轮都判', nOne.calls.request, 3);
const mustAsk = makeRouter({ setting: { decision_timing_mode: 'every_n', decision_every_n_rounds: 2, decision_reuse_rounds: 5 } });
await mustAsk.router.armForGeneration('normal', {}, false);
await mustAsk.router.armForGeneration('normal', {}, false);
check('间隔那轮白嫖旧判定（这就是复用要省的开销）', [mustAsk.calls.request, mustAsk.router.getLastReport().cached], [1, true]);
await mustAsk.router.armForGeneration('normal', {}, false);
check('到点那一轮必须真问一次，哪怕窗口还开着（否则 n 填 5 和填 1 没区别）',
    [mustAsk.calls.request, mustAsk.router.getLastReport().cached], [2, false]);
const busted = makeRouter({ setting: { decision_timing_mode: 'every_n', decision_every_n_rounds: 2, decision_reuse_rounds: 5 } });
await busted.router.armForGeneration('normal', {}, false);
busted.entries[0].content = '这把剑改过了，现在会骂人';
await busted.router.armForGeneration('normal', {}, false);
check('没到点、旧判定又作废：这一轮一个请求都不发，退回关键词', [busted.calls.request, busted.log.warnings.length], [1, 0]);
truthy('这种情况要在栏上说得出来（不然看着像本轮判过了）', busted.router.getDecisionStatus().skip.includes('上次那份判定已作废'));
await busted.router.armForGeneration('normal', {}, false);
check('计数照走，下一轮就到点重问（没到点不等于永远不到点）', busted.calls.request, 2);
const manual = makeRouter({ setting: { decision_timing_mode: 'manual' } });
await manual.router.armForGeneration('normal', {}, false);
check('自主启动：没点按钮就一轮都不问，连候选都不采集', [manual.calls.request, manual.log.warnings.length], [0, 0]);
truthy('栏上写清为什么没问', manual.router.getDecisionStatus().skip.includes('没点「本轮进行决策」'));
manual.router.armManualDecision();
truthy('点一下只许「下一次生成」，当场不发请求', [manual.log.infos.some(t => /下一次生成会走决策模型/.test(t)), manual.calls.request], [true, 0]);
await manual.router.armForGeneration('normal', {}, false);
check('许过的那一轮真的问了', manual.calls.request, 1);
await manual.router.armForGeneration('normal', {}, false);
check('用完就作废，不会变成每轮都判', manual.calls.request, 1);
manual.router.initLorebookRouter();
manual.router.armManualDecision();
manual.log.handlers.chat();
await manual.router.armForGeneration('normal', {}, false);
check('换聊天时那颗按钮的许诺作废（新剧情不该白拿旧聊天许的那次）', manual.calls.request, 1);
const manualReset = makeRouter({ setting: { decision_timing_mode: 'every_n', decision_every_n_rounds: 3 } });
manualReset.router.initLorebookRouter();
await manualReset.router.armForGeneration('normal', {}, false);
manualReset.log.handlers.chat();
await manualReset.router.armForGeneration('normal', {}, false);
check('换聊天也重新起头计数（新剧情第一轮该老实判一次）', manualReset.calls.request, 2);
const offAgain = makeRouter({ setting: { decision_timing_mode: 'every_n', decision_every_n_rounds: 3 } });
await offAgain.router.armForGeneration('normal', {}, false);
offAgain.setting.decision_router_enabled = false;
await offAgain.router.armForGeneration('normal', {}, false);
offAgain.setting.decision_router_enabled = true;
await offAgain.router.armForGeneration('normal', {}, false);
check('接管拨回去再拨开，计数也归零（不能接着白嫖关掉之前的进度）', offAgain.calls.request, 2);
check('状态里带着档位，小栏才知道该不该画那颗按钮',
    [manual.router.getDecisionStatus().timing.mode, manual.router.getDecisionStatus().basisMode, makeRouter({ setting: { decision_basis_mode: 'summary' } }).router.getDecisionStatus().basisMode],
    ['manual', 'chat', 'summary']);

// ============================================================ 5. 依据/时机/拒答的接线与话术
console.log('\n===== 5. 依据与时机接线 =====');
const basisKeys = ['decision_basis_mode', 'decision_basis_use_main_api', 'decision_basis_char_limit',
    'decision_basis_system_prompt', 'decision_basis_template', 'decision_timing_mode', 'decision_every_n_rounds'];
// 「走主 API」在②和③各有一颗，现在并成④顶上那一个控件；键还是两个、读点还是各看各的。
const mergedControl = 'dlb_llm_use_main_api';
const controlId = (k) => (k === 'decision_basis_use_main_api' ? mergedControl : domId(k));
check('七个新键都有默认值（缺一个代理就会报「未在默认设置中找到」）',
    basisKeys.filter(k => !new RegExp(`^\\s*${k}:`, 'm').test(defaultsSrc)), []);
check('七个新键在抽屉里都有控件', basisKeys.filter(k => !htmlSrc.includes(`id="${controlId(k)}"`)), []);
// 这些键不通过 setting.* 回填（是下拉和勾选框），所以按「绑定 + 回填至少两处同名选择器」核对
check('每个新键都既有绑定又有回填（同一选择器出现两次以上）', basisKeys.filter(k => settingSrc.split(`'#${controlId(k)}'`).length - 1 < 2), []);
check('两份可编辑提示词都有重置按钮', ['decision_basis_system_prompt', 'decision_basis_template']
    .filter(k => !htmlSrc.includes(`id="${resetDomId(k)}"`) || !settingSrc.includes(`'#${resetDomId(k)}'`)), []);
// 摘要档那几行散在②的「数值」「按钮」和⑤提示词档里（设置页只留一层折叠，小标题不可点），
// 套不住一个整块，所以改成一个统一类名逐行显隐。
check('摘要档的状态行和按钮都还有 id（切页显隐之外还要能被代码改写）',
    ['decision_basis_hint', 'decision_timing_hint', 'decision_reuse_hint', 'decision_every_n_wrap',
        'decision_basis_view_button', 'decision_basis_clear_button'].map(domId).filter(id => !htmlSrc.includes(`id="${id}"`)), []);
truthy('摘要档专用的行统一带一个类，settings.js 按它逐行显隐',
    htmlSrc.includes('dlb_basis_summary_only')
    && settingSrc.includes("$('.dlb_basis_summary_only').toggle")
    && !htmlSrc.includes('id="dlb_basis_block"'));
// 10-13 他截图指出：② 选「正文 + 每轮都判」时两颗数值都藏了，那行「数值」小标题还孤零零留着
truthy('② 的「数值」小标题跟着那两颗一起显隐（都不显示时不留空标题）',
    htmlSrc.includes('id="dlb_basis_numbers_label"')
    && settingSrc.includes("$('#dlb_basis_numbers_label').toggle(everyN || summary)"));
truthy('设置整块搬进了工作台：隐藏宿主常驻 + 扩展设置区只留一行指路按钮',
    read('index.js').includes('dlb_settings_host') && read('index.js').includes('dlb_open_workbench_button')
    && settingSrc.includes('SETTINGS_NODE_ID') && settingSrc.includes('createSettingsPage'));
truthy('魔法棒菜单那颗入口由 index.js 挂上',
    read('index.js').includes('initDecisionWorkbench') && read('scripts/runtime/decisionWorkbench.js').includes('extensionsMenu'));
// 折叠只留一层：档内那些「填写／勾选／数值／文本与提示词」原来是可点的第二层抽屉，现在是小标题
check('设置模板的抽屉最多一层（第二个数是标签配平后的残留，0 才算配平）', maxDrawerNesting(htmlSrc), [1, 0]);
check('抽屉一共六档（④ 改名并并进走主 API 勾选、⑤ 提示词独立成档）', (htmlSrc.match(/class="inline-drawer wide100p"/g) || []).length, 6);
truthy('档内小标题用的是不可点的 dlb_group_label，插件自己的 CSS 给了样式',
    htmlSrc.includes('class="dlb_group_label"') && read('assets/styles/style.css').includes('.dlb_group_label'));
// 10-13 他把六档并成五档：调试那三颗并进①，「发给决策模型的内容」改名挪到最后
// 10-13 又拆回六档：④ 改名并顶置「走主 API」那颗，可编辑提示词从②⑤抽出来合成⑤
check('六档的标题与顺序', [...htmlSrc.matchAll(/<b>([①-⑩][^<]*)<\/b>/g)].map(m => m[1]), [
    '① 接管与连通', '② 决策依据与时机', '③ 条目摘要索引与分类',
    '④ llm的使用和api自定义填写', '⑤ 提示词', '⑥ 正文/条目作为参考时']);
truthy('① 里的顺序：填完模型名 → 调试那三颗 → 勾选',
    htmlSrc.indexOf('id="dlb_model"') < htmlSrc.indexOf('>调试与查看</div>')
    && htmlSrc.indexOf('>调试与查看</div>') < htmlSrc.indexOf('<div class="dlb_group_label">勾选</div>'));
truthy('第⑥档没了，但三颗按钮一颗不少（只是搬了家）',
    !/⑥ 调试与查看/.test(htmlSrc) && ['dlb_test_button', 'dlb_view_reply_button', 'dlb_view_report_button']
        .every(id => htmlSrc.includes(`id="${id}"`)));
truthy('旧档名「发给决策模型的内容」不再当标题用（这一档现在叫正文/条目作为参考时）',
    !htmlSrc.includes('发给决策模型的内容（上下文与问法）') && !htmlSrc.includes('正文/条目直接输入时'));
// 10-13 ⑥ 的四颗数值改名：名字里点明各自管的是聊天楼层还是条目；凡是「限多少字」的都统一叫……字数限制
truthy('⑥ 的四颗按新名字叫：聊天参考条数／上下文字数限制／消息保留完整字数条数／条目采用字数限制',
    ['聊天参考条数', '上下文字数限制', '消息保留完整字数条数', '条目采用字数限制']
        .every(label => htmlSrc.includes(`>${label}<br>`))
    && !htmlSrc.includes('>完整条数<br>') && !htmlSrc.includes('>条目采用字数<br>'));
truthy('页面上限字数的四颗统一带「限制」，且「摘要字数」不再单独出现（②摘要／③条目摘要各带前缀）',
    htmlSrc.includes('>摘要字数限制<br>') && htmlSrc.includes('>条目摘要字数限制<br>')
    && !/>(摘要字数|读正文上限|上下文字数|条目采用字数)</.test(htmlSrc));
truthy('⑥ 顶上那条说明点清「条数」是用户和 AI 混在一起数的',
    htmlSrc.includes('你发的和 AI 回的混在一起数'));
truthy('索引档那句「上面那条通用判定问法」跟着换位子改成指第⑤类（判定问法搬进⑤后在它下面）',
    !htmlSrc.includes('上面那条通用判定问法') && htmlSrc.includes('第 ⑤ 类里那条通用判定问法'));
truthy('八份可编辑提示词全在 ⑤ 这一档里（建索引那两份也搬进来了），六颗 ↺ 跟着各自的框',
    ['dlb_task_briefing', 'dlb_instruction_template', 'dlb_state_note', 'dlb_pending_note',
        'dlb_basis_system_prompt', 'dlb_basis_template', 'dlb_index_system_prompt', 'dlb_index_template']
        .every(id => withinPromptDrawer(`id="${id}"`))
    && ['dlb_reset_task_briefing', 'dlb_reset_instruction_template', 'dlb_reset_state_note',
        'dlb_reset_pending_note', 'dlb_reset_basis_system_prompt', 'dlb_reset_basis_template']
        .every(id => withinPromptDrawer(`id="${id}"`)));
truthy('③ 只剩数值：「文本与提示词」这种小标题整个页面都不再出现',
    !htmlSrc.includes('文本与提示词'));
truthy('勾选框的名字后面一律不挂括号说明（要紧话挪进它下面那行小字，没新加段落）',
    !/<span>[^<]*（/.test(htmlSrc)
    && ['启用决策路由', '允许压制低概率条目', '关闭关键词触发注入', '条目太多时分多轮问完',
        '用摘要索引和分类问法判条目', '让这两趟 LLM 都走酒馆主 API']
            .every(name => htmlSrc.includes(`<span>${name}</span>`)));
truthy('「允许压制」这颗改名带上管的是谁（那颗的默认行为挪进 ① 顶上那段总说明）',
    !htmlSrc.includes('<span>允许压制</span>')
    && htmlSrc.includes('下面那颗「允许压制低概率条目」默认关着')
    && settingSrc.includes('「允许压制低概率条目」「关闭关键词触发注入」这两颗的前置门控显示'));
const promptDrawerSrc = htmlSrc.slice(htmlSrc.indexOf('<b>⑤ 提示词'), htmlSrc.indexOf('<b>⑥ 正文/条目作为参考时'));
truthy('⑤ 第一组四框按「依据三段在前、判定问法垫底」排（读的顺序就是拼进请求的顺序，问法最后单独一框）',
    ['dlb_task_briefing', 'dlb_state_note', 'dlb_pending_note', 'dlb_instruction_template']
        .every((id, i, ids) => i === 0
            || promptDrawerSrc.indexOf(`id="${ids[i - 1]}"`) < promptDrawerSrc.indexOf(`id="${id}"`)));
const promptTitleLines = promptDrawerSrc.split('\n').map(line => line.trim());
truthy('⑤ 这几框的标题就是名字本身，后面不挂括号说明（要解释写进框下面那段小字）',
    ['工作认知', '固定背景', '正在输入的那句的标注', '判定问法', '摘要改写指令']
        .every(title => promptTitleLines.includes(title))
    && !promptTitleLines.some(line => line.includes('（')
        && ['工作认知', '固定背景', '判定问法', '摘要改写指令'].some(title => line.startsWith(title))));
truthy('判定问法那段说明自己讲清「每个条目一个问题」和兜底关系，不带括号',
    promptDrawerSrc.includes('每个条目都会被套进这句话生成一个问题')
    && promptDrawerSrc.includes('这一条只兜住没索引的条目和没写专属问法的那一类')
    && !/每个条目都会被套进这句话生成一个问题[^。]*（/.test(promptDrawerSrc));
truthy('⑤ 里那两份建索引提示词仍归索引档显隐（类名 + settings.js 一处 toggle）',
    (htmlSrc.match(/dlb_index_prompts_only/g) || []).length === 4
    && settingSrc.includes("$('#dlb_index_block, .dlb_index_prompts_only').toggle(enabled)"));
truthy('④ 顶上那颗合并勾选排在 API 预设之前（一进这档先看见走哪条通道）',
    htmlSrc.indexOf('id="dlb_llm_use_main_api"') < htmlSrc.indexOf('id="dlb_custom_api_preset_select"'));
truthy('一颗勾选一次写两个键，②③那两颗旧控件不再出现（读点没动，仍各认各的）',
    ['decision_basis_use_main_api', 'decision_index_use_main_api']
        .every(k => settingSrc.includes(`USER.store.${k} = this.checked;`))
    && !htmlSrc.includes('id="dlb_basis_use_main_api"') && !htmlSrc.includes('id="dlb_index_use_main_api"'));
truthy('回填要两边都没关过才算勾上（只读过半截会出现页面和实际通道不一致）',
    /updateSwitch\('#dlb_llm_use_main_api', setting\.decision_basis_use_main_api !== false && setting\.decision_index_use_main_api !== false\)/.test(settingSrc));
truthy('代理那套删干净：界面、绑定、预设字段、独立 API、请求层与默认值里都不再提',
    !/table_proxy|reverse_proxy|proxy_password|ChatCompletionService|内部路由/.test(`${htmlSrc}${settingSrc}${apiSrc}`
        + read('scripts/settings/customApiPresets.js') + read('services/llmApi.js') + defaultsSrc));
truthy('.button-square-icon 是原插件自带的类（酒馆 CSS 里搜不到），分叉时得一起搬过来',
    read('assets/styles/style.css').includes('.button-square-icon'));
const workbenchSrc = read('scripts/runtime/decisionWorkbench.js');
truthy('切页高亮不用酒馆里不存在的主题变量——写错就是一个看不见图标的白方块',
    !/SmartThemeBlurTextColor/.test(workbenchSrc) && /\.dlb-wb-tab_active\s*\{\s*border-color:\s*var\(--active\)/.test(workbenchSrc));
const stStylePath = `${ROOT}/../../../../public/style.css`;
truthy('高亮用的 --active 确实是酒馆自己定义的变量（装到别处时这条自动跳过）',
    !fs.existsSync(stStylePath) || /--active:\s*rgb/.test(fs.readFileSync(stStylePath, 'utf8')));
truthy('进设置页时算一次生效值（不然首次打开全是空的）', /^\s*renderDecisionBasis\(\);/m.test(settingSrc));
truthy('改了 n 或复用轮数就当场重算生效值（不用重进设置页）', /#dlb_every_n_rounds, #dlb_reuse_rounds'\)\.on\('input', renderDecisionBasis\)/.test(settingSrc));
truthy('生效值被抬起来时把那一句显示在复用轮数下面，不藏起来', /effective > stored/.test(settingSrc) && settingSrc.includes('实际按'));
truthy('「自主启动」在页面上有说法：点了才判，不点就一直按关键词', htmlSrc.includes('自主启动（我点了才判）') && htmlSrc.includes('每 n 轮判一次'));
truthy('页面上说清每轮自动摘要的代价是多花一次请求', htmlSrc.includes('每轮多花一次请求'));
truthy('这个独立插件的页面上不提「填表／实时表／梗概」：这些功能没搬过来，提了只会让人去翻不存在的东西',
    !/填表|实时表|梗概/.test(htmlSrc));
truthy('抽屉写明拒答时多两颗按钮，以及超时断网不算拒答',
    ['内容被对端过滤（拒答）时弹窗会多两颗', '全部复用上轮结果', '本轮使用正文摘要', '超时、连不上、模型返回格式不对这些'].filter(t => !htmlSrc.includes(t)), []);
truthy('页面上那颗临时救场的按钮名字和代码里的一模一样', /「本轮使用正文摘要」/.test(htmlSrc) && routerSrc.includes("'本轮使用正文摘要'"));
// 旧的「以表代正文」整条路要删干净：文件、键、话术都不能留（留着会有第二份口径）
check('旧模块文件已删除', fs.existsSync(`${ROOT}/scripts/runtime/decisionStateTable.js`), false);
truthy('源码／默认值／页面／绑定里都不再提「以表代正文」和那两个旧键',
    !/以表代正文|决策摘要表|decision_table_state_enabled|decision_table_row_limit|decisionTableState|ensureDecisionTable|buildTableState/.test(`${routerSrc}${defaultsSrc}${htmlSrc}${settingSrc}${barSrc}${indexSrc}`));
truthy('依据来源与时机的口径收在 decisionBasis.js，路由不自己判档位',
    /basisSummary: resolveBasisMode\(setting\) === 'summary'/.test(routerSrc) && /timing: resolveTiming\(setting\)/.test(routerSrc));
truthy('路由把摘要与拒答识别都从请求层取（不是自己复制一份）',
    /buildDigestState/.test(routerSrc) && /isModerationRejection\(reason\)/.test(routerSrc));
truthy('拒答判定只认「对端答了但过滤了」这一类（C1：超时断网走老弹窗）',
    /rejected && !!previousVerdict\(\)/.test(routerSrc) && /rejected && !config\.basisSummary && !basisTried/.test(routerSrc));
truthy('临时摘要一轮只许试一次，防止圈着钱反复摘', /let basisTried = false;/.test(routerSrc) && /basisTried = true/.test(routerSrc));
truthy('白嫖窗口在「每轮都判」档里照样生效（差点被时机改动弄没的那个回归）',
    /config\.timing\.mode === 'every_round' \|\| !timing\.due/.test(routerSrc));
truthy('没到点时绝不加钱重问（每 n 轮是他给的花钱上限）',
    /if \(!timing\.due\)[\s\S]{0,220}lastSkip = ` \$\{timing\.reason\}`.replace/.test(routerSrc) || /if \(!timing\.due\)[\s\S]{0,240}上次那份判定已作废/.test(routerSrc));
truthy('自主启动那颗按钮挂在聊天页小栏上（不问模型是默认档，没入口就等于没这档）',
    ['armManualDecision', 'decision_manual_arm_click', '本轮进行决策', '已许：下一次生成会决策', 'getDecisionStatus', 'describeBasis'].filter(t => !barSrc.includes(t)), []);
truthy('栏上把「本轮为什么没问」写在脸上', /status\?\.skip/.test(barSrc));
truthy('栏上的依据来源跟着走摘要口径，不再提表格', /describeBasis\(report\)/.test(barSrc) && !/stateSource === 'table'/.test(barSrc));
truthy('换聊天把时机计数和按钮许诺一起清掉', /CHAT_CHANGED[\s\S]{0,200}skipsUntilDue = 0/.test(routerSrc) && /CHAT_CHANGED[\s\S]{0,200}manualArmed = false/.test(routerSrc));
truthy('接管拨回去再拨开也清计数', /if \(!config\.enabled\)[\s\S]{0,160}skipsUntilDue = 0/.test(routerSrc));
truthy('生成结束后挂上自动摘要，且失败不炸整轮', /refreshBasisAfterGeneration\(\)\.catch/.test(routerSrc));


console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);