# 客户端协议

三个接口共用国内自部署模型筛选、上游鉴权、超时、取消和单请求并发限制。模型名称请从 `/v1/models` 获取；协议兼容不会添加 Claude、GPT 等国外模型别名。

| 接口 | 鉴权 | 文本 | 工具 | 流结束 |
|---|---|---|---|---|
| POST /v1/chat/completions | Bearer API_KEY | messages | function/tool_calls | [DONE] |
| POST /v1/responses | Bearer API_KEY | input、instructions | function/custom/namespace 与对应 call output | response.completed 或 response.incomplete |
| POST /v1/messages | x-api-key 或 Bearer | messages、system | tool_use/tool_result | message_stop |

Responses 示例请求：`{"model":"qwen-instruct","input":"你好","store":false,"stream":true}`。

Messages 示例请求：`{"model":"qwen-instruct","messages":[{"role":"user","content":"你好"}],"max_tokens":512,"stream":true}`。

Responses 为无状态适配，不存储聊天记录。下一轮传入完整 input 历史，包括前一轮 output 的 function_call 和对应 function_call_output。`store:true`、`previous_response_id` 会返回 400。

普通文本在上游生成时逐块转发。工具声明通过提示词注入，上游完整回复解析成功后才产生工具事件；代理不会执行工具。Responses 支持 function、自由文本 custom、Codex namespace 展平和 allowed_tools 选择，并映射 `custom_tool_call` 的 input 增量/完成事件及历史结果。custom grammar 定义会加入提示词，但学校上游没有原生 CFG 约束。流中断返回 error 事件，不补发成功完成事件。上游明确返回 length 时，Responses 使用 incomplete，Messages 使用 max_tokens。

上游提供 usage 时使用其计数；缺失时 Responses/Messages 采用 UTF-8 字节数除以 3 的粗略估算，不能作为计费或上下文预算依据。非流式响应通过 X-Usage-Source 标记 upstream 或 estimate；Messages 的 message_start 输入用量为估算，结束事件输出用量优先采用上游值。

支持文本、function 工具和上游返回的推理摘要。Responses 将 `reasoning_content` 映射为 reasoning item 及 summary 流事件；Messages 映射为 thinking 内容块。历史中的 reasoning summary/thinking 块会作为带标记的 assistant 摘要送回上游。空 `signature` 只是协议兼容占位，不是 Anthropic 签名；请求中的推理强度不会传给学校上游。

支持 Chat `response_format`、Responses `text.format` 和 Messages `output_config.format` 的 `json_object` / `json_schema`。实现方式是注入格式提示并在本地解析、验证常用 JSON Schema 约束；由于学校上游没有已确认的约束解码，这不保证模型首次生成就合规。流式请求会缓冲到验证成功后再输出，失败返回错误且不发送成功结束事件。未知 schema 关键字和外部 `$ref` 会被拒绝。

图片、音频、内置搜索工具以及有状态 Responses 尚未支持。参考项目的图片透传仅用于 Azure 模型；国内自部署 xinference 模型缺少可复核的视觉入口，因此本项目继续明确拒绝图片输入。未实现的请求参数返回 400；不伪装为已执行。max_tokens 传给学校接口，尚未证明上游严格执行该限制。

2026-09-13 已通过学校 Qwen 验证三个协议的文本 JSON/SSE 和 echo 工具往返。可运行 `node --env-file=.env live-verify.mjs --cas` 复测；脚本会登录学校并发送 12 个测试请求，使用账号额度。该结果不代表任意工具、模型或客户端均已验证。工具提示使用普通 `<api_tool_call>` 文本标签；真实测试中 Qwen 对原 `<tool_call>` 提示返回空正文，故不再以该标签引导生成。

事件格式参考 [OpenAI Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events) 和 [Anthropic streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming)。本地测试验证协议转换，不代表官方 SDK 或所有客户端均已实测。
