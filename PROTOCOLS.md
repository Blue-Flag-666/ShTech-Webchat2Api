# 客户端协议

三个接口共用国内自部署模型筛选、上游鉴权、超时、取消和单请求并发限制。模型名称请从 `/v1/models` 获取；协议兼容不会添加 Claude、GPT 等国外模型别名。

| 接口 | 鉴权 | 文本 | 工具 | 流结束 |
|---|---|---|---|---|
| POST /v1/chat/completions | Bearer API_KEY | messages | function/tool_calls | [DONE] |
| POST /v1/responses | Bearer API_KEY | input、instructions | function_call/function_call_output | response.completed 或 response.incomplete |
| POST /v1/messages | x-api-key 或 Bearer | messages、system | tool_use/tool_result | message_stop |

Responses 示例请求：`{"model":"qwen-instruct","input":"你好","store":false,"stream":true}`。

Messages 示例请求：`{"model":"qwen-instruct","messages":[{"role":"user","content":"你好"}],"max_tokens":512,"stream":true}`。

Responses 为无状态适配，不存储聊天记录。下一轮传入完整 input 历史，包括前一轮 output 的 function_call 和对应 function_call_output。`store:true`、`previous_response_id` 会返回 400。

普通文本在上游生成时逐块转发。工具声明通过提示词注入，上游完整回复解析成功后才产生工具事件；代理不会执行工具。流中断返回 error 事件，不补发成功完成事件。上游明确返回 length 时，Responses 使用 incomplete，Messages 使用 max_tokens。

上游提供 usage 时使用其计数；缺失时 Responses/Messages 采用 UTF-8 字节数除以 3 的粗略估算，不能作为计费或上下文预算依据。非流式响应通过 X-Usage-Source 标记 upstream 或 estimate；Messages 的 message_start 输入用量为估算，结束事件输出用量优先采用上游值。

目前仅支持文本和 function 工具。图片、音频、内置搜索工具、JSON Schema 强制输出、独立推理内容块以及有状态 Responses 尚未支持。未实现的请求参数返回 400；不伪装为已执行。max_tokens 传给学校接口，尚未证明上游严格执行该限制。工具调用质量需要真实模型验证。

事件格式参考 [OpenAI Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events) 和 [Anthropic streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming)。本地测试验证协议转换，不代表官方 SDK 或所有客户端均已实测。
