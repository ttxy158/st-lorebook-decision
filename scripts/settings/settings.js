/**
 * 设置页：DOM ↔ 设置的双向搬运工
 * @description 这里只做三件事：把设置回填进表单、把表单改动写回设置、把「现在到底是什么状态」写在控件下面。
 * @description 判定、摘要、索引的逻辑都不在这个文件里，跑在 scripts/runtime 那几个模块。
 * @description 控件 id 一律带 dlb_ 前缀：本插件要和上游那个表格插件在同一页面共存，同名选择器会串到别人家里。
 * @description 这一整块不再挂在扩展设置抽屉里，而是常驻一个隐藏节点，由工作台的「设置」页搬进弹窗
 * @description （见 createSettingsPage）：绑定只装一次，移动节点不会丢监听，所以不必每次开窗重绑。
 */
import { EDITOR, USER } from '../../core/manager.js';
import { defaultSettings } from '../../data/pluginSetting.js';
import { isUsableSecret } from '../../utils/utility.js';
import { handleApiTestRequest, processApiKey, updateModelList } from './standaloneAPI.js';
import { applyDescriptionCollapse } from './settingHelpCollapse.js';
import { showReply } from './llmReplyViewer.js';
import { deleteCustomApiPreset, exportCustomApiPresets, importCustomApiPresets, newCustomApiPreset, renderCustomApiPresetList, selectCustomApiPreset, updateCustomApiPreset } from './customApiPresets.js';
import { DECISION_MAX_IN_FLIGHT, DECISION_MAX_QUESTIONS, resolveTaskBriefing } from '../../services/decisionApiService.js';
import { renderDecisionStatusBar } from '../runtime/decisionStatusBar.js';
import { showDecisionReport, testDecisionConnection } from '../runtime/lorebookRouter.js';
import { BASIS_CHAR_LIMIT_DEFAULT, DEFAULT_BASIS_SYSTEM_PROMPT, DEFAULT_BASIS_TEMPLATE, basisDigest, dropBasis, effectiveReuseRounds, readBasisState, resolveBasisMode, resolveTiming } from '../runtime/decisionBasis.js';
import { DEFAULT_INDEX_SYSTEM_PROMPT, DEFAULT_INDEX_TEMPLATE, countIndexByType, indexOverview, normalizeTypes, pruneStaleIndex, readIndexNumbers, showIndexReport } from '../runtime/decisionEntryIndex.js';
import { describeDecisionTypes } from '../runtime/decisionTypeEditor.js';
import { openDecisionWorkbench } from '../runtime/decisionWorkbench.js';

/** 绑定只装一次：模板注入后重复调用会让一个输入框存两份监听 */
let bound = false;

/**
 * 更新设置中的开关状态
 */
function updateSwitch(selector, switchValue) {
    if (switchValue) {
        $(selector).prop('checked', true);
    } else {
        $(selector).prop('checked', false);
    }
}

/**
 * 密钥输入框的「写即存」：输入时是掩码、存的是明文，整理过的结果再回填，
 * 这样点小眼睛看到的和复制按钮拷走的，就是真正存下来、真正发出去的那个值。
 * @param {string} selector 输入框选择器
 * @param {string} field 隐私桶里的字段名
 * @param {string} label 提示语里对这个 Key 的称呼
 */
function bindSecretInput(selector, field, label) {
    let timer;
    $(selector).on('input', function () {
        const rawKey = String($(this).val() ?? '');
        clearTimeout(timer);
        timer = setTimeout(() => {
            const trimmed = rawKey.trim();
            if (!trimmed) {
                USER.privacy[field] = '';
                USER.saveSettings && USER.saveSettings();
                EDITOR.success(`已清除${label}。`);
                return;
            }
            const result = processApiKey(trimmed);
            // 粘进来的 Key 常带空格或换行，照原样发出去只会得到一句看不懂的 "Failed to execute 'fetch': Invalid value"
            if (!result.keyString.split(',').every(isUsableSecret)) {
                // 别把框留空：里面重新填回真正存着的值，否则看起来像是把 Key 弄丢了
                $(selector).val(USER.privacy[field] || '');
                EDITOR.error(`粘贴的${label} 里有空格或不可见字符，已保留原来保存的 Key，请重新粘贴一次。`);
                return;
            }
            USER.privacy[field] = result.keyString;
            USER.saveSettings && USER.saveSettings();
            $(selector).val(result.keyString);
            let message = `已保存${label}（${result.remainingKeys}个Key）。`;
            if (result.duplicatesRemoved) message += `已去除${result.duplicatesRemoved}个重复Key。`;
            if (result.invalidKeysCount) message += `已去除${result.invalidKeysCount}个空值。`;
            EDITOR.success(message);
        }, 500);
    });
}

