# Owner 机器消费者：显式 Worker 候选闭环

应用仍为 **8.0.0**。本项只是代码候选，不是已经部署、自然 Cron、真实送达、Turso 耐久或 v9 正式发布的证明。正式 Worker deploy 工具链阻断与云数据库工厂守卫均未改变。

## 实际入口与默认状态

`worker/src/index.ts` 的 `run`、`runScheduled`、Cloudflare scheduled handler 和原受保护 `POST /test` 已接候选消费者，不是独立但闲置的 adapter。

- `OWNER_MACHINE_MODE` 缺省、空字符串或 `off`：保留原 legacy Gist 消费者；这里的 off 仅指新候选模式关闭，不是停掉全部通知。
- 只有显式 `candidate`：走完整 Owner 机器链。Gist ID/Token 不是该路径的依赖；失败、未知或配置缺失不回退 legacy Gist、旧 `/portfolio/decisions`、旧通知事件接口或纯估值发送。
- 其它显式值：配置错误，固定拒绝，不猜测为开/关。

本次没有在 wrangler.toml、平台 Secret 或实际 Cron 上启用候选值，也没有部署或真实发送。启用前必须独立完成完整候选数据库、实际 profile/来源和旧状态迁移验收，不能凭本地测试恢复自动部署。

Evidence 构建另有硬前置：后端同一个候选数据库中，完整 codes 的 `fund_detail` / `nav_history` 缓存须已经具备且满足后端新鲜度校验。外部 `resolveValuations` 只取得盘中观察，**不会**预热这些后端缓存；缺任一只时后端整批拒绝。本消费者不隐式追加 100 次详情请求、不提高行情预算，也不宣称完成缓存预热。实际候选准备必须另行提供和核验这些数据；目前 mock `/evidence` 成功的 Worker 测试不是这个前置的真实联通证明。

冷缓存的真实接口会以 `machine_detail_unavailable` 拒绝 `/evidence`；Worker 对非成功 POST 保守报告 `machine_write_unknown` 并保留原请求 ID/body SHA，不因此补请求或改走旧路径。这个候选不是可直接打开的生产开关资格。

候选要求明确的 HTTPS `FUND_API_BASE` 根 origin、`WORKER_TOKEN`、`WECHAT_SENDKEY` 和构建时完整 40 位 `WORKER_BUILD_SHA`。不发现凭据，不接受重定向或另一 origin。原 `/test` 仍仅 Admin；手工测试不再越过候选机器链的交易日、原 occurrence 或 14:50 截止限制。

## 单次闭环

1. `GET /api/v2/worker/portfolio/source` 取服务器同一快照的 revision、typed source SHA、完整有序 codes 和当前 Policy。完整账户/manual/tombstone 来源保留在服务端，不下放给 Worker 重构持仓。
2. 既有 `resolveValuations` 按全部 codes 取得行情结果，保留 0/null、正式净值/下一净值、stale、不可用与降级语义；34 次外部行情请求预算不提高。超出 fallback 预算的代码仍进入完整 observations，不能丢基金缩小分母。
3. 单次 `POST /evidence` 携原 source revision/SHA/Policy、完整有序 `{code, estimate_context}`，服务器生成并保存真正的 Evidence。Worker 不提交 Holding、私人份额/权重、客户端评分或自造 Evidence 对象。
4. 完整 refs 单次 `POST /tasks/prepare`，保留原 task、analysis request、source、Policy、全部 Decision IDs 和 run。14:30、14:40、manual 均消费同一业务日的原任务，不据新行情另造同日 Decision。
5. 单次 `POST /tasks/claim`。只有真实响应 `claimed=true, duplicate=false` 且原 task/attempt/run 引用、SHA 与 invocation 绑定全部匹配时，才能进入送达阶段。`claimed=false`、读回的原 attempt 或缺失记录都不授予发送资格。
6. 发送前再次只读 source，核原 revision/SHA/Policy/codes/record_count、实际时间、至少一个原 Evidence 仍满足同日 90 分钟 fresh。消息涵盖全部基金；不可用不造零、不以部分组合权重作为完整分母。新 source、超时或过期在发送开始前失败时，原 attempt 以 `pre_delivery_failed` 结束。
7. 只进行一次 ServerChan 物理 POST，不调用 `sendWithOneRetry`。timeout、网络/HTTP 错误、坏/超大/重复键 JSON、缺业务码或成功/错误码矛盾均为 `delivery_ambiguous`；只有明确且不矛盾的非零业务拒绝才为 `delivery_rejected`。一次原样 `POST /tasks/finish` 记录结果；原 source/Policy 后来改变不替换原 attempt。

