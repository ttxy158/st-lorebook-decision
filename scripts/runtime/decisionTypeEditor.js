/**
 * 分类与每类的问法：设置页只留一颗按钮，这一长串编辑区是工作台弹窗里的第二页
 *
 * 为什么要搬走：内置 7 类、每人自己再加几类，每类都是「名字 + 一个 textarea」，
 * 铺在设置页里能把整屏撑满，而它一年也改不了两回。
 *
 * 口径：
 * - 分类 id 是记账用的，改名不会让已经建好的索引失效；「其他」是兜底那一类，删不掉。
 * - 某类的问法留空 = 用设置页里那条通用判定问法。
 * - 删掉一类时不动索引：原本归它的条目判定时自动按「其他」的问法走，想换回专属问法就到
 *   「填写条目索引」里点「重建失效分类」（那颗按钮会发请求，这里不碰）。
 * - 打字即落盘，没有「保存」这一步；弹窗里不发任何请求。
 */
import { EDITOR, USER } from '../../core/manager.js';
import { DECISION_OTHER_TYPE_ID, countIndexByType, editorText, makeTypeId, normalizeTypes } from './decisionEntryIndex.js';

/** 整份分类表写回设置（空数组那种「还没动过」的状态就此变成「动过了」） */
function saveDecisionTypes(types) {
    USER.store.decision_entry_types = types;
    USER.saveSettings && USER.saveSettings();
}

/** 当前分类表（每次都从设置读：弹窗开着时别的地方也可能在改） */
function currentTypes() {
    return normalizeTypes((USER.store || {}).decision_entry_types);
}

/**
 * 改一类的名字或问法
 * @description 只改字段、不重绘列表：重绘会把正在打字的那个框换掉，焦点就丢了
 * @param {string} id
 * @param {'name'|'instruction'} field
 * @param {string} value
 * @returns {boolean} 改到了没有
 */
export function editDecisionType(id, field, value) {
    const types = currentTypes();
    const hit = types.find(type => type.id === id);
    if (!hit) return false;
    hit[field] = value;
    saveDecisionTypes(types);
    return true;
}

/**
 * 删一类（「其他」删不掉）
 * @param {string} id
 * @returns {{removed: boolean, name: string, other: boolean}}
 */
export function removeDecisionType(id) {
    const types = currentTypes();
    const hit = types.find(type => type.id === id);
    if (!hit) return { removed: false, name: '', other: false };
    if (hit.id === DECISION_OTHER_TYPE_ID) return { removed: false, name: hit.name, other: true };
    saveDecisionTypes(types.filter(type => type.id !== id));
    return { removed: true, name: hit.name, other: false };
}

/**
 * 新加一类，插在「其他」前面（「其他」永远是最后那一类兜底）
 * @returns {{id: string}} 新类的 id，弹窗拿它去把光标放到名字框上
 */
export function addDecisionType() {
    const types = currentTypes();
    const id = makeTypeId();
    types.splice(types.length - 1, 0, { id, name: '新分类', instruction: '' });
    saveDecisionTypes(types);
    return { id };
}

/**
 * 分类编辑区的 HTML（一行一类：名字、这一类下几条、删除，然后是那一句问法）
 * @param {Array} types normalizeTypes 的结果
 * @param {Array<{id:string, count:number}>} counts countIndexByType 的结果
 * @returns {string}
 */
