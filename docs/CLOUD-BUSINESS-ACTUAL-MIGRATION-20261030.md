# 完整业务云候选与实际迁移验收（2026-10-30）

本轮请求：完成业务云仓储接线，再做实际迁移验收。应用版本仍为 **8.0.0**，物理 schema 仍独立为 9；本文不授予云写、恢复、真实发送或正式发布资格。

> 历史记录边界：本文记录原地升级与初次捕获阶段，下面的阻断/“尚未创建”陈述不改写。后续用户另行授权并创建干净候选，历史一致快照已一次导入，原写 ACK UNKNOWN 后通过原包全后像及 receipt 独立核对；旧库不改。最新范围、原始失败、331 项相关验证及仍开放的发布门禁见 [`CLEAN-CANDIDATE-ACCEPTANCE-20261030.md`](CLEAN-CANDIDATE-ACCEPTANCE-20261030.md)。不能用后续结果声称本文早期检查已通过。

## 已核实的运行状态

通过已选定的 Render `My Workspace` 只读接口，两个服务均返回 `autoDeploy=no`、`autoDeployTrigger=off`、`plan=free`：

- `fund-compass-api`：最新 live commit 为 `80d01717faeb5a21cd1240ea6d8142e3320f5ae4`。
- `fund-compass-api-v8-candidate`：最新 live commit 同上；保留 `db5ac32` 的 `blueprint_sync / update_failed` 历史，不将其改写为“从未触发部署”。

本轮未修改 Render 配置、触发部署或恢复自动部署。没有用服务 Auto-Deploy Off 推断 Blueprint Auto Sync 当前值，也没有用它推断业务已停写。既有 API、Worker、Admin、数据导入及自然定时任务的 writer 仍需逐项排空。

## 实际连接前置条件：初次检查与后续重试

限定检查的项目根目录/backend `.env`、`.env.local` 及用户此前指定的两个 Temp 候选 env 路径均不存在；当前进程也未配置 `TURSO_DATABASE_URL`、`TURSO_AUTH_TOKEN`。这不是对所有磁盘目录或平台秘密的枚举。本轮没有读取或输出任何凭据值，没有提取浏览器 Cookie、组织 API key 或连接器内部凭据。

该段为本轮初次检查记录，后续用户已恢复指定文件。不要将 Token 发到聊天。正常连接可用前，目标当前身份、schema、optional inventory、服务端能力、备份及实际迁移均为 **NOT VERIFIED**，不能以本地回环代替。

### 用户恢复配置后的真实重试

2026-10-30，用户明确指定的 Temp 候选 env 文件及独立 API 文本文件均存在、均为原始 JWT Token 格式（不是 dotenv 键值格式），且两份 Token 完全相同。只读取指定文件，没有扫描其他凭据位置，也没有输出 Token、JWT 私人 payload 或请求 Authorization。

使用用户提供的候选数据库地址及 Temp 文件中的 Token，通过现有 `tools/turso_candidate.py --timeout 15 inspect` 做一次真实只读请求，返回 `candidate_authentication_rejected`（HTTP 401）。没有改用第二个文件重试同一 Token，没有更换身份/网络/目标，没有云 DDL/DML。离线解析未发现可判定过期时间的 `exp` 字段，签名未在本地验证，故不能断言过期、撤销或绑定错误中的任何一个原因。

当时阻断从“指定配置缺失”更新为 **AUTHENTICATION REJECTED**；该历史失败不被后续成功改写。目录存在、JWT 可解析和浏览器登录均不能代替数据库认证。

Chrome 此前曾成功读到候选数据库 Overview：Active、5.57 MB、累计 Rows Written 7,574、Block Writes Off。这些只是页面观测，不证明本轮写入或当前 schema。正常页面导出动作超时，未获得可验证的 SQLite 导出文件；随后 Windows 浏览器控制因不能可靠确认当前 URL 被安全机制停止，未绕过该限制或创建新 Token。

### 新 Token 的实际只读验收

用户再次明确更新原 Temp 文件后，文件为两行地址/Token 数据，不是 dotenv 赋值。操作器只提取唯一 URL/唯一 JWT，并先核 URL 与用户指定候选一致；第一次本地格式拒绝发生在网络前，没有把该格式错误算成认证失败。随后现有 inspect 成功：schema-table 8、20 张应用表、`fund_count=28169`，`evidence_scope=database_probe_only`。没有打印或保存凭据副本。

再用实际有界 driver 的一个 DEFERRED batch 核完整 metadata，结果为：

- raw 对象 86，全部与仓库固定 schema8 + 两张已知 operational 表精确匹配。
- `_schema_version=8`、原 header `user_version=0`，两轴分别保留；不是完整 machine schema9。
- `foreign_keys=1`、仅 main、temp 空；没有设置 PRAGMA、DDL/DML 或写探针。
- `turso_candidate_probe_v1`、`universe_import_state` 都实际存在，无 `sqlite_stat1`。
- 保留原 inventory 的完整 machine 目标为 **129 > 128**，不满足现有升级合同。

