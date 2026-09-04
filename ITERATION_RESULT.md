# 司南基金 v8.0.0 迭代结果

日期：2026-09-01（Asia/Shanghai）
本文件状态：`LOCAL_RELEASE_CANDIDATE_PASS`；生产发布证据在提交前保持 `NOT_RUN`。

## 结论

v8.0.0 本地发布候选已完成代码加固和全量回归。版本、前端、API、Worker、PWA 与锁文件已统一到 8.0.0；后端 557 项、前端 236 项、Worker 144 项测试通过，类型检查、生产构建、依赖审计、Worker dry-run、本地 Chrome 合成 smoke 和三轮交替性能对比通过。

生产仍必须按同一精确提交完成候选 Render Free、Pages、Worker、三端地址一致性与部署后 smoke。并行候选服务 `fund-compass-api-v8-candidate` 已按 $0/月创建且没有磁盘；Free SQLite 必须报告 `ephemeral / durable=false`，重启可能丢失数据。代码级失败关闭可以部署为未发布候选，但 V8 persistence gate 必须拒绝正式发布；状态保持 `BLOCKED`，不能把本地备份测试写成生产持久化已通过。

## 已完成

### 数据与决策真实性

- 统一 `intraday_estimate`、`qdii_next_nav_estimate`、`holdings_model`、`official_nav` 与 `unavailable` wire；正式净值的估值轴保持 `null`，缺失值不补 0。
- 正式净值超过 7 天、日期轴不一致或来源时间异常时失败关闭；匿名 `force=true` 不再绕过缓存写库。
- 指数行情只使用 5 分钟内短时缓存；Worker 返回 stale 时隐藏价格并显示来源时间。
- 重仓股内存与 localStorage 均执行 12 小时 TTL；季度披露日被校验并展示，未来、超过 200 天或无日期的数据拒绝展示。
- NAV 历史按每只基金滚动保留，刷新时在同一事务中删除超出留存窗口的旧行。

### 隐私、安全与幂等

- 匿名 V8 decision、outcome、policy、watchlist 和 owner 运行状态读取统一以 HTTP 403 失败关闭；完整私人读取只接受独立 `PRIVATE_READ_TOKEN`，Admin/Worker 身份不能替代。
- 私人读取增加独立令牌指纹限流；公开 health 只返回稳定故障分类，不回显上游异常文本、路径或基金代码。
- 旧组合决策入口迁移到请求哈希、租约、冲突拒绝和原响应重放；相同 key 不会再次计算，不同 payload 返回冲突。
- Gist 检查点在通知发送前失败时会记录可补偿失败，14:40 只恢复一次；不会先发送再丢失幂等状态。
- Worker 缓存键只为白名单 CORS origin 分区，任意随机 Origin 与无 Origin 统一进入匿名分区。

### 持久化与部署门禁

- 后端仅在真实持久挂载、路径边界与可写性全部成立时报告 `durable=true`；当前零成本 Render Free 不满足条件并保持 `ephemeral / durable=false`。付费 Blueprint 已移除，避免误创建收费资源。
- SQLite 初始化校验 10 张表、167 列、命名索引、唯一约束和外键；漂移会先生成验证备份，再在迁移事务末失败关闭。
- `save_holding` / `save_decision` 使用 immediate transaction，消除读后写锁升级竞态。
- 完整 Evidence → Source Health → Holding/Policy → Decision → Outcome → Portfolio → Notification/Idempotency 账本已在本地跨进程、备份、恢复和再次进程读回。
- Pages 构建、海外精度、信号推送和策略校准要求显式 API 地址；不再静默回退旧 Free 服务。
- 部署后 smoke 要求 Pages、API、Worker 三端地址与精确源码一致，并验证 canonical wire、静态产物、指数估值降级状态和持久化门禁。

## 有意保留的边界

- 匿名浏览器只得到 HTTP 403 拒绝响应。可信 owner 会话/BFF 未完成前，首页、自选、详情中的私人动作面板明确显示不可用；长期 `PRIVATE_READ_TOKEN` 不下发浏览器。
- 每周策略校准在存在真实私人 outcome 或历史治理证据时主动阻断。这是隐私 fail-closed，不是“全部定时任务已恢复”；恢复前必须先实现认证的私人治理存储。
- 2026-09-01 的真实指数估值抓取仅得到 3/6 核心指数，脚本拒绝覆盖旧快照。现有 2026-08-21 快照在后端按 11 天超龄标记 `stale=true / usable=false` 并降级；这是发布警告，不伪造为新鲜数据。
- Worker 自然 14:30/14:40 调度、物理移动设备和生产性能只能在部署后观察；本地 dry-run 或桌面浏览器不能替代。

## 生产证据

| 门禁 | 提交前状态 | 发布要求 |
|---|---|---|
| 候选 Render Free exact SHA | IN_PROGRESS | 已创建 $0/月服务；等待最终提交部署与 SHA 核验 |
| 生产持久化 | BLOCKED / NOT_MET | Free 保持 `ephemeral / durable=false`；V8 硬门禁拒绝发布 |
| 跨服务重启读回 | NOT_APPLICABLE | Free 无持久保证，不能声称通过 |
| Pages exact SHA | NOT_RUN | `release.json` 等于发布提交 |
| Worker exact SHA / version ID | NOT_RUN | 清洁 worktree 部署并记录 version ID |
| canonical production smoke | NOT_RUN | `/quotes`、`/holdings`、official/unavailable 空值轴 |
| 自然 Cron | NOT_RUN | 下一工作日真实窗口观察 |

即使候选 Free API、Pages、Worker、canonical production smoke 等其他代码与部署门禁通过，也只能形成未发布候选；生产持久化保持 `BLOCKED / NOT_MET`，不得创建 `v8.0.0` 标签。自然 Cron 若尚未到窗口，也必须标为 `NOT_RUN`，不能伪造通过。
