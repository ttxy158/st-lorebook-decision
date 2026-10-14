// setting-help-collapse.test.mjs
// 设置页长说明折叠（选项行尾一颗「？」，点一下就地展开那段长说明）的回归测试
// 运行：node tests/setting-help-collapse.test.mjs
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

const COLLAPSE = 'scripts/settings/settingHelpCollapse.js';
const {
    DESCRIPTION_COLLAPSE_MIN_CHARS, HELP_HIDDEN_CLASS, HELP_OPEN_CLASS, DONE_CLASS,
    isCollapsibleText, canHostHelpButton, planDescriptionCollapse, applyDescriptionCollapse,
} = toFactory(COLLAPSE, {
    __exports: ['DESCRIPTION_COLLAPSE_MIN_CHARS', 'HELP_HIDDEN_CLASS', 'HELP_OPEN_CLASS', 'DONE_CLASS',
        'isCollapsibleText', 'canHostHelpButton', 'planDescriptionCollapse', 'applyDescriptionCollapse'],
});

const LONG = '勾选后，判过的条目不再靠关键词命中自动注入，只有概率 ≥ 强推阈值的条目会进入提示词；中间带也不再兜底。建议先看一次决策报告再勾。';
const SHORT = '概率 ≥ 此值就强制注入';

// ===== 1. 哪些说明该收 =====
check('阈值是 60 字（短说明收起来反而要点两下才看得懂）', DESCRIPTION_COLLAPSE_MIN_CHARS, 60);
check('长静态说明收', isCollapsibleText(LONG), true);
check('刚好卡在阈值上收', isCollapsibleText('啊'.repeat(60)), true);
check('差一个字不收', isCollapsibleText('啊'.repeat(59)), false);
check('带 id 的实时状态行不收（索引统计、门控提示那几行是代码在改的）', isCollapsibleText('啊'.repeat(200), 'dlb_index_stats'), false);
check('空白文字不算长', isCollapsibleText('   \n \t '), false);
check('「(不建议大Token卡使用)」这种小尾巴不收', isCollapsibleText('(不建议大Token卡使用)'), false);
check('没传文字时不炸', isCollapsibleText(undefined), false);

// ===== 2. 按钮放在哪 =====
const row = (tagName, className = '') => ({ tagName, classList: { contains: (c) => className.split(' ').includes(c) } });
check('勾选框那一行能装按钮（按钮跟着选项走）', canHostHelpButton(row('DIV', 'checkbox_label')), true);
check('label 能装按钮', canHostHelpButton(row('LABEL')), true);
check('普通 div 不装（按钮贴着说明另起一行）', canHostHelpButton(row('DIV', 'range-block justifyLeft')), false);
check('下拉框不装（塞不进子元素）', canHostHelpButton(row('SELECT')), false);
check('输入框不装', canHostHelpButton(row('INPUT')), false);
check('前面没有元素时不炸', canHostHelpButton(null), false);

// ===== 3. 假 DOM 跑一遍完整行为 =====
function makeElement({ tagName = 'SMALL', className = '', id = '', text = '', display = '' }) {
    const classes = new Set(className.split(' ').filter(Boolean));
    const el = {
        tagName,
        id,
        textContent: text,
        style: { display },
        get className() { return [...classes].join(' '); },
        set className(value) { classes.clear(); String(value).split(' ').filter(Boolean).forEach(c => classes.add(c)); },
        classList: {
            contains: (c) => classes.has(c),
            add: (...cs) => cs.forEach(c => classes.add(c)),
            remove: (c) => classes.delete(c),
            toggle: (c, force) => {
                const want = force === undefined ? !classes.has(c) : !!force;
                want ? classes.add(c) : classes.delete(c);
                return want;
            },
        },
        children: [],
        parentNode: null,
        previousElementSibling: null,
        listeners: {},
        addEventListener(type, fn) { el.listeners[type] = (el.listeners[type] || []).concat(fn); },
        appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
        insertBefore(child, ref) {
            const i = el.children.indexOf(ref);
            el.children.splice(i < 0 ? el.children.length : i, 0, child);
            child.parentNode = el;
            return child;
        },
        click() {
            const event = { defaultPrevented: false, propagationStopped: false, preventDefault() { event.defaultPrevented = true; }, stopPropagation() { event.propagationStopped = true; } };
            (el.listeners.click || []).forEach((fn) => fn(event));
            return event;
        },
    };
    return el;
}

