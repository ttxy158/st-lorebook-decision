// customApiPresets.js
// 把「④ llm的使用和api自定义填写」那一组参数存成预设，方便在不同 API/模型之间快速切换。
// 只存 API 参数本身：切换预设不会动顶上那颗「走酒馆主 API」的勾选，也不会改变摘要/索引走哪条通道。
import { EDITOR, USER } from '../../core/manager.js';

const EXPORT_TYPE = 'st-memory-enhancement-custom-api-presets';
const SECRET_FIELDS = ['custom_api_key'];

function getPresets() {
    const stored = USER.store.custom_api_presets;
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

function setPresets(next) {
    USER.store.custom_api_presets = next;
}

/**
 * 读取当前生效的自定义 API 配置（key 取隐私区里保存的原值）
 * @returns {object}
 */
export function collectApiConfig() {
    const privacy = USER.privacy;
    const setting = USER.store;
    return {
        custom_api_url: privacy.custom_api_url || '',
        custom_model_name: privacy.custom_model_name || '',
        custom_api_key: privacy.custom_api_key || '',
        custom_temperature: Number(setting.custom_temperature ?? 1.0),
        custom_max_tokens: Number(setting.custom_max_tokens ?? 0),
        custom_thinking_mode: setting.custom_thinking_mode || 'default',
    };
}

/**
 * 把一组配置写回设置并回填表单
 * @param {object} config
 * @param {string} [presetName] - 要标记为当前使用的预设名；不传则只写值不改预设
 */
export function applyApiConfig(config, presetName) {
    const privacy = USER.privacy;
    privacy.custom_api_url = config.custom_api_url || '';
    privacy.custom_model_name = config.custom_model_name || '';
    // 导入的预设被刻意去掉了密钥，这种情况保留本机现值，别把用户已经填好的 key 抹掉；
    // 想清空 key 直接在设置框里删即可。
    if (config.custom_api_key) privacy.custom_api_key = config.custom_api_key;

    USER.store.custom_temperature = Number(config.custom_temperature ?? 1.0);
    USER.store.custom_max_tokens = Number(config.custom_max_tokens ?? 0);
    USER.store.custom_thinking_mode = config.custom_thinking_mode || 'default';
    if (presetName !== undefined) {
        USER.store.active_custom_api_preset = presetName;
    }
    USER.saveSettings && USER.saveSettings();
    syncFormWithConfig();
}

/**
 * 表单回填。这里不复用 renderSetting()，避免 userExtensionSetting 与本模块互相 import。
 */
function syncFormWithConfig() {
    const config = collectApiConfig();
    $('#dlb_custom_api_url').val(config.custom_api_url);
    $('#dlb_custom_api_key').val(config.custom_api_key);
    $('#dlb_custom_model_name').val(config.custom_model_name);
    $('#dlb_custom_temperature').val(config.custom_temperature);
    $('#dlb_custom_temperature_value').text(config.custom_temperature);
    $('#dlb_custom_max_tokens').val(config.custom_max_tokens > 0 ? config.custom_max_tokens : '');
    $('#dlb_custom_thinking_mode').val(config.custom_thinking_mode);
    renderCustomApiPresetList();
}

/**
 * 去掉密钥字段，供导出使用
 * @param {object} config
 */
export function stripSecrets(config) {
    const copy = { ...config };
    SECRET_FIELDS.forEach(field => delete copy[field]);
    return copy;
}

/**
 * 生成不与已有预设冲突的名字
 * @param {string} baseName
 */
function createUniquePresetName(baseName) {
    const presets = getPresets();
    let name = baseName;
    let counter = 1;
    while (presets[name]) {
        name = `${baseName} (${counter})`;
        counter++;
    }
    return name;
}

/**
 * 重绘预设下拉框
 */
export function renderCustomApiPresetList() {
    const $select = $('#dlb_custom_api_preset_select');
    if (!$select.length) return;
    const presets = getPresets();
    const active = USER.store.active_custom_api_preset || '';
    $select.empty();
    $select.append($('<option></option>').attr('value', '').text('— 未使用预设 —'));
    Object.keys(presets).forEach(name => {
        $select.append($('<option></option>').attr('value', name).text(name));
    });
    $select.val(active);
    if (!$select.val()) $select.val('');
}

/**
 * 另存为预设
 */
export async function newCustomApiPreset() {
    const config = collectApiConfig();
    if (!config.custom_api_url && !config.custom_model_name) {
        return EDITOR.warning('当前自定义API配置为空，先填好 URL 和模型再存预设。');
    }
    const name = await EDITOR.callGenericPopup(
        '为这套自定义API配置起个名字：',
        EDITOR.POPUP_TYPE.INPUT,
        config.custom_model_name || '新API预设',
        { okButton: '保存', cancelButton: '取消' }
    );
    if (!name || !String(name).trim()) return;
    const finalName = createUniquePresetName(String(name).trim());
    setPresets({ ...getPresets(), [finalName]: { name: finalName, ...config } });
    USER.store.active_custom_api_preset = finalName;
    USER.saveSettings && USER.saveSettings();
    renderCustomApiPresetList();
    EDITOR.success(`已保存预设 "${finalName}"`);
}

/**
 * 用当前配置覆盖所选预设
 */
export async function updateCustomApiPreset() {
    const name = $('#dlb_custom_api_preset_select').val() || USER.store.active_custom_api_preset;
    if (!name) return EDITOR.warning('请先在下拉框里选择一个预设，或用「另存为」新建。');
    const confirmed = await EDITOR.callGenericPopup(
        `将用当前配置覆盖预设 "${name}"，是否继续？`,
        EDITOR.POPUP_TYPE.CONFIRM,
        '',
        { okButton: '覆盖', cancelButton: '取消' }
    );
    if (!confirmed) return;
    setPresets({ ...getPresets(), [name]: { name, ...collectApiConfig() } });
    USER.saveSettings && USER.saveSettings();
    EDITOR.success(`已更新预设 "${name}"`);
}

/**
 * 删除预设（只删记录，当前表单值保持不变）
 */
export async function deleteCustomApiPreset() {
    const name = $('#dlb_custom_api_preset_select').val();
    if (!name) return EDITOR.warning('请先选择要删除的预设。');
    const confirmed = await EDITOR.callGenericPopup(
        `是否删除预设 "${name}"？该操作不可撤销。`,
        EDITOR.POPUP_TYPE.CONFIRM,
        '',
        { okButton: '删除', cancelButton: '取消' }
    );
    if (!confirmed) return;
    const presets = getPresets();
    delete presets[name];
    setPresets(presets);
    if (USER.store.active_custom_api_preset === name) {
        USER.store.active_custom_api_preset = '';
    }
    USER.saveSettings && USER.saveSettings();
    renderCustomApiPresetList();
    EDITOR.success(`已删除预设 "${name}"`);
}

/**
 * 导出全部预设（去掉密钥字段）
 */
export function exportCustomApiPresets() {
    const presets = getPresets();
    const names = Object.keys(presets);
    if (names.length === 0) return EDITOR.warning('还没有可导出的预设。');
    const payload = {
        type: EXPORT_TYPE,
        exported_at: new Date().toISOString(),
        // Key 现在是明文，更不可能跟着导出文件跑到别人机器上，一律不外发
        note: '导出内容已移除 API Key，导入后需手动重填。',
        presets: names.reduce((acc, name) => {
            acc[name] = stripSecrets(presets[name]);
            return acc;
        }, {}),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'custom-api-presets.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    EDITOR.success(`已导出 ${names.length} 个预设（不含密钥）`);
}

/**
 * 导入预设：接受导出文件、裸的 presets 对象或预设数组；同名自动加序号
 */
export async function importCustomApiPresets() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.style.display = 'none';
    document.body.appendChild(input);

    input.addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (!file) {
            EDITOR.error('未选择文件');
            return;
        }
        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            let list = [];
            if (Array.isArray(parsed)) list = parsed;
            else if (Array.isArray(parsed?.presets)) list = parsed.presets;
            else if (parsed?.presets && typeof parsed.presets === 'object') list = Object.values(parsed.presets);
            else if (parsed?.custom_api_url !== undefined) list = [parsed];
            else list = Object.values(parsed || {});

            const valid = list.filter(item => item && typeof item === 'object'
                && (typeof item.custom_api_url === 'string' || typeof item.custom_model_name === 'string'));
            if (valid.length === 0) throw new Error('文件里没有找到可导入的API预设');

            const presets = getPresets();
            const importedNames = [];
            valid.forEach(item => {
                const baseName = String(item.name || item.custom_model_name || '导入的API预设').trim() || '导入的API预设';
                const name = createUniquePresetName(baseName);
                const config = collectFromItem(item);
                presets[name] = { name, ...config };
                importedNames.push(name);
            });
            setPresets(presets);
            USER.saveSettings && USER.saveSettings();
            renderCustomApiPresetList();
            EDITOR.success(`已导入 ${importedNames.length} 个预设：${importedNames.join('、')}`);
            EDITOR.warning('导入的预设不含密钥，请逐个选中后重填 API Key。');
        } catch (error) {
            EDITOR.error('导入失败', error.message, error);
        } finally {
            document.body.removeChild(input);
        }
    });

    input.click();
}

