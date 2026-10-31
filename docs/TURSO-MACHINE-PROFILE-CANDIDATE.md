# Turso 完整机器 schema profile 候选

应用仍8.0.0。本模块不选择环境凭据、不打开配置中的数据库、不迁移、不写DDL、不挂main路由，也不授予业务写入或通知权限。原core/Owner-only公开verifier和本地SQLite工厂继续拒绝完整云machine组合，不能用本模块放宽旧入口。

## 独立接口

- `machine_profile_manifest(optional_tables=())`：只在可信内存SQLite中从仓库固定DDL生成不可变四列inventory（type/name/tbl_name/sql），包含全部固定table/index/view/trigger和实际SQLite隐式对象，返回确定的manifest SHA。它不是数据库身份、源码认证或来源证明。
- `machine_profile_reads()`：固定12组有界SELECT/PRAGMA，不收输入SQL、DDL或表名前缀。schema名称最多256字节、单DDL最多16KiB、raw inventory最多128个，版本/marker只取最多两行的原生整数0/1投影，不读取业务持仓payload。
- `inspect_machine_profile_snapshot(cursors)`：为受控compiler/rehearsal复用相同固定结果合同；纯解析不认证真实传输或云来源。
- `verify_turso_machine_profile(conn)`：只接受真实`database.turso.Connection`、显式HttpLimits（总预算至多30秒、响应至多4MiB）、无活动事务。以一次`execute_batch(atomic=True, begin_mode='deferred')`读取同一元数据快照，前后核预算，不创建对象、修复marker、重试或改用SQLite。调用者拥有显式URL/Token、连接及关闭，关闭失败须由调用者保留为失败，不能冒称远端事务关闭或耐久证明。

## 完整闭集与真实对象预算

必需core schema-table9、完整Owner五表、analysis三表及六个immutable trigger、machine journal及两个immutable trigger、production视图/固定scope结构和所有隐式索引。schema-table版本必须9；`PRAGMA user_version`是独立轴，可为0/8/9并只读保留，不能把合法迁移目标保留的header8误判为业务schema8，也不能把header9当作完整schema证明。

远端必需`_schema_version`后基线是 **126 raw对象**（含`sqlite_sequence`），不是本地可选版本表之前的125。原128扫描上限不增加。

| 逐表固定可选对象 | 增加的raw对象 | 与基线合计 |
| --- | --- | --- |
| `sqlite_stat1` | 1 | 127 |
| `universe_import_state` | 1 | 127 |
| 上述两者 | 2 | 128 |
| `turso_candidate_probe_v1`（含其TEXT PK隐式autoindex） | 2 | 128 |

probe与任一其他optional同时存在会达到129，三者亦超限，明确拒绝；不隐藏、删表或忽略autoindex来凑预算。`sqlite_stat4`、其它额外对象、相似名称和不一致固定DDL都拒绝。planner/probe/import内容不读取。

只认唯一合法production scope行，远端acceptance元数据不进入这个production-only profile；完整固定scope视图/trigger仍核DDL，不以marker代替隔离。Owner head与changes的MAX/不同revision数量和类型须一致；analysis/machine固定marker、foreign_keys=1、无附加schema/临时对象亦独立核验。它不认证任意raw-SQL全账本数据的正确性，不检查每份业务历史或赋予当前Policy/行情资格。

## 本地验证及未完成资格

测试实际使用有界Turso driver，经拥有的loopback HTTP Hrana模拟器执行真实SQLiteSQL/事务/结果编解码。核一次DEFERRED读取、原header0/8/9、完整固定对象和所有允许optional组合，保证数据库文件SHA无变化；负向覆盖旧版本、部分对象、坏marker/head/scope、未知/超量/超长对象、FK关闭、temp/attach、活动事务、无显式/过大预算、driver错误脱敏及不重试。纯解析另拒绝bool/float冒充原生整数marker。

这是实际本地HTTP/协议证据，不是实际Turso provider支持、JSON1/TEMP能力、云配额、迁移提交、持久性、独立恢复、Cloudflare自然任务或正式发布证明。inspection的durability/restore/formal标志始终false。现阶段由独立受控迁移compiler/rehearsal消费，不能靠只读profile宣称机器业务仓储已可云运行。
