# 已确认持仓的机器任务候选

应用仍为 **8.0.0**。这是本地候选后端，不是 Worker 切换、Turso 启用或正式发布证明。

## 实际实现

在已有完整 analysis 候选库上，显式调用 `provision_owner_machine_candidate(conn, synthetic_candidate=True)` 才会追加固定第三 profile。正常启动只读核验，不创建表、修复 marker、打开缺失库或启用 Turso。旧两个 public exact verifier 继续拒绝第三 profile；应用兼容入口明确识别三种完整 inventory。固定对象125个，原三张可选表同时存在时128个，原扫描上限未提高。

仅现有 Worker/Admin 凭据可访问以下端点，私人响应均 `no-store`；Owner、Private Read 和匿名均无权操作。构造 router 零 I/O。

| 端点（前缀 `/api/v2/worker/portfolio`） | 行为 |
| --- | --- |
| `GET /source` | 同一快照读取完整已确认 Owner 来源，返回 revision、原 typed SHA、完整基金代码、当前有效 Policy；不接受客户端持仓 |
| `POST /tasks/prepare` | 核完整来源、Policy 和逐基金已有 Evidence，真实 Holding/Decision/原 analysis 回执与不可变 day task 同一事务保存 |
| `POST /tasks/claim` | 重核原来源、当前 Policy/策略和盘中行情，调用原通知整批 claim 的同连接内核，与原 attempt 映射一起提交 |
| `POST /tasks/finish` | 只关闭原 attempt；真实 source/Policy 后来变化也不能阻止记录原送达结果 |
| `GET /tasks/{occurrence_date}` | 只读回原 task/analysis、attempt/result 和逐 invocation 观察，不重算、不重新授予发送权 |

请求原正文最多16KiB；完整来源/单记录及整个返回像最多2MiB；最多100基金一次完整 claim。原50项通知公开 DTO 不改，不将100项拆成两份发送权。101项明确拒绝，不能截断。journal 最多100000行/64MiB，单发生项最多读取200条观察，超量失败而非丢历史。30秒协作总预算包含已知业务拒绝后的观察写入，不因第二事务续期；不是 SQLite 硬中断。

## 身份、日期和未知结果

- 基金跨账户聚合复用真实 `project_fund_holdings`，完整 source 包含 manual/tombstone/int/float/负零；0份仍是持仓，未知仍是 null。持仓定价不完整时原分析保持中立，artifact 为 partial，不能由全部近期行情冒充完整基金分母。
- 同一北京时间业务日只保存一份原 task/run/Decision 集合，人工、14:30、14:40不重新造 ID。后来的来源或 Policy 改变会阻断 claim，不重建绕去重。
- invocation 的原 ID/输入摘要与成功、跳过或 blocked 结果一样不可变。14:29被阻断的原请求不能在14:31重新执行成功；明确新 ID 才是另一调用。成功 claim 的读回始终 `claimed=false`，不是再次发送许可。
- 本轮固定国内交易日历仅支持2026年，来自[上交所休市安排](https://www.sse.com.cn/disclosure/dealinstruc/closed/)。周末/节假日跳过资格、未知年份明确拒绝；不是 QDII 净值日历。主窗口14:30，补偿14:40，14:50等号起禁止新发送权。计划与实际时间分开，不能晚到后补造原时刻行情。
- 当前可计入盘中新鲜数量的 Evidence 必须正向 fresh、estimate非空、无下一净值目标和相关 stale 标记；当日实际 market_time、created_at 均在90分钟内。未知/任意 status、正式净值或无估值不能解锁 fresh。模型降级的独立传输合同尚未接入，不冒称全部旧 Worker 类型已迁移。
- 新旧通知入口的边界绑定实际同库 task→analysis components→Decision，而非字符串前缀、部署开关或调用者自报 detail。旧入口拒绝这些管理中的 Decision 的全部阶段；新入口核原完整批次和所有同日发送阶段。另一 natural/manual 轴、另一窗口或伪造 task-only detail 都不能绕过已有 claim。
- `natural_schedule` 记录原发送权的真实触发类型；人工和自然观察独立追加，人工成功不会覆盖自然 blocked。execution_status 与 artifact_status 分轴。
- 未知 commit/close/HTTP 或未知送达不等于回滚，不重发。仅 `delivery_rejected`/`pre_delivery_failed` 这类能证明未送达/未开始的结果，才允许14:40复用原批次；`sent`、`delivery_ambiguous` 或没有终态都阻断补偿。
- 资格只证明 claim 事务时刻的来源/Policy；不声称直到外部发送完成都锁住它们。真正发送者还必须在网络调用前重核实际时间和原预算。

## 未完成，不能据此合并发布

1. 现有生产 Worker 仍用 Gist；新的完整行情入库、严格 Worker HTTP 消费、单次 Server酱发送、私有持久 health/旧状态导入尚未接通。旧路径另造不同 Decision IDs 不受上述“同一管理集合”边界替代，不能双路真实发送。
2. 应急脚本要接同一原任务入口，或明确退役其 workflow；旧槽位、信号前值和歧义状态先完整受控保全，不能从空状态重新通知。
3. main Owner 工厂仍拒 Turso；远端8→9迁移本身也不会自动开启 analysis/machine。真实停写、fresh backup、provider能力/配额、业务写入跨重启和独立恢复须各自证明，不能移除 SQLite-only/旧schema守卫换通过。
4. 真实 Chrome、旧PWA、多设备、连续自然窗口/周级任务、原性能债务和正式证据门禁仍未通过。所有测试使用隔离合成数据，不修改真实持仓，不发送真实通知。

测试、性能和提交身份以 `V9-EXECUTION-LOG.md` 与 `OWNER-MACHINE-PERFORMANCE-20261028.json` 为准。单元测试中的 `finish(sent)` 是合成授权回报，不是外部已送达证明。
