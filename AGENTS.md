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
- Owner 候选控制器对准备、观察与已决结果绑定原包 hash；发送/取消/结束不得误操作另一标签页替换的原包。重载后的已决槽位须当前会话核对匹配回执才可结束；结束已决请求失效完整基线、下次从 0 拉取，但保留已观察 head 的防回退下限。严格合法分页的 upper、经原包语义核对的成功 head 在后续分页/本机确认 CAS 失败前亦须保留；这不是完整 D 或 ACK 资格。未知状态仍只保留原包并手动核对，不因基线刷新或跨标签页状态而自动重发。
- `stores/owner-workspace.ts` 已接真实 watchlist 全部编辑与自选页本机工作区 UI；默认仍纯本地，显式 v4 格式及会话同意后另开受控同步链路。它与 outbox 共用 IDB，物理 v3 保留原 slot/working_copy/import_receipts，增加 local_metadata；versionchange 与缺项 strict 初始化仍是两次提交，中断或坏结构固定拒绝、不重建。业务写须空槽，在同一 strict 事务核完整前像并推进独立 localVersion、空槽 epoch 和最近本机回执；二者不是云 revision 或 HoldingVersion。v3 的新版 outbox 路径禁止 null→prepared，保留已有原包核回执/结束；后续云上传必须另做同工作区原子制包，不能移除守卫冒充兼容。该代码不能控制旧 PWA 或任意原始 JS。
- 物理 v4 是已接本机工作区显式升级 UI 的共同基线/原子制包入口：只对原 target 已采用且空槽的完整 v3 显式升级，默认仍 v3；已有完整 v4 可 existingOnly 重开，缺 sync_metadata/current 不补。versionchange 与 strict 初始化不是单事务。v4 的完整 local state 含 sync 元数据，所有实际本机 writer 前像亦绑定完整 B/epoch；旧 outbox 在 v4 只读，全部 CAS 拒绝，不能清包或 unknown 重发。初次 link 只接同 key 业务完全相等/云端独有基金，差异整批拒绝；manual/tombstone/revisions 完整留 B，不伪称手工资产已迁移。制包只从已应用 B→L 推意图，缺已链接基金行拒绝而非删除，普通 patch 只 guard 编辑字段及 kind/deleted，类型/删除用全前像。crypto/原包恢复在事务外、最终 strict 同库核完整前像并同时存原包/绑定；本机丢响应只手动核原 id/hash，不重放。重载重算原 envelope 与原包 SHA，不能用重制包替换原字节；wire DTO 数字零规范化不改 B/L 的负零。所有 hash 都不是身份认证或防任意 raw-JS 重封。prepared 才能同库取消；受控 delivery 只推进 slot.version，sync/B/epoch/preparationHash 原字节不改。ACK 必须原包/当前已决原始回执与完整 D、显式三方冲突选择，严格同库同时推进本机版本/slot/sync epoch、保存完整 D 并清原包；manual 完整留 D，取消 rename 仍保留未上传新键的本机 tombstone。所有 IDB 仍云端未确认，不以 POST/ACK 或 revision 代替 Holding/Policy/Decision，不开放 main Turso 或据此关闭 I19。
- v3 核心的云命令/完整 v4 codec 按操作懒载，codec 必须在任何相关事务前加载，事务内只能用同步验证；导入失败/原总预算超时/撤销固定拒绝，不回退 LS、重建库或重制包。代码拆分不是 PWA 安装网络优化，Workbox 仍预缓存懒块；性能须同时核单块、完整静态依赖闭包与预缓存总量，不以整体小增长掩盖已有局部回退。
- `createOwnerWorkspaceSync` 是显式注入真实 workspace/transport/session/authority guard 的受控协调器，构造零 IO、默认关闭，已由 watchlist 自有 facade 接实际 UI；打开/登录不等于同意或默认网络。只从已应用 B 制包，先同库 attempted 后单次发送原字节，unknown 没有重发/清包入口；当前 generation 绑定的 write/receipt 原响应加完整 since=0 固定 upper D 才能预览 ACK，普通错误不能抹掉本会话已观察 head。prepared 取消、link/prepare/ACK 均须显式确认；调用者 preview 请求在 canonical 前须拒 getter/隐藏或特殊字段。总 12 秒涵盖本机预检/加载/网络/写入，迟到回调不得续写；本机成功后 hydrate/reset 丢响应亦保留原本机 id/hash，仅手动核回执，不重放。退出/撤销清私人响应且失效旧预览，协调器关闭不关闭共享 app handle。实际多设备、PWA、会话 UI/权限与云来源/耐久仍需独立验收。
- 固定 owner-authority 元数据定位须先于业务 LS/Gist 读取。显式启用要求本轮导出、重新选择同一完整 SHA 文件、严格 legacy codec、实际两槽 source/memory/generation 守卫；adoptLocal 自行重解原文并核备份 SHA，不能只信调用者 seed。指针 legacy→activating→active 与工作区不是跨库原子；中断只凭原文件、ID/hash/target 及已保存 adoption 手动核对，不重新导入。active 必须 existingOnly 打开原 target，丢库/坏结构/端点变化不回退 LS 或新建。LS seen hint 仅检测已观察 locator 丢失，不能选择权威，也不证明全部站点存储清除后的身份。IDB 模式拒旧 Gist，并整体保持云端未确认，不能由历史 pending=false 释放行动。
- 本机编辑/复导失败保留本轮原 id/hash，只能显式核最近同版本回执，不重放；handle 关闭后 existingOnly 重开并核 adoption。最近回执覆盖即 unknown，刷新只读取当前完整 active 状态，不等于核定刷新前丢失的请求标识。旧普通行备份只含自选/账户持仓、0/null、tombstone、原时间或 null、两槽原文与复导档案，不含手工资产/组合历史或认证/outbox；不得冒充完整同步格式备份。双 SHA 非认证或通用脱敏，原文可能有任意私人内容；总 UTF-8 上限 24 MiB、最多 8 个复导档案、单 raw/entries 仍受原 2 MiB 限制，不能丢旧档案换成功。同 key 任一业务或时间差异整批拒绝，空/重复不覆写或推进版本；显式重新关注只能创建 watch/null，不恢复旧 holding。旧候选 adoptLegacy/importCloud/rollback 不得修改已采用本机权威的工作区。合成 IDB/SFC 通过不代表真实浏览器下载、旧 PWA、云同步、跨设备或耐久/恢复验收。
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
- 2026-10-28 用户授权 PR #4 仅合并代码且先暂停自动部署：Pages 的 AUTO_DEPLOY_ENABLED 未设/false 必须持续挡住 push/dispatch 发布，测试、审计、数据任务不跳过；两个 Render 服务须另行读回 Auto-Deploy Off 后才合并。该授权仅延期合并前的上线验收，不把未完成项记 PASS，不开放云 profile、不升9.0.0、不删Gist或恢复部署。操作和状态边界见 `docs/CODE-ONLY-MERGE-HOLD.md`。
- 同日合并后发现 Blueprint Auto Sync 是独立入口：服务两次Off不阻止render.yaml差异同步部署。PR4已合并db5ac32，但一次blueprint_sync尝试update_failed、旧80d01717仍live，不能宣称完全未触发部署。所有后续main配置推送须先独立确认Blueprint Auto Sync=No；源码显式字符串`autoDeployTrigger: 'off'`仅防服务自动部署，不代替平台暂停。现有服务字段省略按官方文档应保留，实际yes/commit改变的内部原因未核，禁止编造默认重置解释。保留失败证据，不重部署、不放宽云schema守卫。
- Worker 的 Miniflare 外部 Undici scoped override 不会替换 Wrangler 自身 bundle；npm audit 0 也不认证内嵌代码。当前正式 deploy 入口在 Git/CLI 启动前固定阻断已知内嵌风险，无环境或参数绕过；关闭须审查已修可信上游制品、锁与兼容证据后显式改源码，不能扫描版本注释自动放行。dry-run/loopback只作功能证据，不运行带认证的 Wrangler 网络操作，不宣称已修已部署 Worker runtime。