export function renderDecisionTypeRowsHtml(types = [], counts = []) {
    const countOf = new Map((counts || []).map(item => [item.id, item.count]));
    return (types || []).map(type => {
        const isOther = type.id === DECISION_OTHER_TYPE_ID;
        const count = countOf.get(type.id) || 0;
        return `<div class="decision-type-row" data-id="${editorText(type.id)}">
            <div class="decision-type-head">
                <input type="text" class="text_pole decision-type-name" data-id="${editorText(type.id)}"
                    value="${editorText(type.name)}" placeholder="分类名" maxlength="20">
                <span class="decision-type-count" title="索引里归在这一类下的条目数（分类被删掉的条目也算进「其他」，因为判定时走的就是「其他」的问法）">这一类 ${count} 条</span>
                <div class="menu_button button-square-icon fa-solid fa-trash-can decision-type-delete${isOther ? ' disabled' : ''}"
                    data-id="${editorText(type.id)}"
                    title="${isOther ? '「其他」是兜底分类，删不掉：认不出归哪类的条目都落到这里，问法可以改' : '删掉这一类；已归到这一类的条目会自动按「其他」的问法判，不用重建索引'}"></div>
            </div>
            <textarea class="text_pole settings_textarea wide100p decision-type-instruction" rows="2"
                data-id="${editorText(type.id)}" placeholder="这一类的判定问法，留空就用通用判定问法">${editorText(type.instruction)}</textarea>
            <div class="decision-type-confirm"></div>
        </div>`;
    }).join('');
}

/**
 * 设置页上那一行摘要（替代原来铺开的一长串分类）
 * @param {Array} types normalizeTypes 的结果
 * @param {Array<{id:string, name:string, count:number}>} counts countIndexByType 的结果
 * @returns {string}
 */
export function describeDecisionTypes(types = [], counts = []) {
    const countOf = new Map((counts || []).map(item => [item.id, item.count]));
    const names = (types || []).map(type => `${type.name}${countOf.get(type.id) ? ` ${countOf.get(type.id)}` : ''}`).join('｜');
    const blank = (types || []).filter(type => !String(type.instruction ?? '').trim()).length;
    return `共 ${types.length} 类：${names}`
        + (blank ? `｜${blank} 类没写专属问法（走通用判定问法）` : '')
        + '｜点左边那颗按钮改';
}

/**
 * 「分类编辑」这一页的工厂：工作台弹窗切到这一页时用它
 * @returns {{key:string, label:string, hint:string, mount(root:HTMLElement):Promise<{dispose:Function,isBusy:Function}>}}
 */
export function createDecisionTypePage() {
    return {
        key: 'types',
        label: '分类编辑',
        hint: '分类和每一类的判定问法在这儿改。打字即落盘，不发请求、不花钱。',
        mount: mountDecisionTypePage,
    };
}

/**
 * 分类与问法的编辑页（不发请求、不花钱）
 * @param {HTMLElement} root 工作台弹窗的内容容器
 * @returns {Promise<{dispose:Function, isBusy:Function}>}
 */
