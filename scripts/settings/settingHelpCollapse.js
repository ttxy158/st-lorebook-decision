/**
 * 设置页长说明折叠：把选项后面那几段大篇幅小字收起来，行尾只留一颗「？」，点一下就地展开。
 *
 * 只收「静态、没有 id、写得长」的说明：带 id 的那几行是代码实时改写的状态提示（索引统计、送达通道、
 * 决策依据与时机的生效值…），收起来就等于把状态藏了；短说明本来就只占一行，收起来反而要点两下才看得懂。
 * 收起来只是加一个类名，说明原文一个字都不改、不搬走。
 */

/** 去掉空白后的字数低于这个值就保持原样显示 */
export const DESCRIPTION_COLLAPSE_MIN_CHARS = 60;

/** 收起状态用的类名，展开就是把它去掉 */
export const HELP_HIDDEN_CLASS = 'setting_help_hidden';
export const HELP_OPEN_CLASS = 'setting_help_button_open';
/** 已经收过的标记，只做记账、没有样式：重跑（导入设置、恢复默认后都会再渲染一次）靠它跳过 */
export const DONE_CLASS = 'setting_help_done';

/**
 * 这段文字够不够长、是不是静态说明。
 * @param {string} text 说明的纯文本
 * @param {string} [id] 说明元素的 id，带 id 的都是代码实时改写的状态行
 */
export function isCollapsibleText(text, id) {
    if (id) return false;
    const plain = String(text ?? '').replace(/\s+/g, '');
    return plain.length >= DESCRIPTION_COLLAPSE_MIN_CHARS;
}

/**
 * 这一条到底收不收：除了内容够长，还要求没收过、也不是别人正藏着的状态行。
 * @param {{collapsed?: boolean, display?: string, id?: string, text?: string}} description
 */
export function shouldCollapseDescription(description) {
    if (description?.collapsed) return false;
    // 本来就藏着的说明不动：那是别人家的显隐逻辑
    if (String(description?.display ?? '').toLowerCase() === 'none') return false;
    return isCollapsibleText(description?.text, description?.id);
}

/**
 * 按钮能塞进选项那一行的情况：勾选框整行是个 div，label 同理；输入框、下拉框塞不进子元素，
 * 按钮只能贴着说明自己另起一行。
 * @param {Element|null} optionRow 说明的前一个兄弟元素
 */
export function canHostHelpButton(optionRow) {
    const tag = String(optionRow?.tagName ?? '').toUpperCase();
    if (tag === 'LABEL') return true;
    return tag === 'DIV' && !!optionRow?.classList?.contains('checkbox_label');
}

/**
 * 判定 + 定位：这一条要不要收、按钮放哪。返回 null 表示不动这一条。
 * @param {Element} description
 */
export function planDescriptionCollapse(description) {
    const decision = shouldCollapseDescription({
        collapsed: description?.classList?.contains(DONE_CLASS),
        display: description?.style?.display,
        id: description?.id,
        text: description?.textContent,
    });
    if (!decision) return null;
    const optionRow = description.previousElementSibling ?? null;
    return { optionRow, insideRow: canHostHelpButton(optionRow) };
}

/** 点「？」只在「说明有没有收起类」这一件事上做文章，别碰选项、别让点击冒泡到勾选框那一行 */
function attachToggle(description, button, toggleClass) {
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const hidden = toggleClass(description, HELP_HIDDEN_CLASS);
        toggleClass(button, HELP_OPEN_CLASS, !hidden);
    });
}

/**
 * 扫一遍设置页，把够长的静态说明收起来。重复调用安全：收过的会跳过。
 * @param {Element|null} root 设置页根节点
 * @param {object} [dom] 注入用，单测里塞假 DOM；浏览器里走默认值
 * @returns {number} 这一次收起来的条数
 */
export function applyDescriptionCollapse(root, dom = {}) {
    const doc = dom.document ?? globalThis.document;
    const toggleClass = dom.toggleClass ?? ((element, name, force) => element.classList.toggle(name, force));
    if (!root?.querySelectorAll || !doc?.createElement) return 0;
    let collapsed = 0;
    root.querySelectorAll('small.toggle-description').forEach((description) => {
        const plan = planDescriptionCollapse(description);
        if (!plan) return;
        description.classList.add(HELP_HIDDEN_CLASS, DONE_CLASS);
        const button = doc.createElement('div');
        button.className = `menu_button setting_help_button fa-solid fa-circle-question${plan.insideRow ? '' : ' setting_help_button_standalone'}`;
        button.title = '展开／收起这段说明';
        attachToggle(description, button, toggleClass);
        if (plan.insideRow) {
            plan.optionRow.appendChild(button);
        } else {
            description.parentNode?.insertBefore(button, description);
        }
        collapsed++;
    });
    return collapsed;
}