## I19 本机格式与实际同步界面约束

- 物理 v5 为显式资产/历史共同工作区，与应用版本独立；普通 v3/v4 启动不升级。迁移先保护导出完整 v4 与独立手工资产/历史 raw，选回同 SHA、显示全部问题/ID 映射后确认。旧 UTC 日期、重复日期、不透明历史 ID、0/null/负零与原文保留，坏源整批拒绝；超长资产 ID 使用显式 SHA 映射不截断。versionchange 写固定 intent，strict 初始化 current，两行及原 id/hash/source SHA 必须匹配；中断只手核原文件，缺库/无 intent/后续编辑不重建或覆盖。应用请求 id 从原文件 SHA 确定生成，跨重载保持同一请求。
- v5 全部本机 writer 同一 strict 事务绑定基金、portfolio、原升级 intent、完整 B/slot/metadata 前像，统一推进独立 localVersion/空槽 epoch/最近本机回执；同值同时间 no-op 不推进。旧刷新响应不得覆盖较新 writer 的已发布状态。资产墓碑不可静默复活，原历史前缀不可变，新观察显式追加且保留零份账户身份，manual 成本未知用 null，余额变化不冒充现金流调整收益。v5 不再读取/双写旧业务 LS/Gist；现阶段完整 manual link/intent/ACK 尚未接入，私人上传/分析入口明确暂停，不移除 fund-only 守卫冒充完成。
- `sinan-owner-workspace-recovery-2` 只含物理 v5 完整本机状态，包括 portfolio/intent、完整 B 与原档案；统一 24 MiB 可导出上限在升级/写入前核，禁止丢档换成功。旧 recovery-1 严格只认 v3/v4。v5 完整导出、升级前保护文件和历史查看导出各自用途明确；文件解码/fake-IDB/SFC 通过均不证明丢库恢复、真实 Chrome/PWA 或远端耐久。
- 物理 v6 为独立完整基金/手工资产 profile，显式 v5 原完整文件+同 SHA 升级；普通启动不升级。保留旧六 store 与所有旧 intent/原文/历史，新增 `portfolio_sync_metadata` 仅 intent/current 两行，旧 sync 作为历史不能驱动活动同步。初始基金用旧 B/L/C 真三方协调，旧 B 未应用过的 manual 差异必须明确 bootstrap 选择；只有完整 C 和全部选择才可 strict 同时应用 L/B，不能假 ACK、静默复活墓碑或解除 local_pending。
- `createOwnerPortfolioWorkspaceSync` 及 store-owned facade 接 v6 完整实际原包，不回退旧 fund-only sender；构造零 IO/默认关闭，读取、保存、单次发送、prepared 取消和完整 ACK 分别确认。原包准备/验证绑定完整基金、portfolio/历史/原 intent/旧 sync/版本，descriptor-safe 输入必须在首个 await 前拥有；每次重读重核原 raw SHA/实际 B→L/新 preparation envelope。先 strict attempted 再唯一 POST，unknown 只核原回执/导出。真实原 write/receipt 响应加固定 upper 完整 D 和显式 B/L/D 冲突选择后，才可 strict 一起更新 L/B/版本/回执并清原包；后置 hydrate/reset 与 Pinia 同步发布前不丢原未知本机 id/hash。关闭不关闭共享 handle，退出/端点/来源变化失效私人结果，合法已观察 head 不因普通失败降低。本机协调本身不授予分析资格；v6 分析须另走完整来源、原回执及当前 Policy/Evidence 的独立核对链。
- `sinan-owner-workspace-recovery-3` 仅含物理 v6 完整本机状态；合法 pending 的全部五态可核原完整 envelope 并导出，但解码不授予重发/恢复/认证能力。统一 24 MiB 与原 200项/128KiB 请求上限不提升、不裁切；recovery-2 严格拒 v6。窄范围升级中断核对不是通用丢库恢复或数据库降级。更多操作与未验收边界见 `docs/OWNER-PORTFOLIO-FULL-SYNC.md`；应用保持8.0.0，云 schema/main 工厂和正式发布门禁不因此放宽。
- v6 写命令仅由 core 私有 host 按操作懒载 `owner-workspace-full-sync-commands`；普通读取/恢复不能加载该写模块。输入在原 bounded 总预算内、首 await 前同步拥有，固定模块加载须先于事务；纯状态分支校验只能作为已加载固定同步函数在事务内调用。完整 expected/baseline/slot 最终 CAS、真实 strict 事务、已加载完整 localState codec 和全部 store 写仍在 core，不接受 UI 注入 validator/事务能力。导入失败/迟到/撤销不写库、不回退旧fund-only/LS路径；代码拆分仍不等于 Workbox 安装网络优化。
- 已链接v6的完整云刷新仅接受原包slot/pending为空、当前会话真实固定upper完整D和独立确认；基金与manual均按已应用B/L/D三方合并，可以保留本机未上传意图。不得假空POST/receipt、借ACK或初始bootstrap重设B；五态原包均拒绝，typed noop不推进版本/回执。strict全像CAS一起应用L'/B=D及独立full receipt `refresh`，旧v4 receipt合同不变。后置实际hydrate/Pinia发布前保留原未知tuple；较新writer使旧发布失败，最近回执覆盖仍unknown，不重放、不清local_pending；刷新本身不授予分析资格。
- Owner历史读取的固定有界折叠器在真实strict页解析后先保留upper，再核累计原raw UTF8 4MiB、100000历史项及保留完整像2MiB；重复key/空白同计，不能只核最终Map。末页还须真实完整baseline codec，失败不发布D、不洗低观察floor。此是逻辑数据预算不是硬堆内存或来源认证。固定portfolio/full shape、全recovery容量及v6观察约束在事务前预加载codec，v3/v4不载portfolio、v5不载full；core仍核全部最终前像/CAS/store，每次async原SHA核验不缓存。

