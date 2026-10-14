// standaloneAPI.js
import {EDITOR, USER} from '../../core/manager.js';
import LLMApiService from "../../services/llmApi.js";
import {PopupConfirm} from "../../components/popupConfirm.js";
import {appendReasoning} from "./llmReplyViewer.js";
import {isUsableSecret, SECRET_UNUSABLE_HINT} from "../../utils/utility.js";

let loadingToast = null;
let currentApiKeyIndex = 0;// 用于记录当前使用的API Key的索引


/**
 * 归一化用户粘贴进来的密钥：按逗号拆分、去空白、去重复
 * @param {string} rawKey - 原始密钥，可以是逗号分隔的多个
 * @returns {{keyString: string, totalKeys: number, remainingKeys: number, duplicatesRemoved: number, invalidKeysCount: number}}
 */
export function processApiKey(rawKey) {
    const parts = String(rawKey ?? '').split(',');
    const keys = parts.map(k => k.trim()).filter(k => k.length > 0);
    const uniqueKeys = [...new Set(keys)];

    return {
        keyString: uniqueKeys.join(','),
        duplicatesRemoved: keys.length - uniqueKeys.length,
        invalidKeysCount: parts.length - keys.length,
        remainingKeys: uniqueKeys.length,
        totalKeys: parts.length,
    };
}

/**
 * 读取隐私区里任意一个 API Key（明文保存，原样返回）
 * @param {string} field 隐私桶（USER.privacy）里的字段名
 * @returns {string|null} 没填、或内容不能直接当密钥用时返回 null
 */
export function getPrivacyKey(field) {
    const stored = USER.privacy[field];
    if (!stored) return null;
    if (!isUsableSecret(stored)) {
        console.error(`隐私字段 ${field} 的内容不能直接作为密钥使用。${SECRET_UNUSABLE_HINT}`);
        return null;
    }
    return stored;
}

/**
 * 当前生效的自定义 API Key（逗号分隔的多个 Key 原样返回）
 * @returns {string|null}
 */
export function getCustomApiKey() {
    return getPrivacyKey('custom_api_key');
}

/**
 * 旧版本密钥的 XOR(设备ID) 迁移逻辑没有搬过来：那是原插件用户自己的历史包袱，
 * 而且它会顺手清空隐私区里同名的 Key——两个插件并存时会踩到别人的数据。
 * 本插件从头就是明文存储，读到的值只判断「能不能直接当密钥用」，不猜历史编码。
 */

async function createLoadingToast(isUseMainAPI = true, isSilent = false) {
    if (isSilent) {
        // 在静默模式下，不显示弹窗，直接模拟“后台继续”
        // 返回 false，因为 PopupConfirm 中“后台继续”按钮（cancelBtn）返回 false
        return Promise.resolve(false);
    }
    loadingToast?.close()
    loadingToast = new PopupConfirm();
    return await loadingToast.show(
        isUseMainAPI
            ? '正在使用【主API】调用决策模型...'
            : '正在使用【自定义API】调用决策模型...',
        '后台继续',
        '中止执行',
    )
}

/**主API调用
 * @param {string|Array<object>} systemPrompt - 系统提示或消息数组
 * @param {string} [userPrompt] - 用户提示 (如果第一个参数是消息数组，则此参数被忽略)
 * @param {boolean} [isSilent=false] - 是否以静默模式运行，不显示加载提示
 * @returns {Promise<string>} 生成的响应内容
 */
