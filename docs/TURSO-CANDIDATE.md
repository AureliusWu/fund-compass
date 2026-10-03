# Turso 零成本候选数据库验证

本文描述候选接入与验证，不代表生产数据库已迁移或 V8 正式发布已通过。2026-10-01 已用用户明确提供的本机配置完成一次真实候选库只读 `inspect`；本地 SQLite 注入测试与真实只读连接分开记录，均不替代应用耐久/恢复验收。

## 费用和范围

2026-09-28 核对的 [Turso 官方定价](https://turso.tech/pricing)：Free 为 $0/月，无需信用卡，含 100 个数据库、5 GB 存储、每月 5 亿行读取、1000 万行写入和 3 GB 同步流量。保持 Free 套餐且不要启用付费升级或 Overages；用量超限的服务阻断需要监控。套餐内容可能变化，创建时以账户页面为准。

远端数据库解决应用宿主临时磁盘的数据丢失问题，不保证 Render 永不休眠、网络永远可用，也不保证所有历史任务已补跑。权威写入必须提交到远端；关键账本不能依赖尚未 push 的本地副本。

## 候选准备和环境配置

1. 在 Turso Free 账户创建独立候选数据库，或从已核验的 SQLite 快照导入新数据库。候选库与现有正式库分开；保留原库和恢复资料。使用数据库级 Token，避免使用覆盖所有数据库的凭据。
2. 将以下配置放入运行候选工具/候选后端的环境或平台 Secret 中。不要写进仓库、URL 查询参数、命令行参数、截图或 CI 输出：

   | 环境变量 | 值/用途 |
   | --- | --- |
   | `FUND_DB_BACKEND` | `turso`，显式选择远端适配器 |
   | `FUND_DB_PERSISTENCE` | `turso_candidate`，显式限定为候选持久化模式 |
   | `TURSO_DATABASE_URL` | 候选库的 `libsql://` 或 `https://` 地址，仅从环境读取 |
   | `TURSO_AUTH_TOKEN` | 候选库数据库 Token；只读检查可使用只读 Token |

3. 工具调用 `backend/database/turso.py` 的 `connect(url, token, timeout)`，不会调用应用启动函数。只有显式的 `initialize --candidate` 会创建或采纳已符合 V8 合同的业务 schema；正常应用启动仅校验、不自动迁移。安装项目后端依赖后，从仓库根目录执行下文命令。
4. 后端接入仍需通过应用回归：连接/事务、外键、不可变触发器、幂等、并发、批量导入、schema 验证和恢复路径。Turso Cloud 有 SQLite 差异，不能照搬本地 WAL、`busy_timeout`、文件备份等设置；迁移版本使用 `_schema_version(singleton=1, version)`，本地 SQLite 仍使用 `PRAGMA user_version`。参考 [Cloud 限制](https://docs.turso.tech/cloud/limitations)。

`--candidate` 表示操作者已确认环境指向候选库；它无法验证你的账户资源命名或阻止错误配置指向正式库。写入前先核对平台中所选数据库，配置仅该库可写的 Token。

## 显式初始化候选 schema

```powershell
python tools/turso_candidate.py initialize --candidate
```

空库会在单个原子批次中创建 V8 schema 与 `_schema_version`。已存在的兼容 V8 候选库可重复执行且不重写数据；未知表、新版本或不兼容结构会显式失败，不会自动修复或删除。建议先执行 `inspect`，确认资源后再初始化。

## 只读检查

```powershell
python tools/turso_candidate.py inspect
```

只读执行 `SELECT 1`，读取 schema 版本、应用表数量以及公开基金目录 `funds` 的数量。没有 `funds` 表时返回 `null`，不会伪造为零；空库 schema 版本可为 0。不会读取私有决策、持仓、通知或审计记录，不会自动启动迁移。`fund_count` 是一次实际聚合查询，不适合作为高频保活任务。

### 已验证的无浏览器替代路线（2026-10-01）

数据库 SQL 访问不依赖 Dashboard、MCP OAuth 或组织级 CLI 登录。使用已有候选数据库 URL 与数据库 Token，经子进程环境传给上述工具即可；不要为此枚举浏览器密钥、读取登录 Cookie 或降低 OAuth 校验。配置只从用户明确提供的确切文件读取，本轮未在仓库保存凭据，也未把值放入命令行或输出。

本次结果：`connectivity=true`、`schema_version=8`（`schema_table`）、`table_count=20`、`fund_count=27947`、`evidence_scope=database_probe_only`、`formal_release_verified=false`。没有执行 DDL/DML、读取私人账本、初始化/迁移 schema、写标记、轮换/撤销 Token 或更改套餐。现有凭据可读不证明其写权限、最小权限、有效期或已完成旧 Token 轮换；费用配置也仍未核验。

本地已实现不可变 scope 旁表与默认 V8 读取隔离，物理 schema 因合同变化独立升至 9，应用版本仍为 8.0.0。SQLite 8→9 迁移保留原 payload/ID 和备份；已有 schema 9 缺失 scope 元数据拒绝自动重分类。线上仍是 schema 8，尚未做受控增量迁移；新代码会拒绝该旧库，不能直接推 main 自动部署，也不能用重复 `initialize` 冒充迁移。远端验收写入、独立恢复与应用跨重启证据仍未完成。

### 2026-10-02：元数据核对与离线升级演练

真实候选库只读结构核对：54 个非 SQLite 内置核心 schema 对象没有缺失或 DDL 差异，版本仍为 8。额外两张表分别为既有 `turso_candidate_probe_v1` 和 `universe_import_state`，DDL 与仓库固定定义一致；无其他额外对象。仅查询 schema/版本元数据，不读私人账本记录，不输出 DDL 值、地址或 Token，没有 DDL/DML 或远端应用迁移。这不是全体业务数据、并发、恢复或耐久证明。

新增入口只处理显式本地快照，不会自动导出或连接云库：

```powershell
python tools/turso_scope_upgrade.py plan --source <closed-snapshot.db> --source-kind remote-schema-table
python tools/turso_scope_upgrade.py rehearse --source <closed-snapshot.db> --source-kind remote-schema-table --expected-plan-sha256 <plan摘要> --expected-backup-sha256 <逻辑备份摘要>
```

本地 header 版本 8 使用 `--source-kind local-header`，不自动猜测来源；输入必须是一致、关闭的 SQLite 快照，存在 WAL/SHM/journal、坏结构/JSON/引用链、漂移或超限时拒绝。工具只读输入，在私有内存执行仓库固定 DDL；验证 typed 行、ID/hash/投影/完整派生链，保留 payload、rowid 和序列，并将逻辑备份独立恢复、再次升级和仓储读回。计划绑定输入字节、逻辑行、代码、合同与备份摘要，不接受旧计划代替当前核验。

输出 scope 固定 `local_turso_schema_migration_rehearsal`，`remote_applied=false`、`remote_restore_verified=false`、`formal_release_verified=false`。默认 `core-only` 仍拒绝额外用户对象；显式 `--operational-profile known-operational-v1` 只接受上述两张固定辅助表的零张、一张或两张组合，并验证精确 DDL、完整 typed 行、rowid 和序列在备份/恢复中保留。profile 与辅助表生产者源码摘要纳入计划绑定；未知表、额外索引/触发器/视图和旧计划均拒绝，不使用前缀或表数量豁免。快照含这些表时，plan 与 rehearse 必须使用相同的显式 profile。

当前工具没有 apply、远端导出、原子前像/receipt/reconcile、独立远端恢复或发布能力；不能直接对真实候选库执行升级。

### 2026-10-02：受限只读快照模块

`backend/database/turso_scope_snapshot.py` 仅提供显式注入 transport 的 schema-8 捕获函数，没有默认网络实现、凭据发现、落盘或 apply。固定单批 Hrana 3 查询在同一 SQL 事务内读取闭集结构、typed 行、rowid/sequence 和完整性信息，只有确认提交、autocommit 和关闭成功后才返回私有内存 SQLite。只接受明示的固定辅助表 inventory，不执行远端返回的 DDL。

默认 `query_mode_profile='query-only-v1'` 设置并严格要求远端 query_only=1；失败不自动降级。真实候选首次拒绝该赋值（`SQL_PARSE_ERROR`），因此增加显式 `turso-fixed-read-v1`：只发送仓库固定读取/事务语句，不含远端 DDL/DML/PRAGMA 赋值，仍保留全部事务、结构和 typed 数据门禁。兼容 profile 的 `query_only_observed` 必须为真实整数 0 或 1，`server_write_protection_verified=false`，不能用重建内存连接的 query_only=1 冒充远端写保护。

响应最多 64 MiB、100,000 总行、单 cell 256 KiB、30 秒；transport 必须另外保证单次发送、禁止重定向和阻塞读取预算。官方协议实现中的 optional `replication_index` 和标准无 padding BLOB 编码按固定类型支持，未知字段仍拒绝，参见 [官方 Hrana 实现](https://github.com/tursodatabase/libsql/blob/main/libsql-hrana/src/proto.rs)。

`consistent_sql_snapshot=true` 只表示本次历史 SQL 快照一致，不是应用时锁内前像。`remote_verified`、`remote_applied`、`remote_restore_verified`、`formal_release_verified`、`migration_rehearsed` 和 `apply_preimage_verified` 均保持 false。本地快照/恢复演练不代表远端升级、独立恢复或正式耐久资格；实际捕获结果另记执行记录。

2026-10-03 已实际使用兼容 profile 完成一次候选只读捕获：31,957 行、21 张表（含 SQLite sequence），真实 query_only=0。快照保存在仓库外、仅当前用户/SYSTEM 可访问的只读文件中；本地 8→9 演练验证旧行不变、独立逻辑恢复、仓储读回及源文件不变。真实云端 schema 未改变；此证据不关闭远端迁移、独立远端恢复或跨部署耐久门禁。摘要与测试见 [执行记录](V9-EXECUTION-LOG.md)。

## 合成标记写入与独立连接读回

```powershell
python tools/turso_candidate.py write-probe --candidate
python tools/turso_candidate.py read-probe --nonce <上一步返回的64位nonce>
```

写入使用随机 nonce，数据库仅保存 nonce SHA256、带用途前缀的校验 SHA256 和 UTC 时间，表名为 `turso_candidate_probe_v1`。创建表与 INSERT 在显式事务内提交，不修改应用账本，不自动清理标记。输出中的 nonce 是合成验证标记，不是数据库凭据，可用于下一进程读回。读回不会创建表，也不会打印数据库中的任意文本。

未带 `--candidate` 的写请求在连接前被拒绝。工具没有 URL/Token 命令行选项；异常仅输出固定错误码，不输出提供方报错、数据库地址、Token、SQL 参数或私账内容。退出码：`0` 为本次操作成功，`2` 为参数/环境/验证失败，`1` 为连接或执行失败。超时/断连后的写入结果可能不确定，工具不会自动重试写入。

全局超时参数放在子命令之前，例如 `python tools/turso_candidate.py --timeout 20 inspect`。成功结果始终包含 `evidence_scope=database_probe_only` 和 `formal_release_verified=false`。

两次本地命令即便连接同一远端数据库，也只证明跨连接/进程读回；不能作为 Render 重启或重新部署证据。

### 脱敏失败分类（2026-10-01）

只有适配器实际观察到合法整数 HTTP 状态时，CLI 才返回下列固定码；不读取非 200 响应正文，不从提供方异常文本或任意 `status_code` 属性推断分类。分类不改变失败退出码 `1`，也不新增成功、写入确认或撤销确认字段。

| HTTP 观察 | 固定错误码 | 能说明的边界 |
| --- | --- | --- |
| 401 | `candidate_authentication_rejected` | 本次鉴权被拒；不能区分过期、错误配置、撤销等原因 |
| 403 | `candidate_access_denied` | 本次访问被拒；不证明旧 Token 已撤销 |
| 429 | `candidate_rate_limited` | 本次收到限流状态；不会自动重试或启用付费超额 |
| 500–599 | `candidate_service_unavailable` | 本次收到服务端错误；不证明请求未执行或写入可安全重放 |
| 其他状态、传输/协议错误或不可信异常 | `candidate_operation_failed` | 原因未知；不解析错误文本，不输出地址、凭据或私账 |

HTTP 错误保持 `sqlite3.OperationalError` 兼容性。失败连接被标记为不可继续使用，后续 SQL、回滚和关闭不重放请求。响应/会话关闭失败不得掩盖原始 HTTP 或协议错误；独立关闭失败同样脱敏。提交、批量写入或关闭失败时，CLI 不输出成功 JSON 或 `committed=true`；这不能倒推数据库一定未提交，应独立核对结果后再决定后续操作。

这些码用于诊断，不是凭据轮换验收。撤销结论仍需要平台明确操作结果、准确作用范围，以及同资源的新旧凭据对照；只读成功不证明写权限或耐久。

## 导入副本、重部署和恢复验收

1. **保留基线。** 暂停候选导入源的写入或使用 SQLite 一致性备份 API 生成副本；不能只复制正在写入的 `.db` 而漏掉 WAL。记录源版本、表结构、受保护数据的校验摘要和导出时间，私有明细留在受控存储。
2. **导入候选。** 只在副本上按 [官方迁移指南](https://docs.turso.tech/cloud/migrate-to-turso) 检查 WAL、完成 checkpoint 并关闭连接，再导入一个新数据库；不要覆盖原库。核对记录数量、关键约束/触发器、schema 版本及抽样数据。仅 `inspect` 成功不足以完成导入验收。
3. **应用回归。** 在候选环境以 Turso 配置启动应用并运行受保护的合成请求，验证不可变记录、幂等重试、失败回滚、任务状态和并发写入。恢复固定 artifact 只覆盖空目录库的启动行为；持久化后还需显式管理目录更新，不能把新 artifact 元数据当作数据库已刷新的证据。
4. **跨部署读回。** 从候选应用宿主执行写标记，保留 nonce/hash、应用 commit、部署 ID、启动时间和 UTC 时间；完成真实 Render 重启/重新部署，确认新的实例/启动证据，再在新环境用同一配置读回同一 nonce。收集部署状态与标记校验结果，不能仅凭 `durable=true` 或本地进程 PID 变化判定成功。Free 环境若无法执行所需宿主探针，保留该项未完成；不要升级付费套餐来替代验证。
5. **恢复演练。** Free PITR 保留最近 24 小时，恢复会创建新数据库，需要新地址和 Token，并占用数据库额度；不能恢复已经删除的免费数据库。用候选库演练恢复，核验恢复点前后的合成记录。参考 [PITR 文档](https://docs.turso.tech/features/point-in-time-recovery)。PITR 窗口较短，仍需单独保留可验证的逻辑导出/快照；不要自动删除旧库。
6. **切换及回滚。** 只有导入核对、真实重部署和恢复验证通过，才在约定的停写窗口导入最后增量并切换应用配置。回滚时先停写，保留远端新增数据，再恢复已校验的连接配置/数据；不能直接切回旧 SQLite 丢弃切换后的记录。凭据过期或配额耗尽应明确失败，不得退回临时库接受权威写入。

现有 `tools/persistence_gate.py` 与 `post-deploy-smoke.yml` 正式持久化门禁保持原有阻断逻辑。本工具没有放宽门禁、创建 Tag、GitHub Release、部署或切换生产配置的能力；完整的生产证据门禁仍须单独实现和验收。