- `POST /api/v2/owner/analysis` 是独立 `run_personal_analysis` Owner scope 与 `owner-analysis-v1` 同意的本地候选链，不复用 Admin/Worker 或 write_holdings。只收 expected_revision、原请求标识、已有 production Evidence 与显式 Policy 引用；完整服务端来源（含所有账户/manual/tombstone）在同一 BEGIN IMMEDIATE 核验，跨账户 fund_only 聚合后真实 Holding/Decision/来源/回执一起追加。不完整定价不构造部分分母；0份仍 held，未知仍 null。完整原始来源保留 int/float/负零，V8 业务模型沿用自身 canonical_json；不能把两种合同混用。
- 分析扩展 `owner-analysis-schema-1` 只显式本地候选 provision；正常 startup/factory 不补 DDL，旧 Owner-only/analysis 公共 exact verifier 和 Turso profile 仍封闭。应用 workspace verifier 仅兼容固定的 Owner-only/完整 analysis/完整 machine 三种 inventory，分析兼容 verifier 只认后两种；不能放宽路径、远端或 schema8 拒绝。原 id/hash 回执仅核原历史模型/引用/映射，不用当前策略重算；`source_current` 只表明该读事务中的完整来源 revision+SHA 相同，不认证 active Policy/策略、行情新鲜或当前动作资格。超时/commit或close异常后只能手核原回执，不从缺失推断回滚或自动重发；30秒为协作预算，授权回调及提交前后均重核，不能声称硬中断 SQLite。
- 前端持仓分析默认关闭并按操作懒载；实际 active locator/handle 只接受 v4 或完整 v6，v5 仍拒绝。v4 使用原 sync B 且原 `{authority,state}` preimage 字节不变；v6 真实 readFullSyncState，只取活动 fullSync B，不回退历史旧 sync，独立 `{profile:'v6',authority,state}` 绑定完整基金/portfolio/history/raw/双升级 intent/旧 sync/版本及 0/null/-0。须空同步槽/pending、无未知本机 tuple/忙碌操作、实际对应 B→L planner 零 issues/operations，再从0读取固定 upper 全部 changes 重建 D。entries/portfolio 两份内存与实际全像必须一致；verify 用原 handle 前后核 locator 和完整前像，不自动接受较新 DB 像。完整同步操作的真实 prepare 开端同步失效分析 epoch，不能靠非响应 busy 值保留缓存资格。合法观察 head 跨本会话失败/失效保留防回退；它不是完整 D，也不声称跨刷新持久。独立分析任务库保存原 raw/hash/contextHash，显式保存与发送分开，strict CAS attempted 必须先于唯一 POST；unknown 只能手核原 id/hash、导出或关闭，不能取消或重发。分析任务不在工作区格式备份内，不证明丢库恢复。
- 原分析回执与当前完整 D、本机完整前像、Policy/逐基金 Evidence 引用再次相等后，三页才可暂用同一轮结果；保留 local_pending，不把同步 revision 冒充业务版本。最近核对资格最多60秒（等号失效、坏/回退时钟拒绝），编辑/会话/端点/恢复焦点失效；未观察的跨标签或设备变化仍可能在窗口内，不能声称实时全局锁。旧启用回调不能清新启用流程；logout/关闭清私人视图但保留原任务。统一金融门禁独立核结构/引用、7日新鲜度、覆盖率和实际策略置信度，缺 diff 明示未提供比较，不造首次/未变。合成 SFC/fake-IDB 不代替真实 Chrome/PWA/云迁移验收。
- `GET /api/v2/private/portfolio/policy-state` 是 Owner/read_private 只读本地候选快照，不授予策略写权限。仅已有普通本地 schema9/完整 Owner 工厂；同一读事务核固定 Policy/scope DDL、原 ID/SHA/冗余列和完整单链，按实际 UTC 微秒选 current/next/history，最多1000版/2MiB，超量不截断。旧 Policy 读接口保留历史 at 语义，仅修合法非 UTC 直接模型的排序；不能把此离线路径缺陷冒称已确认线上事故。观察不生成默认策略、不补表、不开放 Turso 或自动执行 Admin 护栏。
- 既有 PortfolioPolicy POST 仍仅 Admin：从完整链 tip（含已排期版本）构造追加，原 BEGIN IMMEDIATE 最终核 tip/时间/前驱，竞争只409不重基或重试，模型不合法422；不新增 Owner scope 或浏览器 Admin 凭据。显式空库 Admin 根不暗建默认，legacy bootstrap 保留空链默认初始化，已有合法 Admin/default 根及未来 tip 不另补默认；tip 不是当前已生效版本。共享 tip 查询的非相关 NOT IN 必须排除 NULL 前驱并保留原 production view/父子同 scope/最终 CAS，不改 DDL 或借等价测试宣称任意 raw-SQL 损坏认证。未知 commit/close 错误仍传播，不自动重发；此旧 Admin API 没有独立持久请求槽或原回执，不能把相似历史行或缺失当作原请求提交/回滚证明。Policy 护栏版本与模型 registry 的 active/history 晋级是两类治理，不相互授予权限。
- 前端分析必须取严格 `owner-policy-state-1`，不回退旧 policy 单读；版本核对只读，不拉持仓、不生成分析或续旧资格。原 state 的单调时钟 proof 覆盖 Evidence/本机校验耗时，预览发布、prepare CAS 前后及 attempted CAS 后真实 POST 前都重核，下一生效时刻或最多60秒等号即失效；若已存 attempted 则保留原包且不 POST/回退/重发。三页资格绑定同一个原 proof，不能在分析完成时重启窗口；UI 定时器用独立响应计数而非停滞 Date.now 值。完整规则仅显式展开才渲染，微秒待生效标签复用严格链次序，不再用毫秒 Date.parse 误分类。统一请求 deadline 拒非有限起点/预算/进度及中途回退，取消优先级和原总预算保持。
- `owner-machine-schema-1` 仅显式扩展已有完整本地 analysis 候选：单个不可变 journal 与固定 marker，125 个固定对象加三个原可选表恰为原128上限，不加预算、不按前缀放行。受保护 `/api/v2/worker/portfolio/*` 只认 Worker/Admin，不授予 Owner 新权限；完整服务端来源、原 analysis 与 day task 同事务追加，最多100基金整批、不截前50。14:30/14:40/人工共享原 task/Decision IDs，真实 trigger 独立记账；blocked 原 invocation 也须原结果不可变，新请求才是独立尝试。旧通知入口拒绝实际 machine-task 绑定的 Decision；内部整批 claim 必须原 occurrence/hash 与真实 journal/V8 阶段匹配，不能换 natural 轴或窗口绕过去重。此边界不阻止旧 Gist 路径另造 Decision，不能冒称已切换消费者。未知提交或送达仅核原记录，不授予再次发送；只有明确未送达/未开始才允许原批次补偿。固定 schema verifier 冷缓存可构造可信内存参考，但业务写入/通知 claim 仍只用调用者同一事务，不另开业务连接。机器 API 不读取 Gist、不创建 schema、不连接远端、不发送通知；当前生产 Worker、行情入库、health/旧状态迁移与自然运行仍需接通和实际验收，详见 `docs/OWNER-MACHINE-CANDIDATE.md`。

