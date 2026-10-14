/**
 * 决策工作台：底部魔法棒菜单里那颗入口，一个弹窗三页切换
 *
 * 为什么收在这儿：这套东西的日常动线是「看条目 → 写摘要 → 改分类 → 调阈值」，
 * 原来摊在扩展设置抽屉里，抽屉在页面最底下，改一次要滚很久，而「填写条目索引」
 * 和「分类编辑」又各自是一个弹窗，切一次关一次。
 *
 * 口径：
 * - 三页共用一个弹窗，切页只换内容容器，不叠第二层弹窗。
 * - 索引那一页还在跑 LLM 时不许切走（跑完会自己存盘，但中途看不见进度）。
 * - 设置整块是常驻节点，切到设置页时整块搬进弹窗、切走搬回隐藏宿主：
 *   移动 DOM 不会丢已经挂上的监听，所以绑定只装一次，不必每次开窗重绑。
 */
import { EDITOR } from '../../core/manager.js';
import { createManualIndexPage } from './decisionEntryIndex.js';
import { createDecisionTypePage } from './decisionTypeEditor.js';

/** 魔法棒菜单里那颗入口的 id */
export const MENU_BUTTON_ID = 'dlb_workbench_menu_button';

/** 内置两页；设置页由调用方注册进来（settings.js 反过来 import 本文件，直接引会成环） */
const builtinPages = [createManualIndexPage(), createDecisionTypePage()];
/** @type {Array<{key:string, label:string, hint?:string, icon?:string, mount:Function}>} */
const extraPages = [];
/** 当前开着的弹窗：再点入口不重开，只切页 */
let current = null;

/**
 * 注册一页（目前只有设置页用它）
 * @param {{key:string, label:string, icon?:string, mount:Function}} page
 * @returns {boolean} 注册成功；同名的已经存在就不覆盖
 */
export function registerDecisionPage(page) {
    if (!page?.key || typeof page.mount !== 'function') return false;
    if (pages().some(item => item.key === page.key)) return false;
    extraPages.push(page);
    return true;
}

/** 全部页：索引、分类在前，注册进来的排在后面 */
export function pages() {
    return [...builtinPages, ...extraPages];
}

/**
 * 底部魔法棒菜单里那一行的 HTML
 * @param {string} label 菜单里显示的名字
 * @returns {string}
 */
export function menuButtonHtml(label = '决策索引工作台') {
    return `<div id="${MENU_BUTTON_ID}" class="list-group-item flex-container flexGap5 interactable">
        <div class="fa-solid fa-book-bookmark extensionsMenuExtensionButton"></div><span>${label}</span>
    </div>`;
}

/**
 * 挂上菜单入口（重复调用安全：已经有了就不再挂一份）
 * @param {{menu?:HTMLElement|null, label?:string}} [dom] 单测里塞假菜单容器
 * @returns {boolean} 挂上了没有
 */
export function initDecisionWorkbench({ menu, label } = {}) {
    const host = menu ?? (typeof document !== 'undefined' ? document.querySelector('#extensionsMenu') : null);
    if (!host) return false;
    if (host.querySelector(`#${MENU_BUTTON_ID}`)) return false;
    host.insertAdjacentHTML('beforeend', menuButtonHtml(label));
    const button = host.querySelector(`#${MENU_BUTTON_ID}`);
    button?.addEventListener('click', () => { void openDecisionWorkbench(); });
    return true;
}

/**
 * 顶部那一排：左边并列切页，右边一颗齿轮进设置
 * @param {Array} list pages()
 * @param {string} activeKey 当前这一页
 * @returns {string}
 */
