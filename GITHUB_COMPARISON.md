# GitHub 同类项目比较

参考项目检索日期：2026-09-12；本项目状态更新：2026-09-13。重点比较直接访问 `genai.shanghaitech.edu.cn/htk` 的项目。以下参考项目描述是源码/文档观察，不等于全部真实调用验证。

## 直接相关项目

| 项目 | 形态与接口 | 鉴权 | 主要能力 | 与当前项目的差异 |
|---|---|---|---|---|
| [ShanghaitechGeekPie/GenAI2OpenAI](https://github.com/ShanghaitechGeekPie/GenAI2OpenAI) | Flask；OpenAI Chat Completions | JWT 或学号密码 | 原始基线；流式/非流式、模型列表、基础 OpenAI 兼容 | 当前项目的上游请求验证和最小实现更小；该项目模型和协议覆盖更广，但 README 自称维护动力较低 |
| [HeZeBang/GenAI2OpenAI](https://github.com/HeZeBang/GenAI2OpenAI) | Flask；`/v1/chat/completions`、`/v1/responses`、`/v1/messages` | JWT 或 CAS 自动登录/刷新 | 多模型适配、推理字段、图片、工具调用、Responses、Docker、动态模型列表 | 功能最完整，适合借鉴模型注册、token 刷新和多协议设计；复杂度和上游假设也最高 |
| [cmjang/shanghaitech-genai2api](https://github.com/cmjang/shanghaitech-genai2api) | Python/uv；OpenAI + Anthropic | JWT 或学号密码 | Claude Code 适配、自动刷新、工具调用提示词转换、动态模型 | 可参考 Claude Code 和凭证登录设计；当前项目也已实现 Messages 和自动登录 |
| [jollyxenon/shanghaitech-genai2api](https://github.com/jollyxenon/shanghaitech-genai2api) | Python/pixi；OpenAI Chat、Responses + Anthropic Messages | JWT 或 CAS | 面向 Claude Code 和 Codex；Responses 支持 `function_call`、`custom_tool_call`、reasoning 事件；自动刷新、动态模型列表、上下文探测和速度基准 | 比 cmjang 的公开说明更明确地补齐 Codex Responses；代价是 Responses 只做兼容子集、无服务端 response storage、工具调用依赖 prompt 注入和文本解析 |
| [Rainy-14b/GenAI2Codex](https://github.com/Rainy-14b/GenAI2Codex) | Python/uv；重点兼容 OpenAI Responses | JWT | Codex 配置、Responses、模型适配、字符修正 | 可参考 Codex 专项适配；当前项目也已有无状态 Responses 文本和 function 工具接口 |

## 当前项目的实际位置

当前项目是一个 Node.js 22、零第三方依赖的本地小型代理，已经真实验证：

- `POST /v1/chat/completions` 的流式和非流式调用。
- 上游 `POST /htk/chat/start/chat` 的 SSE 解析，包括中文跨 UTF-8 分块、CR/LF/CRLF、多行 data 和 `[DONE]`。
- 本地 Bearer API key、请求大小限制、单请求并发限制、客户端断开取消、超时和错误事件。
- 学校上游不规范 CSP 响应头的兼容处理；固定上游、TLS 校验保持开启、不跟随重定向。

2026-09-13 已进一步真实验证 CAS/OAuth 自动登录、国内自部署模型目录，以及三个协议的文本 JSON/SSE 和 function 工具往返。Chat 可保留 reasoning_content。Windows/Linux CI 与 amd64/arm64 镜像测试通过，GHCR 已发布且可匿名读取 manifest。仍缺少图片、Responses/Messages 独立推理块、custom tools 和广泛客户端实测；不能宣称比参考项目完整。

## 值得吸收的设计

1. **token 管理**：已实现账号密码登录、JWT 过期刷新、HTTP/SSE 登录失效时最多一次重试。支持本地忽略提交的 .env 与 `_FILE` secrets；刷新 token 只保留在内存。
2. **动态模型列表**：已读取真实目录，仅保留国内家族且 rootAiType 为 xinference 的记录；首次目录失败返回空列表，已确认目录可短暂缓存。
3. **SSE 失败处理**：已识别首帧登录失效并在输出前重试，截断流返回错误；输出后不重试。业务错误和不同模型的非标准字段仍需持续兼容。
4. **协议扩展**：如果目标是 Codex，优先参考 GenAI2Codex 的 Responses 接口；如果目标是 Claude Code，优先参考 cmjang/HeZeBang 的 Anthropic Messages 转换。两者都不应在没有真实回归测试前直接合并。
5. **测试隔离**：HeZeBang 的测试把本地 mock、上游 transport 和显式 live 测试分开。当前项目已有 mock 端到端测试和真实 `verify.mjs`，可以沿用这个边界。

## jollyxenon 项目的特别比较

jollyxenon 不是只增加一个别名：它把三个协议放在同一个代理里，并针对 Codex 的 `wire_api = "responses"` 做了事件级适配。README 明确列出 `function_call`、`custom_tool_call`、reasoning summary 事件，以及客户端每轮发送完整历史的无状态模式；同时还提供 CAS 登录、动态模型列表、上下文上限探测和速度基准工具。[项目 README](https://raw.githubusercontent.com/jollyxenon/shanghaitech-genai2api/main/README.md)

源码还显示它会从 `/htk/ai/aiModel/list` 缓存模型，读取 `aiType`、`rootAiType` 和 `maxToken`，并实现了与上海科技大学 CAS 登录页配套的 AES-CBC 密码加密登录流程。[config.py](https://github.com/jollyxenon/shanghaitech-genai2api/blob/main/config.py)、[cas_login.py](https://github.com/jollyxenon/shanghaitech-genai2api/blob/main/auth/cas_login.py)

它的限制同样需要保留在比较中：Responses 不支持 `previous_response_id` 或服务端存储；工具调用是提示词注入加文本解析；usage 是本地估算；`reasoning_effort` 等参数会被接受但忽略。也就是说，它比当前项目覆盖面大，但不是上游原生 OpenAI/Anthropic 协议，不能把“接口存在”理解成完整语义兼容。

## 结论

本项目的重点是零第三方运行依赖、国内自部署模型筛选、可复测的真实登录与三协议工具往返，以及双架构 GHCR 发布。参考项目在特定客户端、图片、推理和自定义工具方面仍有值得吸收的实现。具体支持边界以 [PROTOCOLS.md](PROTOCOLS.md) 和 [DEPLOYMENT.md](DEPLOYMENT.md) 为准。

## 来源与可复核证据

- [GenAI2OpenAI 原始 README](https://raw.githubusercontent.com/ShanghaitechGeekPie/GenAI2OpenAI/main/README.md)：OpenAI 兼容、流式/非流式和项目基线。
- [HeZeBang README](https://raw.githubusercontent.com/HeZeBang/GenAI2OpenAI/main/README.md)：Responses、Anthropic、工具调用、图片、自动刷新和动态模型列表。
- [HeZeBang provider/genai.py](https://github.com/HeZeBang/GenAI2OpenAI/blob/main/provider/genai.py)：SSE、token 失效检测、重试和 usage 处理。
- [cmjang README](https://raw.githubusercontent.com/cmjang/shanghaitech-genai2api/main/README.md)：Claude Code、JWT/CAS 两种模式和自动刷新。
- [Rainy-14b/GenAI2Codex README](https://raw.githubusercontent.com/Rainy-14b/GenAI2Codex/main/README.md)：Codex 的 Responses 配置和模型适配方向。
- [jollyxenon/shanghaitech-genai2api README](https://raw.githubusercontent.com/jollyxenon/shanghaitech-genai2api/main/README.md)：三协议、Codex 事件、CAS 刷新、模型缓存和已知限制。
- [jollyxenon config.py](https://github.com/jollyxenon/shanghaitech-genai2api/blob/main/config.py)：模型列表接口和模型元数据字段。
- [jollyxenon CAS 登录](https://github.com/jollyxenon/shanghaitech-genai2api/blob/main/auth/cas_login.py)：统一身份认证登录流程。
- [GitHub API 仓库元数据](https://api.github.com/repos/HeZeBang/GenAI2OpenAI)：星标、fork、许可证和最新提交可复核。
