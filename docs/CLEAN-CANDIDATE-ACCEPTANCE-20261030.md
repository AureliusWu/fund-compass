# 干净云候选：历史一致快照验收（2026-10-30）

本记录承接 `CLOUD-BUSINESS-ACTUAL-MIGRATION-20261030.md`，不覆盖其认证失败、捕获失败、ACL 失败或原地升级容量不足的历史。用户批准保留旧库、在免费额度内使用新建的 `fund-compass-v9-clean`；本轮仅向独立空候选复制历史一致快照，不切换生产权威，不发布 v9。

## 本轮结论：历史候选已应用，原包完整核对通过

状态为 **HISTORICAL_CANDIDATE_APPLIED_RECONCILED**，不是正式发布或生产 cutover。

- 真实新库完整后像：126 个 raw 对象、35,063 行（包括固定 scope/Owner/schema/receipt 元数据），core schema-table9、原 header0、Owner revision0、无 optional 表。
- 操作器没有向旧源写入、删除或迁移，也没有据此声称其它 writer 已停写；捕获时两张旧运维表共 3 行，完整留在原始加密归档，不进入干净业务目标。本轮不动旧库及其运维表，不推断其它 writer 此后没有变化。
- 经原有严格派生修复合同，8 行的 11 个投影单元只做精确的一 ULP 修复；原始未修复数据完整保存在旧库与归档，未改原 payload 或采用 epsilon 容差。
- **实际 write helper 只调用一次**。原写请求返回 `transport_failed / http_status=null / outcome=unknown`，没有可靠 COMMIT ACK；没有重发、换 ID、重建包、删库或初始化目标。
- 随后仅按原身份和原包进行一次独立 DEFERRED 全量只读核对，返回 `target_image_acknowledged`、完整响应合同及 close 通过，全部 typed 行/rowid/sequence/126 个 raw 对象/FK/header/版本/原 receipt 均精确匹配，确认读回时该包后像已存在。该读事务的 COMMIT ACK **不改写** 原写请求的 ACK UNKNOWN。
- 另起独立进程，用真实有界 Turso driver 再核完整 machine profile，通过（0.800 秒）；真实 `TursoBusinessEngine.policy.read_state()` 通过（12.942 秒、保留 1 个历史策略版本）。没有请求业务变更或写入伪造 Owner/任务/sent。

三次真实原归档的本地完整演练均通过。每次仅累计 34,928 行、共享 9,677,000 VM 指令；其中完整 SQL 事务 7,694,000 指令，三次耗时 0.761306 / 0.708845 / 0.729989 秒。原 100k 行、10M 指令、30 秒、16MiB、900 参数及 256KiB cell 上限均未提高或重置。这里的本机耗时不是云端事务时长保证。

写前实际只读容量请求也通过：同目标、同 Token、标准 UTF-8、13,360,319 字节、772 步（含 BEGIN/COMMIT/ROLLBACK），固定 JSON1/MATERIALIZED/I64/Unicode/null guard 与最终包一致；其余只有自生零字符串 SELECT。它不证明 DML 时长、900 参数维度、恢复或发布资格。

原始写回包失败与独立核对成功分别记录；helper 内置的 durability/restore/formal/natural 等 false 资格没有被改为 true。当前应用仍 8.0.0，未推送或触发部署，未启用付费项。

## 原包外部身份与证据

- 编译器 SHA：`11d6d11a3c7a98990ebbd6cf40d43f5aa4e8e3deccffd9b6fc604707474666db`。
- transport SHA：`39192d7017e53af635011053858103ade04221d0df72a9d235a69b1e6bcd4342`。
- repair SHA：`f58422881c681a210c376fd877605661767ebf25e0b4b20d9962e24c21ccf9da`。
- plan SHA：`c3b6d6fe11efd4a4621c31874daeb7afcfe45ef77a52ff6025cd3df811806927`。
- 唯一写包 SHA：`00cd0a5ba329de116f4635a6c3fff2c585de312fb07d0abfcb33c3e69eff1bf0`，13,360,319 字节。
- 独立读包 SHA：`d11e9cc8bafd23744dea850d7d1f337cc958a2e094c5ee5e67f67d3161dc995b0`，8,235,951 字节。
- 独立读响应 SHA：`4eb96e62cdaf4ee49a2843ab6cbcac28790ea6db4ccb62ff823e93bb4e43504a`。
- 完整目标 typed rows SHA：`96e682abd75c370eaa5c2f4409f2af53f311210214ccdfa478a3af1c20ab1dec1`。
- 写调用开始：`2026-10-30T08:07:40.346529+00:00`；计划创建时间不是捕获或提交时间。

