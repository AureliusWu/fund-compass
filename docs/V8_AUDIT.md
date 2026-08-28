# 司南基金 v8.0.0 开工审计

> 审计日期：2026-08-25
> 审计基线：`a7a0015dc0eb4a337bade923c6058add980abc30`（`main == origin/main`）
> 续作同步：2026-08-28 已快进到 `ef5aaf3d36612f7a4622618bb7b41d1137623137`（`main == origin/main`）；上述 SHA 仅保留为开工审计时的历史基线。
> 当前产品版本：`7.0.1`
> 审计范围：后端、前端、SQLite、策略注册表、Cloudflare Worker、GitHub Actions、Render 配置与现有数据账本
> 结论口径：本文件第 1—14 节描述开工审计时真实代码和配置，不把 README 中的路线编号当成 SemVer，也不把尚未执行的生产验证写成成功；后续实现状态以续作验收记录和最终汇报为准。

## 1. 结论摘要

7.0.1 已具备选基、评分、信号、决策卡、组合决策、组合实验室、QDII/海外估值、结果回看、策略候选治理、Worker 推送、数据源降级和 PWA 等能力，但它还不是 v8 方案要求的“证据 → 决策 → 结果”可复现闭环。

主要差距如下：

1. `/decision` 和 `/analyze` 每次都从当前详情重新计算，没有先生成不可变 `EvidenceSnapshot`。
2. 现有 `decision_history` 只保存少量结果字段，不足以复现当时决策；相同实时输入还会因 `calculated_at=now()` 得到不同响应。
3. Outcome 是查询时从 `decision_history + nav_history` 动态回算，不是与 `decision_id + horizon` 一一对应的不可变结算记录。
4. 持仓只有请求中的临时权重，没有 `holding_version`；组合规则写在代码中，没有 `policy_version`。
5. Worker 的两个 Cron 已形成 14:30 主触发和 14:40 补偿触发，但二者共享 `14:30` 槽位和日期级请求键；尚无 `decision_id + scheduled_window` 的 `notification_event_id` 账本。
6. Render 明确配置为免费实例和 `ephemeral` SQLite，当前生产持久化不真实。此项不能只靠代码修复，发布前必须配置真实持久盘或等价耐久存储。
7. QDII 离线精度账本已严格使用 `target_nav_date` 精确结算，但该日期尚未贯穿当前在线 decision/evidence/history 契约。
8. 组合路径仍有 `missing -> 0` 的权重归一写法，必须在 v8 新契约中 fail closed。

因此，本次采用“保留旧 API、添加 `/api/v2` 契约和增量表”的迁移方式；旧记录保持原样并标识为 legacy，不重算、不覆盖。

## 2. 当前 7.0.1 的实际能力

| 能力 | 实际状态 | 审计结论 |
| --- | --- | --- |
| 基金清单与详情 | 已实现，含本地缓存、12 小时 TTL、最长 7 天旧缓存兜底 | 可复用；旧缓存必须继续显式标记 stale |
| 四维评分、信号、单基金回测 | 已实现，纯 Python 运行时 | 可作为 v8 Evidence 输入，但不能直接充当快照 |
| 单基金决策卡 | 已实现 BUY/DCA/WATCH 与 ADD/HOLD/REDUCE/SELL 的中文映射基础 | 输出以自由文本为主，缺少稳定 reason code、版本绑定和不可变 ID |
| 组合决策 | 已实现 Worker/Admin 写接口、请求幂等键与决策历史写入 | 先计算后 claim；重复请求会重算当前数据，不能返回原始不可变响应 |
| 组合实验室 | 已实现共同净值日期、回测、风险贡献、压力情景和受约束再平衡 | 当前代码使用共同日期；文档中旧“向前填充”说明已过时。权重缺失值语义仍需修复 |
| Outcome | 已实现 5/20/60 观测点收益、回撤、同类 leave-one-out 超额和分组统计 | 动态回算而非持久化 outcome；“日”实际是第 N 个后续净值观测点 |
| 策略注册表 | 已实现 active/candidate/history/governance；候选可自动评估但不会无门槛晋级 | 当前 active 为 `v1-default`；候选被拒绝，符合人工治理边界 |
| QDII/海外模型 | 已实现精确目标净值日、四态账本、误差分位和离线校准 | 在线决策快照未绑定 `target_nav_date` 与模型样本/误差证据 |
| Worker 推送 | 已实现工作日 14:30/14:40 Cron、一次重试、Gist 状态与已发送跳过 | 补偿行为存在，但事件 ID 和状态账本不符合 v8 目标 |
| GitHub 定时任务 | 基金清单、持仓/经理富集、海外精度和策略校准为离线任务；旧推送工作流仅手动应急 | 实时推送没有重新放回 Actions，边界正确 |
| 前端/PWA | 主导航为“首页 / 选基 / 自选”；高级路由保留；API 为 NetworkOnly | 尚无 v8 行动中心、结构化 Diff、Evidence Graph 与 Policy 页面 |
| 生产持久化 | 后端会报告存储耐久状态，但 Render 配置明确为临时 SQLite | 不满足 v8 生产验收 |