/**
 * 决策依据与决策时机现在到底是什么状态，直接写在设置下面
 * @description 存的是什么和生效什么是两件事：摘要档要当前聊天真攒出一份摘要才算换了依据，
 *   第一两轮还没有摘要时依据仍是正文；「每 n 轮」还会把复用轮数抬到不小于 n。
 *   不说清楚会让人一直以为模型看的是摘要，或以为间隔那几轮也判过。
 */
function renderDecisionBasis() {
    const setting = USER.store;
    const summary = resolveBasisMode(setting) === 'summary';
    const timing = resolveTiming(setting);
    const everyN = timing.mode === 'every_n';
    $('#dlb_every_n_wrap').toggle(everyN);
    // 摘要档那些行不是单独一个框了（设置页按「勾选／数值／文本」分了档），改成逐行显隐
    $('.dlb_basis_summary_only').toggle(summary);
    // 这一档的两个数值都藏着时，「数值」那行小标题也别留——光秃秃一行标题下面什么都没有
    $('#dlb_basis_numbers_label').toggle(everyN || summary);
    $('#dlb_basis_hint').text(!summary ? '' : (basisDigest()
        ? '本聊天已攒出决策摘要，下一轮决策读的就是它，正文不再送进决策请求。'
        : '本聊天还没有摘要：头一两轮的依据仍是正文，等一轮 AI 回复写完、自动摘要跑成功之后才换成摘要。'));
    $('#dlb_timing_hint').text(
        timing.mode === 'every_n'
            ? `每 ${timing.everyN} 轮问一次模型，间隔那几轮复用上一次判定（一个请求都不发）。`
            : timing.mode === 'manual'
                ? '自主启动：平时每轮都不问模型、按关键词注入。想判就点聊天页那颗「本轮进行决策」，只有紧跟着的那一次生成会问，问完作废。'
                : '每轮都问一次模型。');
    const stored = Math.max(0, Math.floor(Number(setting.decision_reuse_rounds) || 0));
    const effective = effectiveReuseRounds(stored, timing);
    $('#dlb_reuse_hint').text(effective > stored
        ? `复用轮数你填的是 ${stored}，但「每 ${timing.everyN} 轮」至少要有 ${timing.everyN} 轮判定可用，所以实际按 ${effective} 生效。你填的那个数不改，改回「每轮都判」就照 ${stored} 走。`
        : '');
}

/**
 * 「允许压制低概率条目」「关闭关键词触发注入」这两颗的前置门控显示
 * @description 接管没开时插件整轮不发请求、也不碰这次世界书扫描（lorebookRouter 里两处早退），
 *   留着能点会让人以为勾上就不注入关键词了——勾了确实什么都不变。
 * @description 只灰这两颗：地址／Key／模型名／阈值那些开着接管要用的东西得先能填。
 */
function renderDecisionInjectionGate() {
    const enabled = USER.store.decision_router_enabled === true;
    $('#dlb_suppress_enabled, #dlb_block_keyword').prop('disabled', !enabled);
    $('#dlb_injection_gate_hint').text(enabled
        ? '接管开着，这两颗才起作用。勾了「关闭关键词触发注入」也仍有例外：常驻条目、@@ 手动钉住的、本轮没拿到判定的条目照常按关键词进（故意留的兜底）。'
        : '要先勾上上面那颗「启用决策路由」：没开时插件整轮不发请求、也不碰这次世界书扫描，这两颗勾了什么都不会变。地址、Key、模型名和下面的阈值可以先填着，开了就用。');
}