export async function handleMainAPIRequest(systemPrompt, userPrompt, isSilent = false) {
    let finalSystemPrompt = '';
    let finalUserPrompt = '';
    let suspended = false; // Define suspended outside the blocks

    if (Array.isArray(systemPrompt)) {
        // --- Start: Processing for array input ---
        const messages = systemPrompt; // messages is defined here now

        // Loading toast logic
        createLoadingToast(true, isSilent).then((r) => {
            if (loadingToast) loadingToast.close();
            suspended = r; // Assign to the outer suspended variable
        });

        let startTime = Date.now();
        // 修复：静默模式下 createLoadingToast 不创建 toast，旧实例 toastElement 可能为 null，
        // 直接调用 frameUpdate 会抛 "Cannot read properties of null (reading 'style')"。
        if (loadingToast?.toastElement) {
            loadingToast.frameUpdate(() => {
                if (loadingToast) {
                    loadingToast.text = `正在使用【主API】(多消息)请求决策模型: ${((Date.now() - startTime) / 1000).toFixed(1)}秒`;
                }
            });
        }

        console.log('主API请求的多消息数组:', messages); // Log the actual array
        // 优先使用「酒馆助手 TavernHelper」插件(支持流式，体验最佳)；
        // 未安装时回退到酒馆自带 generateRaw(非流式，不依赖任何插件，不会 ReferenceError)。
        if (typeof TavernHelper?.generateRaw === 'function') {
            const response = await TavernHelper.generateRaw({
                ordered_prompts: messages, // Pass the array directly
                should_stream: true,      // Re-enable streaming
            });
            loadingToast.close();
            return suspended ? 'suspended' : response;
        }

        if (typeof EDITOR.generateRaw === 'function') {
            const response = await EDITOR.generateRaw({
                prompt: messages,
                systemPrompt: '',
                trimNames: false, // 不要修剪命名，避免模型返回的整段内容被改写
            });
            loadingToast.close();
            return suspended ? 'suspended' : response;
        }

        throw new Error("当前酒馆未安装「酒馆助手」(TavernHelper)插件且版本过低，无法通过主API发送决策请求，请安装酒馆助手或更新酒馆。");
        // --- End: Processing for array input ---

    } else { // Correctly placed ELSE block
        // --- Start: Original logic for non-array input ---
        finalSystemPrompt = systemPrompt;
        finalUserPrompt = userPrompt;

        createLoadingToast(true, isSilent).then((r) => {
            if (loadingToast) loadingToast.close();
            suspended = r; // Assign to the outer suspended variable
        });

        let startTime = Date.now();
        // 修复：静默模式下 createLoadingToast 不创建 toast，旧实例 toastElement 可能为 null
        if (loadingToast?.toastElement) {
            loadingToast.frameUpdate(() => {
                if (loadingToast) {
                    loadingToast.text = `正在使用【主API】请求决策模型: ${((Date.now() - startTime) / 1000).toFixed(1)}秒`;
                }
            });
        }

        // Use EDITOR.generateRaw for non-array input
        const response = await EDITOR.generateRaw({
            prompt: finalUserPrompt,
            systemPrompt: finalSystemPrompt,
            trimNames: false,
        });
        loadingToast.close();
        return suspended ? 'suspended' : response;
        // --- End: Original logic ---
    }
} // Correct closing brace for the function

/**
 * 处理 API 测试请求，包括获取输入、读取密钥、调用测试函数和返回结果。
 * @param {string} apiUrl - API URL.
 * @param {string} modelName - 模型名称.
 * @returns {Promise<Array<{keyIndex: number, success: boolean, error?: string}>>} 测试结果数组.
 */