因此新 Token 已可认证；当前阻断不是凭据或仅浏览器问题，而是完整迁移的结构/保全合同未满足。读成功不证明 Token 写权限、provider 写能力、已停写、耐久或恢复。

### 一致逻辑源捕获：失败，不计备份

仅尝试一次现有 `capture_scope_snapshot` + `RequestsSnapshotTransport`，显式选择 `turso-fixed-read-v1`、两张固定 optional、30 秒原预算；没有调用迁移 sender。返回 `capture_transport_failed`，没有取得经过验证的一致逻辑源镜像，也没有自动换路径重跑。不能根据这个通用错误断言认证再次失败、provider 具体错误或某一超时根因。

为私有输出新建的仓库外目录为 `D:\给人类看的\司南基金迁移备份\2026-10-30\readonly-004cd3bc304846849b08a5f2b78eb459`。ACL 构造出现 SID 解析错误；后续修正尝试被 `SeSecurityPrivilege` 权限要求拒绝，已停止，不提权、不 take ownership、不绕过限制。该目录不算受保护备份，可能需要用户处理其空目录访问权限；没有把失败目录当作已有数据删除。实际云业务数据完全未改。

## 兼容风险：已由 fresh 只读核实

`TURSO-CANDIDATE.md` 的 2026-10-02 实际只读记录同时存在 `turso_candidate_probe_v1` 和 `universe_import_state`。完整 machine 固定 raw 基线为 126；前者连 TEXT PK autoindex 占 2，后者占 1，如今仍全部保留则需 129 个对象，超出原 128 上限。

上述组合现已 fresh 核实。禁止为让验收通过而新建 probe、删既有对象、忽略 autoindex 或提高预算。

优先方案是保留原库不变，先核实零成本额度，再设计新的干净业务候选：完整核心业务行保留，旧 probe/import-state 留在原库和经过验证的备份。新资源需明确授权、来源/目标双绑定的固定逻辑导入、完整核对、切换和独立恢复，不是现有 sender 可直接完成的操作。此处只有方案，未创建新数据库。

若必须原库原地升级，probe 改 `WITHOUT ROWID` 可省一个 autoindex，但会改变物理 rowid 合同，需要显式新 profile、原 rowid 映射、固定 PK 捕获/guard/seed/恢复及新原子 receipt；不能只改 DDL/manifest。移动公开数据、保留空表不会减少固定对象数，ATTACH 也不在当前 engine 合同内。

## 真实迁移顺序与禁止替代项

1. 先完成并验证显式完整业务候选入口；旧 main 本地工厂、旧 Owner-only verifier、默认 Worker 及正式部署门禁均不放宽。此候选只承接声明的私人业务与 Worker 路径，不是公共基金、旧 V8/Admin/settlement 与现有 Render health 的整站替代应用。
2. 以正常配置做只读 inventory，核目标身份、core 版本、header 独立轴、所有固定对象及 optional 容量。不得用 `initialize` 代替 schema8 增量迁移。
3. 独立停写并排空全部消费者；保存时间窗与未完成请求。部署暂停不等于停写。
4. fresh 一致捕获原库，原始字节/typed 行/raw schema/resource/source SHA 保存在仓库外受保护的非临时位置；实际验证独立恢复。复制活跃 `.db` 漏 WAL、内存重建和临时 SQLite copy 均不是云备份恢复证明。
5. 核实际 provider 的 FK/session、固定只读 PRAGMA、REAL/atan2、JSON1/TEMP、批次容量/时长与响应上限；读成功不等于写能力。
6. 若源为 schema8，依次编译并演练 repair + scope + Owner 原包，一次发送后用独立固定 readback 验完整后像及原 receipt。原 resource/plan/packet SHA 外部保留。
7. 保持停写，fresh 捕获真实 Owner9，再编译 machine 扩展；不可用本地计算后像冒充 fresh 云快照。现有 `turso_machine_upgrade` 只有 native 本地编译/演练/固定读回计划：远端 Owner9 一致捕获、machine 单次 sender、真实响应 FSM 和完整远端 readback 尚须独立补齐并审查，不能用 local reconcile 宣称远端提交。
8. 全云 profile 通过后，在真实候选上验 Owner 0/null/tombstone、Policy、缓存准备、Evidence/Decision、原 task ID 去重及只读 receipt；合成 `sent` 不代表真实通知，自然 Cron 另验。
9. 同一真实应用记录做 write → 真实新 boot → read，并在独立恢复资源由应用读回，保存 RPO/RTO、schema/约束/digest。真实 Chrome/PWA、自然周期及正式版本发布仍是独立门禁。

发送后响应、close、超时或权限状态未知，一律保留原 snapshot/artifact/原请求及独立 SHA，仅核原记录，不自动重放。`missing` 不授予重发；401/403/429 不换身份、网络或数据库重试。没有为本轮创建付费资源、发送通知或删除旧 Gist。