/** 造一个设置页片段：每行都是「选项 + 说明」，说明的兄弟就是选项 */
function makePage(items) {
    const container = makeElement({ tagName: 'DIV', className: 'st_ld_settings' });
    const smalls = [];
    items.forEach((item) => {
        const optionRow = makeElement({ tagName: item.rowTag || 'DIV', className: item.rowClass || 'checkbox_label' });
        container.appendChild(optionRow);
        const description = makeElement({ className: `toggle-description justifyLeft ${item.extraClass || ''}`, id: item.id, text: item.text, display: item.display });
        optionRow.appendChild(description); // 说明挂在选项后面：insertBefore 用的就是这个父节点
        description.previousElementSibling = optionRow;
        smalls.push(description);
    });
    container.querySelectorAll = () => smalls.slice();
    return { container, smalls };
}

const fakeDocument = {
    createElement: (tag) => makeElement({ tagName: tag.toUpperCase() }),
};

const { container, smalls } = makePage([
    { text: LONG, rowClass: 'checkbox_label' },            // ① 勾选框后面的长说明
    { text: LONG, rowTag: 'SELECT', rowClass: 'text_pole' }, // ② 下拉框后面的长说明
    { text: LONG, id: 'dlb_index_stats' },                  // ③ 带 id 的状态行
    { text: SHORT },                                        // ④ 短说明
    { text: LONG, display: 'none' },                        // ⑤ 本来就藏着的
]);
const collected = applyDescriptionCollapse(container, { document: fakeDocument, toggleClass: (el, name, force) => el.classList.toggle(name, force) });

check('五处里只收起两处（①②）', collected, 2);
truthy('① 打上收起类和已处理标记', smalls[0].classList.contains(HELP_HIDDEN_CLASS) && smalls[0].classList.contains(DONE_CLASS));
truthy('② 也收起了', smalls[1].classList.contains(HELP_HIDDEN_CLASS));
truthy('③④⑤ 一个字没动（没类名、没按钮）', [smalls[2], smalls[3], smalls[4]].every((s) => !s.classList.contains(HELP_HIDDEN_CLASS) && s.children.length === 0));

const buttonInside = smalls[0].previousElementSibling.children.find((c) => c.classList.contains('setting_help_button'));
truthy('① 的按钮进了勾选框那一行（和选项同一行）', !!buttonInside);
check('① 的按钮不是另起一行那种', buttonInside.classList.contains('setting_help_button_standalone'), false);
const buttonStandalone = smalls[1].parentNode.children.find((c) => c !== smalls[1] && c.classList.contains('setting_help_button'));
truthy('② 的按钮贴在说明前面（父节点里、说明之前）', !!buttonStandalone);
check('② 的按钮带另起一行的类', buttonStandalone.classList.contains('setting_help_button_standalone'), true);
check('按钮位置在说明之前', smalls[1].parentNode.children.indexOf(buttonStandalone) < smalls[1].parentNode.children.indexOf(smalls[1]), true);
check('按钮用问号图标', /fa-circle-question/.test(buttonStandalone.className), true);
check('按钮提示文案', buttonStandalone.title, '展开／收起这段说明');

// 点一下展开
const firstClick = buttonInside.click();
check('点「？」后说明不再带收起类（就地展开）', smalls[0].classList.contains(HELP_HIDDEN_CLASS), false);
check('展开时按钮点亮', buttonInside.classList.contains(HELP_OPEN_CLASS), true);
check('点问号不会把点击传给勾选框', firstClick.propagationStopped, true);
check('点问号不会顺带提交所在的表单', firstClick.defaultPrevented, true);
// 再点收起、第三点又展开（留着展开状态去验重跑）
buttonInside.click();
check('再点「？」又收回去', smalls[0].classList.contains(HELP_HIDDEN_CLASS), true);
check('收起后按钮不再高亮', buttonInside.classList.contains(HELP_OPEN_CLASS), false);
buttonInside.click();

// 重复渲染安全
const secondPass = applyDescriptionCollapse(container, { document: fakeDocument, toggleClass: (el, name, force) => el.classList.toggle(name, force) });
check('再跑一遍不重复收、不重复插按钮', secondPass, 0);
check('正看着的说明不会被重跑又关上', smalls[0].classList.contains(HELP_HIDDEN_CLASS), false);
check('①那一行只有一颗按钮', smalls[0].previousElementSibling.children.filter((c) => c.classList.contains('setting_help_button')).length, 1);
check('②那颗按钮还在（说明还是收起的）', smalls[1].parentNode.children.filter((c) => c.classList.contains('setting_help_button')).length, 1);

// 没有设置页时什么都不做
check('拿不到根节点时返回 0 不报错', applyDescriptionCollapse(null), 0);
check('根节点不像元素时也不报错', applyDescriptionCollapse({ id: 'x' }), 0);

