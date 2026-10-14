export class LLMApiService {
    constructor(config = {}) {
        this.config = {
            api_url: config.api_url || "https://api.openai.com/v1",
            api_key: config.api_key || "",
            model_name: config.model_name || "gpt-3.5-turbo",
            system_prompt: config.system_prompt || "You are a helpful assistant.",
            temperature: config.temperature || 1.0,
            max_tokens: config.max_tokens || 63000, // 将默认值从 20000 修改为 63000
            stream: config.stream || false,
            // 思考模式：'default' 不改动请求体，其余值见 #getThinkingFields
            thinking_mode: config.thinking_mode || 'default',
            // 每收到一段思考内容就回调，供「查看上次 LLM 回复」实时累积
            on_reasoning: typeof config.on_reasoning === 'function' ? config.on_reasoning : null,
        };
        // 部分服务商会把思考内容放在 reasoning_content / reasoning 字段回传
        this.lastReasoning = '';
    }

    /**
     * 思考模式的请求体字段映射。
     * 端点不认识的字段可能被忽略、也可能报错，用设置页那颗「测试」先验一次。
     */
    #getThinkingFields() {
        switch (this.config.thinking_mode) {
            case 'thinking_disabled':
                return { thinking: { type: 'disabled' } };
            case 'chat_template_kwargs':
                return { chat_template_kwargs: { enable_thinking: false } };
            case 'reasoning_effort_minimal':
                return { reasoning_effort: 'minimal' };
            default:
                return {};
        }
    }

    #captureReasoning(text) {
        if (!text) return;
        this.lastReasoning += text;
        this.config.on_reasoning?.(text);
    }

    async callLLM(prompt, streamCallback = null) {
        if (!prompt) {
            throw new Error("输入内容不能为空");
        }

        if (!this.config.api_url || !this.config.api_key || !this.config.model_name) {
            throw new Error("API配置不完整");
        }

        let messages;
        if (Array.isArray(prompt)) {
            // 如果 prompt 是数组，直接作为 messages
            messages = prompt;
        } else if (typeof prompt === 'string') {
            // 如果 prompt 是字符串，保持旧逻辑
            if (prompt.trim().length < 2) throw new Error("输入文本太短");
            messages = [
                { role: 'system', content: this.config.system_prompt },
                { role: 'user', content: prompt }
            ];
        } else {
            throw new Error("无效的输入类型，只接受字符串或消息数组");
        }

        this.config.stream = streamCallback !== null;

        let apiEndpoint = this.config.api_url;
        if (!apiEndpoint.endsWith("/chat/completions")) {
            apiEndpoint += "/chat/completions";
        }

        const headers = {
            'Authorization': `Bearer ${this.config.api_key}`,
            'Content-Type': 'application/json'
        };

        const data = {
            model: this.config.model_name,
            messages: messages,
            temperature: this.config.temperature,
            max_tokens: this.config.max_tokens,
            stream: this.config.stream,
            ...this.#getThinkingFields()
        };

        try {
            if (this.config.stream) {
                if (!streamCallback || typeof streamCallback !== 'function') {
                    throw new Error("流式模式下必须提供有效的streamCallback函数");
                }
                return await this.#handleStreamResponse(apiEndpoint, headers, data, streamCallback);
            } else {
                return await this.#handleRegularResponse(apiEndpoint, headers, data);
            }
        } catch (error) {
            console.error("直接调用 LLM API 错误:", error);
            throw error;
        }
    }

    async #handleRegularResponse(apiEndpoint, headers, data) {
        const response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(data)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API请求失败: ${response.status} - ${errorText}`);
        }

        const responseData = await response.json();

        const message = responseData?.choices?.[0]?.message;
        // 部分提供商（DeepSeek-R1、Qwen-thinking、Kimi 等）把思考内容放在 reasoning_content，
        // 正文可能为空（思考用完 token 的情况），此时仍要把思考带回去展示，不能直接判定为结构无效。
        const reasoning = message?.reasoning_content ?? message?.reasoning ?? '';
        this.#captureReasoning(reasoning);

        if (!responseData.choices || responseData.choices.length === 0 ||
            !message || (!message.content && !reasoning)) {
            throw new Error("API返回无效的响应结构");
        }

        let translatedText = message.content || '';
        return this.#cleanResponse(translatedText);
    }

    async #handleStreamResponse(apiEndpoint, headers, data, streamCallback) {
        const response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(data)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API请求失败: ${response.status} - ${errorText}`);
        }

        if (!response.body) {
            throw new Error("无法获取响应流");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let fullResponse = '';
        let chunkIndex = 0; // Add chunk index for logging

        try {
            console.log('[Stream] Starting stream processing for custom API...'); // Log stream start
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    console.log('[Stream] Custom API stream finished (done=true).'); // Log stream end
                    break;
                }

                const decodedChunk = decoder.decode(value, { stream: true });
                buffer += decodedChunk;
                chunkIndex++;
                console.log(`[Stream] Custom API received chunk ${chunkIndex}. Buffer length: ${buffer.length}`); // Log received chunk and buffer size

                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // Keep potential incomplete line in buffer

                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (trimmedLine === '') continue;
                    console.log(`[Stream] Custom API processing line: "${trimmedLine}"`); // Log processed line

                    try {
                        if (trimmedLine.startsWith('data: ')) {
                            const dataStr = trimmedLine.substring(6).trim();
                            if (dataStr === '[DONE]') {
                                console.log('[Stream] Custom API received [DONE] marker.'); // Log DONE marker
                                continue; // Skip further processing for this line
                            }

                            const jsonData = JSON.parse(dataStr);
                            // Optional: Log parsed structure if needed for deep debugging
                            // console.log('[Stream] Custom API parsed JSON:', JSON.stringify(jsonData));

                            const delta = jsonData.choices?.[0]?.delta;
                            this.#captureReasoning(delta?.reasoning_content ?? delta?.reasoning ?? '');
                            if (delta?.content) {
                                const content = delta.content;
                                fullResponse += content;
                                // console.log(`[Stream] Custom API extracted content: "${content}"`); // Log extracted content if needed
                                streamCallback(content); // Pass content to the callback
                            } else {
                                // console.log('[Stream] Custom API line parsed, but no content found in delta.');
                            }
                        } else {
                             console.log('[Stream] Custom API line does not start with "data: ". Skipping.');
                        }
                    } catch (e) {
                        console.warn("[Stream] Custom API error parsing line JSON:", e, "Line:", trimmedLine); // Log parsing errors
                    }
                }
                 // Optional: Log buffer state after processing lines
                 // console.log(`[Stream] Custom API buffer after processing lines (potential incomplete line): "${buffer}"`);
            }

            // Process any remaining data in the buffer after the loop finishes
            const finalBufferTrimmed = buffer.trim();
            if (finalBufferTrimmed) {
                console.log(`[Stream] Custom API processing final buffer content: "${finalBufferTrimmed}"`); // Log final buffer processing
                try {
                    // Attempt to handle potential JSON object directly in buffer (less common for SSE)
                    if (finalBufferTrimmed.startsWith('data: ')) {
                         const dataStr = finalBufferTrimmed.substring(6).trim();
                         if (dataStr !== '[DONE]') {
                            const jsonData = JSON.parse(dataStr);
                             // Optional: Log parsed structure if needed
                             // console.log('[Stream] Custom API parsed final buffer JSON:', JSON.stringify(jsonData));
                            const delta = jsonData.choices?.[0]?.delta;
                            this.#captureReasoning(delta?.reasoning_content ?? delta?.reasoning ?? '');
                            if (delta?.content) {
                                const content = delta.content;
                                fullResponse += content;
                                // console.log(`[Stream] Custom API extracted final buffer content: "${content}"`);
                                streamCallback(content);
                            }
                         }
                    } else {
                         // Maybe it's a non-SSE JSON object? Or just leftover text.
                         console.warn("[Stream] Custom API final buffer content does not start with 'data: '. Attempting direct parse (if applicable) or ignoring.");
                         // Example: try parsing directly if expecting a single JSON object
                         // const jsonData = JSON.parse(buffer);
                         // ... handle jsonData ...
                    }
                } catch (e) {
                    console.warn("[Stream] Custom API error processing final buffer content:", e);
                }
            }

            console.log('[Stream] Custom API stream processing complete. Full response length:', fullResponse.length); // Log final length
            return this.#cleanResponse(fullResponse);
        } catch (streamError) {
            console.error('[Stream] Custom API error during stream reading:', streamError); // Log errors during read()
            throw streamError; // Re-throw the error
        } finally {
            console.log('[Stream] Custom API releasing stream lock.'); // Log lock release
            reader.releaseLock();
        }
    }

    #cleanResponse(text) {
        // 清理响应文本，移除可能的前缀或后缀
        return text.trim();
    }

    async testConnection() {
        const testPrompt = "Say hello.";
        const messages = [
            { role: 'system', content: this.config.system_prompt },
            { role: 'user', content: testPrompt }
        ];

        let apiEndpoint = this.config.api_url;
        if (!apiEndpoint.endsWith("/chat/completions")) {
            apiEndpoint += "/chat/completions";
        }

        const headers = {
            'Authorization': `Bearer ${this.config.api_key}`,
            'Content-Type': 'application/json'
        };

        const data = {
            model: this.config.model_name,
            messages: messages,
            temperature: this.config.temperature,
            max_tokens: 50, // 测试连接不需要太多 token
            stream: false,
            ...this.#getThinkingFields()
        };

        try {
            const response = await fetch(apiEndpoint, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(data)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API测试请求失败: ${response.status} - ${errorText}`);
            }

            const responseData = await response.json();
            const testMessage = responseData?.choices?.[0]?.message;
            // 思考型模型在 50 token 预算下可能只回 reasoning_content 而没有正文，
            // 这同样说明连通了，不应判定为无效响应。
            const testReasoning = testMessage?.reasoning_content ?? testMessage?.reasoning ?? '';
            // 检查响应是否有效
            if (!responseData.choices || responseData.choices.length === 0 || !testMessage || (!testMessage.content && !testReasoning)) {
                throw new Error("API测试返回无效的响应结构");
            }
            return testMessage.content || '[仅有思考内容，测试通过]'; // 返回响应内容表示成功
        } catch (error) {
            console.error("直接 fetch 测试 API 连接错误:", error);
            throw error;
        }
    }
}

export default LLMApiService;
