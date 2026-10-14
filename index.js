/**
 * 决策模型接管世界书 —— 插件入口
 *
 * 这一份只做挂载：设置模板进一个常驻隐藏节点（工作台的「设置」页整块搬进搬出）、
 * 扩展设置区只留一行指路、底部魔法棒菜单里挂上工作台入口、把事件挂上、把调试出口开到 window 上。
 * 决策本体在 scripts/runtime/lorebookRouter.js（它自己挂生成前后与世界书扫描的事件），
 * 聊天区小栏在 scripts/runtime/decisionStatusBar.js。
 *
 * `$` 和 `jQuery` 用酒馆的全局，跟上游一样不 import。
 */
import { SYSTEM, USER } from './core/manager.js';
import { SETTINGS_HOST_ID, createSettingsPage, loadSettings } from './scripts/settings/settings.js';
import { MENU_BUTTON_ID, initDecisionWorkbench, openDecisionWorkbench, pages, registerDecisionPage } from './scripts/runtime/decisionWorkbench.js';import {
    applyToLoadedEntries,
    armForGeneration,
    disarm,
    getDecisionStatus,
    getLastReport,
    initLorebookRouter,
    showDecisionReport,
} from './scripts/runtime/lorebookRouter.js';
import { initDecisionStatusBar } from './scripts/runtime/decisionStatusBar.js';
import { dropBasis, readBasisState, refreshBasisAfterGeneration } from './scripts/runtime/decisionBasis.js';
import { buildEntryIndex, collectIndexableEntries, indexOverview } from './scripts/runtime/decisionEntryIndex.js';
import { getReplies, showReply } from './scripts/settings/llmReplyViewer.js';

const VERSION = '1.0.0';

/**
 * 扩展设置区里只留这一行指路：整块设置搬进了底部魔法棒那个工作台弹窗的齿轮页
 * @description 节点常驻隐藏宿主，开弹窗时整块搬过去、关窗搬回来（见 settings.js 的 createSettingsPage）
 */
function mountSettingsHost($template) {
    let $host = $(`#${SETTINGS_HOST_ID}`);
    if (!$host.length) {
        $host = $('<div id="dlb_settings_host" style="display: none;"></div>').appendTo(document.body);
    }
    $host.append($template);
}

function mountEntryHint() {
    if ($('#dlb_settings_entry_hint').length) return;
    const hint = `
<div id="dlb_settings_entry_hint" class="inline-drawer wide100p">
    <div class="inline-drawer-toggle inline-drawer-header">
        <b>决策模型接管世界书</b>
        <div class="fa-solid fa-circle-chevron-down inline-drawer-icon down"></div>
    </div>
    <div class="inline-drawer-content" style="display: none;">
        <small class="toggle-description justifyLeft">
            设置和条目索引都搬到页面<b>底部的魔法棒菜单</b>里了：点「决策索引工作台」，
            左边两页是填写条目索引和分类编辑，右上角齿轮是其余全部设置（开关、阈值、提示词都在这儿）。
        </small>
        <div class="flex-container">
            <div id="dlb_open_workbench_button" class="menu_button menu_button_icon">
                <i class="fa-solid fa-book-bookmark"></i><span>打开决策索引工作台</span>
            </div>
        </div>
    </div>
</div>`;
    const $container = $('#extensions_settings2');
    if ($container.length) $container.append(hint);
    else $('#translation_container').after(hint);
}

jQuery(async () => {
    // 调试与外部调用出口。名字不叫 stMemoryEnhancement，两个插件并存时各找各的。
    window.stLorebookDecision = {
        VERSION,
        __test_decision: {
            status: getDecisionStatus,
            report: getLastReport,
            showReport: showDecisionReport,
            arm: armForGeneration,
            apply: applyToLoadedEntries,
            disarm,
        },
        __test_basis: {
            read: readBasisState,
            refresh: refreshBasisAfterGeneration,
            drop: dropBasis,
        },
        __test_index: {
            collect: collectIndexableEntries,
            build: buildEntryIndex,
            overview: indexOverview,
        },
        __test_reply: {
            records: getReplies,
            show: showReply,
        },
        __test_workbench: {
            // 想在控制台里直接开某一页：stLorebookDecision.__test_workbench.open('types')
            open: openDecisionWorkbench,
            pages,
            menuButtonId: MENU_BUTTON_ID,
        },
        store: USER.store,
    };

    // 设置整块常驻隐藏宿主；扩展设置区只留一行指路
    mountSettingsHost($(await SYSTEM.getTemplate('index')));
    mountEntryHint();

    // 绑定要在模板进 DOM 之后装一次（移动节点不掉监听，所以整套只绑这一回）
    loadSettings();

    // 工作台：注册齿轮那一页，再把底部魔法棒菜单的入口挂上
    registerDecisionPage(createSettingsPage());
    initDecisionWorkbench();

    // 决策路由：内部自挂 GENERATION_STARTED / WORLDINFO_ENTRIES_LOADED / GENERATION_ENDED / CHAT_CHANGED
    initLorebookRouter();

    // 聊天区的决策结果小栏：只在开关打开时存在，换聊天和每轮出字由它自己重画
    initDecisionStatusBar();

    console.log('______________________决策模型接管世界书：加载完成______________________');
});