- 完整文件 `sinan-owner-workspace-recovery-1` 与旧普通行备份分开：含当前完整 local/sync、B/manual/tombstone、原包与 preparationHash、最近本机回执及旧档案；严格闭集、原 UTF-8 SHA、24 MiB，重核原 adoption 备份与 pending 原 envelope。无凭据、独立资产存储或组合历史；解码成功不是来源认证、自动重发许可或丢库恢复证明。
- v3→v4 必须本轮导出后选回相同完整文件、空槽、原 target/active locator/adoption/完整前像及明确确认。正常 existingOnly 仍不补 current；显式中断核对只接受原 v3 文件与已存在物理 v4 的完整未变原像，strict 初始化唯一空 sync current（或核对完全相同初始 current）。缺库不创建、物理 v3 不升级、额外 store/行或后续编辑不覆盖；这是窄范围升级完成核对，不是灾难恢复、降级或云迁移。
- watchlist 自有 managed facade 按操作核真实 locator/端点原字符串/会话 generation/两槽来源/当前内存/完整本机状态及 handle；不能由 UI 传恒真 guard。关闭面板或退出只撤销并隐藏私人响应，保留当前 store 内原未知本机 id/hash；整次 writer、后置 hydrate 与 Pinia 同步发布完成之前不能丢该标识。手动原回执匹配才释放，不重放；跨刷新未知标识仍需独立导出，不声称内存标识永久持久。
- 已采用 IDB 后旧 candidate/CAS UI 必须退出，不同时保留另一写路径。实际 managed UI 默认关闭，link/制包/发送/取消/三方 ACK 分别预览确认；字段或更名整组选项变化失效旧 ACK 请求，unknown 仅回执/导出/关闭。数据 0/null/负零、删除与未知时间仍不同；实际 Chrome、旧 PWA、多设备和部署验收不由合成 SFC/IDB 测试代替。

