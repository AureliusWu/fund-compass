# Turso 零成本候选数据库验证

本文描述候选接入与验证，不代表生产数据库已迁移或 V8 正式发布已通过。目前没有实库凭据证据；本地 SQLite 注入测试只能验证工具行为。

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

## 合成标记写入与独立连接读回

```powershell
python tools/turso_candidate.py write-probe --candidate
python tools/turso_candidate.py read-probe --nonce <上一步返回的64位nonce>
```

写入使用随机 nonce，数据库仅保存 nonce SHA256、带用途前缀的校验 SHA256 和 UTC 时间，表名为 `turso_candidate_probe_v1`。创建表与 INSERT 在显式事务内提交，不修改应用账本，不自动清理标记。输出中的 nonce 是合成验证标记，不是数据库凭据，可用于下一进程读回。读回不会创建表，也不会打印数据库中的任意文本。

未带 `--candidate` 的写请求在连接前被拒绝。工具没有 URL/Token 命令行选项；异常仅输出固定错误码，不输出提供方报错、数据库地址、Token、SQL 参数或私账内容。退出码：`0` 为本次操作成功，`2` 为参数/环境/验证失败，`1` 为连接或执行失败。超时/断连后的写入结果可能不确定，工具不会自动重试写入。

全局超时参数放在子命令之前，例如 `python tools/turso_candidate.py --timeout 20 inspect`。成功结果始终包含 `evidence_scope=database_probe_only` 和 `formal_release_verified=false`。

两次本地命令即便连接同一远端数据库，也只证明跨连接/进程读回；不能作为 Render 重启或重新部署证据。

## 导入副本、重部署和恢复验收

1. **保留基线。** 暂停候选导入源的写入或使用 SQLite 一致性备份 API 生成副本；不能只复制正在写入的 `.db` 而漏掉 WAL。记录源版本、表结构、受保护数据的校验摘要和导出时间，私有明细留在受控存储。
2. **导入候选。** 只在副本上按 [官方迁移指南](https://docs.turso.tech/cloud/migrate-to-turso) 检查 WAL、完成 checkpoint 并关闭连接，再导入一个新数据库；不要覆盖原库。核对记录数量、关键约束/触发器、schema 版本及抽样数据。仅 `inspect` 成功不足以完成导入验收。
3. **应用回归。** 在候选环境以 Turso 配置启动应用并运行受保护的合成请求，验证不可变记录、幂等重试、失败回滚、任务状态和并发写入。恢复固定 artifact 只覆盖空目录库的启动行为；持久化后还需显式管理目录更新，不能把新 artifact 元数据当作数据库已刷新的证据。
4. **跨部署读回。** 从候选应用宿主执行写标记，保留 nonce/hash、应用 commit、部署 ID、启动时间和 UTC 时间；完成真实 Render 重启/重新部署，确认新的实例/启动证据，再在新环境用同一配置读回同一 nonce。收集部署状态与标记校验结果，不能仅凭 `durable=true` 或本地进程 PID 变化判定成功。Free 环境若无法执行所需宿主探针，保留该项未完成；不要升级付费套餐来替代验证。
5. **恢复演练。** Free PITR 保留最近 24 小时，恢复会创建新数据库，需要新地址和 Token，并占用数据库额度；不能恢复已经删除的免费数据库。用候选库演练恢复，核验恢复点前后的合成记录。参考 [PITR 文档](https://docs.turso.tech/features/point-in-time-recovery)。PITR 窗口较短，仍需单独保留可验证的逻辑导出/快照；不要自动删除旧库。
6. **切换及回滚。** 只有导入核对、真实重部署和恢复验证通过，才在约定的停写窗口导入最后增量并切换应用配置。回滚时先停写，保留远端新增数据，再恢复已校验的连接配置/数据；不能直接切回旧 SQLite 丢弃切换后的记录。凭据过期或配额耗尽应明确失败，不得退回临时库接受权威写入。

现有 `tools/persistence_gate.py` 与 `post-deploy-smoke.yml` 正式持久化门禁保持原有阻断逻辑。本工具没有放宽门禁、创建 Tag、GitHub Release、部署或切换生产配置的能力；完整的生产证据门禁仍须单独实现和验收。