export async function handleApiTestRequest(apiUrl, modelName) {
    const apiKeys = (getCustomApiKey() || '').split(',').map(k => k.trim()).filter(k => k.length > 0);
    if (!apiUrl || apiKeys.length === 0) {
        EDITOR.error(!apiUrl ? '请先填写 API URL。' : `请先在设置里填好可用的 API Key。${SECRET_UNUSABLE_HINT}`);
        return [];
    }
    const testAll = await EDITOR.callGenericPopup(`检测到 ${apiKeys.length} 个 API Key。\n注意：测试方式和酒馆自带的相同，将会发送一次消息（token数量很少），但如果使用的是按次计费的API请注意消费情况。`, EDITOR.POPUP_TYPE.CONFIRM, '', { okButton: "测试第一个key", cancelButton: "取消" });
    let keysToTest = [];
    if (testAll === null) return []; // 用户取消弹窗，返回空数组

    if (testAll) {
        keysToTest = [apiKeys[0]];
        EDITOR.info(`开始测试第 ${keysToTest.length} 个 API Key...`);
    } else {
        return []; // 用户点击取消，返回空数组
    }
    //！！~~~保留测试多个key的功能，暂时只测试第一个key~~~！！
    try {
        // 调用测试函数
        const results = await testApiConnection(apiUrl, keysToTest, modelName);

        // 处理结果并显示提示消息
        if (results && results.length > 0) {
            EDITOR.clear(); // 清除之前显示的'开始测试第x个API Key...'提示
            let successCount = 0;
            let failureCount = 0;
            results.forEach(result => {
                if (result.success) {
                    successCount++;
                } else {
                    failureCount++;
                    // 记录详细错误，如果可用则使用原始密钥索引
                    console.error(`Key ${result.keyIndex !== undefined ? result.keyIndex + 1 : '?'} 测试失败: ${result.error}`);
                }
            });

            if (failureCount > 0) {
                EDITOR.error(`${failureCount} 个 Key 测试失败。请检查控制台获取详细信息。`);
                EDITOR.error(`API端点: ${apiUrl}`);
                EDITOR.error(`错误详情: ${results.find(r => !r.success)?.error || '未知错误'}`);
            }
            if (successCount > 0) {
                EDITOR.success(`${successCount} 个 Key 测试成功！`);
            }
        } else if (results) {
            // 处理testApiConnection可能返回空数组的情况(例如用户取消)
        }

        return results; // 返回结果数组
    } catch (error) {
        EDITOR.error(`API 测试过程中发生错误`, error.message, error);
        console.error("API Test Error:", error);
        // 发生一般错误时返回一个表示所有测试密钥失败的数组
        return keysToTest.map((_, index) => ({
            keyIndex: apiKeys.indexOf(keysToTest[index]), // 如果需要则查找原始索引
            success: false,
            error: `测试过程中发生错误: ${error.message}`
        }));
    }
}

/**
 * 测试API连接
 * @param {string} apiUrl - API URL
 * @param {string[]} apiKeys - API密钥数组
 * @param {string} modelName - 模型名称
 * @returns {Promise<Array<{keyIndex: number, success: boolean, error?: string}>>} 测试结果数组
 */
export async function testApiConnection(apiUrl, apiKeys, modelName) {
    const results = [];
    const testPrompt = "Say 'test'"; // 测试用例

    for (let i = 0; i < apiKeys.length; i++) {
        const apiKey = apiKeys[i];
        console.log(`Testing API Key index: ${i}`);
        try {
            const llmService = new LLMApiService({
                api_url: apiUrl,
                api_key: apiKey,
                model_name: modelName || 'gpt-3.5-turbo', // 使用用户设置的模型名称
                system_prompt: 'You are a test assistant.',
                temperature: 0.1, // 使用用户设置的温度
                // 测试要如实复现真实请求，否则「测试通过但实际调用报错」会误导人
                thinking_mode: USER.store.custom_thinking_mode,
            });

            // 调用API
            const response = await llmService.callLLM(testPrompt);

            if (response && typeof response === 'string') {
                console.log(`API Key index ${i} test successful. Response: ${response}`);
                results.push({ keyIndex: i, success: true });
            } else {
                throw new Error('Invalid or empty response received.');
            }
        } catch (error) {
            console.error(`API Key index ${i} test failed (raw error object):`, error); // Log the raw error object
            let errorMessage = 'Unknown error';
            if (error instanceof Error) {
                errorMessage = error.message;
            } else if (typeof error === 'string') {
                errorMessage = error;
            } else if (error && typeof error.toString === 'function') {
                errorMessage = error.toString();
            }
            results.push({ keyIndex: i, success: false, error: errorMessage });
        }
    }
    return results;
}

