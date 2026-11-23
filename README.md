# magpie-quick-auth

把 AWS Quick（`quick.aws.com`）的聊天模型接进 Magpie，provider id 为 `quick`。

## 它走哪条路

Quick 网页端不直接调 `quicksight.<region>.amazonaws.com`，而是走自己的代理：

```
POST https://quick.aws.com/sn/account/<alias>/qbsproxy/quicksight/accounts/<alias>/conversations/chat
```

认证是两样东西：

- 浏览器里 Quick 会话的 **Cookie**（`JSESSIONID` 等）
- 页面里的 **CSRF 令牌**（`csrf` / `mbtc`）

返回的是 AWS event-stream，事件体是 JSON（`textMessageEvent`、`metadataEvent`）。插件把它转换成 OpenAI Chat Completions，所以 Magpie 可以直接用。

**不需要 AWS 的 `aws-creds`，也不需要 IAM / SigV4。** 早期版本试图用 AWS 临时凭证签名，那是错的。

## 模型

| Magpie 模型 | Quick 模式 |
|---|---|
| `quick/auto` | 不指定，由 Quick 自己选 |
| `quick/fast` | Fast |
| `quick/smart` | Smart |
| `quick/advanced` | Advanced |

Quick 只接受 `FAST` / `SMART` / `ADVANCED` 三个值，没有 `BALANCED`。

## 安装

```sh
/Applications/magpie.app/Contents/MacOS/magpie plugin add /path/to/magpie-quick-auth
```

或者从 GitHub：

```sh
git clone https://github.com/markmini1234/magpie-aws-quick.git
/Applications/magpie.app/Contents/MacOS/magpie plugin add ./magpie-aws-quick
```

## 登录

### 方式一：浏览器（推荐）

选择 **AWS Quick (browser)**。插件会打开一个专用的 Chrome/Edge 配置窗口，你在里面登录 Quick；登录完成后插件通过 DevTools 读取 Cookie，窗口自动关闭。

专用配置在 `~/.config/magpie/quick-browser/`，下次登录通常会自动恢复会话。

### 方式二：粘贴 Cookie

选择 **AWS Quick cookie**：

1. 登录 `https://quick.aws.com/sn`。
2. 开发者工具 → Network，点任意一个发往 `quick.aws.com` 的请求。
3. 复制请求头里的 `Cookie`（或整段 cURL）。
4. Account alias 留空即可：插件会用这个 Cookie 请求 `/sn/start`，让 Quick 自己告诉它账号。

关键字段是 `JSESSIONID`。`qs-directory-alias`、`qs-saved-accounts` 这些不是必须的——它们只在账号页面加载后才出现，从早期请求复制的 Cookie 往往没有，插件不再依赖它们。

登出/过期时会直接报“会话已过期”，不会再把登录页当成模型回复。

## 多账号

插件不再把登录限制成单账号。每登录一次就新增一个 Quick 账号，Magpie 会在这些账号之间分摊请求：

- 某个账号会话过期（401）→ Magpie 标记它并改用下一个
- 某个账号 10 小时额度用完（插件映射成 429）→ 该账号休息，请求转给下一个
- 各账号的 Cookie、账号别名、会话续接缓存、用量都是彼此隔离的

添加账号：

```sh
/Applications/magpie.app/Contents/MacOS/magpie plugin login quick
```

每执行一次登录一个账号；同一个账号重复登录会替换原来的账号，不会堆出重复项。在 Providers → AWS Quick 里可以看到所有账号，也能设置同时使用几个。

## 会话轮换

Quick 在每次响应里都会下发新的 `JSESSIONID`（`/sn/start`、聊天页、聊天接口都是）。插件会把 `Set-Cookie` 应用到当前 Cookie 上：

- 登录校验后保存的是**轮换后**的会话，不是请求时带去的旧会话
- 每次聊天页/聊天接口返回的 Cookie 变化都会写回 Magpie 的登录信息
- 支持多个 `Set-Cookie`、`Max-Age=0` 与 `Expires` 过期删除

不这样做会出现“登录成功、几秒后调用模型却提示会话过期”的现象：服务端已经换掉了旧会话，而插件还存着它。

## 会话过期

Quick 的 Cookie 过期后，插件返回 401 并标记账号需要重新登录。重新登录一次即可。

## 50000 字符上限

Quick 的 `userMessage` 上限是 **50000 字符**，超了会返回：

```
CHAT_MESSAGE_LENGTH_EXCEEDED: Request exceeded chat message limit of 50000 characters
```

插件会先尽量**续接同一个 Quick 会话**：Magpie 每次都会把完整对话发过来，插件用“上次发给 Quick 的对话”做前缀匹配，命中就只发这一轮的新消息，历史由 Quick 保存在服务端——和 Quick 网页端的行为一致，长对话因此不再撞 5 万字符上限。

只有开新会话（首轮、改了系统提示、重新生成）时才会整段发送，这时才按预算裁剪：系统提示优先保留，最新一轮完整保留，旧消息从最早的一条开始丢弃，并在开头标注 `[... earlier messages omitted ...]`。单条超长消息会保留首尾并标注 `[... truncated ...]`。

重新生成（对话内容没变再发一次）会开一个新 Quick 会话，避免同一条消息在旧会话里重复追加。

## 10 小时用量

Quick 免费试用版给的是 **600 分钟（10 小时）agent hours**。插件会读取 Quick 的 metering 接口，在 Magpie 的账号卡片上显示剩余时长，例如：

```
9.93 h left
Agent hours  0.07 / 10 hours
```

用量用完时 Quick 会拒绝请求；插件把这类“配额/时长”错误转换成 **429**，让 Magpie 把请求交给路由组里的下一个 provider，并让这个账号休息一会儿，而不是当成普通 400。

## 说明

Quick 没有公开的模型 API，这个插件使用的是 Quick 网页端自己的对话接口，接口和 Cookie 结构可能随 Quick 更新而变化。请只在你自己的账号和使用条款允许范围内使用。
