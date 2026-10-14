/**
 * 默认设置
 * @description 这里的键就是 USER.store（extension_settings.stLorebookDecision）里的键。
 * @description 缺键会让读的地方拿到 undefined，所以新增设置必须在这儿补一条。
 * @description 只 import decisionApiService 那几句默认文案：那个 service 自己不 import 任何东西，
 * @description 所以不会绕成循环依赖（内置分类表就不能这么写，decisionEntryIndex 会反过来 import manager）。
 */
import { DEFAULT_BASIS_SYSTEM_PROMPT, DEFAULT_BASIS_TEMPLATE, DEFAULT_DECISION_TASK_BRIEFING } from '../services/decisionApiService.js';

export const defaultSettings = {
    // ---- 摘要与建索引那两趟用的独立 API ----
    // 密钥不在这里，在 extension_settings.stLorebookDecisionPrivacy：custom_api_url / custom_api_key / custom_model_name
    // 自定义 API 温度
    custom_temperature: 1.0,
    // 自定义 API 的输出 token 上限。不传 max_tokens 时接口层会按很大的默认值发，
    // 在输出窗口较小的模型上会直接报 API 错误。
    custom_max_tokens: 4096,
    // 思考模式：default=不改动请求体；thinking_disabled=thinking{type:disabled}；
    // chat_template_kwargs=关 Qwen 类思考；reasoning_effort_minimal=GPT-5/o 系列少想
    custom_thinking_mode: 'default',
    // 自定义独立 API 预设集合：{ [预设名]: { name, custom_api_url, ... } }
    custom_api_presets: {},
    // 当前正在使用的预设名，空字符串表示未使用
    active_custom_api_preset: '',
    // ---- 决策模型接管世界书（阿里云百炼 System One）----
    // 总开关，默认关闭：没验过自己世界书分布之前不要开
    decision_router_enabled: false,
    // 完整接口地址（填到 /compatible-mode/v1 即可，代码会自动补 /systemone）
    decision_api_url: '',
    decision_model: 'decision-model-preview',
    // 走 ST 自带的 /proxy 同源转发。该端点不返回 CORS 头，浏览器直连必失败，
    // 只有在你自己配了允许跨域的转发时才需要关掉
    decision_use_proxy: true,
    // 概率 ≥ 强推阈值 → 关键词没命中也强制激活
    decision_force_threshold: 0.85,
    // 概率 ≤ 压制阈值 → 关键词命中了也压制。默认关闭，先只记录「本会被压制」的清单
    decision_suppress_enabled: false,
    decision_suppress_threshold: 0.25,
    // 勾选后被决策模型判过的条目不再靠关键词命中注入，只有概率 ≥ 强推阈值才进提示词。
    // 默认关闭 = 中间带仍交回关键词规则。没拿到判定的条目（超出候选上限、模型无返回）不受影响。
    decision_block_keyword: false,
    // 一次最多问多少个条目，超出部分不判（保持关键词原样）
    decision_max_candidates: 60,
    // ---- 本轮注入名额上限 ----
    // 「候选上限」管问多少条，这两个管判出来以后实际塞进去多少条。
    // 概率够高的条目按从高到低排，取到这两个线为止；0 = 不限（默认，等于没这个功能）。
    // 被名额挤掉的条目不是「判成不相关」：关着「关闭关键词触发注入」时它照旧走关键词规则，
    // 开着那颗时它这一轮不注入。自己在弹窗里手动挑的那批不受这两个数管。
    decision_inject_max_entries: 0,
    decision_inject_max_chars: 0,
    // 单次请求塞多少个条目。接口有硬上限 16 条，超过会返回 400
    // （questions: N exceeds the limit of 16），所以这个数不会再往上走，只会因为分轮而变多请求
    decision_batch_size: 16,
    // 待判条目超过单批上限时，是否分多轮问完（分轮之间并发，所以不会一轮一轮地累加等待）
    decision_multi_round: false,
    // 分轮时同时发几路。接口侧并发 8 路实测不限流，瓶颈是浏览器对同一来源只有 6 个连接
    // （插件走 ST 的 /proxy），留 2 个给正常收发，所以最多 4。填 1 = 退回逐轮串行
    decision_in_flight: 4,
    // 每个条目摘要里带多少字的正文
    decision_digest_limit: 120,
    // 拼进 state 的最近消息条数（不含输入框里本次正要发的那句）
    decision_context_messages: 4,
    // 每条消息（含正在输入的那句）拼进 state 的字数上限，控制上传内容与 token 量
    decision_context_chars: 600,
    // 末尾几条整段带过去、不截字数。默认 1＝最新那条（通常是 AI 回复的结尾，也就是此刻的处境）保留完整，
    // 更早的只当背景、按上面的字数截头。填 0 退回「每条都截」的老行为。
    decision_context_full_messages: 1,
    // ---- 决策依据从哪儿来 ----
    // chat = 直接拼最近几楼正文；summary = 每轮生成结束后另发一次 LLM 请求，把新剧情并进一份滚动摘要，
    // 下一轮决策只送这份摘要。正文里的露骨描写会让决策模型整批拒答（实测 DataInspectionFailed），
    // 摘要档就是为这个准备的常用解法；chat 档被拒答时弹窗里还能临时摘要一次救场。
    // 默认关着：开了等于每轮多花一次 LLM 请求，必须用户自己点。
    decision_basis_mode: 'chat',
    // 摘要那趟请求走哪个模型：勾 = 主 API（写正文的那个），不勾 = 插件的自定义 API
    // 页面上和下面索引那颗并成了一颗（第 ④ 类顶上），一次写这两个键；读点仍是各看各的
    decision_basis_use_main_api: true,
    // 摘要总长上限（字），也是每次塞进决策请求的量
    decision_basis_char_limit: 800,
    // 摘要器的系统提示词（整框清空退回默认）
    decision_basis_system_prompt: DEFAULT_BASIS_SYSTEM_PROMPT,
    // 摘要器的人话提示词：{old} 已有摘要、{new} 本轮新增剧情、{limit} 字数上限
    decision_basis_template: DEFAULT_BASIS_TEMPLATE,
    // ---- 决策时机 ----
    // every_round = 每轮都判；every_n = 每 n 轮判一次，中间那几轮复用判定；
    // manual = 自主启动，只有点了聊天页那颗「本轮进行决策」的下一次生成才问模型。
    decision_timing_mode: 'every_round',
    // 「每 n 轮」的 n。生效的复用轮数会自动抬到不小于它（设置页显示的是生效值，存的用户填的那个数不动）。
    decision_every_n_rounds: 2,
    // 工作认知：拼在每次决策请求依据最前面那段任务说明，设置页里直接摊开可改。
    // 整段清空就是不要这段（跟「正在输入那句的标注」同一个口径），框旁边那颗返回箭头回到默认。
    decision_task_briefing: DEFAULT_DECISION_TASK_BRIEFING,
    // 判定问法模板：每个条目会变成一个问题，模板决定模型在判断什么。
    // 占位符 {digest} 条目摘要、{label} 标题、{keys} 关键词、{content} 正文片段。
    // 留空回到默认问法；写了但一个占位符都没用会自动补 {digest}，
    // 否则所有条目问的是同一句话、分数全都一样，决策就没有意义了。
    decision_instruction_template: '本段剧情是否涉及以下条目所描述的人物、地点、道具或事件？条目：{digest}',
    // 拼在 state 第一行的固定背景（渲染成「当前场景：xxx」），留空则不拼
    decision_state_note: '',
    // 最后那句「正要发送但还没进聊天记录」的输入后面的标注，整段清空就是不要标注
    decision_pending_note: '（这句正要发出，尚未写入记录）',
    decision_timeout_ms: 15000,
    // 判定成功后连着几轮不再问模型（直接复用那份判定，一个请求都不发）。0 = 每轮都问。
    // 复用键只由「这轮问了什么」决定，条目正文/索引摘要/判定问法一变就当场作废重问。
    decision_reuse_rounds: 0,
    // 勾选后失败不再弹窗询问，直接按原关键词注入
    decision_fail_silent: false,
    // 勾选后每轮决策跑完自动弹一次报告（不挡生成）；不勾就看聊天页那条「决策结果」小栏自己点
    decision_auto_popup: false,
    /**
     * ---- 条目摘要索引（先让 LLM 把条目读一遍，决策只看短摘要 + 按分类问）----
     * 默认开着：这一份是索引档为主、条目原文为补充的口径。
     * 没建过索引的条目自动落回原文片段 + 通用问法，所以开着也不会因为索引是空的就判不出来；
     * 但要真正用上摘要和分类问法，还是得去工作台里填一遍索引（那一步发请求、消耗 token）。
     * 分类表故意留空数组：空 = 用 decisionEntryIndex.js 里的内置分类。
     * 这里不能 import 那份默认值（pluginSetting ← core/manager ← 运行时模块会成环），
     * 所以内置分类只在那一个模块里写一次。
     */
    decision_index_enabled: true,
    decision_entry_types: [],
    decision_entry_index: {},
    // 上次建索引的时间戳，只用来进缓存键（重建之后不许复用旧摘要判出来的结果）
    decision_index_at: 0,
    // 索引里每条摘要存多少字，也是决策请求里那条摘要的实际长度上限
    decision_index_summary_limit: 60,
    // 建索引时一条正文最多读多少字（超过就截断，并在失败清单里点名）
    decision_index_content_limit: 1200,
    // ---- 建索引那趟一次送多少 ----
    // 真正的打包依据是字数：按累计「标题＋关键词＋正文（读正文上限截过）」切批，谁先到算谁。
    // 条目长短差几十倍，只按条数切的话，短条目浪费请求、长条目一批塞几万字。
    decision_index_batch_chars: 6000,
    // 第二道硬顶：一批最多几条。失败是整批记账的（请求挂了或整批没按 JSON 行回，这一批全记失败），
    // 所以字数那颗填得再大也不许一批牵连几十条。代码里再夹一层 50。
    decision_index_batch_size: 20,
    // 让 LLM 摘要走主 API 还是自定义独立 API（跟上面那套自定义 API 是同一份配置）
    decision_index_use_main_api: true,
    // 让 LLM 摘要那趟的提示词，留空用内置默认
    decision_index_system_prompt: '',
    decision_index_template: '',
};