/**
 * 条目摘要索引区：显隐、分类摘要行、统计
 * @description 分类表每次重绘都由 normalizeTypes 生成，所以「老存档没动过 = 内置分类」这件事不用单独存一份
 * @description 分类和每类的问法摊到独立弹窗里编辑，这一页只留一行摘要——铺在这儿能把整屏撑满
 * @description 发请求的四个按钮都收在「填写条目索引」弹窗里了，这一页只留数字，两份提示词在 ⑤ 提示词档
 */
function renderDecisionIndex() {
    const setting = USER.store;
    const enabled = setting.decision_index_enabled === true;
    // 建索引那两份提示词搬到 ⑤ 去了，但它们仍属于这一档：索引档关着时一起藏
    $('#dlb_index_block, .dlb_index_prompts_only').toggle(enabled);
    if (!enabled) {
        $('#dlb_index_stats').text('');
        $('#dlb_type_summary').text('');
        return;
    }
    const types = normalizeTypes(setting.decision_entry_types);
    $('#dlb_type_summary').text(describeDecisionTypes(types, countIndexByType(types, setting.decision_entry_index)));
    const overview = indexOverview(setting);
    const counts = overview.byType.map(item => `${item.name} ${item.count}`).join('｜');
    $('#dlb_index_stats').text(
        overview.records === 0
            ? '索引里一条都没有：点「填写条目索引」，自己逐条写或在那儿让 LLM 填；没索引过的条目按正文片段 + 通用问法判。'
            : `索引里 ${overview.records} 条${counts ? `（${counts}）` : ''}`
                + (overview.manual ? `｜其中你手填了 ${overview.manual} 条` : '')
                + (overview.invalid ? `｜${overview.invalid} 条的分类已被删掉，判定时按「其他」的问法走，可到「填写条目索引」里点「重建失效分类」重问` : '')
                + (overview.lastAt ? `｜最后一条写于 ${new Date(overview.lastAt).toLocaleString()}` : '')
    );
}

/**
 * 把设置里的值回填进表单，并刷新那几行状态提示
 */