// 判定入口：DOM 元素版
check('planDescriptionCollapse 认得假元素', planDescriptionCollapse(smalls[3]), null);
check('已处理过的不再排', planDescriptionCollapse(smalls[2]), null);
const freshPlan = planDescriptionCollapse(makeElement({ text: LONG, className: 'toggle-description' }));
truthy('新元素给出方案：按钮另起一行', freshPlan && freshPlan.insideRow === false);

// ===== 4. 真实设置页的收起名单 =====
/** 扫 index.html 里所有小字说明（不引 DOM 库，只做标签级扫描） */
function scanDescriptions(html) {
    const out = [];
    const re = /<small\b([^>]*)>([\s\S]*?)<\/small>/g;
    let m;
    while ((m = re.exec(html))) {
        if (!/toggle-description/.test(m[1])) continue;
        out.push({
            line: html.slice(0, m.index).split('\n').length,
            id: (m[1].match(/id="([^"]+)"/) || [])[1] || '',
            plain: m[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ''),
            inlineDisplay: /display\s*:/.test(m[1]),
        });
    }
    return out;
}

const page = read('assets/templates/index.html');
const all = scanDescriptions(page);
const willCollapse = all.filter((d) => isCollapsibleText(d.plain, d.id));
const collapseSet = new Set(willCollapse.map((d) => d.line));

truthy(`设置页共 ${all.length} 处小字说明，收起 ${willCollapse.length} 处长说明`, all.length > 30 && willCollapse.length >= 15);
// 钉住当前口径：以后改文案导致条数变了，这里会红，提醒人复核一遍名单
check('收起条数＝15（改完文案请重看名单）', willCollapse.length, 15);
check('不收的＝32 处（带 id 的 6 条 + 短说明；① 注入名额两框各算一条，③ 那颗「单批字数限制」是把原来「单批条目」的小字换了个说法、没多加一行）', all.length - willCollapse.length, 32);

/** 按开头文字找，不按行号——行号会随着页面加内容整体漂移 */
const collapsedStartingWith = (prefix) => willCollapse.some((d) => d.plain.startsWith(prefix));
const visibleStartingWith = (prefix) => all.some((d) => d.plain.startsWith(prefix) && !collapseSet.has(d.line));
truthy('「启用决策路由」那段总说明被收（说明现在从「开着它…」起头，因为那颗的名字挪进这里了）', collapsedStartingWith('开着它，每次生成前先把最近剧情和候选条目发给决策模型问一轮'));
truthy('走 /proxy 那段被收', collapsedStartingWith('阿里云这个端点不返回跨域许可头'));
truthy('「关闭关键词触发注入」那段确实被收', collapsedStartingWith('勾选后，判过的条目不再靠关键词命中自动注入'));
truthy('「条目太多时分多轮问完」那段被收（开头补的那句把「什么时候才起作用」搬进了说明）', collapsedStartingWith('只有候选条目数超过「单批上限」时这颗才起作用'));
truthy('「调用失败时不再询问」那段确实被收', collapsedStartingWith('不勾选时，失败弹窗有三颗按钮'));
truthy('「自动弹结果报告」那段被收', collapsedStartingWith('弹窗不会挡住生成'));
truthy('「正文／LLM 摘要」两档的代价说明被收', collapsedStartingWith('正文就是现行的做法：把最近几楼'));
truthy('摘要改写指令那段「只喂给决策模型」的提醒被收（占位符说明并进同一段，没另起一小字）', collapsedStartingWith('占位符：{old}已有摘要、{new}本轮新增剧情'));
truthy('判定问法那段长说明被收（问号点一下才展开，页面不被它撑长）', collapsedStartingWith('上面三段拼在一起是模型读的依据'));
truthy('间隔轮数那行是短提示，直接摊在页面上（n 填几是第一眼要看清的）', visibleStartingWith('「每n轮」时每几次生成才问一次模型'));
truthy('「分类提示词」那段占位符说明也被收', collapsedStartingWith('占位符：{types}分类清单'));
truthy('固定背景那句改口后是短提示，直接摊在页面上', visibleStartingWith('这里只填一句「当前场景是什么」'));
truthy('「工作认知」那段说明是短提示，直接摊在页面上', visibleStartingWith('这段每轮都拼在决策依据最前面'));
truthy('分类摘要行带 id（内容是代码填的），绝不收', !all.some((d) => d.id === 'dlb_type_summary' && collapseSet.has(d.line)));
truthy('搬去独立编辑页的那句长说明不在设置页了（没什么可收）', !page.includes('名字随便改'));
truthy('条目索引那段长说明也被收', collapsedStartingWith('这是默认打法：每轮生成时，条目拼给决策模型的不是正文片段'));
truthy('Key 明文保存那段被收', collapsedStartingWith('Key以明文保存在服务器的settings.json里'));
truthy('「复用轮数」的代价说明被收（改这个数之前该看清它说什么）', collapsedStartingWith('「复用轮数」的代价说清楚'));
truthy('「复用轮数」那行短提示直接摊着（0＝每轮都问是用户第一眼要的）', visibleStartingWith('判定成功后连着几轮不再问模型'));
check('带 id 的六处状态行一处都没收', ['dlb_index_stats', 'dlb_type_summary', 'dlb_injection_gate_hint', 'dlb_basis_hint', 'dlb_timing_hint', 'dlb_reuse_hint']
    .filter((id) => all.some((d) => d.id === id)).length, 6);