## 2026-10-29 候选接线补充

- Owner 同步已用明确三操作 repository seam 接回原 main 本地入口；`owner_sync_candidate_app.create_turso_owner_sync_candidate_app` 另以显式 URL/Token 挂真实会话与同步 HTTP，构造/startup 零 IO，不读取数据库环境凭据、不挂 health/analysis/machine，不开放 CORS。main 仍只用原本地工厂；Turso 候选仍只认 core schema-table9 + Owner-only 五表，不能借此放行完整 machine 云 profile 或宣称迁移/耐久。
- `/worker/portfolio/evidence` 只认 Worker/Admin，完整排序至多100条行情观察必须核原完整 source revision/SHA/当前Policy。只读同一完整本地 machine 库的已有有效详情缓存；外部行情解析不会预热后端缓存，冷/过旧/未来或不一致缓存整批拒绝。不网络抓取、不另开业务连接、不接受 Holding/score/客户端 Evidence。专属正文128KiB，原 prepare/claim/finish仍16KiB；所有Evidence/health/scope及原字节SHA的批次回执同事务追加。既有不可变journal仅增加显式receipt文档合同，不改DDL/对象预算；它不算自然任务成功。原回执可手动只读核对，缺失、401、commit/close/HTTP未知均不能授予重发。新packet只收canonical字段，intraday值日期必须当日；QDII目标轴、0/null和原已存Evidence时间保留，历史summary全批次10000行/8MiB超限拒绝不截断。
- Worker 的 `OWNER_MACHINE_MODE` 缺省/空/off 仍为legacy生产路径，只有显式candidate接完整source→行情→Evidence→prepare→claim→单次发送→finish，任何失败不回退Gist。未启用平台开关、未部署或迁移旧发送状态，不能双路真实发送。原POST字节SHA/原task/attempt须保留，unknown只手核；claimed=false或读回attempt不授予发送。发送前复核source/Policy/真实窗口；60秒总预算、API15秒及发送10秒各自覆盖完整正文/验证，34次行情预算不增加。候选health明确unknown，私有status只读，不能以模拟sent代替真实送达或自然周期证据。

