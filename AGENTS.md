# AGENTS.md

## 项目识别

- 目录名：`fund-compass`
- 中文名：司南基金
- 用户说「司南基金」时，指本项目。
- 线上形态：前端 PWA + 后端 API 的个人基金选基、择时、持仓分析工具。

## 项目定位

司南基金面向个人投资者，解决「买哪只基金」和「什么时候买/卖」两个问题。它不是机构量化平台，也不做自动交易。所有评分、信号、估值、回测、AI 解读都应保持中立，并明确仅供参考。

## 技术结构

- 前端：Vue 3、Vite、TypeScript、Pinia、Vant 4、ECharts、vite-plugin-pwa。
- 后端：FastAPI、Python 3.12、SQLite。
- `frontend/`：前端页面、组件、状态、工具函数。
- `backend/`：API、数据源、策略算法、SQLite。
- `tools/`：离线补全、估值推送、通知脚本。
- `.github/workflows/overseas-accuracy.yml`：独立的海外估值预测落账、精确净值结算、校准和审计流水线。
- `worker/`：Cloudflare Workers Cron 14:30 自选决策推送；Secret 只存 Cloudflare，不写入仓库。
- `docs/`：部署、路线图、推送配置、迭代记录。

## 常用命令

```bash
cd frontend
npm run test
npm run type-check
npm run build

cd backend
pytest
uvicorn main:app --reload --port 8000
```

## 核心约定