唯一原包另存同目录 `request-00cd0a5b.dpapi`（密文 13,360,941 字节，SHA `8ad1e06c1f23b4bb276756d619667d63a7aafe3bae36c41bef118725fadefddbb`），新文件 close 后独立读回解密与原包字节一致。此封装的 archive-SHA 字段仅表示该**包 payload SHA**，不是下文 `c927...` 的源归档 SHA；恢复仍须原 source/resource/repair/plan/packet 等外部绑定，不是执行或重发许可。所有含凭据的操作器进程已结束。

## 免费与权限边界

用户提供的账户截图显示 Starter (Free)、无付款方式；新建前数据库 1/100，存储 5.57 MB/5 GB，读取 3.66M/500M，写入 7.57K/10M，同步 5.57 MB/3 GB。显示值经过取整，不能据此计算精确剩余量。Billing 的 Current Spending 为 `-`，不是已核实的零元账单；截图未展示 Overages 开关，不能声称该开关已核实关闭。

用户随后自行创建新库并提供两个配置文件。操作器只使用这两个明确文件，不枚举其他凭据、不提取浏览器 Cookie 或连接器内部密钥；没有修改套餐、付款方式或超额设置，没有新建付费资源。没有改动 Render、Blueprint、Worker 或 Gist，也不根据部署暂停推断旧源已停写。

## 已验证的真实输入

- 源 resource SHA：`ea56eac30cd59cf7e420084178524a0cd97b539df2de6f2d70602f99db021d07`。
- 新目标 resource SHA：`3093a29e02465d49b01757b2f6c411cb55936d675294f8dc0f6815599bffdc68`，与源不同。
- 新目标写前只读检查：raw 对象 0，header 0，FK=1，仅 main，temp 空，atan2 正负零能力通过。检查本身没有设置 PRAGMA、DDL/DML 或探针。
- 新的压缩捕获仍发送固定 `turso-fixed-read-v1`，同一请求、同一源、同一 Token，无重定向、重试或失败回退；只通过 gzip 降低传输量，原有严格结构与 typed 行校验不变。
- 捕获约 3.61 秒，gzip 1,226,215 字节，解码 8,547,540 字节，21 张表、34,928 行。源 schema8/header0 与两个 operational 表均完整保留。
- 原始 SQLite image SHA：`00b2c0aad051a16b6cf15fcba44a3c02b520c99a4d9b97dda1c665bf36f3d2ec`。
- 原始 typed rows SHA：`c24654692085fcee4e88a23286b8f14f62fa0375e47617c76ede787ac1ebb99d`。
- 原始完整逻辑归档 7,485,074 字节，SHA：`c92733b2dedba15d1688d9ba261b1cbc020920c6574aafefa98fc459041972bf`。

捕获在 `2026-10-30T06:52:53Z` 前完成，未单独保留捕获起止的精确墙钟时间；不得将计划创建时间冒充捕获时间。该固定 image 是历史输入身份，不证明此后旧源没有增量，也不是 provider 物理快照或生产停写证明。

## 加密归档与恢复范围

源的全部表、raw schema、typed 行及原始 image 进入仓库外归档。保存路径为 `D:\给人类看的\司南基金迁移备份\2026-10-30\clean-import-20261030-3093a29e\source-c92733b2.dpapi`，同目录的 `MANIFEST.json` 仅保存非敏感身份及范围证据，不包含 Token 或业务行。

D 盘只读核实为 Fixed / NTFS / Healthy。新工具仅使用 Windows DPAPI CurrentUser、禁止 UI；不使用 LOCAL_MACHINE、不改 ACL、不提权，不读取任何既有凭据密文。新文件仅写密文、CreateNew、不覆盖，fsync/close 后独立读取解密并核三 SHA。另起无网络、无数据库凭据的新 Python 进程再次解密、严格重建全部源结构及 typed 行，重编归档字节完全相等。

密文 7,485,693 字节，SHA：`7aaadfed5ece85491f1c96cd534803b33d9d72936098a64e25c6060be50f05b1`。这是当前 Windows 用户/密钥恢复边界内的本地验证，不是跨机、provider 独立恢复、RPO/RTO 或防删除保证。Windows 的 0600 不作为私有 ACL 证据。