## 3. README 中 V8—V13 / Iteration 15—17 的真实含义

README 和 `docs/ITERATION-PLAN.md` 中的 V8—V13 是历史功能批次编号，不是当前应用 SemVer 8—13。当前所有版本标记仍为 `7.0.1`。

| 历史路线名 | 已真实实现 | 与本次 v8 仍有差距 |
| --- | --- | --- |
| 历史 V8：Outcome 闭环 | `decision_history`、5/20/60 动态结果、同类超额、结果页 | 无完整 Evidence/Decision snapshot；无 outcome 持久表；不能由 `decision_id` 一对一追溯 |
| 历史 V9：海外日期与精度 | `pending/settled/stale/market_closed`、精确 `target_nav_date`、leave-one-out、审计与 CSV | 在线 decision 未保存同一套 QDII 证据链 |
| 历史 V10：组合实验室 | 共同日期回测、风险贡献、约束再平衡、组合历史 | 无版本化 Policy/Holding；组合 outcome 仍动态回算 |
| 历史 V11：可信度收口 | 海外精度独立任务、样本与 P80 展示、三主导航/两自选区契约 | 可信度还不是统一数值 gate；在线快照不保存源健康图谱 |
| 历史 V12：数据韧性 | stale/null/timeout/cache 门禁、API NetworkOnly、当前组合共同日期 | 部分组合权重逻辑仍将缺失转换为 0 |
| 历史 V13：身份与交互 | 经理 ID、提醒指纹、本地提醒迁移、布局契约 | 本地提醒指纹不是服务端 notification event 账本 |
| Iteration 15—17 | 温度/评分语义、来源健康、富集与发布门禁等大部分任务在代码和测试中可见 | 这些名称不能替代 v8 snapshot、policy、holding、diff、outcome 的验收 |

需同时修正文档历史中的一处口径：V10 的旧说明写“共同区间向前填充”，而当前 `portfolio_lab.py` 已只取所有基金都存在净值的共同日期。应以当前代码和 V12 修正口径为准，后续更新路线说明，避免把 forward-fill 误认为当前行为。

## 4. 当前 API 契约

### 4.1 `GET /api/fund/{code}/decision`

- 查询参数：`held`、`target_weight`、`current_weight`，另有详情依赖的 `force`。
- 每次请求读取当前基金详情、实时估值上下文，再计算 score/signal/backtest/decision。
- 返回：动作、强度、中文置信度、数据状态、自由文本 reasons/risks/change conditions、仓位提示、方法版本和 freshness。
- 不生成 `evidence_id`/`decision_id`，不绑定 strategy/holding/policy version，也不持久化。

### 4.2 `GET /api/fund/{code}/analyze`

- 查询参数与单基金决策相同。
- 同一次响应返回 detail、score、signal、backtest、decision。
- 仍是当前数据实时重算，不保存输入快照。

### 4.3 `POST /api/portfolio/decisions`

- 权限：Worker 或 Admin。
- 输入：`request_id?`、`items[{code,current_weight?,target_weight?,estimate_context?}]`、`portfolio_value?`。
- `estimate_context` 已有严格的估值类型、时间、新鲜度和诊断字段验证。
- 输出：逐基金 decision、errors、allocation 和 rebalance。
- 当前执行顺序是先完成实时计算，再 claim `request_id`；重复请求返回重新计算的结果，而非第一次请求的原始响应。
- 成功时写入精简 `decision_history` 和 `portfolio_decision_history`；没有完整 Snapshot。

### 4.4 兼容策略

旧接口在 v8 期间保持兼容。新增 `/api/v2`：

