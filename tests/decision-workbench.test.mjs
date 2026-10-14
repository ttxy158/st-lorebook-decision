// decision-workbench.test.mjs
// 决策索引工作台（底部魔法棒菜单入口 + 一个弹窗三页切换 + 设置整块搬进搬出）的回归测试
// 运行：node tests/decision-workbench.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
function toFactory(file, deps) {
    const exportNames = deps.__exports;
    delete deps.__exports;
    const src = read(file)
        .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?$/gm, '')
        .replace(/^export\s+async\s+function/gm, 'async function')
        .replace(/^export\s+function/gm, 'function')
        .replace(/^export\s+/gm, '');
    const names = Object.keys(deps);
    const factory = new Function(...names, `${src}\n return { ${exportNames.join(', ')} };`);
    return factory(...names.map(n => deps[n]));
}

/** 假菜单容器：插过一次之后那颗按钮就在里面了（重复挂载靠它认） */
function makeMenu() {
    const host = {
        html: '',
        clicks: 0,
        querySelector: (sel) => (host.html.includes(`id="${MENU_BUTTON_ID}"`) && sel.includes(MENU_BUTTON_ID)
            ? { addEventListener: () => { host.clicks++; } } : null),
        insertAdjacentHTML: (_, html) => { host.html += html; },
    };
    return host;
}

const WB_EXPORTS = ['MENU_BUTTON_ID', 'registerDecisionPage', 'pages', 'menuButtonHtml', 'initDecisionWorkbench', 'tabsHtml', 'openDecisionWorkbench'];
/** 菜单入口的 id 写死在这儿（假菜单靠它认「已经有了」），下面第一条断言会把它和模块钉在一起 */
const MENU_BUTTON_ID = 'dlb_workbench_menu_button';

/** 每次都新造一份模块实例：`current` 和 extraPages 都是模块级状态 */
function makeWorkbench() {
    const log = { warning: [], mounted: [], disposed: [], popups: [] };
    const EDITOR = {
        warning: (m) => log.warning.push(String(m)),
        POPUP_TYPE: { TEXT: 'text' },
        Popup: class {
            constructor(html) {
                this.html = html;
                this.tabs = [];
                this.dlg = {
                    querySelector: (sel) => (sel === '.dlb-wb-body' ? { innerHTML: '' } : sel === '.dlb-wb-hint' ? { textContent: '' } : null),
                    querySelectorAll: () => this.tabs,
                    addEventListener: () => {},
                    removeEventListener: () => {},
                };
                // 真弹窗的 show() 要到关窗才落定，这里照做：开着的窗口不能把测试吊住，所以不 await 它
                this.show = () => new Promise((resolve) => { this.close = resolve; });
                log.popups.push(this);
            }
        },
    };
    // 两页用假实现：只关心工作台怎么切页、什么时候拆监听
    const busy = { index: false };
    const page = (key, label, icon) => ({
        key, label, icon, hint: `${label}的说法`,
        mount: async (root) => {
            log.mounted.push(key);
            root.innerHTML = `<div>page:${key}</div>`;
            return { isBusy: () => key === 'index' && busy.index, dispose: () => log.disposed.push(key) };
        },
    });
    const mod = toFactory('scripts/runtime/decisionWorkbench.js', {
        __exports: WB_EXPORTS,
        EDITOR,
        console,
        createManualIndexPage: () => page('index', '填写条目索引', 'fa-pen'),
        createDecisionTypePage: () => page('types', '分类编辑', 'fa-tags'),
    });
    return { mod, log, busy, EDITOR };
}