export function renderSetting() {
    const setting = USER.store;

    // ---- 自定义独立 API ----
    $('#dlb_custom_temperature').val(setting.custom_temperature);
    $('#dlb_custom_temperature_value').text(setting.custom_temperature);
    const maxTokens = setting.custom_max_tokens;
    $('#dlb_custom_max_tokens').val(maxTokens && maxTokens > 0 ? maxTokens : '');
    $('#dlb_custom_thinking_mode').val(setting.custom_thinking_mode || 'default');
    if (!$('#dlb_custom_thinking_mode').val()) $('#dlb_custom_thinking_mode').val('default');
    renderCustomApiPresetList();

    // 密钥那一桶：存的是明文，回填时原样填进框里（框本身是掩码显示，点小眼睛看）
    $('#dlb_custom_api_url').val(USER.privacy.custom_api_url || '');
    $('#dlb_custom_api_key').val(USER.privacy.custom_api_key || '');
    $('#dlb_custom_model_name').val(USER.privacy.custom_model_name || '');

    // ---- 决策接管 ----
    updateSwitch('#dlb_router_enabled', setting.decision_router_enabled);
    updateSwitch('#dlb_use_proxy', setting.decision_use_proxy !== false);
    updateSwitch('#dlb_suppress_enabled', setting.decision_suppress_enabled);
    updateSwitch('#dlb_block_keyword', setting.decision_block_keyword);
    updateSwitch('#dlb_multi_round', setting.decision_multi_round);
    updateSwitch('#dlb_fail_silent', setting.decision_fail_silent);
    updateSwitch('#dlb_auto_popup', setting.decision_auto_popup);

    $('#dlb_basis_mode').val(resolveBasisMode(setting));
    const timing = resolveTiming(setting);
    $('#dlb_timing_mode').val(timing.mode);
    $('#dlb_every_n_rounds').val(Math.max(1, Math.floor(Number(setting.decision_every_n_rounds) || 1)));
    // 一颗勾选管两趟 LLM（摘要 + 建索引）：两个键都要读，只有两边都没关过才算勾上
    updateSwitch('#dlb_llm_use_main_api', setting.decision_basis_use_main_api !== false && setting.decision_index_use_main_api !== false);
    $('#dlb_basis_char_limit').val(Math.max(100, Number(setting.decision_basis_char_limit) || BASIS_CHAR_LIMIT_DEFAULT));
    $('#dlb_basis_system_prompt').val(String(setting.decision_basis_system_prompt ?? '').trim() || DEFAULT_BASIS_SYSTEM_PROMPT);
    $('#dlb_basis_template').val(String(setting.decision_basis_template ?? '').trim() || DEFAULT_BASIS_TEMPLATE);

    $('#dlb_api_url').val(setting.decision_api_url || '');
    $('#dlb_api_key').val(USER.privacy.decision_api_key || '');
    $('#dlb_model').val(setting.decision_model || '');
    $('#dlb_force_threshold').val(setting.decision_force_threshold);
    $('#dlb_suppress_threshold').val(setting.decision_suppress_threshold);
    $('#dlb_max_candidates').val(setting.decision_max_candidates);
    $('#dlb_inject_max_entries').val(Math.max(0, Number(setting.decision_inject_max_entries) || 0));
    $('#dlb_inject_max_chars').val(Math.max(0, Number(setting.decision_inject_max_chars) || 0));
    $('#dlb_batch_size').val(Math.min(DECISION_MAX_QUESTIONS, Number(setting.decision_batch_size) || DECISION_MAX_QUESTIONS));
    $('#dlb_in_flight').val(Math.min(DECISION_MAX_IN_FLIGHT, Number(setting.decision_in_flight) || DECISION_MAX_IN_FLIGHT));
    $('#dlb_context_messages').val(setting.decision_context_messages);
    $('#dlb_context_chars').val(setting.decision_context_chars);
    $('#dlb_context_full_messages').val(setting.decision_context_full_messages);
    $('#dlb_digest_limit').val(setting.decision_digest_limit);
    $('#dlb_timeout_ms').val(setting.decision_timeout_ms);
    $('#dlb_reuse_rounds').val(setting.decision_reuse_rounds);

    $('#dlb_task_briefing').val(resolveTaskBriefing(setting.decision_task_briefing));
    $('#dlb_instruction_template').val(setting.decision_instruction_template ?? '');
    $('#dlb_state_note').val(setting.decision_state_note ?? '');
    $('#dlb_pending_note').val(setting.decision_pending_note ?? '');

    // ---- 条目摘要索引 ----
    const indexNumbers = readIndexNumbers(setting);
    $('#dlb_index_enabled').prop('checked', setting.decision_index_enabled === true);
    $('#dlb_index_summary_limit').val(indexNumbers.summaryLimit);
    $('#dlb_index_content_limit').val(indexNumbers.contentLimit);
    $('#dlb_index_batch_chars').val(indexNumbers.batchChars);
    $('#dlb_index_batch_size').val(indexNumbers.batchSize);
    $('#dlb_index_system_prompt').val(String(setting.decision_index_system_prompt ?? '').trim() || DEFAULT_INDEX_SYSTEM_PROMPT);
    $('#dlb_index_template').val(String(setting.decision_index_template ?? '').trim() || DEFAULT_INDEX_TEMPLATE);

    renderDecisionBasis();
    renderDecisionInjectionGate();
    renderDecisionIndex();

    // 长说明默认收起来，只留选项行尾一颗「？」（重复渲染安全：收过的打标记跳过）
    applyDescriptionCollapse(document.querySelector('.st_ld_settings'));

    console.log('[决策接管] 设置已渲染');
}

/**
 * 装绑定：输入即落盘，勾了就重画受影响的那几行提示
 */
