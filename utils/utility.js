// 通用工具函数

function loadFontAwesome() {
    // const fontAwesomeLink = document.createElement('link');
    // fontAwesomeLink.rel = 'stylesheet';
    // fontAwesomeLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css'; // 替换为 Font Awesome CDN 链接
    // document.head.appendChild(fontAwesomeLink);
}

/**
 * 判断一个密钥值是否还能用
 *
 * 隐私区存的是明文，所以这一关只在一处起作用：粘贴时带进来的空格、换行、不可见字符
 * —— 拿去发 fetch 只会得到一句看不懂的 "Failed to execute 'fetch': Invalid value"。
 * 合法的 API Key 只有可见 ASCII、不含空格。
 * @param {string|null|undefined} value 待检查的密钥
 * @returns {boolean}
 */
export function isUsableSecret(value) {
    return typeof value === 'string' && value.length > 0 && /^[\x21-\x7e]+$/.test(value);
}

// 拿到不可用密钥时的统一说法，指到「清空后重新粘贴」这个动作上
export const SECRET_UNUSABLE_HINT = '清空输入框后重新粘贴一次 Key。';

export function compareDataDiff(target, source) {
    const diff = {};
    for (const key of Object.keys(target)) {
        if (target[key] !== source[key]) {
            diff[key] = target[key];
        }
    }
    return diff;
}

export function compareDataSame(target, source) {
    const same = {};
    for (const key of Object.keys(target)) {
        if (target[key] === source[key]) {
            same[key] = target[key];
        }
    }
}

export function cssColorToRgba(name, opacity = 1) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).replace(')', `, ${opacity})`);
}

/**
 * 创建一个只读属性
 * @param {object} obj 要在其上定义属性的对象
 * @param {string} propertyName 属性名称
 * @param {function} getter 获取属性值的函数
 */
export function readonly(obj, propertyName, getter) {
    Object.defineProperty(obj, propertyName, {
        get: getter,
        set(value) {
            throw new Error(`${propertyName} 属性是只读的，不允许写入。`);
        }
    });
}

let step = 0;  // 保证每次调用该函数时绝对能生成不一样的随机数
function stepRandom(bias = step) {
    // console.log('stepRandom');
    let r = 100000 / (100000 / Math.random() + bias++);
    return r;
}

/**
 * 生成一个随机字符串
 * @description 请注意，该函数不适用于安全敏感的场景，在长度低于 12 时有碰撞的风险
 * @description 在 length = 8 时有 0.000023% (1,000,000次实验) 的可能性会出现重复
 * @param length
 * @param bias
 * @param characters
 * @returns {string}
 */
export function generateRandomString(length = 12, bias = step, characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789') {
    let result = '';
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(stepRandom(bias) * characters.length));
    }
    return result;
}

/**
 * 生成一个随机数字
 * @description 请注意，该函数不适用于安全敏感的场景，且在 length = 8 时有 0.00005% (1,000,000次实验) 的可能性会出现重复
 * @param length
 * @param forceLength
 * @returns {number}
 */
export function generateRandomNumber(length = 12, forceLength = true) {
    let randomNumber;

    do {
        randomNumber = Math.floor(stepRandom() * Math.pow(10, length));

        // 如果需要强制长度，确保生成的数字符合要求
        if (forceLength && randomNumber.toString().length < length) {
            randomNumber *= Math.pow(10, length - randomNumber.toString().length);
        }
    } while (forceLength && randomNumber.toString().length !== length);

    return randomNumber;
}


let antiShakeTimers = {};
/**
 * 防抖函数，控制某个操作的执行频率
 * @param {string} uid 唯一标识符，用于区分不同的防抖操作
 * @param {number} interval 时间间隔，单位毫秒，在这个间隔内只允许执行一次
 * @returns {boolean} 如果允许执行返回 true，否则返回 false
 */
export function lazy(uid, interval = 100) {
    if (!antiShakeTimers[uid]) {
        antiShakeTimers[uid] = { lastExecutionTime: 0 };
    }
    const timer = antiShakeTimers[uid];
    const currentTime = Date.now();

    if (currentTime - timer.lastExecutionTime < interval) {
        return false; // 时间间隔太短，防抖，不允许执行
    }

    timer.lastExecutionTime = currentTime;
    return true; // 允许执行
}

// 上游 utility.js 里那个 calculateStringHash（crypto.subtle.digest('MD5')）故意没搬：
// 浏览器不认 MD5 这个算法名，await 它就抛 NotSupportedError。缓存键一律用 decisionEntryIndex.js 的 fnv1aHex。