- `GET /api/v2/fund/{code}/evidence`
- `GET /api/v2/fund/{code}/decision`
- `GET /api/v2/fund/{code}/decision/diff`
- `GET /api/v2/fund/{code}/outcomes`
- `POST /api/v2/watchlist/decisions`
- `POST /api/v2/portfolio/decisions`
- `POST /api/v2/portfolio/rebalance`
- `GET/POST /api/v2/portfolio/policy`
- `GET /api/v2/portfolio/policy/history`
- `GET /api/v2/strategy/registry`
- `GET /api/v2/strategy/{version}/performance`
- `GET /api/v2/strategy/candidates`

## 5. 当前 SQLite Schema 与真实数据状态

### 5.1 现有表

1. `funds`
2. `fund_detail`
3. `nav_history`
4. `watchlist`
5. `decision_history`
6. `portfolio_decision_history`
7. `idempotency_requests`

当前迁移只按列存在性执行 `ALTER TABLE`，`PRAGMA user_version` 仍为 0，没有显式 schema 版本。

审计时本地数据库：

- `PRAGMA quick_check`：`ok`
- `funds`：27,133 行
- `fund_detail`：10 行
- `nav_history`：8,016 行
- `decision_history`：5 行
- `portfolio_decision_history`：1 行
- `watchlist`：0 行
- `idempotency_requests`：0 行

### 5.2 不可变性

- 现有历史写入使用 `INSERT OR IGNORE`，相同 `(code, decision_date, strategy_version)` 不覆盖；这是“不可覆盖写入”，但不是完整不可变快照。
- 表没有阻止 `UPDATE`/`DELETE` 的约束或触发器。
- `decision_history` 没有保存完整 evidence、reason codes、invalidation、holding/policy version，无法保证可复现。
- `portfolio_decision_history` 以 JSON 保存组合条目，但仍缺 strategy 输入外的完整版本链。

### 5.3 Outcome 对应关系

- 单基金 outcome 查询时按 `decision_history` 动态展开为最多 3 个 horizon 结果，不存在唯一 `(decision_id, horizon)` 行。
- 组合 outcome 同样动态计算，而且不同成分的“第 N 个观测”可能落在不同实际日期。
- 因此当前 outcome 与原 decision 不是数据库意义上的一一对应；旧 decision 本身没有被改写，但结果也没有被固定。

## 6. 当前版本链

### 6.1 Strategy

- 策略版本只在精简历史中记录 `strategy_version`。
- 注册表是 `backend/data/strategy-params.json` 文件，不是 SQLite 版本表。
- active：`v1-default`。
- 当前 candidate：`candidate-20260824`，状态 `rejected`，没有自动晋级。

### 6.2 Holding

- 没有 `holding_version`。
- 持仓份额来自 Worker Gist，自选/资产输入来自前端本地数据，请求只把当前/目标权重传入决策函数。
- 同一持仓被修改后，历史 decision 无法证明当时使用了哪一版份额、成本、市值、账户和目标。

### 6.3 Policy

- 没有 `policy_version`。
- 再平衡阈值、单基金上限等是代码常量或请求参数，不是用户确认的版本化资产配置目标。

## 7. 数据新鲜度与源健康链

当前链路：第三方适配器 → 基金详情缓存 → `_estimate_context` → decision freshness → 前端展示/Worker 推送。

- 详情缓存正常 TTL 为 12 小时，源失败时最多返回 7 天旧缓存并标记 stale 和年龄。
- 精确盘中估值/持仓模型超过 90 分钟会硬过期并清空精确估值字段；不可用时回退最新正式净值。
- PWA 对 `/api` 使用 `NetworkOnly`，不会由 Service Worker 伪装新鲜 API 响应。
- 当前 health 返回全局当前源状态，但 decision 没有保存“生成当时”的统一 `SourceHealth` 列表。
- v8 必须将 `source_id/state/last_success/last_failure/latency/data_age/stale/error_class` 归一化后写入 EvidenceSnapshot；关键源 stale 时 confidence 只能下降。

## 8. QDII `target_nav_date` 链

已实现并验证的离线链：

1. 观察日决定精确目标净值归属日和基准净值日。
2. 每个模型特征保存与目标日一致的 quote date/time/source。
3. 结算只查 `history[target_nav_date]`，不会拿下一条净值顶替。
4. 等待记录依次保持 `pending`、`market_closed` 或 `stale`；即使 stale 也不自动顺延。
5. 旧错误轴记录保留为 `legacy_misaligned`，不进入指标。

缺口：在线 `EstimateContext` 和现有 decision history 没有完整保存 `target_nav_date`、样本数、MAE/P80、方向准确率和模型版本。v8 新 EvidenceSnapshot 必须贯穿这些字段；样本不足或 P80 误差过高时模型仅作辅助，不能触发高置信 BUY/ADD/SELL。

