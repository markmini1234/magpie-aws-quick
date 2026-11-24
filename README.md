# 欢迎交流 https://x.com/dahaozi130
# magpie-quick-auth

把 AWS Quick（`quick.aws.com`）接进 Magpie，provider id 为 `quick`。一个插件，两条通道：

| 通道 | 模型 | 能力 | 登录方式 |
|---|---|---|---|
| **桌面 agent 通道**（WS） | `quick/fast` `quick/balanced` `quick/smart` `quick/advanced` | 完整 agent：账号记忆、工具调用、`thinking_effort`，实测 `smart` 服务端给 `us.anthropic.claude-opus-5-5`、1M 上下文 | 浏览器 OIDC（无需桌面端）/ 本地凭据 |
| **网页轻量通道**（HTTP） | `quick/web-auto` `quick/web-fast` `quick/web-smart` `quick/web-advanced` | 轻量推理：无记忆/工具，更快更省，Cookie 轮换自动保持 | 浏览器抓 Cookie / 粘贴 Cookie |

## 桌面 agent 通道（推荐）

走桌面客户端的 `quickwork-chat-bidirectional-stream` WebSocket，不是网页端那条被限流的 `SpaceNeedleConversationService`。

**模型**：`agent_mode` 选层，服务端自己路由。实测 `smart` → `us.anthropic.claude-opus-5-5`，`fast` → `us.anthropic.claude-haiku-5-5`。`advanced` 可能归一化到 `smart`。

**登录**（`magpie login quick`）：

- **账号登录（浏览器 OAuth，无需桌面端）**：重放桌面 App 的 OIDC+PKCE，存 `~/Library/Application Support/magpie-aws-quick/oauth-sessions.json`，`refresh_token` 自动轮换，无需桌面 App。
- **复制登录地址**：同一流程，给另一台机器的浏览器用（第一次存 discovery，15 分钟内第二次完成）。
- **本地凭据（桌面端登录态）**：Windows 读 Credential Manager；其他平台拉起 `quickwork-agent --outpost-only` 复用 App 登录态。

**能力**：

- 会话续接：增量哈希链 + 模糊锚点 + 网关 session key，跨进程持久化（`thread-sessions.json`，只存哈希不存内容）
- 工具调用：OpenAI `tools` 经 `<tool_call>` 文本约定桥接，`tool_choice:'required'` 已验证稳定
- 图片附件：小图内联、大图走 Quick 云附件流
- `X-Magpie-Effort` → `thinking_effort`（off/low/medium/high/max）
- 中断、`stop_generation` 尾事件、idle 看门狗、`continuation_expected` 多步轮次都已处理

## 网页轻量通道

走网页端 `POST /conversations/chat`，Cookie + 页面 CSRF。无记忆/工具，但更快，适合简单问答或当 agent 通道不可用时的降级。

**登录**：浏览器抓 Cookie（专用 Chrome 配置窗口）或粘贴 Cookie。Quick 每次响应都轮换 `JSESSIONID`，插件会把 `Set-Cookie` 写回 Magpie 的登录信息，所以不会"登录成功几秒后过期"。

**上限**：`userMessage` 正好 50,000 字符也会被拒，插件按 49,999 裁剪并尽量续接同一会话。

## 多账号

不限单账号。每登录一次新增一个 Quick 账号，Magpie 在账号间分摊请求：过期（401）或额度用完（429）的账号休息，请求转给下一个。`magpie plugin login quick` 每执行一次登录一个。

## 用量卡片

账号卡片显示 `Quick Lite (free trial)` 等计划和 agent hours 用量，到期时间，按账号隔离。

## 说明

桌面 agent 通道基于 [magpie-aws-quick](https://github.com/httpdone/magpie-aws-quick)（httpdone）的协议实现（MIT），整合了本插件原有的网页通道、多账号路由和 Cookie 轮换。Quick 无公开 API，两条通道都驱动其内部协议，接口可能随 Quick 更新变化。请只在你自己的账号和使用条款允许范围内使用。
