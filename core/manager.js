/**
 * 插件自带的地基
 * @description 沿用上游那份 `core/manager.js` 的导出名（EDITOR / USER / APP / SYSTEM），
 * @description 是为了让搬过来的决策代码不必改几十处调用点。
 * @description 上游那一份还拖着整套表格系统（TTable、数据页、渲染器、调试面板），独立版一律不要：
 * @description 提示语直接走酒馆的 toastr，设置存进自己的桶。
 */
import { eventSource, event_types, generateRaw, getRequestHeaders, saveSettingsDebounced } from '/script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '/scripts/extensions.js';
import { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup } from '/scripts/popup.js';
import { defaultSettings } from '../data/pluginSetting.js';
import { newPopupConfirm } from '../components/popupConfirm.js';
import { generateRandomNumber, generateRandomString, lazy } from '../utils/utility.js';

// 模板目录：renderExtensionTemplateAsync 认的是 extensions/third-party 下面的相对路径
const TEMPLATE_PATH = 'third-party/st-lorebook-decision/assets/templates';
// 两个桶都挂在 extension_settings 上，跟别的插件（包括上游那个表格插件）互不干扰。
// 密钥单独一个桶：导出设置时可以整桶剔除，不必逐字段挑。
const SETTINGS_BUCKET = 'stLorebookDecision';
const PRIVACY_BUCKET = 'stLorebookDecisionPrivacy';

function bucket(name) {
    if (!extension_settings[name] || typeof extension_settings[name] !== 'object') {
        extension_settings[name] = {};
    }
    return extension_settings[name];
}

/**
 * 读时兜到默认值、写时落盘并自动保存
 * @param {string} name 桶名
 * @param {boolean} withDefaults 缺键时是否回 data/pluginSetting.js 里的默认值（密钥桶要关）
 */
function createSettingProxy(name, withDefaults = true) {
    return new Proxy({}, {
        get: (_, property) => {
            const stored = bucket(name);
            if (property in stored) return stored[property];
            if (withDefaults && property in defaultSettings) return defaultSettings[property];
            return undefined;
        },
        set: (_, property, value) => {
            bucket(name)[property] = value;
            saveSettingsDebounced();
            return true;
        },
    });
}

/** 提示语：上游那套是「toastr + 插件自己的调试面板」，这里只留 toastr 那一半 */
const notify = (type, message, detail, timeout) => {
    const toast = window.toastr;
    if (!toast || typeof toast[type] !== 'function') return;
    toast[type](message, detail || undefined, { timeOut: timeout });
};

export const APP = {
    eventSource,
    event_types,
    getContext,
    extension_settings,
    generateRaw,
    getRequestHeaders,
    callGenericPopup,
    Popup,
    POPUP_TYPE,
    POPUP_RESULT,
};

/**
 * @description `USER` 用户数据管理器：设置、密钥、当前聊天上下文
 */
export const USER = {
    store: createSettingProxy(SETTINGS_BUCKET),
    privacy: createSettingProxy(PRIVACY_BUCKET, false),
    getContext: () => getContext(),
    saveSettings: () => saveSettingsDebounced(),
};

/**
 * @description `EDITOR` 提示与弹窗
 */
export const EDITOR = {
    Popup,
    POPUP_TYPE,
    POPUP_RESULT,
    callGenericPopup,
    generateRaw,
    info: (message, detail = '', timeout = 500) => notify('info', message, detail, timeout),
    success: (message, detail = '', timeout = 500) => notify('success', message, detail, timeout),
    warning: (message, detail = '', timeout = 2000) => notify('warning', message, detail, timeout),
    error: (message, detail = '', error, timeout = 2000) => {
        console.error(message, detail, error);
        notify('error', message, detail, timeout);
    },
    clear: () => window.toastr?.clear(),
    // popupConfirm 与本文件互相 import（它要在弹窗里生成随机 id），所以这里用 getter 推迟取值
    get confirm() { return newPopupConfirm; },
    tryBlock: (cb, errorMsg, ...args) => {
        try {
            return cb(...args);
        } catch (e) {
            EDITOR.error(errorMsg ?? '执行代码块失败', e.message, e);
            return null;
        }
    },
};

/**
 * @description `SYSTEM` 系统级工具：模板、随机 id、防抖
 */
export const SYSTEM = {
    getTemplate: (name) => renderExtensionTemplateAsync(TEMPLATE_PATH, name),
    generateRandomString,
    generateRandomNumber,
    lazy,
};