/**
 * 归一化外部导入的预设项：补齐缺省值，并强制丢弃密文字段
 */
function collectFromItem(item) {
    const clean = stripSecrets({ ...collectApiConfig(), ...item });
    clean.custom_temperature = Number(item.custom_temperature ?? clean.custom_temperature);
    clean.custom_max_tokens = Number(item.custom_max_tokens ?? clean.custom_max_tokens);
    clean.custom_thinking_mode = item.custom_thinking_mode || 'default';
    return clean;
}

/**
 * 下拉框切换：确认后套用预设
 * @param {string} name
 */
export async function selectCustomApiPreset(name) {
    if (!name) {
        USER.store.active_custom_api_preset = '';
        USER.saveSettings && USER.saveSettings();
        renderCustomApiPresetList();
        return;
    }
    const preset = getPresets()[name];
    if (!preset) {
        renderCustomApiPresetList();
        return EDITOR.error(`未找到预设 "${name}"`);
    }
    const confirmed = await EDITOR.callGenericPopup(
        `将用预设 "${name}" 覆盖当前的自定义API配置（URL / Key / 模型 / 温度 / 输出上限 / 思考模式）。` +
        `顶上那颗「走酒馆主 API」的勾选不受影响。是否继续？`,
        EDITOR.POPUP_TYPE.CONFIRM,
        '',
        { okButton: '套用', cancelButton: '取消' }
    );
    if (!confirmed) {
        renderCustomApiPresetList();
        return;
    }
    applyApiConfig(preset, name);
    EDITOR.success(`已切换到预设 "${name}"`);
}