## 9. Cloudflare 14:30 / 14:40 实际行为

- `wrangler.toml` 配置两个工作日 Cron：UTC 06:30 和 06:40，即北京时间 14:30 和 14:40。
- Worker 内部只有一个逻辑槽位常量 `14:30`。
- 14:30 成功后写入 `sent_slots=["14:30"]`；14:40 再触发会以 `already_sent` 跳过，因此可作为补偿触发。
- 组合 API 请求键为 `${date}-14:30`，两个自然触发共享同一键。
- Gist 状态区分 `last_cron_at/result/reason`、`last_attempt_at`、`last_success_at`、错误、警告和 attempt count。
- 手动 `force` 路径不写自然发送状态，避免覆盖自然调度成功记录。

缺口：

- 没有按 `decision_id + scheduled_window` 生成 `notification_event_id`。
- 没有持久化 `scheduled/skipped/attempted/sent/failed/compensated` 的逐事件账本。
- 14:40 在状态中仍被记作 14:30 槽位，无法独立审计补偿发生在哪个窗口。
- 自然 schedule 是否实际成功属于实时生产证据，不能由配置推断；发布阶段必须读取 Worker 日志/health 并记录时间与 exact SHA。

## 10. 生产持久化

`render.yaml` 使用 `plan: free` 且设置 `FUND_DB_PERSISTENCE=ephemeral`，没有 persistent disk。后端 health 会正确报告 `durable=false`，但真实含义是实例重建后 Snapshot、Outcome 和通知账本可能丢失。

结论：本地可以实现并验证 v8 schema；生产上线在没有真实持久盘或等价耐久存储前为 **BLOCKED**。不得把“SQLite 能写入”写成“生产数据可持久”。

## 11. 本次建议修改文件

以下为审计后的最小增量范围，实际实现按阶段落盘：

- `backend/database/db.py`：显式 schema version、增量表、不可变触发器与索引。
- `backend/models/api.py`：v2 Holding/Policy/批量请求模型。
- `backend/models/v8.py`：EvidenceSnapshot、DecisionSnapshot、DecisionDiff、PositionGuidance、SourceState。
- `backend/service/v8_repo.py`：快照、Policy、Holding、Outcome、通知事件的幂等持久化与查询。
- `backend/strategy/decision_v2.py`：确定性 Evidence normalizer、confidence gate、动作状态机、reason codes、diff。
- `backend/main.py`：兼容新增 `/api/v2` 路由，旧路由不破坏。
- `backend/tests/test_v8_*.py`：迁移、确定性、不可变、golden/metamorphic、防穿越、QDII、通知幂等。
- `worker/src/index.ts` 与 Worker 测试：独立 scheduled window、notification event ID 和补偿状态。
- `frontend/src/api/client.ts` 与测试：v2 类型和 client；旧 UI 继续工作。
- `frontend/src/pages/*`、组件与展示测试：仅在“今日行动中心”原型确认后全量修改。
- `docs/ITERATION-PLAN.md`、README、release notes、版本文件：仅在功能和验收真正完成时统一更新；不会提前写 8.0.0。

## 12. 数据迁移方案

### 12.1 原则

1. 迁移前复制 SQLite 文件为带时间戳备份，并对源库执行 `quick_check`。
2. 使用 `PRAGMA user_version` 的增量、幂等迁移；每一步在单事务中完成。
3. 新建 v8 表，不重写现有 7 张表；旧接口继续读取旧表。
4. 旧 `decision_history` 不回填当前数据，不伪造 evidence/holding/policy；只在新查询中标识 `legacy`。
5. Snapshot 与 Outcome 使用确定性主键和 `INSERT OR IGNORE`；内容哈希冲突时 fail closed。
6. 对 Evidence、Decision、Outcome、Policy/Holding 版本和通知成功事件建立防 UPDATE/DELETE 触发器。
7. 迁移后执行 schema/索引/触发器检查、`foreign_key_check` 和 `quick_check`，再读回样本。

### 12.2 新逻辑表

- `source_health_events`
- `evidence_snapshots`
- `holding_versions`
- `portfolio_policy_versions`
- `decision_snapshots`
- `outcome_evaluations`
- `portfolio_outcome_evaluations`
- `notification_events`

reason codes、risks、invalidation、position guidance 和 evidence nodes 先以规范化 JSON 固定在不可变 snapshot 中，避免为仅用于快照重放的数组拆出可被局部修改的子表。策略文件注册表继续作为当前 active/candidate 来源，同时在 decision 中固定引用的 strategy version。