export function bindSettings() {
    if (bound) return;
    bound = true;

    // ---- 自定义独立 API ----
    $('#dlb_custom_api_url').on('input', function () {
        USER.privacy.custom_api_url = $(this).val();
        USER.saveSettings && USER.saveSettings();
    });
    bindSecretInput('#dlb_custom_api_key', 'custom_api_key', '自定义 API Key');
    $('#dlb_custom_model_name').on('input', function () {
        USER.privacy.custom_model_name = $(this).val();
        USER.saveSettings && USER.saveSettings();
    });
    // 温度与输出上限
    $('#dlb_custom_temperature').on('input', function () {
        const value = $(this).val();
        $('#dlb_custom_temperature_value').text(value);
        USER.store.custom_temperature = Number(value);
    });
    $('#dlb_custom_max_tokens').on('input', function () {
        const value = $(this).val();
        USER.store.custom_max_tokens = value === '' ? 0 : Number(value);
        USER.saveSettings && USER.saveSettings();
    });
    // 思考模式（决定往请求体里附加哪个关闭思考的字段）
    $('#dlb_custom_thinking_mode').change(function (event) {
        const value = event.target.value || 'default';
        USER.store.custom_thinking_mode = value;
        USER.saveSettings && USER.saveSettings();
        EDITOR.success(value === 'default' ? '已恢复为不改动请求体' : '思考模式已更新，建议点一次「测试」确认端点接受');
    });
    // 模型列表
    $('#dlb_model_selector').change(function (event) {
        $('#dlb_custom_model_name').val(event.target.value);
        USER.privacy.custom_model_name = event.target.value;
        USER.saveSettings && USER.saveSettings();
    });
    $('#dlb_fetch_models_button').on('click', updateModelList);
    $(document).on('click', '#dlb_table_test_api_button', async () => {
        await handleApiTestRequest($('#dlb_custom_api_url').val(), $('#dlb_custom_model_name').val());
    });
    // API 预设
    $('#dlb_custom_api_preset_select').on('change', function () {
        selectCustomApiPreset($(this).val());
    });
    $('#dlb_custom_api_preset_new').on('click', () => newCustomApiPreset());
    $('#dlb_custom_api_preset_update').on('click', () => updateCustomApiPreset());
    $('#dlb_custom_api_preset_delete').on('click', () => deleteCustomApiPreset());
    $('#dlb_custom_api_preset_export').on('click', () => exportCustomApiPresets());
    $('#dlb_custom_api_preset_import').on('click', () => importCustomApiPresets());

    // 密钥框的小眼睛：切换明文/掩码；复制按钮：把框里的值拷进剪贴板
    $(document).on('click', '.secret_reveal_button', function () {
        const $input = $($(this).data('target'));
        const revealing = $input.attr('type') === 'password';
        $input.attr('type', revealing ? 'text' : 'password');
        $(this).toggleClass('fa-eye fa-eye-slash');
    });
    $(document).on('click', '.secret_copy_button', async function () {
        const value = $($(this).data('target')).val();
        if (!value) return EDITOR.warning('输入框是空的，没有可复制的内容。');
        try {
            await navigator.clipboard.writeText(value);
        } catch (error) {
            // 用局域网 IP + http 访问时 navigator.clipboard 不可用，退回老办法
            const $temp = $('<textarea>').val(value).css({ opacity: 0 }).appendTo('body');
            $temp[0].select();
            document.execCommand('copy');
            $temp.remove();
        }
        EDITOR.success('已复制到剪贴板。');
    });

    // ---- 决策模型接管世界书 ----
    const decisionNumber = (id, key, normalize) => {
        $(id).on('input', function () {
            const raw = $(this).val();
            USER.store[key] = raw === '' ? '' : normalize(raw);
            USER.saveSettings && USER.saveSettings();
        });
    };

    $('#dlb_router_enabled').change(function () {
        USER.store.decision_router_enabled = this.checked;
        USER.saveSettings && USER.saveSettings();
        // 聊天页那条「决策结果」小栏跟着开关显隐
        renderDecisionStatusBar();
        // 那两颗只管注入的勾跟着开关置灰，免得勾了才发现不起作用
        renderDecisionInjectionGate();
        if (this.checked && !USER.store.decision_api_url) {
            EDITOR.warning('决策路由已开启，但接口地址还是空的，生成时会退回原来的关键词注入。');
        }
    });
    // 决策依据来源：正文 / LLM 摘要。摘要档每轮都要多花一次请求，所以点它时要把代价说在前面
    $('#dlb_basis_mode').change(function () {
        const mode = $(this).val() === 'summary' ? 'summary' : 'chat';
        USER.store.decision_basis_mode = mode;
        USER.saveSettings && USER.saveSettings();
        renderDecisionBasis();
        if (USER.store.decision_router_enabled !== true) {
            EDITOR.warning('这个依据要开了上面那颗「启用决策路由」才用得上：没开时插件一轮都不问模型，摘要也不会生成。');
        } else if (mode === 'summary') {
            EDITOR.warning('决策依据改为 LLM 摘要：每轮 AI 回复写完都会另发一次请求把新剧情并进摘要（走主 API 还是自定义 API 看第 ④ 类顶上那颗勾选），等于每轮多花一次调用。摘要只喂给决策模型，不进发给模型写正文的那份提示词。', '', 14000);
        }
    });
    // 决策时机：间隔那几轮靠复用撑着，自主启动的入口在聊天页那颗按钮上
    $('#dlb_timing_mode').change(function () {
        const mode = ['every_round', 'every_n', 'manual'].includes($(this).val()) ? $(this).val() : 'every_round';
        USER.store.decision_timing_mode = mode;
        USER.saveSettings && USER.saveSettings();
        renderDecisionBasis();
        renderDecisionStatusBar();
        if (mode === 'manual') {
            EDITOR.warning('自主启动已选中：从现在起每轮都不再问模型、按关键词注入。想判就点聊天页底部小栏上的「本轮进行决策」，只有紧跟着的那一次生成会问。', '', 14000);
        }
    });
    $('#dlb_llm_use_main_api').change(function () {
        // 摘要那趟和建索引那趟各自认自己的键（decisionBasis / decisionEntryIndex 都在读），
        // 页面上并成一颗，所以一次写两个键，不动那两个读点。
        USER.store.decision_basis_use_main_api = this.checked;
        USER.store.decision_index_use_main_api = this.checked;
        USER.saveSettings && USER.saveSettings();
    });
    // 看/清当前聊天的决策摘要：两个都只读插件自己存的那份，一次请求都不发
    $('#dlb_basis_view_button').on('click', async function () {
        const state = readBasisState();
        const text = String(state?.text ?? '').trim();
        const body = text
            ? `<div style="text-align:left;white-space:pre-wrap;">${$('<div>').text(text).html()}</div>`
                + `<small class="toggle-description justifyLeft">已覆盖 ${state.covered} 楼（这几楼以上不再重复摘要）｜改写时间 ${state.at ? new Date(state.at).toLocaleString() : '未知'}</small>`
            : '<small class="toggle-description justifyLeft">本聊天还没有决策摘要。开了「LLM 摘要」之后，每轮 AI 回复写完会自动攒一份；下一轮生成时决策模型读的就是它。</small>';
        await new EDITOR.Popup(body, EDITOR.POPUP_TYPE.TEXT, '', {
            large: true,
            wide: true,
            allowVerticalScrolling: true,
            okButton: '关闭',
        }).show();
    });
    $('#dlb_basis_clear_button').on('click', async function () {
        const dropped = await dropBasis();
        renderDecisionBasis();
        EDITOR[dropped ? 'success' : 'info'](dropped
            ? '已清除本聊天的决策摘要：下一轮生成依据仍是正文，回复写完重新从头摘要一次。'
            : '本聊天没有决策摘要可清。');
    });
    $('#dlb_api_url').on('input', function () {
        USER.store.decision_api_url = $(this).val().trim();
        USER.saveSettings && USER.saveSettings();
    });
    $('#dlb_model').on('input', function () {
        USER.store.decision_model = $(this).val().trim();
        USER.saveSettings && USER.saveSettings();
    });
    bindSecretInput('#dlb_api_key', 'decision_api_key', '决策模型 API Key');
    $('#dlb_use_proxy').change(function () {
        USER.store.decision_use_proxy = this.checked;
        USER.saveSettings && USER.saveSettings();
    });
    $('#dlb_suppress_enabled').change(function () {
        USER.store.decision_suppress_enabled = this.checked;
        USER.saveSettings && USER.saveSettings();
        if (this.checked) EDITOR.warning('已开启压制：概率低于阈值的条目即使关键词命中也不会注入，建议先点「查看最近一次决策报告」确认清单无误伤。');
    });
    $('#dlb_block_keyword').change(function () {
        USER.store.decision_block_keyword = this.checked;
        USER.saveSettings && USER.saveSettings();
        if (this.checked) EDITOR.warning('已关闭关键词触发注入：判过的条目只认强推阈值，中间带也不会注入；没拿到判定的条目本轮仍按关键词走，并会提醒有多少条。');
    });
    $('#dlb_multi_round').change(function () {
        USER.store.decision_multi_round = this.checked;
        USER.saveSettings && USER.saveSettings();
    });
    $('#dlb_fail_silent').change(function () {
        USER.store.decision_fail_silent = this.checked;
        USER.saveSettings && USER.saveSettings();
    });
    $('#dlb_auto_popup').change(function () {
        USER.store.decision_auto_popup = this.checked;
        USER.saveSettings && USER.saveSettings();
    });
    decisionNumber('#dlb_force_threshold', 'decision_force_threshold', Number);
    decisionNumber('#dlb_suppress_threshold', 'decision_suppress_threshold', Number);
    decisionNumber('#dlb_max_candidates', 'decision_max_candidates', (v) => Math.max(1, Math.floor(Number(v) || 1)));
    decisionNumber('#dlb_inject_max_entries', 'decision_inject_max_entries', (v) => Math.max(0, Math.floor(Number(v) || 0)));
    decisionNumber('#dlb_inject_max_chars', 'decision_inject_max_chars', (v) => Math.max(0, Math.floor(Number(v) || 0)));
    decisionNumber('#dlb_batch_size', 'decision_batch_size', (v) => Math.min(DECISION_MAX_QUESTIONS, Math.max(1, Math.floor(Number(v) || 1))));
    decisionNumber('#dlb_in_flight', 'decision_in_flight', (v) => Math.min(DECISION_MAX_IN_FLIGHT, Math.max(1, Math.floor(Number(v) || 1))));
    decisionNumber('#dlb_context_messages', 'decision_context_messages', (v) => Math.max(1, Math.floor(Number(v) || 1)));
    decisionNumber('#dlb_context_chars', 'decision_context_chars', (v) => Math.max(50, Math.floor(Number(v) || 50)));
    decisionNumber('#dlb_context_full_messages', 'decision_context_full_messages', (v) => Math.max(0, Math.floor(Number(v) || 0)));
    decisionNumber('#dlb_digest_limit', 'decision_digest_limit', (v) => Math.max(40, Math.floor(Number(v) || 40)));
    decisionNumber('#dlb_timeout_ms', 'decision_timeout_ms', (v) => Math.max(2000, Math.floor(Number(v) || 2000)));
    decisionNumber('#dlb_basis_char_limit', 'decision_basis_char_limit', (v) => Math.max(100, Math.floor(Number(v) || 100)));
    decisionNumber('#dlb_every_n_rounds', 'decision_every_n_rounds', (v) => Math.max(1, Math.floor(Number(v) || 1)));
    decisionNumber('#dlb_reuse_rounds', 'decision_reuse_rounds', (v) => Math.max(0, Math.floor(Number(v) || 0)));
    // 这两个数一改「实际按几轮生效」就变了，跟着重画那行提示
    $('#dlb_every_n_rounds, #dlb_reuse_rounds').on('input', renderDecisionBasis);

    // 注入决策模型的提示词：原样存，空白由渲染时处理，所以这里不要 trim（用户能清空就是清空）
    const decisionText = (id, key) => {
        $(id).on('input', function () {
            USER.store[key] = String($(this).val() ?? '');
        });
    };
    decisionText('#dlb_task_briefing', 'decision_task_briefing');
    decisionText('#dlb_instruction_template', 'decision_instruction_template');
    decisionText('#dlb_state_note', 'decision_state_note');
    decisionText('#dlb_pending_note', 'decision_pending_note');
    // 摘要那两份提示词：原样存，留空由发送那趟兜回默认
    decisionText('#dlb_basis_system_prompt', 'decision_basis_system_prompt');
    decisionText('#dlb_basis_template', 'decision_basis_template');

    const resetDecisionText = (buttonId, id, key, label) => {
        $(buttonId).on('click', function () {
            const defaultValue = defaultSettings[key] ?? '';
            $(id).val(defaultValue);
            USER.store[key] = defaultValue;
            EDITOR.success(`${label}已恢复默认。`);
        });
    };
    resetDecisionText('#dlb_reset_task_briefing', '#dlb_task_briefing', 'decision_task_briefing', '工作认知');
    resetDecisionText('#dlb_reset_instruction_template', '#dlb_instruction_template', 'decision_instruction_template', '判定问法');
    resetDecisionText('#dlb_reset_state_note', '#dlb_state_note', 'decision_state_note', '固定背景');
    resetDecisionText('#dlb_reset_pending_note', '#dlb_pending_note', 'decision_pending_note', '标注');
    resetDecisionText('#dlb_reset_basis_system_prompt', '#dlb_basis_system_prompt', 'decision_basis_system_prompt', '摘要器系统提示词');
    resetDecisionText('#dlb_reset_basis_template', '#dlb_basis_template', 'decision_basis_template', '摘要改写指令');

    // ---- 条目摘要索引 ----
    $('#dlb_index_enabled').change(function () {
        USER.store.decision_index_enabled = this.checked;
        USER.saveSettings && USER.saveSettings();
        renderDecisionIndex();
        if (this.checked && indexOverview(USER.store).records === 0) {
            EDITOR.warning('已开启条目摘要索引，但索引还是空的：现在每轮还是按正文片段 + 通用问法判。点「填写条目索引」，自己逐条写或者在那儿让 LLM 填，才会用上摘要和分类。');
        }
    });
    decisionNumber('#dlb_index_summary_limit', 'decision_index_summary_limit', (v) => Math.max(20, Math.floor(Number(v) || 20)));
    decisionNumber('#dlb_index_content_limit', 'decision_index_content_limit', (v) => Math.max(200, Math.floor(Number(v) || 200)));
    decisionNumber('#dlb_index_batch_chars', 'decision_index_batch_chars', (v) => Math.max(500, Math.floor(Number(v) || 500)));
    decisionNumber('#dlb_index_batch_size', 'decision_index_batch_size', (v) => Math.max(1, Math.floor(Number(v) || 1)));
    decisionText('#dlb_index_system_prompt', 'decision_index_system_prompt');
    decisionText('#dlb_index_template', 'decision_index_template');

    // 分类和索引两页都在同一个工作台弹窗里，这两颗只是切页，不另开窗。
    // openDecisionWorkbench 的 promise 在「切完页」或「关窗」时才落定，所以刷新摘要行放在 then 里
    const openPage = (key) => () => openDecisionWorkbench(key).then(() => renderDecisionIndex());
    $('#dlb_type_edit_button').on('click', openPage('types'));
    $('#dlb_index_manual_button').on('click', openPage('index'));
    // 扩展设置抽屉里那一行指路按钮
    $('#dlb_open_workbench_button').on('click', () => openDecisionWorkbench('index'));
    $('#dlb_index_prune_button').on('click', () => pruneStaleIndex().then(() => renderDecisionIndex()));
    $('#dlb_index_stats_button').on('click', () => showIndexReport());

    $('#dlb_test_button').on('click', () => testDecisionConnection());
    $('#dlb_view_report_button').on('click', () => showDecisionReport());
    // 摘要和索引那两趟请求的原文只存内存，这一颗是唯一的入口
    $('#dlb_view_reply_button').on('click', () => showReply(0));
}