## 2026-10-30 完整云 schema 与缓存准备补充

- `turso_machine_profile` 是独立、显式的完整云schema只读合同：实际有界Turso driver一次DEFERRED batch核metadata，固定raw基线126、上限128（probe连autoindex占2），core `_schema_version=9`与原header0/8/9分轴；production-only、全部固定对象/marker/FK/temp/attach闭集。它不是main启动开关或完整业务全账本认证，旧core/Owner-only verifier与本地factory不放宽；全部云耐久/恢复/正式资格仍false。
- `turso_machine_upgrade` 只接受显式idle、query_only/FK开启的nativeSQLite原快照与外部source/resource身份，独立编Owner-only9→完整machine增量条件包。原页界与serialize同一自有只读snapshot，原caller事务不动；全部旧表typed值/rowid/原header/旧迁移回执不变，只有仓库固定新DDL可执行。新迁移receipt复用已有immutable journal，保留非业务日期occurrence，不加对象/发通知；原四SHA重建与末尾源码/预算复核不能去掉。包含私有原像，禁止日志/CI上传；本地演练/固定只读计划不等于真实云应用、来源认证、恢复或重发许可。没有sender、凭据发现、startup迁移或自动修旧8。
- 独立Worker/Admin `POST /worker/portfolio/cache/prepare` 是显式100次预算的准备操作，不是Worker34次行情预算扩张；不收客户端code/持仓/缓存，只核完整source/Policy与原缓存前像。最多4并发、每code一次固定HTTPS匿名primary、4MiB正文、原30秒总预算，网络必须在事务外；401/403/429停止新请求，不换身份/源/重试。原同连接IMMEDIATE重核后，全部cache及原字节SHA immutable receipt一起提交；fresh复用不续updated_at，失败不覆盖旧cache，unknown只手核原id/hash。成功仅对fetched code精确替换本次已验证公共NAV日期集合，不能union混入旧独有日期，不动其它codes/不可变业务链。独立cache receipt不算自然Cron成功，历史可读不续当前资格。真实云准备、实际停写/迁移/恢复与发送状态仍未执行；默认Worker和部署暂停不变。