/** 弹窗那一趟是异步挂页的：让出一次宏任务，mount 已经跑完、show() 还挂着 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

console.log('\n===== 1. 页面契约与注册 =====');
const first = makeWorkbench();
check('内置两页：索引在前、分类在后', first.mod.pages().map(p => p.key), ['index', 'types']);
check('同名页不覆盖、空键和不带 mount 的一律不收',
    [first.mod.registerDecisionPage({ key: 'index', mount: async () => ({}) }),
     first.mod.registerDecisionPage({ key: '', mount: async () => ({}) }),
     first.mod.registerDecisionPage({ key: 'settings' }),
     first.mod.registerDecisionPage({ key: 'settings', mount: async () => ({}) })],
    [false, false, false, true]);
check('注册的那页排在后面（右上角齿轮按 key 找，不看位置）', first.mod.pages().map(p => p.key), ['index', 'types', 'settings']);
check('内置两页都带 mount / label / hint（缺 hint 的那页切过去只是空一行，不该炸）',
    first.mod.pages().slice(0, 2).map(p => [typeof p.mount, !!p.label, !!p.hint]),
    [['function', true, true], ['function', true, true]]);

console.log('\n===== 2. 魔法棒菜单入口 =====');
const host = makeMenu();
check('挂上了菜单行', first.mod.initDecisionWorkbench({ menu: host }), true);
truthy('菜单 id 和这个测试假菜单认的那串一致（也带 dlb_ 前缀，不撞原插件）', first.mod.MENU_BUTTON_ID === MENU_BUTTON_ID);
truthy('用的是酒馆那套 list-group-item 结构，图标走 extensionsMenuExtensionButton',
    host.html.includes('list-group-item') && host.html.includes('extensionsMenuExtensionButton'));
check('同一个菜单容器再挂一次不插第二份（插件重载是常态）', first.mod.initDecisionWorkbench({ menu: host }), false);
check('容器里确实只有一颗', (host.html.match(/id="dlb_workbench_menu_button"/g) || []).length, 1);
check('没有菜单容器时安静返回 false（不炸加载）', first.mod.initDecisionWorkbench({ menu: null }), false);
truthy('默认名字是「决策索引工作台」', first.mod.menuButtonHtml().includes('决策索引工作台'));

console.log('\n===== 3. 顶部那一排 =====');
const tabs = first.mod.tabsHtml(first.mod.pages(), 'index');
truthy('左并列两页带名字，右端只有齿轮（不带文字，省得把两页挤下去）',
    /<span>填写条目索引<\/span>/.test(tabs) && /<span>分类编辑<\/span>/.test(tabs) && !/<span>设置<\/span>/.test(tabs));
truthy('设置那颗是图标钮、data-page 还是 settings', /fa-gear dlb-wb-tab"[\s\S]{0,24}data-page="settings"/.test(tabs));
truthy('当前页打上选中类', /dlb-wb-tab dlb-wb-tab_active"[\s\S]{0,24}data-page="index"/.test(tabs));
truthy('标题里说清齿轮是什么', tabs.includes('其余那些开关、阈值和提示词都在这儿'));

console.log('\n===== 4. 切页：谁忙、谁被拆 =====');
const wb = makeWorkbench();
void wb.mod.openDecisionWorkbench();
await settle();
check('默认停在第一页', wb.log.mounted, ['index']);
check('只开了一层弹窗（切页不叠第二窗）', wb.log.popups.length, 1);
await wb.mod.openDecisionWorkbench('types');
check('再点入口不重开，只切页：前一页先 dispose', wb.log.mounted, ['index', 'types']);
check('切走时拆掉前一页的监听', wb.log.disposed, ['index']);
check('仍然只有那一个窗口', wb.log.popups.length, 1);
wb.log.popups[0].close();
await settle();
check('关窗时拆掉最后这一页', wb.log.disposed, ['index', 'types']);
void wb.mod.openDecisionWorkbench('index');
await settle();
check('关完之后能重开（current 归位了）', [wb.log.mounted, wb.log.popups.length], [['index', 'types', 'index'], 2]);

// 已经开着、且当前页在跑 LLM 时不许切走（那一趟会往已经摘掉的节点里写）
const busyWb = makeWorkbench();
void busyWb.mod.openDecisionWorkbench('index');
await settle();
busyWb.busy.index = true;
await busyWb.mod.openDecisionWorkbench('types');
check('跑着的时候切页被挡下：没换页、说了一句', [busyWb.log.mounted, busyWb.log.warning.length], [['index'], 1]);
check('被挡下时前一页也不该被拆', busyWb.log.disposed, []);
truthy('警告里点名了这一页还在跑', /这一页还在跑/.test(busyWb.log.warning[0]));
busyWb.busy.index = false;
await busyWb.mod.openDecisionWorkbench('types');
check('跑完了照常切', busyWb.log.mounted, ['index', 'types']);

// 不存在的页退回第一页，别开出一个空白弹窗
const fallback = makeWorkbench();
void fallback.mod.openDecisionWorkbench('nope');
await settle();
check('认不出的页名回落到第一页', fallback.log.mounted, ['index']);

console.log('\n===== 5. 设置那一页：整块搬进搬出 =====');
const settingSrc = read('scripts/settings/settings.js');
truthy('设置页是注册进来的，不是自己弹窗（避免同一份控件出现两套 id）',
    settingSrc.includes('export function createSettingsPage') && settingSrc.includes("key: 'settings'") && settingSrc.includes("icon: 'fa-gear'"));
truthy('mount 把常驻节点搬进容器、dispose 搬回隐藏宿主',
    /const node = document\.getElementById\(SETTINGS_NODE_ID\);/.test(settingSrc)
    && /root\.appendChild\(node\);\s*\n\s*renderSetting\(\);/.test(settingSrc)
    && /dispose: \(\) => document\.getElementById\(SETTINGS_HOST_ID\)\?\.appendChild\(node\)/.test(settingSrc));
truthy('两个 id 常量化，index.js 和这里用的是同一串',
    settingSrc.includes("SETTINGS_HOST_ID = 'dlb_settings_host'") && settingSrc.includes("SETTINGS_NODE_ID = 'dlb_settings_root'")
    && read('index.js').includes('dlb_settings_host') && read('assets/templates/index.html').includes('id="dlb_settings_root"'));
truthy('节点没注入完时不炸，只说一句', settingSrc.includes('设置那块模板还没注入完'));

const indexSrc = read('index.js');
truthy('入口在 index.js：模板进隐藏宿主 → 绑定 → 注册设置页 → 挂菜单',
    /mountSettingsHost\(\$\(await SYSTEM\.getTemplate\('index'\)\)\);[\s\S]{0,120}loadSettings\(\);[\s\S]{0,200}registerDecisionPage\(createSettingsPage\(\)\);[\s\S]{0,80}initDecisionWorkbench\(\);/.test(indexSrc));
truthy('扩展设置区只留一行指路 + 一颗按钮，设置整块不再挂在那儿',
    indexSrc.includes('dlb_open_workbench_button') && indexSrc.includes('底部的魔法棒菜单') && !/\$container\.append\(\$template\)/.test(indexSrc));
truthy('宿主只造一次（插件重载不叠第二份设置）', /if \(!\$host\.length\) \{/.test(indexSrc));

console.log(`\n${fail ? 'FAILED' : 'OK'}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