主链共用有限 60 秒预算，单次 API 请求最多 15 秒，行情阶段最多 25 秒，实际发送最多 10 秒。预算包含响应正文与校验，不只等待 response headers；后台行情 GET 即使在超时后才完成，也不再触发后续业务 POST。实际发送严格早于 14:50，原名义 Cron 时间不能续期。

## 严格响应与未知状态

机器响应整包最多 2 MiB，拒绝重复键、非有限数值、超深结构与尾随内容。task、run、attempt、result 的 SHA 使用原 JSON 子串，不能用 JS stringify 先把 Python `1.0`、`-0.0` 等词法表示改掉再冒称匹配。SHA 不是来源认证；可信来源仍取决于显式 origin、TLS 与 Worker 授权。

每次真实 invocation 使用独立 request_id，同次 evidence/prepare/claim 各阶段保留这个原 ID。每个 POST 的实际发送 body UTF-8 SHA 分别作为 `evidence_request_hash`、`prepare_request_hash`、`claim_request_hash`、`finish_request_hash` 留在结果的 `original` 中；同时保留原 occurrence/slot/source/Policy、已知 task_hash、attempt_hash 和实际 outcome。它不含 Token、原私人输入或 provider body。

任何 Evidence/prepare/claim/finish 未知结果均只返回原 tuple，**不自动重发、不自动 GET 对账、不把后来的 GET 转为发送权**。finish 未知而 outcome 已为 sent/ambiguous 时尤其不能重送。Worker 本身不把内存结果冒称永久存储；后台日志、原后端不可变记录与受控人工导出须分别保留。

原 Evidence 请求可由操作者直接使用后端受保护只读入口：`GET /evidence/{request_id}?occurrence_date=YYYY-MM-DD&request_hash=<原 body SHA>`。只核原包，不据 receipt 缺失重试。

## 状态核对

- 候选公开 `/health` 不再读取 Gist，也不把本地配置当作本日自然任务成功；runtime 明示 `unknown / authenticated_status_required`。
- 候选 `GET /machine-status?date=YYYY-MM-DD` 要求 Worker 或 Admin Bearer，固定 no-store；只代理后端原 `/tasks/{date}`，不计算新任务、不 claim、不发通知。Worker 仅核有界严格 JSON、闭集顶层和数组上限；业务日期 task、attempt、result 和真实 prepare/claim observations 的完整合同由可信 origin 的后端核验，不宣称 Worker 重做了全部仓储核验。状态读取不需要 ServerChan Secret。
- 原 Evidence 入库 receipt 不等于 Cron 运行成功，缺少自然 trigger 或真实发送终态仍未验收。

## 本轮本地验证

新增 Worker 测试覆盖真实 runScheduled 与 /test 接线、完整 100 基金单批次、0/null、原 JSON REAL 词法、原 body SHA、各阶段未知不重试、claimed=false 不发送、单次发送及 ambiguous 分类、发送前 source/时钟变化、候选失败不回退、配置闭集、私有状态授权与 health 零 Gist IO。

这些是 mock 网络和本地类型/回归证据，不是真实 Cloudflare Cron、ServerChan、Chrome/PWA 或云耐久验收。云恢复/停写迁移、旧 Gist 状态纳入与自然 14:30/14:40 观察仍须另外完成；不能据此删除旧 Gist、开放 Turso/main 工厂或标记 9.0.0 已发布。