DPAPI 审查曾发现 `NUL .txt` 等 Windows 保留设备名的 basename 空格边界；先修复并增加网络/加密/文件访问前拒绝测试，再进行真实归档。此前 ACL 失败目录没有被重试提权、接管或删除。

## 导入前容量门禁

第一版完整请求在纯本地生成时被拒：23,051,515 字节、771 个 batch steps，超过固定 16,777,216 字节上限；未发送任何写请求。保留该原始失败，不提高请求、参数、行数、对象数、指令或时间预算，也不拆为多个非原子写事务。

随后仅对新 clean-target profile 的编码做窄范围优化。旧 repair/scope/Owner profile、原固定源码 pins、旧库及主应用工厂不修改。相同历史归档、明确 repair/plan/packet 身份、本地完整演练、独立审查通过后才执行前述一次导入；unknown 后只核原完整后像及回执，没有自动重发。

中间版紧凑 profile2 曾将真实快照写包降至 13,510,189 字节、读包 8,384,149 字节，随后被前述最终 `00cd...` 包（13,360,319 / 8,235,951 字节）取代；所有版本均不放宽 16MiB。新编码仅适用于原大小分块中全为 native integer、无 NUL text、null 的情形；REAL/BLOB/NUL 或超出原 256KiB 单参数限制时整块保留旧 exact 路径。普通文本标准 UTF-8 传输不改变字节语义；旧 profile 的编码与 pins 未改。CTE INSERT 的原生 affected count 单独保持严格验证，不把 Python cursor.rowcount=-1 当作实际写入零行。

该版实际完整演练又发现一个本地流程问题：初始 validate 加上 rehydrate 的双重完整重建，将同一 34,928 行源扫描了三遍，累计第 100,001 行触发原 100,000 上限。观察时为 16.273 秒、累计 typed 行编码处理计费 21,651,369 字节（`_Budget.body_bytes`，不是 wire request）、3,655,000 VM 进度，**实际导入 SQL 尚未开始，云端未发送写请求**。这是重复处理预算问题，不是 Token、16MiB 或 provider 故障。修复须去掉冗余重建，仍保留原六元组（body/facts/recipe/specs/request specs/private archive）与来源重建的逐 native 比较、独立完整后像及所有原预算，不以重置计数、提上限或静默洗净伪造 packet 替代。

最终修复对调用者实际 snapshot 先做完整 strict source build，仅对刚生成的 canonical packet 做完整 native/frame/control/pipeline 结构检查，再比对所有外部身份及输入 artifact；不重复对刚生成图做相同的全 SQL 扫描。归档序列化的独立边界由严格 JSON/base64 往返、metadata/raw 逐 native 相等、image 字节和 SHA 相等保留。外部 packet 的 public getter 仍从其私有归档完整重导，不能用 shape-only 验证外部包。演练仍比较输入原六成员，再独立读取全部 native 数据核 typed digest。plain 域比较仅将已限定 integer/text/null 的等价比较化简；REAL/BLOB/NUL fallback 保持旧 matcher。新增大规模回归还曾按原 10,001,000 VM 上限正确中断，原失败与最终通过没有混记。

## 验证范围

本轮最终相关本地回归为 184 通过、0 fail/error/skip（186.248 秒）：compiler 43、plainpack 19、真实 owned-loopback transport 22、只读容量 probe 32、DPAPI 38、业务 engine/候选 HTTP 30。另源捕获及原 transport 147 项通过（11.80 秒），两组文件不重叠，合计 331 项相关验证；不是宣称本轮重新跑过全部 backend 或远端 CI。

本地出现现有 Starlette/httpx 弃用提醒及两项 JUnit record_property 格式提醒，不是失败或 skip。本轮未将两个配置文件、JWT、私人行、原始镜像或请求包写入测试日志、Git 或 CI；生成的私有源与包文件仅保存 DPAPI 密文。已观测的闭合失败代码及范围、原始 JUnit 在仓库外同目录保留。没有改 Render/Blueprint/默认 Worker；没有用只读业务成功冒充应用业务 write→真实新 boot→read 或 provider 独立恢复。

## 尚未由本轮关闭的门禁

生产源停写与最终增量、生产切换、provider 独立恢复、真实新 boot 后应用读回、真实 Chrome/PWA、自然定时周期与通知送达、正式 v9 发布仍独立保留。新 Owner 工作区初始 revision0 不代表浏览器或旧 Gist 的持仓已同步。不得通过远端虚构 Owner 持仓、任务或 sent 记录制造通过。

应用版本仍为 8.0.0；本轮不推送，不触发部署，不删除旧库或旧 Gist。
