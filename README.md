# magpie-quick-auth

把 AWS Quick（`quick.aws.com`）的聊天模型接进 Magpie，作为一个名为 `quick` 的 provider。

## 它走哪条路

Quick 网页端聊天调用的是 SpaceNeedle 的会话服务：

```
POST https://quicksight.<region>.amazonaws.com/accounts/<accountId>/conversations/chat
```

请求用 SigV4（service `quicksight`）签名，返回 `application/vnd.amazon.eventstream`。Quick 登录完成后会在浏览器里留下 `aws-creds` cookie，里面是本会话的临时 AWS 凭证；插件读取它来签名，所以不需要 Quick API key。

插件把 Quick 的三种回答模式映射成 Magpie 模型：

| Magpie 模型 | Quick 模式 |
|---|---|
| `quick/auto` | 不指定，由 Quick 自动路由 |
| `quick/fast` | Fast |
| `quick/smart` | Smart |
| `quick/advanced` | Advanced |

每次 Magpie 请求会作为一条新的 Quick 临时会话发送，`inferenceOnly` 打开，避免 Quick 的 agent/connector 介入；历史消息会拼进 `userMessage`。

## 安装

```sh
/Applications/magpie.app/Contents/MacOS/magpie plugin add /path/to/magpie-quick-auth
```

或者从 GitHub 克隆后安装：

```sh
git clone https://github.com/markmini1234/magpie-aws-quick.git
/Applications/magpie.app/Contents/MacOS/magpie plugin add ./magpie-aws-quick
```

然后在 Magpie 的 Providers 里打开 `AWS Quick`，添加账号。

## 登录

登录选择 **AWS Quick (browser)**：

1. 插件会打开一个专用的 Chrome/Edge 配置窗口，并进入 Quick 登录页。
2. 在窗口里正常登录 `quick.aws.com`。
3. 登录完成后，插件通过 Chrome DevTools 读取 `aws-creds`，窗口自动关闭。
4. Account id 留空即可自动读取；Region 默认 `us-east-1`。

专用浏览器配置保存在 `~/.config/magpie/quick-browser/`，下次登录 Quick 通常会自动恢复会话。
也可以选择 **AWS Quick cookie**，手动粘贴 `Cookie` 或整段 `curl`。

`aws-creds` 是临时凭证，会过期。过期后请求会返回 401，并让 Magpie 标记账号需要重新登录；再点一次登录即可。

## 说明

Quick 没有公开的“模型 API”。这个插件使用的是 Quick 网页端自己的聊天接口，因此接口和 Cookie 格式可能随 Quick 更新而变化。请只在你自己的账号和自己的使用条款允许范围内使用。