### 12.3 ID 规则

- canonical JSON：UTF-8、键排序、紧凑分隔符、禁止 NaN/Infinity。
- `evidence_id = sha256(canonical evidence input)`。
- `holding_version = sha256(canonical holding input)`。
- `policy_version = sha256(canonical policy input)`，显式用户版本名可作为 metadata，不能替代内容哈希。
- `decision_id = sha256(fund_code + evidence_id + holding_version/null + policy_version + strategy_version)`。
- `outcome_id = sha256(decision_id + horizon + exact evaluation date)`。
- `notification_event_id = sha256(decision_id + scheduled_window)`。

### 12.4 兼容与备份

- 本地真实数据库不作为单元测试写入目标；迁移测试使用临时副本。
- 首次实际迁移前保存备份路径、大小和 SHA-256；迁移成功后保留备份。
- 生产因临时盘当前不执行有价值数据迁移；必须先解决耐久存储，再做受控备份/迁移/读回。

## 13. 回滚方案

### 13.1 代码回滚

- v2 路由和模块为增量新增；旧 `/api` 路由与旧表不删除。
- 若 v2 运行异常，回退应用代码到上一个 exact SHA，旧 UI/旧 API 仍可运行。
- Worker 在 notification event 新协议异常时可回退到旧日期槽位逻辑，但不能删除已写审计事件。

### 13.2 数据回滚

- 迁移事务失败自动 rollback；数据库保持迁移前版本。
- 迁移提交后如需回退代码，保留新增表不动，旧代码会忽略它们。
- 只有在明确验证不再需要且有备份时，才允许通过单独维护操作删除 v8 表；常规回滚不 DROP、不清空、不覆盖历史。
- 数据库文件损坏时停止服务写入，从迁移前备份恢复到新路径，执行 `quick_check`、行数核对和读回后再切换；不在原损坏文件上继续写。

## 14. 开工门槛与阻塞项

审计完成后可在本地继续 P1—P4、P6 和 P7 的代码/测试实现。以下事项保持边界：

- P5 先交付原型，未经用户确认不全量改 UI。
- 生产耐久 SQLite：**BLOCKED（需要真实持久盘/等价存储）**。
- Pages、Render/Railway、Worker 发布与线上 smoke：**NOT_RUN（当前未授权发布）**。
- 版本号 8.0.0：**不提前修改**。
- Git push / tag / release：**不执行**。

## 15. 2026-08-28 本地续作验收（未发布）

本节记录审计之后的本地实现状态，不回写或美化第 1—14 节的历史基线。

- Git 基线已快进并复核为 `ef5aaf3d36612f7a4622618bb7b41d1137623137`，本轮实现仍在未提交工作树；产品版本继续统一为 `7.0.1`。
- P1—P4 的不可变 Evidence/Decision/Holding/Policy、Decision Diff、确定性内核与 `/api/v2` 增量契约已落地；P6 的单基金和组合 5/20/60 日 Outcome 已按共同净值日期且不前向填充的口径持久化，历史同策略 Outcome 也已作为 Evidence Node 接入新快照。
- Worker 已实现计划时间与实际发生时间分离、14:30/14:40 补偿幂等和通知事件账本；自动校准已收紧为 candidate-only，不能修改 `active/history`。
- 本地真实数据库已在自动创建并验证 `fund_compass.db.pre-v8-20260828T070002Z.bak` 后迁移到 `PRAGMA user_version=8`。备份 SHA-256 为 `89C15D392815A9714AA9D24382676177B8AC6A9AD5C84B3A30CFAFB6C4CE1DFE`；迁移前后 27,133 条基金、10 条详情和 8,016 条净值保持不变，`quick_check=ok`、外键错误为 0，二次初始化未重复生成备份。
- 最终本地门禁：后端 382 项、前端 194 项、Worker 99 项测试通过；前端类型检查和生产/PWA 构建通过；30 个变更 Python 文件编译通过；前端与 Worker 的生产依赖审计为 0 漏洞。Worker 仅完成 dry-run，未真实部署。
- P5 只交付了可切换手机/PC及 loading、empty、stale、partial、low-confidence、multi-action、offline 状态的行动中心原型；在用户确认信息架构前不接入正式路由。
- 生产耐久存储、自然 Cron 新版本证据、Pages/API/Worker exact SHA 和部署后 smoke 仍未完成。Render 仍为临时 SQLite，因此 v8 发布状态继续是 **BLOCKED / NOT_RUN**，不是已发布。
