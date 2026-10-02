# v9 合同冻结记录 · I18-02

日期：2026-09-30。版本号仍为 8.0.0；合同版本独立于发布版本。

## Owner 权限与会话

`contracts/owner-session-v1.json` 定义浏览器登录响应。单所有者、无公共注册；服务端通过 `OWNER_PASSWORD_HASH` 校验密码，原始密码不落盘。浏览器只能持有短期随机 Bearer，不保存到 localStorage/sessionStorage/URL/Service Worker。现有 Gist PAT 不得作为新会话凭据。

| 身份 | 可访问 | 禁止 |
| --- | --- | --- |
| 匿名 | 现有公开行情、公共摘要 | 私人 DTO、持仓与运维写入 |
| Owner/read_private | `/api/private/*`、`/api/v2/private/*` | schema、active 策略、基础设施、通知发送 |
| Owner/write_holdings | 后续专用同步接口 | 既有 Admin/Worker 写接口 |
| Owner/run_personal_analysis | 后续受限个人分析入口 | 以 Admin 身份运行或改变全局策略 |
| Private Read | 现有机器私人读取兼容 | Owner 登录、任何写权限 |
| Worker/Admin | 既有受限运维接口 | 自动成为浏览器 Owner 会话 |

首版会话最长 30 分钟、最多 8 个活跃会话，服务端只保存 Token 摘要。为保持零新增服务，首版会话及登录限频限定单 API 进程；重启、到期、退出或密码校验材料变更都要求重新登录。多进程部署前须先实现共享会话/限频，不能直接增加 workers。

初始化密码至少 15 个 Unicode 字符、最多 512 UTF-8 字节，不强制字符类别、不修剪或截断。服务端使用随机盐和 PBKDF2-HMAC-SHA256，工作因子至少 600,000 次；参数上限、验证并发与登录速率均有界。依据：[OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)、[OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)。此为标准库与当前轻量依赖下的明确选择，不宣称为 OWASP 首选的 Argon2id。

登录错误不回显密码、请求 body 或校验材料。私人/会话响应包括失败响应设置 `Cache-Control: no-store`；生产只允许已有 Pages HTTPS 来源，本地开发来源保持显式允许。退出取消在途请求、清理页面私人数据，并用 session generation 拒绝迟到结果。

## 同步与聚合

`contracts/owner-sync-v1.json` 是后续 I19-02 的写合同，不代表接口已上线。当前合同冻结 revision、request_id、409 冲突和 tombstone 等不变量；各字段 allowlist/上限在实现模型中进一步封闭校验，不能直接将任意 `changes` 写入数据库。

账户 trim 后使用 `code::account` 稳定身份；同基金跨账户份额/目标相加。首版基金行动采用 `fund_only` 分母，现金和手动资产另列；缺份额、净值或成本时明确不完整，未知不补零。成本仅在完整时按份额加权，组合实验仍要求完整目标合计 100%，不得替缺值自动均分。

本地待同步修改不是已确认 holding_version。只有云端 revision 确认后才生成追加式 Holding/Policy/Decision；旧证据不就地更新。真实持仓上传和迁移等待存储阶段出口及用户明确启用云同步。

## 机器任务与迁移

机器消费者只读已确认 revision，经受限接口形成 `revision → holding_version → decision → notification` 链。浏览器内存中的未同步状态不成为推送输入。

Worker 的自选、推送槽位、歧义送达状态、自然调度记录及 health；人工应急的同类状态；旧通知的信号前值，必须一并迁移或明确停用对应入口。人工/自然发送复用同一稳定任务键和 notification claim，不允许切换期双路真实发送。没有全部解除 Gist 读/写依赖与自然验证，不删除旧 Gist。

任务摘要区分执行与产物：`execution_status` 是 queued/running/succeeded/failed/skipped/blocked；`artifact_status` 是 fresh/stale/partial/unavailable。两者绑定 occurrence、源码/产物摘要、计划/实际时间、有效数量和原因；手工运行不覆盖自然任务证据。

## 持久化验收边界

物理存储类型、局部数据库探针、隔离本地应用链、真实宿主业务写入重启读回、独立远端恢复是五种不同证据。只能按真实 scope 报告，不能将前者升级为后者。

正式证据必须来自受保护执行流程，绑定部署/写路径代码/schema/资源/凭据配置版本，保存前后启动身份、应用写入与读回摘要及独立恢复报告。换资源、写路径/schema/配置变化或证据到期重新核验；任意 `verified=true` 文件不得放行。