/**自定义API调用
 * @param {string|Array<object>} systemPrompt - 系统提示或消息数组
 * @param {string} [userPrompt] - 用户提示 (如果第一个参数是消息数组，则此参数被忽略)
 * @param {boolean} [isSilent=false] - 是否以静默模式运行，不显示加载提示
 * @returns {Promise<string>} 生成的响应内容
 */
export async function handleCustomAPIRequest(systemPrompt, userPrompt, isSilent = false) {
    const USER_API_URL = USER.privacy.custom_api_url;
    const apiKeys = (getCustomApiKey() || '').split(',').map(k => k.trim()).filter(k => k.length > 0);
    const USER_API_MODEL = USER.privacy.custom_model_name;
    // const MAX_RETRIES = USER.store.custom_api_retries ?? 0; // 从设置中获取重试次数，默认为 0
    const MAX_RETRIES = 0; // 从设置中获取重试次数，默认为 0

    if (!USER_API_URL || !USER_API_MODEL) {
        EDITOR.error('请填写完整的自定义API配置 (URL 和模型)');
        return;
    }

    if (apiKeys.length === 0) {
        EDITOR.error(`未找到可用的 API Key，请检查设置。${SECRET_UNUSABLE_HINT}`);
        return;
    }

    let suspended = false;
    createLoadingToast(false, isSilent).then((r) => {
        if (loadingToast) loadingToast.close();
        suspended = r;
    })

    const totalKeys = apiKeys.length;
    const attempts = MAX_RETRIES === 0 ? totalKeys : Math.min(MAX_RETRIES, totalKeys);
    let lastError = null;

    for (let i = 0; i < attempts; i++) {
        if (suspended) break; // 检查用户是否中止了操作

        const keyIndexToTry = currentApiKeyIndex % totalKeys;
        const currentApiKey = apiKeys[keyIndexToTry];
        currentApiKeyIndex++; // 移动到下一个密钥，用于下一次整体请求

        console.log(`尝试使用API密钥索引进行API调用: ${keyIndexToTry}`);
        if (loadingToast) {
            loadingToast.text = `尝试使用第 ${keyIndexToTry + 1}/${totalKeys} 个自定义API Key...`;
        }

        try { // Outer try for the whole attempt with the current key
            const promptData = Array.isArray(systemPrompt) ? systemPrompt : userPrompt;
            let response; // Declare response variable

            // --- ALWAYS Use llmService ---
            console.log(`自定义API: 使用 llmService.callLLM (输入类型: ${Array.isArray(promptData) ? '多消息数组' : '单条消息'})`);
            if (loadingToast) {
                loadingToast.text = `正在使用第 ${keyIndexToTry + 1}/${totalKeys} 个自定义API Key (llmService)...`;
            }

            const llmService = new LLMApiService({
                api_url: USER_API_URL,
                api_key: currentApiKey,
                model_name: USER_API_MODEL,
                // Pass empty system_prompt if promptData is array, otherwise pass the original systemPrompt string
                system_prompt: Array.isArray(promptData) ? "" : systemPrompt,
                temperature: USER.store.custom_temperature,
                // 修复 #162/#193：将用户配置的输出上限接入 max_tokens。
                // 旧代码未传 max_tokens，导致 LLMApiService 永远使用默认 63000，
                // 在输出窗口较小的模型上（如 GPT-4.1-nano、部分 DeepSeek）会直接报 API 错误。
                max_tokens: Number(USER.store.custom_max_tokens) || 4096,
                thinking_mode: USER.store.custom_thinking_mode,
                on_reasoning: (text) => appendReasoning(text),
            });

            const streamCallback = (chunk) => {
                if (loadingToast) {
                    loadingToast.text = `正在使用第 ${keyIndexToTry + 1} 个Key生成: ${chunk}`;
                }
            };

            try {
                // Pass promptData (which could be string or array) to callLLM
                response = await llmService.callLLM(promptData, streamCallback);
                console.log(`请求成功 (llmService, 密钥索引: ${keyIndexToTry}):`, response);
                loadingToast?.close();
                return suspended ? 'suspended' : response; // Success, return immediately
            } catch (llmServiceError) {
                // llmService failed, log error and continue loop
                console.error(`API调用失败 (llmService)，密钥索引 ${keyIndexToTry}:`, llmServiceError);
                lastError = llmServiceError;
                EDITOR.error(`使用第 ${keyIndexToTry + 1} 个 Key 调用 (llmService) 失败: ${llmServiceError.message || '未知错误'}`);
                // Let the loop continue to the next key
            }
            // If code reaches here, the llmService call failed for this key

        } catch (error) { // This catch should ideally not be reached due to inner try/catch
            console.error(`处理密钥索引 ${keyIndexToTry} 时发生意外错误:`, error);
            lastError = error;
            EDITOR.error(`处理第 ${keyIndexToTry + 1} 个 Key 时发生意外错误`, error.message || '未知错误', error);
        }
    }

    // 所有尝试均失败
    loadingToast?.close();
    if (suspended) {
        EDITOR.warning('操作已被用户中止。');
        return 'suspended';
    }

    const errorMessage = `所有 ${attempts} 次尝试均失败。最后错误: ${lastError?.message || '未知错误'}`;
    EDITOR.error(errorMessage, "", lastError);
    console.error('所有API调用尝试均失败。', lastError);
    return `错误: ${errorMessage}`; // 返回一个明确的错误字符串

    // // 公共请求配置 (Commented out original code remains unchanged)
    // const requestConfig = {
    //     method: 'POST',
    //     headers: {
    //         'Content-Type': 'application/json',
    //         'Authorization': `Bearer ${USER_API_KEY}`
    //     },
    //     body: JSON.stringify({
    //         model: USER_API_MODEL,
    //         messages: [
    //             { role: "system", content: systemPrompt },
    //             { role: "user", content: userPrompt }
    //         ],
    //         temperature: USER.store.custom_temperature
    //     })
    // };
    //
    // // 通用请求函数
    // const makeRequest = async (url) => {
    //     const response = await fetch(url, requestConfig);
    //     if (!response.ok) {
    //         const errorBody = await response.text();
    //         throw { status: response.status, message: errorBody };
    //     }
    //     return response.json();
    // };
    // let firstError;
    // try {
    //     // 第一次尝试补全/chat/completions
    //     const modifiedUrl = new URL(USER_API_URL);
    //     modifiedUrl.pathname = modifiedUrl.pathname.replace(/\/$/, '') + '/chat/completions';
    //     const result = await makeRequest(modifiedUrl.href);
    //     if (result?.choices?.[0]?.message?.content) {
    //         console.log('请求成功:', result.choices[0].message.content)
    //         return result.choices[0].message.content;
    //     }
    // } catch (error) {
    //     firstError = error;
    // }
    //
    // try {
    //     // 第二次尝试原始URL
    //     const result = await makeRequest(USER_API_URL);
    //     return result.choices[0].message.content;
    // } catch (secondError) {
    //     const combinedError = new Error('API请求失败');
    //     combinedError.details = {
    //         firstAttempt: firstError?.message || '第一次请求无错误信息',
    //         secondAttempt: secondError.message
    //     };
    //     throw combinedError;
    // }
}