truthy('接管门控那行带 id（开着要说、关着也要说，不能被「？」藏起来）', all.some((d) => d.id === 'dlb_injection_gate_hint' && !collapseSet.has(d.line)));
truthy('带 id 的状态行全都躲过了折叠（收到名单里一个 id 都没有）', willCollapse.every((d) => !d.id));
truthy('「接口硬上限 16 条」这种一行短提示保持可见', visibleStartingWith('一次请求塞多少条'));
truthy('「概率 ≥ 此值就强制注入」保持可见', visibleStartingWith('概率≥此值就强制注入'));
truthy('「概率 ≤ 此值才压制」这种一行短提示保持可见', visibleStartingWith('概率≤此值才压制'));
truthy('⑥ 那句「条数是用户和 AI 混在一起数」摊在页面上（改数值前第一眼就要看到）',
    visibleStartingWith('这里说的「条数」都按聊天楼层算'));
// 页面上有写着行内 display 的说明（折叠类名要盖过它，所以 .setting_help_hidden 必须带 !important）
truthy('页面上确有写着行内 display 的说明（类名靠 !important 才压得住它）', all.some((d) => d.inlineDisplay));

// ===== 5. 接线 =====
const settingSrc = read('scripts/settings/settings.js');
truthy('设置模块导入了折叠函数', /import\s*\{\s*applyDescriptionCollapse\s*\}\s*from\s*["']\.\/settingHelpCollapse\.js["']/.test(settingSrc));
truthy('renderSetting 末尾调一次（模板注入之后才跑）', /applyDescriptionCollapse\(document\.querySelector\('\.st_ld_settings'\)\);[\s\S]{0,140}设置已渲染/.test(settingSrc));
truthy('只作用在设置页容器里（弹窗里那些同名小字不受影响）', (page.match(/class="st_ld_settings"/g) || []).length === 1);
check('折叠扫的选择器和这里扫 HTML 用的是同一个口径', /querySelectorAll\('small\.toggle-description'\)/.test(read(COLLAPSE)), true);

const css = read('assets/styles/style.css');
truthy(`收起类 .${HELP_HIDDEN_CLASS} 是 display:none !important`, new RegExp(`\\.${HELP_HIDDEN_CLASS}\\s*\\{[^}]*display:\\s*none\\s*!important`).test(css));
// 酒馆给 .toggle-description 的是 inline，说明会和下一颗标题挤在同一行（⑤ 那四段就是这样）
truthy('设置页里的说明统一按块排，但不带 !important（收起那颗 !important 才压得住它）',
    /\.st_ld_settings small\.toggle-description\s*\{\s*display:\s*block;?\s*\}/.test(css)
    && !/\.st_ld_settings small\.toggle-description\s*\{[^}]*!important/.test(css));
truthy('已处理标记在判定和落笔两处都用到（重跑靠它跳过，CSS 里不需要样式）',
    /classList\??\.contains\(DONE_CLASS\)/.test(read(COLLAPSE)) && /classList\.add\(HELP_HIDDEN_CLASS,\s*DONE_CLASS\)/.test(read(COLLAPSE)));
check('类名只在常量声明里写死一次，别处一律用常量', (read(COLLAPSE).match(/'setting_help_hidden'/g) || []).length, 1);
truthy('按钮是小方块，不撑高选项行', /\.setting_help_button\s*\{[\s\S]{0,340}width:\s*20px/.test(css));
truthy('另起一行用的独立样式在', new RegExp(`\\.setting_help_button_standalone\\s*\\{`).test(css));
truthy('展开时按钮点亮', /\.setting_help_button:hover,\s*\n\.setting_help_button_open\s*\{/.test(css));

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
