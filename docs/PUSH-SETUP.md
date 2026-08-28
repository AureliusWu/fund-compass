# 司南基金 · 14:30 自选估值推送配置

核心目标：交易日北京时间 **14:30**，读取 Gist 里的自选基金，优先生成带证据边界的盘中参考估值，并推送到微信或其它通知通道。

## 触发方式

当前主触发器：`worker/` 中的 Cloudflare Worker：

- Worker：`sinan-estimate-push`
- URL：`https://sinan-estimate-push.ligugu69.workers.dev`
- cron：`30 6 * * MON-FRI` 与 `40 6 * * MON-FRI`，即北京时间周一至周五 14:30 主任务和 14:40 补偿任务；使用星期名称避免 Cloudflare `1=周日` 的编号歧义
- `14:30` 与 `14:40` 是两个独立、可审计的调度窗口；14:30 成功后 14:40 依据同日状态跳过，14:30 失败时 14:40 复用同一不可变决策批次补偿，两个窗口分别留存审计记录
- Gist 状态文件继续使用 `sinan-estimate-state.json`，与旧脚本共享去重状态
- GitHub Actions `manual-estimate-push` 只保留手动应急入口，不再定时执行

v7.0.0 的持仓模型参考蜉蝣基金的公开持仓穿透方法，但在司南 Worker 内独立实现。它是由披露持仓和公开行情推算的**非官方参考值**，不是基金公司公布净值。返回必须同时带模型类型、覆盖率、行情时间与状态；持仓证据不足、行情过期、部分报价缺失或上游错误时，按契约降级为最近正式净值或不可用，不能用 0 补空，也不能把降级值标成实时估值。

旧 Render Cron 已从 `render.yaml` 删除，避免与 Cloudflare Worker 重复发送。历史实现曾使用：

- `fund-compass-estimate-push`
- cron：`30 6 * * 1-5`，即北京时间 14:30
- 脚本：`python tools/estimate_push.py`

GitHub Actions 的 `manual-estimate-push` 仅用于人工应急；正式定时推送由 Cloudflare Worker 承担。

> Render Cron Job 没有 free plan；未启用 Cloudflare Worker 时，需要自行配置可靠的外部定时触发器。

## 必填 Secret

需要能读取 App 云同步自选的 Gist。GitHub 的 secret Gist 不是权限隔离的私有存储；任何拿到 ID 的人都可能访问，因此不要把 Gist ID 写入公开源码，历史上暴露过的 ID 应轮换：

| Name | Value |
|------|-------|
| `GIST_ID` | 云同步 Gist ID；Cloudflare Worker 与 GitHub Actions 均按 Secret 配置 |
| `GIST_TOKEN` | GitHub Personal Access Token，需勾选 `gist` 权限 |
| `FUND_API_BASE` | 司南后端公网地址；配置后推送包含决策动作与组合校准 |
| `WORKER_TOKEN` | 后端 Worker 写接口凭证；Cloudflare Worker 与人工应急 workflow 必须使用同一个值 |

先在 App「自选 → 云同步」里上传一次，确保 Gist 中存在 `sinan-watchlist.json`。

轮换 Gist 后，旧浏览器首次同步若命中已删除 ID，会自动只读发现新 Gist。迁移期间必须先执行“下载”完成合并，再执行上传；客户端在成功下载前会保持写入关闭，防止旧本地副本覆盖新云端数据。手工资产也应先下载后上传。

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

1. 仓库 → Actions → `manual-estimate-push` → Run workflow
2. 勾选 `force = true`
3. `slot` 填 `14:30` 或留空
4. 已配置 `FUND_API_BASE` 时应收到「司南基金 · 自选决策摘要（14:30）」，否则收到估值降级版

`force = true` 只用于测试，不会占用当天正式推送去重状态。

## 去重与跳过规则

- 每个交易日 `14:30` 最多正式推送一次。
- 周末跳过。
- 如果天天基金没有返回当天盘中估值，跳过。
- 只有分钟时间且不超过 90 分钟的主估值可触发推送；仅日期级数据标记为延迟估值，只展示、不触发。
- 只有模型结果满足覆盖率、新鲜度和数值完整性门槛时才允许进入正式推送；正式净值降级仅供展示，不作为新鲜盘中估值发送。
- 定时任务晚到超过 25 分钟，跳过，避免推送过期实时估值。
- V8 生产配置了决策后端后，后端不可用会失败关闭本次通知，避免绕过不可变通知 claim 造成并发重复发送；未配置后端的旧式纯估值模式仍只依赖 Gist 去重。

推送内容仅为数据参考，不构成投资建议。

## 发布验收边界

- `GET /health` 与 `GET /estimates` 是安全只读检查，不会发送通知；发布流程不得调用 `POST /test`。
- 部署烟测允许非交易时段只返回 `official_nav` 或 `unavailable`，不得强制要求 `holdings_model` 出现。
- 自然调度门禁以 Gist 中新的 `last_cron_at`、`last_cron_result`、`last_cron_reason`、`last_attempt_at` 与 `last_success_at` 为准。部署当天尚未经过工作日 14:30/14:40 时，应标记“待自然运行验证”，不能宣称定时推送成功。
- 14:30 首次失败后允许 14:40 补偿；两个时点都失败时保留真实错误，并不得写入伪成功时间。
