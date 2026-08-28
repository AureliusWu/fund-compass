# 司南基金 Cloudflare Worker

工作日北京时间 14:30 读取 Gist 云同步自选，获取盘中估值与司南决策摘要，通过 Server酱推送。GitHub 的 secret Gist 只是“不公开列出”，并不具备真正的私有访问控制；不要把 Gist ID 提交到公开仓库。

## 变量

`wrangler.toml` 只包含非敏感的 `FUND_API_BASE`。`GIST_ID` 会定位自选、持仓和运行状态，因此也按 Secret 管理。以下必须使用 Cloudflare Secret：

```bash
npx wrangler secret put GIST_ID
npx wrangler secret put GIST_TOKEN
npx wrangler secret put WECHAT_SENDKEY
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put WORKER_TOKEN
```

`ADMIN_TOKEN` 使用密码管理器生成的至少 32 位随机字符串，只用于保护 `POST /test`。`WORKER_TOKEN` 必须与后端环境中的同名 Secret 完全一致，用于调用 V8 决策、结果结算和通知审计接口。

正式 Cron 为北京时间工作日 14:30 与 14:40；Cloudflare 的星期编号是 `1=周日`，因此配置使用 `MON-FRI` 消除歧义。14:30 是主窗口，14:40 是独立可审计的补偿窗口：主窗口成功后，补偿窗口记录 `skipped`；主窗口失败时，14:40 可以另行抢占并重试。每次发送前必须由后端 `attempted` 审计事件明确返回 `claimed=true, duplicate=false`，否则失败关闭，不发送重复通知。

Cloudflare `scheduledTime` 只表示计划触发时刻，不作为行情新鲜度或审计发生时间。Worker 使用实际启动时间判断 freshness，并写入 `occurred_at` 和 `last_cron_at`；计划时刻仅作为 `scheduled_at` 保存，同时记录 `schedule_delay_seconds`。

生产配置了 `FUND_API_BASE` 后，如果决策快照或通知 claim 不可用，本次通知失败关闭；不会绕过后端审计退回无幂等锁的纯估值发送。

自然 14:30 在读取自选和估值之前独立调用受保护的 Outcome 结算接口；即使自选为空、只有正式净值或估值上游失败，历史决策仍会结算。结算不可用或响应不完整时只记录警告，不会伪报成功，也不阻断当次估值通知或可解释的跳过；手动测试和 14:40 不重复结算。同一天 14:30 与 14:40 共用 `natural-<date>-primary` 幂等键以重放原始决策批次；手动任务使用 `manual-` 键，与自然任务隔离。

Server酱请求超时、网络中断、响应无法完整解析或响应缺少明确结果码时，可能已经送达，因此失败审计统一写入 `error_class=delivery_ambiguous`。补偿窗口必须依据后端返回失败关闭，不得把不确定送达当成可安全重发。

## 部署

```bash
npm install
npm run check
npm test
npm run deploy
```

`npm run deploy` 是唯一受支持的生产发布入口：它会拒绝脏工作树，把当前完整 40 位 Git commit SHA 作为构建常量注入 Worker。不要直接运行 `npx wrangler deploy`，否则 `/health.build_sha` 缺失，发布 smoke 会拒绝该 bundle。版本号相同不再视为同一构建；后续仅修改 Worker 目录以外的数据或文档时，smoke 会用该 SHA 与目标 SHA 的 Worker 源码差异验证二者仍完全等价，不要求无意义地重部署相同 bundle。

部署后访问 `/health` 会公开 `build_sha`，并且只显示各变量是否存在，不会泄露 Secret 值。自然 Cron 会把同一 SHA 写入 `runtime.last_cron_build_sha`；若当前构建尚未经过工作日 14:30/14:40，发布 smoke 必须明确记录 `NOT_RUN / 待下一个自然窗口`，不能复用旧构建的运行记录冒充验证。公开只读接口
`GET /estimates?codes=000001,000002` 仅接受 1–50 个六位基金代码，并只为司南/蜉蝣
GitHub Pages 与本地开发源开放浏览器跨域访问。它不会接收任意上游 URL，也不会返回 Secret。
交易日优先返回盘中估值表；只有提供分钟时间且不超过 90 分钟的主估值才可触发推送。仅有日期的估值明确标记为 `delayed`、可展示但不冒充实时，也不会单独触发盘中推送。非交易日或估值表不可用时，按代码读取最近两条正式净值，
返回 `est_kind=official_nav`、对应净值日期和最近正式净值涨跌，不伪装成当日实时估值。传给 V8 决策的 `official_nav` 证据中，`estimate_nav` 和 `estimate_change` 固定为 `null`，正式净值只放在 `value_nav`。
v7.0.0 增加参考蜉蝣基金持仓穿透思路、在本 Worker 内独立实现的 `holdings_model`：它把公开披露持仓与可用行情组合为非官方盘中参考值，并同时返回覆盖率、行情时间和模型状态。该分支固定使用 `source=eastmoney_holdings_model`、`status=modeled`、`source_time_precision=datetime` 与 `est_realtime=false`；证据字段为 `model_coverage`、`model_quote_count`、`model_report_date`、`model_oldest_quote_time`、`model_newest_quote_time`、`model_rejected_count`，同时保留不带 `model_` 的短别名供兼容。它不是基金公司公布净值；覆盖不足、行情过期、上游异常或结果非有限数时必须失败关闭，继续降级为 `official_nav` 或 `unavailable`，未知值保持 `null`。
FundVal v13 等旧客户端的 `est_time` 别名在 `holdings_model` 分支故意只给日期，防止将非官方模型误标为实时。新客户端应以 `source_time`、`model_oldest_quote_time` 和 `model_newest_quote_time` 为精确行情时间。
批量响应的 `accounting` 分别统计 `primary`、`model`、`official`、`unavailable`，四项之和必须等于 `requested`；客户端可据此判断本批结果中有多少是直接盘中数据、持仓模型、正式净值降级或完全不可用。
为兼容既有客户端，`items` 只包含数值可用的基金；无法回退的代码列在
`unavailable_codes`，详情列在 `unavailable_items`，不会把空净值塞入旧数值列表。
`GET /holdings?code=005844` 仅接受单个六位基金代码，由 Worker 为东方财富重仓接口
补齐来源标头，返回最多十只重仓股、占净值比例和季度披露截止日期；结果缓存 30 分钟。

手动测试：

```bash
curl -X POST "https://sinan-estimate-push.<subdomain>.workers.dev/test" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

正式推送由 Worker Cron 承担；`.github/workflows/manual-estimate-push.yml` 仅保留手动应急入口。

发布烟测只允许调用上述公开 GET 接口，不调用 `POST /test`。非交易时段不要求响应中出现 `holdings_model`；只有部署后的工作日 14:30/14:40 自然运行记录，才能证明 Cron 取数与推送判定链路有效。