`contracts/storage-release-evidence-v1.json` 冻结正式证据结构与跨字段核验要求。`tools/storage_release_evidence.py` 已实现严格验签与独立当前元数据绑定；受保护的真实操作执行器及正式 workflow 接入仍待 I18-06 完成。HMAC 证明的是受控流程来源，不替代真实操作；schema 合法或存在签名字段不等于放行。现有正式 gate/smoke 保持不变，本轮本地仓储 receipt 不签名、scope 不符，不能用于正式发布。

验签要求 32–4096 字节的独立 HMAC key，固定 key_id，32 KiB/8 层输入限制；拒绝额外字段、重复 JSON key、布尔整数、非有限数字、错误或非 UTC 日期。必须绑定 target SHA、写路径摘要、schema、资源、凭据配置 revision、受控生成器 run 和当前 read boot。时间顺序为 `write_started ≤ written < read_started ≤ read ≤ restored ≤ issued ≤ now < expires`；issued 与真实 written 起算都不得超过 7 天。旧 boot/config/run/错资源、恢复同库、摘要不一致和 unsigned/local receipt 均拒绝。

`contracts/storage-verification-context-v1.json` 定义独立当前元数据，不得从待验记录抄字段。CLI `python tools/verify_storage_evidence.py --evidence <受控签名文件> --context <受保护的当前元数据文件>` 仅做读取验签预检。专用 key/key_id 通过 `FUND_STORAGE_EVIDENCE_KEY_B64`（无 padding 的 base64url）及 `FUND_STORAGE_EVIDENCE_KEY_ID` 在受保护执行环境配置；无命令行 key、签名功能、Admin/provider key fallback。已知凭据复用被拒绝，但完整独立性仍需配置流程保证。CLI 成功明确输出 `formal_release_verified=false`，不是正式门禁通过。

生产验收记录在远端隔离与迁移未实证通过前不得写入普通 V8 表，避免被 latest/outcomes/训练/通知读取。本地旁路恢复是开发测试，不是 Turso PITR 或生产恢复演练。

2026-10-01 本地防误写子项：仓储在同一 `BEGIN IMMEDIATE` 内、任何幂等返回/写入前检查保留 provenance（`local-persistence:`、`synthetic:`、已知 Evidence 包装和 `local-acceptance-v1`）。普通库/远端拒绝这些记录及引用；独占本地库只允许当前源码、精确 namespace、schema/trigger/population/现有链与实际连接资源全部一致的原定四类 fixture。组合、Outcome、通知拒绝验收链，混合通知批次整批拒绝；决策 JSON 与关联列必须一致。普通远端 guard 不新增 marker 查询。此处不是完整生产 scope、普通读取隔离、原始 SQL/legacy 保护或虚构数据识别；不放行生产验收，也不自动删除/修复旧 fixture。源指纹变化使旧本地 receipt 失效，须保留原文件、显式创建新的隔离测试库，不得改 marker 绕过。

## AI 条件提案与静态请求 · I21-02

`contracts/nl-filter-spec-v1.json` 定义条件提案，不是模型生成的基金数据或买卖动作。解析只接受单一 JSON 根对象，拒绝外围说明、重复键（包含 Unicode 转义同名键）、未知字段、嵌套数值、字符串/布尔数字和非有限值。类型限定六类基金，排序限定七个实际收益/费率字段。收益下限允许 -100–100000、费率上限允许 0–100，单位为百分数；这些是输入执行保护，不是收益预测、市场数据上限或投资推荐，超出范围直接拒绝，不截断或偷换。输出最多 4096 UTF-16 单元，unsupported 最多 20 项、每项最多 100 UTF-16 单元且不得全空白。

UI 先取得非空且未过期的真实排行，再启动用户明确请求的 BYOK 解析。提案绑定原始需求、当前请求 generation 和当次已校验数据集，展示全部生效条件（含默认近一年排序）及数据日期；只有用户确认后才执行本地筛选。任何 unsupported 整次阻断，不按支持部分返回结果；修改需求、取消、切模式、卸载使提案和旧回调失效。确认前重新核对北京日历新鲜度。合同校验无法证明模型完整理解自然语言，人工审核仍是必要边界。

