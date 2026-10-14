// llmReplyViewer.js
// 把「决策摘要 / 条目索引」那两趟 LLM 请求的原始回复留在内存里，点一下就摊开看。
// 只存内存、不落盘：刷新聊天会重建 DOM，但不会重载扩展模块，所以记录活得过刷新。
// 为什么要看这个：摘要档判得不准、索引写跑偏时，唯一的线索就是模型到底回了什么原文。
import { EDITOR } from '../../core/manager.js';

const MAX_RECORDS = 5;

let records = [];
let current = null;

/**
 * 一次请求开始，登记元信息
 * @param {{purpose: string, apiType: string, model: string, promptText?: string, inputTokens?: number}} meta
 */
export function beginReply(meta) {
    current = {
        time: new Date().toLocaleTimeString(),
        purpose: meta?.purpose || 'LLM 请求',
        apiType: meta?.apiType || 'unknown',
        model: meta?.model || '',
        promptText: meta?.promptText || '',
        inputTokens: meta?.inputTokens ?? 0,
        reasoning: '',
        rawContent: '',
        note: '',
        error: '',
        startAt: Date.now(),
        durationMs: 0,
    };
}

/**
 * 累积思考内容（流式回调可能多次调用）
 * 只有在一次请求进行中才累积：测试连通等其它调用方共用同一个接口层，
 * 不判空就会凭空造出一条记录、把内容串到别的请求上。
 * @param {string} text
 */
export function appendReasoning(text) {
    if (!current || !text) return;
    current.reasoning += text;
}

/**
 * 结束本次记录并压入内存历史
 * @param {{rawContent?: string, note?: string, error?: string}} patch
 */
export function finishReply(patch = {}) {
    if (!current) return null;
    Object.assign(current, patch || {});
    current.rawContent = current.rawContent || '';
    current.durationMs = Date.now() - current.startAt;
    records.unshift(current);
    if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
    current = null;
    return records[0];
}

/**
 * @returns {Array} 内存中已有的回复记录（最新在前）
 */
export function getReplies() {
    return records;
}

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function buildHeader(record) {
    const apiName = record.apiType === 'main' ? '主API' : '自定义API';
    const parts = [
        `用途：${record.purpose}`,
        `API：${apiName}`,
        record.model ? `模型：${record.model}` : '',
        `耗时：${(record.durationMs / 1000).toFixed(1)} 秒`,
        record.inputTokens ? `输入约 ${record.inputTokens} token` : '',
        record.note || '',
        record.time ? `时间 ${record.time}` : '',
    ];
    return parts.filter(Boolean).join('　|　');
}

function buildHtml(record) {
    const sections = [];

    if (record.reasoning) {
        sections.push(`
            <div class="dlb-reply-section">
                <div class="dlb-reply-label">思考过程</div>
                <textarea id="dlb_reply_reasoning" class="text_pole settings_textarea wide100p" rows="8" readonly></textarea>
            </div>`);
    } else if (record.apiType === 'main') {
        sections.push(`
            <div class="dlb-reply-section">
                <small class="toggle-description justifyLeft">主API 不回传思考内容，如需查看请在「④ llm的使用和api自定义填写」里配好并改用自定义 API。</small>
            </div>`);
    }

    sections.push(`
        <div class="dlb-reply-section">
            <div class="dlb-reply-label">AI 回复正文（未经解析的原文）</div>
            <textarea id="dlb_reply_content" class="text_pole settings_textarea wide100p" rows="14" readonly></textarea>
        </div>`);

    if (record.error) {
        sections.push(`
            <div class="dlb-reply-section">
                <div class="dlb-reply-label" style="color: var(--SmartThemeErrColor)">错误信息</div>
                <textarea id="dlb_reply_error" class="text_pole settings_textarea wide100p" rows="3" readonly></textarea>
            </div>`);
    }

    if (record.promptText) {
        sections.push(`
            <details class="dlb-reply-section">
                <summary class="dlb-reply-label">本次实际发送给 AI 的请求</summary>
                <textarea id="dlb_reply_prompt" class="text_pole settings_textarea wide100p" rows="12" readonly></textarea>
            </details>`);
    }

    return `
<div class="wide100p padding5" style="display: flex; flex-direction: column; gap: 8px;">
    <div class="dlb-reply-meta">${escapeHtml(buildHeader(record))}</div>
    ${sections.join('')}
    <div class="menu_button menu_button_icon" id="dlb_reply_copy_all" style="align-self: flex-start;">
        <i class="fa-solid fa-copy"></i><span>复制全部</span>
    </div>
</div>
<style>
    .dlb-reply-meta { color: var(--SmartThemeEmColor); font-size: 13px; }
    .dlb-reply-label { text-align: left; font-weight: bold; margin-bottom: 4px; }
    .dlb-reply-section textarea { font-family: var(--mainFixedWidthFont, monospace); font-size: 12px; white-space: pre; }
    details.dlb-reply-section summary { cursor: pointer; }
</style>`;
}

/**
 * clipboard API 不可用或被拒绝时的兜底复制
 * @param {HTMLElement} container 弹窗根节点
 * @param {string} text
 */
function copyBySelecting(container, text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    (container || document.body).appendChild(textArea);
    textArea.focus();
    textArea.select();
    let ok = false;
    try {
        ok = document.execCommand('copy');
    } catch (e) {
        ok = false;
    }
    textArea.remove();
    return ok;
}

function buildPlainText(record) {
    const blocks = [buildHeader(record)];
    if (record.reasoning) blocks.push(`【思考过程】\n${record.reasoning}`);
    blocks.push(`【AI 回复正文】\n${record.rawContent}`);
    if (record.error) blocks.push(`【错误信息】\n${record.error}`);
    if (record.promptText) blocks.push(`【本次发送的请求】\n${record.promptText}`);
    return blocks.join('\n\n');
}

/**
 * 弹窗展示指定记录（默认最新一条）
 * @param {number} [index=0]
 * @returns {Promise<void>}
 */
export async function showReply(index = 0) {
    const record = records[index];
    if (!record) {
        EDITOR.info('这次打开页面还没有跑过摘要或索引，没有可看的模型回复。');
        return;
    }

    const popup = new EDITOR.Popup(buildHtml(record), EDITOR.POPUP_TYPE.TEXT, '', {
        large: true,
        wide: true,
        allowVerticalScrolling: true,
        okButton: '关闭',
    });
    const $dlg = $(popup.dlg);

    // 用 .val() 写内容，避免回复文本里出现 </textarea> 时把弹窗结构顶掉
    $dlg.find('#dlb_reply_reasoning').val(record.reasoning);
    $dlg.find('#dlb_reply_content').val(record.rawContent);
    $dlg.find('#dlb_reply_error').val(record.error);
    $dlg.find('#dlb_reply_prompt').val(record.promptText);
    $dlg.find('#dlb_reply_copy_all').on('click', async () => {
        const text = buildPlainText(record);
        try {
            await navigator.clipboard.writeText(text);
            EDITOR.success('已复制到剪贴板');
        } catch (e) {
            // 页面失焦时 clipboard API 会拒绝，退回旧的选择复制方案
            if (copyBySelecting(popup.dlg, text)) {
                EDITOR.success('已复制到剪贴板');
            } else {
                EDITOR.error('复制失败，请全选文本框内容自己复制', e.message, e);
            }
        }
    });

    await popup.show();
}