export function tabsHtml(list, activeKey) {
    const tab = (page, iconOnly) => `<div class="menu_button button-square-icon fa-solid ${page.icon || 'fa-gear'} dlb-wb-tab${page.key === activeKey ? ' dlb-wb-tab_active' : ''}"
        data-page="${page.key}" title="${iconOnly ? '设置：其余那些开关、阈值和提示词都在这儿' : ''}"></div>`;
    const labelled = (page) => `<div class="menu_button menu_button_icon dlb-wb-tab${page.key === activeKey ? ' dlb-wb-tab_active' : ''}" data-page="${page.key}">
        ${page.icon ? `<i class="fa-solid ${page.icon}"></i>` : ''}<span>${page.label}</span>
    </div>`;
    const left = list.filter(page => page.key !== 'settings');
    const right = list.filter(page => page.key === 'settings');
    return `<div class="dlb-wb-head">
        <div class="dlb-wb-tabs">${left.map(labelled).join('')}</div>
        <span class="dlb-wb-spacer"></span>
        <div class="dlb-wb-tabs">${right.map(page => tab(page, true)).join('')}</div>
    </div>`;
}

/**
 * 打开工作台，或把已经开着的那一个切到某一页
 * @param {string} [pageKey] 默认停在「填写条目索引」
 * @returns {Promise<void>}
 */
export async function openDecisionWorkbench(pageKey) {
    const list = pages();
    const start = list.find(page => page.key === pageKey) || list[0];
    if (current) {
        await current.switchTo(start.key);
        return;
    }
    const html = `
<div class="dlb-wb wide100p padding5">
    ${tabsHtml(list, start.key)}
    <small class="dlb-wb-hint toggle-description justifyLeft"></small>
    <div class="dlb-wb-body"></div>
</div>
<style>
    .dlb-wb { display: flex; flex-direction: column; gap: 8px; text-align: left; }
    .dlb-wb-head { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .dlb-wb-tabs { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .dlb-wb-spacer { flex: 1 1 auto; }
    .dlb-wb-tab { font-size: 13px; }
    .dlb-wb-tab .fa-gear { font-size: 15px; }
    /* 当前页用绿边+绿字标出来（跟酒馆 .menu_button.toggleable.toggled 同一口径）。
       别写成反色块：酒馆没有「底色的对比字色」这个变量，写错就是一个看不见图标的白方块 */
    .dlb-wb-tab_active { border-color: var(--active); color: var(--active); }
    .dlb-wb-hint { font-size: 12px; color: var(--SmartThemeEmColor); }
    .dlb-wb-body { display: flex; flex-direction: column; gap: 8px; }
</style>`;
    const popup = new EDITOR.Popup(html, EDITOR.POPUP_TYPE.TEXT, '', {
        large: true, wide: true, allowVerticalScrolling: true, okButton: '关闭',
    });
    const dlg = popup.dlg;
    const bodyHost = dlg.querySelector('.dlb-wb-body');
    const hintHost = dlg.querySelector('.dlb-wb-hint');
    const onTabClick = (event) => {
        const tab = event.target?.closest?.('.dlb-wb-tab');
        if (!tab || !dlg.contains(tab)) return;
        void switchTo(tab.dataset.page);
    };
    /** 切页：先问当前页忙不忙，再摘监听、换内容 */
    const switchTo = async (key) => {
        if (current?.handle?.isBusy?.()) {
            EDITOR.warning('这一页还在跑（LLM 摘要逐批存盘中），等它跑完再切。');
            return;
        }
        const page = pages().find(item => item.key === key) || pages()[0];
        current.handle?.dispose?.();
        current.key = page.key;
        bodyHost.innerHTML = '';
        hintHost.textContent = page.hint ?? '';
        current.handle = await page.mount(bodyHost);
        dlg.querySelectorAll('.dlb-wb-tab').forEach(tab => tab.classList.toggle('dlb-wb-tab_active', tab.dataset.page === page.key));
    };
    current = { popup, key: start.key, handle: null, switchTo };
    dlg.addEventListener('click', onTabClick);
    await switchTo(start.key);
    await popup.show();
    // 关窗：拆掉当前页的监听，再摘掉这层切页监听
    current.handle?.dispose?.();
    dlg.removeEventListener('click', onTabClick);
    current = null;
}