## 2026-10-30 完整业务云候选接线补充

- `service/turso_business_engine.py` 为显式 URL/Token 的独立完整 machine profile 候选，不是 SQLite 协议伪装器。一个自有远端一致读事务内固定分页，完整 private/legacy、Owner/Policy/journal/引用均保留；只有 public funds/detail/NAV 按完整 Owner-key code 域截取。每页保留前就逐 typed/cell/JSON 校验并跨表累计原100k行/64MiB，超限即停读/rollback/close，不允许先聚齐再核。只执行仓库固定 DDL 建 owned native mirror，原业务 core 不放宽 native 守卫；public 比对用固定非空唯一 PK，不借子集 rowid。
- 固定操作闭集编 delta，同一原子远端 batch 核原 raw schema/header/FK/完整前像、精确 REAL、affected count、完整后像/FK；响应也必须逐 guard 恰单行原生1及原生 affected。响应/close/撤权/时间或源码漂移均不得返回本地推演成功，unknown 不重放；cache 网络仍在 native 事务外。原900参数/16k steps/16MiB写包/30秒预算保持。
- 新 `owner_business_candidate_app` 仅显式接 Owner sync/analysis、Policy read 与 Worker cache/evidence/task，构造/startup 零 IO；固定会话/CORS/consent/Worker隔离保留。本地 router seam 仍由原 factory/close 拥有，不改 main/default Worker/旧 profile。此 app 没有公共基金、旧 Admin/结算或 `/api/health`，不得直接替换原 Render 启动或全站 API_BASE 冒充消费者全迁移。
- 真实候选最新只读确认 schema8/header0、raw86、probe+universe 两 optional 均在、完整 machine 保留原 inventory 后需129>128；新Token认证成功不解决迁移容量。不得删表、忽略隐式索引、放宽128或 initialize凑通过。一次一致源捕获失败，停写/受保护备份/实际迁移/独立恢复仍未完成；完整记录见 `docs/CLOUD-BUSINESS-ACTUAL-MIGRATION-20261030.md`。实际云库保持不变，应用仍8.0.0、部署继续暂停。

## 项目边界

- `FundVal`（蜉蝣基金）和 `pan`（盘中宝）是纯前端盘中估值工具。
- 本项目负责选基评分、择时信号、资产页、回测实验室、数据故事和体检报告。