async function mountDecisionTypePage(root) {
    const render = () => {
        const types = currentTypes();
        const index = (USER.store || {}).decision_entry_index;
        return { types, counts: countIndexByType(types, index) };
    };
    const html = `
<div class="wide100p padding5" style="display:flex;flex-direction:column;gap:8px;">
    <div class="decision-type-meta"></div>
    <div id="dlb_type_rows" class="flex-container flexFlowColumn"></div>
    <div class="flex-container alBaseline">
        <div class="menu_button menu_button_icon decision-type-add"><i class="fa-solid fa-plus"></i><span>添加分类</span></div>
        <small class="toggle-description justifyLeft flex1 decision-type-hint"></small>
    </div>
</div>
<style>
    .decision-type-meta { color: var(--SmartThemeEmColor); font-size: 12px; text-align: left; }
    .decision-type-row { border: 1px solid var(--SmartThemeBorderColor); border-radius: 4px; padding: 6px 8px; text-align: left; }
    .decision-type-head { display: flex; gap: 8px; align-items: center; }
    .decision-type-head .decision-type-name { flex: 1; }
    .decision-type-count { font-size: 11px; color: var(--SmartThemeEmColor); white-space: nowrap; }
    .decision-type-confirm { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 12px; color: var(--SmartThemeEmColor); text-align: left; }
    .decision-type-hint { font-size: 12px; color: var(--SmartThemeEmColor); text-align: left; }
</style>`;
    root.innerHTML = html;
    const rowsHost = root.querySelector('#dlb_type_rows');
    const metaHost = root.querySelector('.decision-type-meta');
    const hintHost = root.querySelector('.decision-type-hint');

    const draw = (focusId) => {
        const { types, counts } = render();
        rowsHost.innerHTML = renderDecisionTypeRowsHtml(types, counts);
        const total = counts.reduce((sum, item) => sum + item.count, 0);
        metaHost.textContent = `一共 ${types.length} 类｜索引里 ${total} 条已经有归属｜每一类的问法留空就走设置页那条通用判定问法。这里一个字都不发请求。`;
        hintHost.textContent = '名字随便改，改名字不会让已经建好的索引失效。「其他」是兜底那一类，删不掉（它的问法可以改）。删掉一类时，原本归它那些条目会自动按「其他」的问法判，判定不会丢，也不用重建索引；要让它们重新用专属问法，到「填写条目索引」里点「重建失效分类」（那一步会发请求）。';
        if (focusId) rowsHost.querySelector(`.decision-type-name[data-id="${focusId}"]`)?.select();
    };
    draw();

    const countOf = (id) => render().counts.find(item => item.id === id)?.count || 0;
    const clearConfirms = () => {
        rowsHost.querySelectorAll('.decision-type-confirm').forEach(host => { host.innerHTML = ''; });
    };
    /** 删除的确认就在这一行里展开，不叠第二层弹窗（叠上去会把正在编辑的这页关掉） */
    const armDelete = (row, id) => {
        clearConfirms();
        const host = row.querySelector('.decision-type-confirm');
        const name = currentTypes().find(type => type.id === id)?.name ?? '';
        const count = countOf(id);
        host.innerHTML = `<span>删除分类「${editorText(name)}」？${count ? `归在这一类下的 ${count} 条不用重建索引：判定时自动按「其他」的问法走，想换回专属问法就到「填写条目索引」里点「重建失效分类」。` : '这一类下没有条目，删了不影响索引。'}</span>`
            + '<div class="menu_button menu_button_icon decision-type-delete-yes"><i class="fa-solid fa-trash-can"></i><span>删除</span></div>'
            + '<div class="menu_button menu_button_icon decision-type-delete-no"><i class="fa-solid fa-ban"></i><span>取消</span></div>';
        host.dataset.id = id;
    };
    const onClick = (event) => {
        const target = event.target;
        if (!target || !rowsHost.contains(target)) return;
        const deleteButton = target.closest('.decision-type-delete');
        if (deleteButton) {
            if (deleteButton.classList.contains('disabled')) {
                EDITOR.warning('「其他」是兜底分类，删不掉：认不出归哪类的条目总要有个问法可用。它的问法可以直接改。');
                return;
            }
            armDelete(deleteButton.closest('.decision-type-row'), deleteButton.dataset.id);
            return;
        }
        if (target.closest('.decision-type-delete-no')) { clearConfirms(); return; }
        const yes = target.closest('.decision-type-delete-yes');
        if (yes) {
            const id = yes.closest('.decision-type-confirm')?.dataset.id;
            const result = removeDecisionType(id);
            if (result.other) { EDITOR.warning('「其他」删不掉。'); return; }
            if (result.removed) draw();
        }
    };
    const onInput = (event) => {
        const target = event.target;
        if (!rowsHost.contains(target)) return;
        if (target.classList.contains('decision-type-name')) { editDecisionType(target.dataset.id, 'name', String(target.value ?? '')); return; }
        if (target.classList.contains('decision-type-instruction')) { editDecisionType(target.dataset.id, 'instruction', String(target.value ?? '')); }
    };
    // 添加那颗按钮不在重绘的名单里，直接挂它自己（挂 document 会跟着每一次点击跑）
    root.querySelector('.decision-type-add')?.addEventListener('click', () => draw(addDecisionType().id));
    document.addEventListener('click', onClick, true);
    document.addEventListener('input', onInput);
    return {
        isBusy: () => false,
        // 挂在 document 上的监听要摘掉：留着会跟着每一次点击跑，还会串到下一次打开这一页
        dispose: () => {
            document.removeEventListener('click', onClick, true);
            document.removeEventListener('input', onInput);
        },
    };
}