AI POST 使用共享 deadline，fetch、流式 body 与解析总计 30 秒，流式正文最多 64 KiB，结果文本最多 16384 UTF-16 单元。HTTPS、无 userinfo/query/hash、禁止 redirect、omit 浏览器 ambient credentials。错误只显示固定状态消息，不读取失败 body 或回显上游错误/需求/Key；取消、超时和重复发送均不自动重试。取消终止本地等待，不保证提供方取消计费。既有 BYOK 配置仍属用户本机配置，不能作为 Owner Token 或新机器凭据；本轮测试没有真实模型调用。

自由文本 `llmInterpret` / `generateStorySummary` 暂停，直接调用也固定拒绝且不访问网络。详情和故事页明确不可用，不恢复/显示/写入旧 `sinan_ai_text`，也不删除旧数据或其他配置；不以未核验的规则 fallback 冒充模型输出。规则解读只在评分 eligible、有限 coverage≥70%、数据非 stale，且存在信号时其 coverage 也为有限 70%–100%，才给出当前判断。缺超额不补零，真实零超额仅表示本次历史持平，历史回测不外推未来。

共享网络核心保留既有 API no-store / 204 兼容。Screener/Managers 每次集合加载有独立 12 秒总 deadline（清单、分片、body、hash），分片同时工作最多 6 个并保持清单顺序；失败/取消停止该次队列和活动兄弟请求，不影响另一消费者。只有 manifest 404 可回旧文件，503/超时/校验错误不得静默换代。Enrich 的 fetch+body 限 6 秒；精度报告限 12 秒，失败 null 不永久缓存，单用户取消与强制更新代次隔离。Screener 命中内存仍重新计算日期，Enrich 命中仍检查披露年龄，保留 source/updated/金融 null。

本节不等于全 Screen 请求卸载管理、全局并发/去重、完整精度元数据合同、第三方当前 CORS 或真实设备体验。经理日期 UI 与 Story 的后续本地改动见下节；legacy 独立评分/信号卡片的统一门禁仍待 I19/I20，不能称全页金融数据已可信。

## 2026-10-02 本地合同增量

- **仓储 scope / 物理 schema 9：**四类不可变 root 带显式 scope，同事务注册不可变旁表；默认 V8 读取先通过 production 视图再排序/limit，循环或孤立 Policy、跨 scope 祖先/派生/通知被拒绝或隐藏。旧 SQLite schema 8 迁移先验证模型、身份/摘要、投影、引用链及派生 population，并保留备份；异常整批回滚。已有 schema 9 缺少 scope 记录要求显式修复，不自动改为 production。应用仍 8.0.0；Turso 旧 schema 8 不自动迁移，远端 acceptance 写仍关闭。这不是任意 SQL/legacy 路径或虚构业务数据的全局识别系统。
- **经理采集日期：**`loadManagerDataset` 区分采集日/可得采集时间与指标日期，`valueDate=null` 不从请求时钟补造。Screen 显示历史索引年龄、来源及指标基准日未知；缺失/非法/未来日期降级，跨北京午夜在本地更新年龄，不轮询源。经理模式取消/卸载拒绝迟到回调，兼容 `loadManagers`。
- **Story 数值发布：**缺净值/成本/日变动保留 null，真实零保留；完整覆盖才发布总估值/成本/盈亏，部分定价小计明确披露。日变动聚合/排行须来源日期一致、非未来且新鲜度明确；信号/评分须独立 evidence、详情新鲜、coverage≥70%、合法来源日期，评分还须 eligible。报告生成时间不冒充金融日期，陈旧净值只作历史估值，跨账户同基金请求去重。自由文本 AI 继续暂停。
- **私人周校准：**只读 GET 最多三次，总预算 150 秒，单次上限 45 秒；网络/408/425/429/5xx 可有限重试，其他错误、错误 JSON/合同及鉴权失败不重试。正文最多 8 MiB，逐 `read1` 收紧 socket 超时，重定向/不支持 transport 固定拒绝。没有受保护私人 sink 时 workflow 明确 BLOCKED，不上传公开 artifact 或 commit 私人报告，不自动改变 active 策略。

以上是本地实现范围，不授予 I18/I19/I20 整体出口或正式发布资格。真实云写入、Owner 初始化、凭据轮换、远端恢复、自然任务和用户旅程仍须独立验收。

## 本轮验收

- 会话合同与真实路由响应匹配，机器写权限未扩张。
- 匿名拒绝、退出/撤销/到期和迟到响应测试通过。
- 存储工具报告准确 scope，正式 smoke 保持失败关闭。
- 后续同步/机器任务按上述不变量开发，未实现部分保持待办。
