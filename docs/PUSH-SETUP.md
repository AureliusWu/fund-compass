# 司南基金 · 14:30 自选估值推送配置

核心目标：交易日北京时间 **14:30**，读取 Gist 里的自选基金，抓天天基金实时估值，并推送到微信或其它通知通道。

## 触发方式

当前主触发器：`worker/` 中的 Cloudflare Worker：

- Worker：`sinan-estimate-push`
- URL：`https://sinan-estimate-push.ligugu69.workers.dev`
- cron：`30 6 * * 1-5`，即北京时间 14:30
- Gist 状态文件继续使用 `sinan-estimate-state.json`，与旧脚本共享去重状态
- GitHub Actions `estimate-push` 只保留手动应急入口，不再定时执行

旧 Render Cron 配置仍在 `render.yaml` 中作为历史参考；启用 Cloudflare Worker 后不要同时启用 Render Cron。

原 Render 配置：

- `fund-compass-estimate-push`
- cron：`30 6 * * 1-5`，即北京时间 14:30
- 脚本：`python tools/estimate_push.py`

GitHub Actions 的 `estimate-push` 仍保留为兜底，但 GitHub 免费定时任务可能延迟。脚本会自动跳过延迟超过 25 分钟的旧任务，避免 18 点补发一条标题写着 14:30 的消息。

> Render Cron Job 没有 free plan；如果不启用 Render Cron，只用 GitHub Actions，也能工作，但准点性不保证。

## 必填 Secret

需要能读取 App 云同步自选的 Gist：

| Name | Value |
|------|-------|
| `GIST_TOKEN` | GitHub Personal Access Token，需勾选 `gist` 权限 |
| `FUND_API_BASE` | 司南后端公网地址；配置后推送包含决策动作与组合校准 |

先在 App「自选 → 云同步」里上传一次，确保 Gist 中存在 `sinan-watchlist.json`。

## 通知通道

脚本按下面顺序使用第一个已配置通道：

| 通道 | Secret / Env | 说明 |
|------|--------------|------|
| PushPlus | `PUSHPLUS_TOKEN` | 推荐，微信推送；可选 `PUSHPLUS_TOPIC`、`PUSHPLUS_CHANNEL` |
| Server 酱 | `WECHAT_SENDKEY` 或旧名 `SC_SENDKEY` | 兼容旧配置 |
| 自定义 Webhook | `NOTIFY_WEBHOOK_URL` | POST JSON：`{ "title": "...", "content": "..." }` |

Render Cron Job 需要在 Render 服务环境变量里配置；GitHub Actions 兜底需要在仓库 Actions Secrets 里配置同名 Secret。

## 测试

GitHub Actions 手动测试：

1. 仓库 → Actions → `estimate-push` → Run workflow
2. 勾选 `force = true`
3. `slot` 填 `14:30` 或留空
4. 已配置 `FUND_API_BASE` 时应收到「司南基金 · 自选决策摘要（14:30）」，否则收到估值降级版

`force = true` 只用于测试，不会占用当天正式推送去重状态。

## 去重与跳过规则

- 每个交易日 `14:30` 最多正式推送一次。
- 周末跳过。
- 如果天天基金没有返回当天盘中估值，跳过。
- 定时任务晚到超过 25 分钟，跳过，避免推送过期实时估值。
- 决策后端不可用时自动降级为纯估值推送，不影响 14:30 通知。

推送内容仅为数据参考，不构成投资建议。
