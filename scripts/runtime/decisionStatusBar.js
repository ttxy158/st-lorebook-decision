/**
 * 聊天区的「决策结果」小栏
 * @description 决策路由每轮生成前都会跑，但结果默认不弹（弹一次要手动关一次），
 * @description 所以在聊天页底部留一条常驻栏：一眼看到本轮判了什么，点按钮翻完整报告。
 */
import { USER } from '../../core/manager.js';
import { armManualDecision, describeBasis, getInjectView, getLastReport, getDecisionStatus, showDecisionReport } from './lorebookRouter.js';

const BAR_ID = 'dlbStatusBar';

function clockOf(timeText) {
    // 报告里的时间是 toLocaleString() 的整串，栏上只要时分
    return String(timeText || '').split(' ').filter(Boolean).pop() || '';
}

/** 一栏话术：判了多少、动了几条、有没有没问到的 */
function describe(report, status) {
    if (!report) {
        return { text: status?.skip || '决策路由已开启，本轮生成后生效', usable: false };
    }
    const inject = getInjectView(report);
    const forced = inject.kept.length;
    const suppressed = (report.suppress || []).length;
    const judged = Object.keys(report.scores || {}).length;
    if (report.manual) {
        // 手动挑的那一轮一条都没判定，说「强推 N」会让人以为模型判过了
        return { text: `决策 ${clockOf(report.time)} · 你手动挑了 ${forced} 条（本轮没问模型，其余按关键词）`, usable: true };
    }
    const squeezed = inject.squeezed.length;
    const middle = Math.max(0, judged - forced - suppressed - squeezed);
    const parts = [`决策 ${clockOf(report.time)}`, `强推 ${forced}`, `压制 ${suppressed}`, `中间带 ${middle}`];
    // 名额挤掉的跟「判成不相关」是两回事，不写出来会让人以为强推那个数就是模型给的全部相关条目
    if (squeezed) parts.push(`名额挤掉 ${squeezed} 条`);
    if (report.truncated) {
        parts.push(`还有 ${(report.totalCandidates ?? judged) - judged} 条没问到`);
    }
    // 按轮复用：这一轮的判定是旧的（前面那个时间是判定那轮的），所以要说清本轮没问模型、还能省几轮
    if (report.cached) parts.push(`复用旧判定（${[report.skipReason, `本轮没问模型，还能这样省 ${report.reuseLeft} 轮`].filter(Boolean).join('，')}）`);
    else if (report.reuseLeft > 0) parts.push(`这份判定接下来 ${report.reuseLeft} 轮不再问模型`);
    if (report.blockKeyword) parts.push('关键词注入已关闭');
    // 依据来源：摘要读的是概括词、正文读的是原样剧情，判得准不准跟这个直接相关，所以摆在栏上
    const basis = describeBasis(report);
    if (basis) parts.push(`依据 ${basis}`);
    // 这一轮根本没问模型（没到点又没有可复用的判定、或自主启动没点按钮）：
    // 不写出来会让人以为上面那行数字是本轮的
    if (status?.skip) parts.push(status.skip);
    return { text: parts.join(' · '), usable: true };
}

/**
 * 重画小栏（决策路由没开就把自己摘掉）
 */
export function renderDecisionStatusBar() {
    const setting = USER.store;
    if (setting.decision_router_enabled !== true) {
        $(`#${BAR_ID}`).remove();
        return;
    }
    if (!$(`#${BAR_ID}`).length) {
        const $bar = $('<div></div>')
            .attr('id', BAR_ID)
            .addClass('flex-container')
            .css({
                'gap': '10px',
                'padding': '4px 10px',
                'flex-wrap': 'wrap',
                'justify-content': 'center',
                'border-top': '1px solid var(--SmartThemeBorderColor)',
                'opacity': '0.92',
            });
        $bar.insertBefore('#form_sheld');
    }
    const status = getDecisionStatus();
    const info = describe(getLastReport(), status);
    // 自主启动档：不问模型是默认，所以得在这儿给一颗能自己点的按钮，不然这个档根本没入口
    const manual = status.timing?.mode === 'manual';
    $(`#${BAR_ID}`).html(
        `<span>${$('<div>').text(info.text).html()}</span>`
        + (manual
            ? `<button id="dlb_manual_arm_click" type="button" class="margin0 menu_button menu_button_icon"${status.manualArmed ? ' disabled' : ''}>${status.manualArmed ? '已许：下一次生成会决策' : '本轮进行决策'}</button>`
            : '')
        + '<button id="dlb_report_click" type="button" class="margin0 menu_button menu_button_icon">查看决策结果</button>'
    );
    $('#dlb_report_click').prop('disabled', !info.usable);
}

/**
 * 挂载：开关、换聊天、每轮生成完都重画一次
 */
export function initDecisionStatusBar() {
    $(document).on('click', '#dlb_report_click', function () {
        showDecisionReport();
    });
    $(document).on('click', '#dlb_manual_arm_click', function () {
        armManualDecision();
        renderDecisionStatusBar();
    });
    const context = USER.getContext();
    if (!context?.eventTypes || !context?.eventSource) {
        console.warn('[决策路由] 拿不到事件表，小栏只在这一刻画一次');
        renderDecisionStatusBar();
        return;
    }
    const types = context.eventTypes;
    [
        types.CHARACTER_MESSAGE_RENDERED,
        types.CHAT_CHANGED,
        types.MESSAGE_DELETED,
        types.MESSAGE_EDITED,
        types.MESSAGE_SWIPED,
    ].filter(Boolean).forEach(type => context.eventSource.on(type, () => renderDecisionStatusBar()));
    renderDecisionStatusBar();
}