/**
 * 模板注入完成后调用一次
 */
export function loadSettings() {
    renderSetting();
    bindSettings();
}

/** 设置整块常驻的隐藏宿主节点 id（挂在 body 上，关窗时搬回这里） */
export const SETTINGS_HOST_ID = 'dlb_settings_host';
/** 设置整块自己的根节点 id */
export const SETTINGS_NODE_ID = 'dlb_settings_root';

/**
 * 工作台右上角那颗「设置」页
 * @description 整块设置 DOM 不复制、不重建，是在隐藏宿主和弹窗之间来回搬一个节点：
 * @description 移动节点不会掉监听，所以 bindSettings 那套一次绑定能一直用，不必每次开窗重绑。
 */
export function createSettingsPage() {
    return {
        key: 'settings',
        label: '设置',
        icon: 'fa-gear',
        hint: '剩下的设置都在这儿，按类别分成几档，每档里再按控件样子收着。打字即存盘，改完直接关窗。',
        async mount(root) {
            const node = document.getElementById(SETTINGS_NODE_ID);
            if (!node) {
                root.innerHTML = '<div class="toggle-description justifyLeft">设置那块模板还没注入完，刷新页面再试一次。</div>';
                return { isBusy: () => false, dispose: () => { } };
            }
            root.appendChild(node);
            renderSetting();
            return {
                isBusy: () => false,
                dispose: () => document.getElementById(SETTINGS_HOST_ID)?.appendChild(node),
            };
        },
    };
}