- 后端运行时保持轻量，不引入 pandas/numpy；算法维持纯 Python。
- 从蜉蝣基金借鉴能力时，在本项目用 TypeScript 和现有结构重新实现。
- 修改估值、回测、评分、收益口径时，必须补/改测试。
- QDII/海外基金要区分「最新公布净值涨跌」和「下一净值估算」。
- 海外估值必须先保存当时预测，再按同一 `target_nav_date` 的官方净值结算；禁止拿下一条净值顺延配对，样本不足 20 条不得自动晋级。
- 海外精度新鲜度须绑定同code/model_version的有效账本记录；有样本用自身settled_at，零样本仅用自身observed_at，不借pipeline全局时钟、另基金/版本、registry候选训练时间或updated_at续期。缺失/无区/坏日期保持未知，96小时与5分钟未来偏差门槛不变。历史精度卡与估值附件复用同一判定，过期/未知指标必须明示历史用途；页面停留与visibility恢复须重核并清理时钟/请求。现仅observation-target-v2三轴账本，不把该合同泛化到其它同日估值；旧持久估值缓存/旧PWA仍需独立验收。
- 数据新鲜度属于估值口径的一部分：严重过期时隐藏精确涨跌值并明确显示“数据过期”。
- 温度统一表示拥挤与短期回撤风险，数值越高越热；分析术语统一使用估值分位、趋势状态、动量状态、数据覆盖率和证据强度。
- 新计划遵循 `docs/NAMING-CONVENTIONS.md`：SemVer 用于发布、`Iteration N` 用于周期、`I{N}-{NN}` 用于工作项、`P0-P3` 只表示优先级；历史编号不重写。
- Iteration 17 起所有后端写接口必须声明 Admin/Worker 权限；模型比较只读且样本门槛未满足时不得自动晋级或调参。
- Iteration 18 的 Owner 会话生命周期是受限例外：登录须验证独立密码，会话只授权声明的私人 scope，不能进入既有 Admin/Worker 运维写接口；后续持仓写入须显式 Owner scope。Owner Token 仅浏览器内存，退出/到期清理私人响应并拒绝迟到请求。当前会话/登录限频仅单 API 进程，部署必须 `--workers 1`；多进程前先实现共享状态。
- Iteration 18 本地验收的 `local-persistence:` / `synthetic:` provenance 为保留用途。仓储写入只在同事务核对独占本地库、当前源码与精确 fixture 后例外允许；普通库/远端及通知/结算/组合派生写拒绝验收链。不可变 scope 旁表与 root 写入同事务注册，默认 V8 读取在排序/limit 前经过 production 视图，跨 scope 引用拒绝；不得以基金代码、展示文案、环境布尔开关或仅有 marker 表代替隔离。此为本地实现，不开放远端验收写入，也不覆盖任意原始 SQL/legacy 读写。
- 物理 schema 9 独立于应用版本 8.0.0。SQLite 8→9 增量迁移须保留备份并验证旧链；已有 schema 9 缺少 scope 元数据不得自动补为 production。Turso 正常启动只读校验，旧远端 schema 8 在受控迁移前拒绝启动；禁止直接推 main 触发不兼容部署，禁止用 initialize 冒充增量迁移。
- Iteration 19 的本地持仓编辑不代表云端确认：`local_pending` 不能作为 holding_version/revision，旧 Gist 上传不得解除当前行动的待确认门禁。PAT 与明确同步同意分开；默认不上传私人输入，撤销及迟到响应必须失效。仅关注、真实零份与未知份额保持不同语义；账户更名/删除保留 tombstone，已观察到的旧本地副本不可覆盖更新后的存储。
- `createOwnerSyncHttpTransport` 仅封闭三类Owner同步操作，构造不发请求/开库；Token仍只在ownerSession内存。API端点指纹不是数据库身份或耐久证明，adapter不等于UI已启用。严格原始响应、有界正文及统一超时必须保留；401只撤销对应旧generation，不得清掉后来登录。上传还需控制器显式consent，未知写保留outbox且不能自动重发；确认revision不得当作Holding/Policy/Decision版本。
- main的Owner同步工厂仅接受普通路径下已有、扩展完整的本地SQLite；Turso、所有file:URI/内存/UNC/缺失或不兼容库固定拒绝，不创建文件或补DDL。URI只读语义不能被重解释为rw；原schema8远端启动拒绝不变。可选_schema_version先核固定DDL，再限两行0/1类型/值投影；不能用版本行代替完整schema校验。正常启动已有的universe_import_state与sqlite_stat1仅按逐表固定DDL兼容，不读取其数据、不自动创建、不禁用optimize；sqlite_stat4、未知对象及相似名称仍拒绝。CORS固定来源和请求header闭集不授予Owner权限，主应用本地ASGI测试不等于实际启动/云迁移或正式发布。
- `service/owner_sync_turso.py` 是显式 URL/Token 的真实 HTTP 候选仓储，main 仍不导入或启用；不得放宽上述工厂。仅已有 core schema-table 9 与完整 Owner 扩展可进入；单次原子 batch 内保存业务结果/合法并发的原包 409 回执，TEMP 仅存内部布尔状态并在提交前删除。真实未知提交不重发，回执缺失不证明回滚。固定前后像、MAX/absence、锁内容量与原生 affected rows 必须保留；选中记录结构一致性不是任意原始 SQL 全库防篡改证明。loopback HTTP/SQLite 通过不代表实际 Turso JSON1/TEMP 支持、云耐久或恢复。
- Owner 候选控制器对准备、观察与已决结果绑定原包 hash；发送/取消/结束不得误操作另一标签页替换的原包。重载后的已决槽位须当前会话核对匹配回执才可结束；结束已决请求失效完整基线、下次从 0 拉取，但保留已观察 head 的防回退下限。未知状态仍只保留原包并手动核对，不因基线刷新或跨标签页状态而自动重发。
- `stores/owner-workspace.ts` 已接真实 watchlist 全部编辑与自选页本机工作区 UI，仅启用纯本地链路。它与 outbox 共用 IDB，物理 v3 保留原 slot/working_copy/import_receipts，增加 local_metadata；versionchange 与缺项 strict 初始化仍是两次提交，中断或坏结构固定拒绝、不重建。业务写须空槽，在同一 strict 事务核完整前像并推进独立 localVersion、空槽 epoch 和最近本机回执；二者不是云 revision 或 HoldingVersion。v3 的新版 outbox 路径禁止 null→prepared，保留已有原包核回执/结束；后续云上传必须另做同工作区原子制包，不能移除守卫冒充兼容。该代码不能控制旧 PWA 或任意原始 JS。
- 物理 v4 是另一个显式、尚未接 UI/网络的共同基线/原子制包入口：只对原 target 已采用且空槽的完整 v3 显式升级，默认仍 v3；已有完整 v4 可 existingOnly 重开，缺 sync_metadata/current 不补。versionchange 与 strict 初始化不是单事务。v4 的完整 local state 含 sync 元数据，所有实际本机 writer 前像亦绑定完整 B/epoch；旧 outbox 在 v4 只读，全部 CAS 拒绝，不能清包或 unknown 重发。初次 link 只接同 key 业务完全相等/云端独有基金，差异整批拒绝；manual/tombstone/revisions 完整留 B，不伪称手工资产已迁移。制包只从已应用 B→L 推意图，缺已链接基金行拒绝而非删除，普通 patch 只 guard 编辑字段及 kind/deleted，类型/删除用全前像。crypto/原包恢复在事务外、最终 strict 同库核完整前像并同时存原包/绑定；prepare/cancel 本机丢响应只手动核原 id/hash，不重放。重载重算原 envelope 与原包 SHA，不能用重制包替换原字节；wire DTO 数字零规范化不改 B/L 的负零。所有 hash 都不是身份认证或防任意 raw-JS 重封。prepared 才能同库取消；发送、完整固定 upper 拉取、三方冲突/ack 与真实会话 UI 尚未接通，所有 IDB 仍云端未确认，不开放 main Turso 或据此关闭 I19。
- 固定 owner-authority 元数据定位须先于业务 LS/Gist 读取。显式启用要求本轮导出、重新选择同一完整 SHA 文件、严格 legacy codec、实际两槽 source/memory/generation 守卫；adoptLocal 自行重解原文并核备份 SHA，不能只信调用者 seed。指针 legacy→activating→active 与工作区不是跨库原子；中断只凭原文件、ID/hash/target 及已保存 adoption 手动核对，不重新导入。active 必须 existingOnly 打开原 target，丢库/坏结构/端点变化不回退 LS 或新建。LS seen hint 仅检测已观察 locator 丢失，不能选择权威，也不证明全部站点存储清除后的身份。IDB 模式拒旧 Gist，并整体保持云端未确认，不能由历史 pending=false 释放行动。
- 本机编辑/复导失败保留本轮原 id/hash，只能显式核最近同版本回执，不重放；handle 关闭后 existingOnly 重开并核 adoption。最近回执覆盖即 unknown，刷新只读取当前完整 active 状态，不等于核定刷新前丢失的请求标识。备份只含自选/账户持仓、0/null、tombstone、原时间或 null、两槽原文与复导档案，不含手工资产/组合历史或认证/outbox。双 SHA 非认证或通用脱敏，原文可能有任意私人内容；总 UTF-8 上限 24 MiB、最多 8 个复导档案、单 raw/entries 仍受原 2 MiB 限制，不能丢旧档案换成功。同 key 任一业务或时间差异整批拒绝，空/重复不覆写或推进版本；显式重新关注只能创建 watch/null，不恢复旧 holding。旧候选 adoptLegacy/importCloud/rollback 不得修改已采用本机权威的工作区。合成 IDB/SFC 通过不代表真实浏览器下载、旧 PWA、云同步、跨设备或耐久/恢复验收。
- V8 Holding/Decision 同连接内核只接受调用者已开启的事务，不开连接、不提交/回滚/关闭；全部 ID/hash、引用、scope、未来时间与幂等守卫必须保留。应用生成使用同一事务保存 Holding、Decision 及其 scope；Evidence 仍先独立保存，不声称全链原子。该内部基础不是 Owner 权限或已确认 revision 证明；后续 Owner 任务仍须在同一事务核完整服务端组合来源与预期 revision，禁止把本机输入或 revision 冒充业务版本。
- `tools/turso_scope_upgrade.py` 仅对显式、关闭的本地 SQLite 快照做有界 plan/rehearse；不连接 Turso、不读取凭据、不执行输入 DDL、不应用远端迁移。内存逻辑恢复不是远端恢复或正式发布资格，额外 operational 表须逐表固定合同审查，不以前缀豁免。
- `tools/turso_projection_repair.py` 是独立、显式 SHA 绑定的本地修复演练，不放宽上述原迁移校验；文件访问前拒绝 UNC/device/相对路径，仅在固定 DDL 内存副本恢复 Evidence 两列恰 1 ULP 的有限 REAL 差异。完整 typed 差异、原 payload/ID/hash 和原始 schema8 独立恢复必须通过；原文件不写，摘要须承认 legacy rows 改变，所有远端/正式资格 false。`exact_real_binding` 仅供可信固定 SQL 值槽显式使用，只接受原生float/None并拒负零/非有限，不是默认 driver 修复；不得全文替换任意 SQL。
- `database/turso_owner_upgrade_packet.py` 为独立的纯本地 repair+scope+Owner 编译 profile，先 plan 再显式绑定 repair SHA；不复用旧 scope-only 回执槽、不接旧 sender/verifier 或启动路径。原始 schema/typed 全前像、header 0/8、空槽在同一 BEGIN IMMEDIATE 后核；仅暂移固定 Evidence UPDATE trigger、修恰 1 ULP 两列并恢复仓库固定 DDL，随后 scope、Owner 五表/revision0、schema-table9、完整后像与十列回执一起提交/回滚。目标 raw schema 明示该 trigger 的唯一规范拼写例外，remote header 不改。所有值槽无 JSON float；只读 pragma_user_version 的实际 provider 支持/事务容量仍须单独验收。公开 facts 与 repair/plan/receipt/specs 交叉绑定，重建/发送前校验依旧须保留外部原始 resource/plan/packet SHA；30 秒为协作总预算而非硬终止。无凭据/网络/云应用能力，所有远端和发布资格 false；不得据合成回滚或本地容量样本开放云迁移。
- `turso_owner_upgrade_response/reconcile/transport.py` 是上述新 profile 的独立入口，旧 public 类型/profile 不放宽，仅复用固定私有 JSON/FSM/image/HTTP 核。对账须保留原 schema8 捕获和外部原始三 SHA；schema9 完整核修复 Evidence、所有旧表、scope、Owner 五表初始 revision0、原 header 和十列回执，schema8 missing 必须完整原像及空槽，不是重发许可或长期业务写入后的验收。已观察 identity/origin/code 错误不能被后来健康读取洗掉；DTO timer 先于全部 values 校验，未知权限结果仍核源码，坏时钟只能返回无绑定资格的 unknown/time_limit。仅无资格 code_drift 可在源码漂移后读出；所有 remote/restore/formal/retry false。新 transport 真能发一次显式 POST，但没有 CLI/默认路由、凭据发现或自动后续；必须先独立完成实际停写/排空、配额、容量和新保护备份。流中源码变化只能阻止成功判定，不能撤回已发请求；本地 close/合成回执不证明云提交，所有未知及权限错误停止，不换 Token 或重试。
- `database/v8_insert.py` 仅编译 `v8_repo.py` 的十个固定 INSERT，表/列/REAL 槽及 claim 六参数 literals 为闭集。原生 sqlite3.Connection 保留原参数对象，其余已有 SQLite 协议连接只在固定 REAL 槽使用整数精确表达式；不猜传输身份、不授予云能力。固定 V8 投影遵循既有 canonical_json 的数值零合同，仅原生 float 零投影为 +0.0，不改输入模型/payload/ID/hash；generic primitive 仍拒负零，非有限和其它类型仍拒绝。Evidence 与全部 health 在第一条 INSERT 前编译，原事务/幂等/引用/scope 守卫不变；FakeSession 测试不证明实际 Turso 写入或耐久。
- watchlist 的 Owner snapshot 须绑定深冻结 sourceKey/v1Raw/v2Raw、当前内存及 generation；原 raw 仍仅指 v2。相关 storage event 即使原文已回到相同值也失效旧上下文，不宣称发现未观察 ABA 或实现原子 CAS。当前 store 曾观察/创建 v2 后，v2 删除须保留最后工作副本并 failclosed，不能复活旧 v1；首次启动未观察 v2 的历史 fallback 仍保留，因此不是跨重启防复活。Gist 后置来源校验不能撤回已发送 PATCH 或 helper 已写的旧同步元数据，更不能解除 local_pending。
- `backend/database/turso_scope_packet.py` 仅将已验证的私有内存捕获编译为有界、不可变的迁移包，不提供 transport/apply。原始 DDL 只作前后像数据，执行 DDL 必须来自仓库固定模板；公开摘要保持闭集且六项远端/正式资格为 false。包体、语句参数与 artifact 含私人数据，不得日志化或上传 CI。摘要/seal 不是来源认证或写入授权；未来发送前须以外部原始 resource/plan/packet SHA 重编译核验，未知提交不得自动重试或回收回执。
- scope packet 的固定 row-guard VALUES 槽使用整数精确 REAL 表达式；负零比较仅用固定 `(-0.0)` literal，不归一化、不改变 generic helper 的拒负零合同。旧 v1 的能力探针仍按原合同要求 provider 保留 JSON ±0 参数及 atan2 行为，不能把比较绑定修复当作实际 provider 能力或云迁移通过。
- `backend/database/turso_scope_response.py` 仅核验提供的响应字节与外部原始 SHA 重编译包的本地合同；acknowledged/session_closed 不是真实传输、提交或关闭证明。构造/getter 均须闭合身份/状态/权限关系，前后核对自身及 compiler 源码并保持总预算；未知或权限错误不重试，所有 remote/apply/restore/formal/retry 旗标均为 false。不得作为 sender、未知提交对账读回器或发布放行来源。
- `backend/database/turso_scope_reconcile.py` 仅构建固定只读计划并核验提供的读回字节；matched 须完整后像和十列回执一致，missing 须完整原前像且保留槽位为空。二者均不认证来源，missing 不证明仍未提交/可回放；未知或已绑定权限错误停止，不换凭据、不重试。原 schema-8 捕获及外部 resource/plan/packet SHA 必须独立保留，remote/apply/restore/formal/retry 均 false；不得把纯本地合同核当真实 transport、远端对账或发布资格。
- `backend/database/turso_scope_transport.py` 提供显式真实 HTTP 能力，不是迁移授权或默认启动路径；发送前必须独立完成实际停写/容量与新受保护备份。只用显式 origin/Token、原始三 SHA 重编译和单次精确 bytes POST，禁环境凭据/重定向/重试；未知结果不自动对账或重放。once 仅每调用/每实例，不是永久去重；本地 Session.close 不证明 SQL close/commit。30秒为协作预算，外部监督仍必需。既有 verifier 的 remote/restore/formal/retry 旗标不提升，FakeSession/内存 SQL 通过不代表真实 TLS、迁移、耐久或恢复。
- `tools/record_overseas_ops.py` 只以本次原生 producer/audit 计数和日期上下文记录公开任务；缺失/冲突不造零。金融四文件仅在 main 确认后绑定 digest；运维日记独立写固定 `ops/overseas-run-journal` 分支的唯一普通 JSON，不 checkout/执行分支代码、不借金融 index、更不推进 main 使精确 CI 失效。固定可信 pre-push hook 核本次服务端通告的旧 OID/本地新 OID/唯一 ref，仍是普通推送、不是 main 与 ops 的跨 ref 事务；main 后变可留下已写日记但必须失败、不回滚或重试。金融结果和 CI dispatch 失败分轴；未知 push/已观察 ref 变化不重试。不要把合成/mock Git 门禁当成实际远端留存或自然恢复。
- 缺失值不得用 `0` 代替；评分覆盖率低于 70% 时不得输出总分或星级。
- 后端缓存回退最多允许 7 天并必须返回 `stale`/数据年龄；指数估值超过 7 天不得参与信号。
- 指数富集的公开乐咕 client 只认固定 symbol 和加权 `addTtmPe`/`addPb` 字段；不把等权值或其他指数替代缺项。单匿名 bootstrap、每指标一次、15秒间隔/240秒源读取协作预算只是负载约束，不证明上游配额或恢复。401/403/429整源停止，不换身份/网络重试；失败不覆写旧产物，六核心6/6、同日PE/PB、7天和30个真实非重复日期样本门槛保留。HTTP状态/经校验Retry-After可公开，原body、Cookie、CSRF及请求query不日志化；不支持的候选显式missing/unsupported，不降低requested掩盖覆盖。
- 组合历史只能使用全部成分都有净值的共同日期，禁止用前向填充制造零收益。
- 前端 API 请求必须经过统一超时层；大于 1 MB 的静态集合应使用清单与分片加载。
- Iteration 21 的 AI 筛选是严格校验后的条件提案，必须显示全部生效条件并由用户确认；任何 unsupported 阻断整次执行，禁止静默部分筛选。BYOK POST 不自动重试，自由文本 AI 暂停期间不得恢复旧缓存或以规则 fallback 冒充模型输出。
- 基金经理跳转优先使用公开经理 ID，姓名只作展示和旧数据兜底，避免同名或包含关系误匹配。
- 持仓提醒必须用行情时间/信号变化组成稳定事件指纹，禁止仅靠生成时间或展示文案去重。
- 前端直连第三方公开接口时，要接入容灾/源状态机制。
- 主导航保持“首页 / 选基 / 自选”三项；资产、对比、回测和组合实验室能力保留路由，不因入口隐藏而删除。
- 中文界面优先使用系统宋体与系统无衬线字体，不依赖 Google Fonts 等国内不稳定的线上字体服务。
- 不在代码、日志、文档示例中写真实密钥或 Token。
- npm ci 的漏洞告警不等于安全门禁通过。CI 的前端/Worker安装与审计须显式包含dev依赖；审计是有界、无容错/条件绕过的独立步骤，中危及以上或网络/超时错误阻断受控CI发布链，不用force或省略开发工具换PASS。公共registry审计失败保持未知，镜像NOT_IMPLEMENTED不能记零漏洞；npm JSON不是通用脱敏器。平台自身自动部署设置须另行验收，不能由CI YAML推断已受门禁保护。
- Worker 的 Miniflare 外部 Undici scoped override 不会替换 Wrangler 自身 bundle；npm audit 0 也不认证内嵌代码。当前正式 deploy 入口在 Git/CLI 启动前固定阻断已知内嵌风险，无环境或参数绕过；关闭须审查已修可信上游制品、锁与兼容证据后显式改源码，不能扫描版本注释自动放行。dry-run/loopback只作功能证据，不运行带认证的 Wrangler 网络操作，不宣称已修已部署 Worker runtime。

## 项目边界

- `FundVal`（蜉蝣基金）和 `pan`（盘中宝）是纯前端盘中估值工具。
- 本项目负责选基评分、择时信号、资产页、回测实验室、数据故事和体检报告。