/**请求模型列表
 * @returns {Promise<void>}
 */
/**
 * 格式化API Key用于错误提示
 * @param {string} key - API Key
 * @returns {string} 格式化后的Key字符串
 */
function maskApiKey(key) {
    const len = key.length;
    if (len === 0) return "[空密钥]";
    if (len <= 8) {
        const visibleCount = Math.ceil(len / 2);
        return key.substring(0, visibleCount) + '...';
    } else {
        return key.substring(0, 4) + '...' + key.substring(len - 4);
    }
}

/**请求模型列表
 * @returns {Promise<void>}
 */
export async function updateModelList() {
    const apiUrl = $('#dlb_custom_api_url').val().trim();
    const apiKeys = (getCustomApiKey() || '').split(',').map(k => k.trim()).filter(k => k.length > 0);

    if (!apiUrl) {
        EDITOR.error('请输入API URL');
        return;
    }
    if (apiKeys.length === 0) {
        EDITOR.error(`未找到可用的 API Key，请检查设置。${SECRET_UNUSABLE_HINT}`);
        return;
    }

    let foundValidKey = false;
    const invalidKeysInfo = [];
    let modelCount = 0; // 用于记录获取到的模型数量
    const $selector = $('#dlb_model_selector');

    // 规范化URL路径
    let modelsUrl;
    try {
        const normalizedUrl = new URL(apiUrl);
        normalizedUrl.pathname = normalizedUrl.pathname.replace(/\/$/, '') + '/models';
        modelsUrl = normalizedUrl.href;
    } catch (e) {
        EDITOR.error(`无效的API URL: ${apiUrl}`, "", e);
        console.error('URL解析失败:', e);
        return;
    }

    for (let i = 0; i < apiKeys.length; i++) {
        const currentApiKey = apiKeys[i];
        try {
            const response = await fetch(modelsUrl, {
                headers: {
                    'Authorization': `Bearer ${currentApiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                let errorMsg = `请求失败: ${response.status}`;
                try {
                    const errorBody = await response.text();
                    errorMsg += ` - ${errorBody}`;
                } catch {}
                throw new Error(errorMsg);
            }

            const data = await response.json();

            // 只有在第一次成功获取时才更新下拉框
            if (!foundValidKey && data?.data?.length > 0) {
                $selector.empty(); // 清空现有选项
                const customModelName = USER.privacy.custom_model_name;
                let hasMatchedModel = false;

                data.data.forEach(model => {
                    $selector.append($('<option>', {
                        value: model.id,
                        text: model.id
                    }));

                    // 检查是否有模型名称与custom_model_name匹配
                    if (model.id === customModelName) {
                        hasMatchedModel = true;
                    }
                });

                // 如果有匹配的模型，则选中它
                if (hasMatchedModel) {
                    $selector.val(customModelName);
                }

                foundValidKey = true;
                modelCount = data.data.length; // 记录模型数量
                // 不在此处显示成功消息，统一在最后处理
            } else if (!foundValidKey && (!data?.data || data.data.length === 0)) {
                 // 即使请求成功，但没有模型数据，也视为一种失败情况，记录下来
                 throw new Error('请求成功但未返回有效模型列表');
            }
            // 如果已经找到有效key并更新了列表，后续的key只做有效性检查，不再更新UI

        } catch (error) {
            console.error(`使用第 ${i + 1} 个 Key 获取模型失败:`, error);
            invalidKeysInfo.push({ index: i + 1, key: currentApiKey, error: error.message });
        }
    }

    // 处理最终结果和错误提示
    if (foundValidKey) {
        EDITOR.success(`成功获取 ${modelCount} 个模型并更新列表 (共检查 ${apiKeys.length} 个Key)`);
    } else {
        EDITOR.error('未能使用任何提供的API Key获取模型列表');
        $selector.empty(); // 确保在所有key都无效时清空列表
        $selector.append($('<option>', { value: '', text: '未能获取模型列表' }));
    }

    if (invalidKeysInfo.length > 0) {
        const errorDetails = invalidKeysInfo.map(item =>
            `第${item.index}个Key (${maskApiKey(item.key)}) 无效: ${item.error}`
        ).join('\n');
        EDITOR.error(`以下API Key无效:\n${errorDetails}`);
    }
}
