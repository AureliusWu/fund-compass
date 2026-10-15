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
- 数据新鲜度属于估值口径的一部分：严重过期时隐藏精确涨跌值并明确显示“数据过期”。
- 温度统一表示拥挤与短期回撤风险，数值越高越热；分析术语统一使用估值分位、趋势状态、动量状态、数据覆盖率和证据强度。
- 新计划遵循 `docs/NAMING-CONVENTIONS.md`：SemVer 用于发布、`Iteration N` 用于周期、`I{N}-{NN}` 用于工作项、`P0-P3` 只表示优先级；历史编号不重写。
- Iteration 17 起所有后端写接口必须声明 Admin/Worker 权限；模型比较只读且样本门槛未满足时不得自动晋级或调参。
- Iteration 18 的 Owner 会话生命周期是受限例外：登录须验证独立密码，会话只授权声明的私人 scope，不能进入既有 Admin/Worker 运维写接口；后续持仓写入须显式 Owner scope。Owner Token 仅浏览器内存，退出/到期清理私人响应并拒绝迟到请求。当前会话/登录限频仅单 API 进程，部署必须 `--workers 1`；多进程前先实现共享状态。
- Iteration 18 本地验收的 `local-persistence:` / `synthetic:` provenance 为保留用途。仓储写入只在同事务核对独占本地库、当前源码与精确 fixture 后例外允许；普通库/远端及通知/结算/组合派生写拒绝验收链。不可变 scope 旁表与 root 写入同事务注册，默认 V8 读取在排序/limit 前经过 production 视图，跨 scope 引用拒绝；不得以基金代码、展示文案、环境布尔开关或仅有 marker 表代替隔离。此为本地实现，不开放远端验收写入，也不覆盖任意原始 SQL/legacy 读写。
- 物理 schema 9 独立于应用版本 8.0.0。SQLite 8→9 增量迁移须保留备份并验证旧链；已有 schema 9 缺少 scope 元数据不得自动补为 production。Turso 正常启动只读校验，旧远端 schema 8 在受控迁移前拒绝启动；禁止直接推 main 触发不兼容部署，禁止用 initialize 冒充增量迁移。
- Iteration 19 的本地持仓编辑不代表云端确认：`local_pending` 不能作为 holding_version/revision，旧 Gist 上传不得解除当前行动的待确认门禁。PAT 与明确同步同意分开；默认不上传私人输入，撤销及迟到响应必须失效。仅关注、真实零份与未知份额保持不同语义；账户更名/删除保留 tombstone，已观察到的旧本地副本不可覆盖更新后的存储。
- `createOwnerSyncHttpTransport` 仅封闭三类Owner同步操作，构造不发请求/开库；Token仍只在ownerSession内存。API端点指纹不是数据库身份或耐久证明，adapter不等于UI已启用。严格原始响应、有界正文及统一超时必须保留；401只撤销对应旧generation，不得清掉后来登录。上传还需控制器显式consent，未知写保留outbox且不能自动重发；确认revision不得当作Holding/Policy/Decision版本。
- `tools/turso_scope_upgrade.py` 仅对显式、关闭的本地 SQLite 快照做有界 plan/rehearse；不连接 Turso、不读取凭据、不执行输入 DDL、不应用远端迁移。内存逻辑恢复不是远端恢复或正式发布资格，额外 operational 表须逐表固定合同审查，不以前缀豁免。
- `backend/database/turso_scope_packet.py` 仅将已验证的私有内存捕获编译为有界、不可变的迁移包，不提供 transport/apply。原始 DDL 只作前后像数据，执行 DDL 必须来自仓库固定模板；公开摘要保持闭集且六项远端/正式资格为 false。包体、语句参数与 artifact 含私人数据，不得日志化或上传 CI。摘要/seal 不是来源认证或写入授权；未来发送前须以外部原始 resource/plan/packet SHA 重编译核验，未知提交不得自动重试或回收回执。
- `backend/database/turso_scope_response.py` 仅核验提供的响应字节与外部原始 SHA 重编译包的本地合同；acknowledged/session_closed 不是真实传输、提交或关闭证明。构造/getter 均须闭合身份/状态/权限关系，前后核对自身及 compiler 源码并保持总预算；未知或权限错误不重试，所有 remote/apply/restore/formal/retry 旗标均为 false。不得作为 sender、未知提交对账读回器或发布放行来源。
- `backend/database/turso_scope_reconcile.py` 仅构建固定只读计划并核验提供的读回字节；matched 须完整后像和十列回执一致，missing 须完整原前像且保留槽位为空。二者均不认证来源，missing 不证明仍未提交/可回放；未知或已绑定权限错误停止，不换凭据、不重试。原 schema-8 捕获及外部 resource/plan/packet SHA 必须独立保留，remote/apply/restore/formal/retry 均 false；不得把纯本地合同核当真实 transport、远端对账或发布资格。
- `backend/database/turso_scope_transport.py` 提供显式真实 HTTP 能力，不是迁移授权或默认启动路径；发送前必须独立完成实际停写/容量与新受保护备份。只用显式 origin/Token、原始三 SHA 重编译和单次精确 bytes POST，禁环境凭据/重定向/重试；未知结果不自动对账或重放。once 仅每调用/每实例，不是永久去重；本地 Session.close 不证明 SQL close/commit。30秒为协作预算，外部监督仍必需。既有 verifier 的 remote/restore/formal/retry 旗标不提升，FakeSession/内存 SQL 通过不代表真实 TLS、迁移、耐久或恢复。
- `tools/record_overseas_ops.py` 只以本次原生 producer/audit 计数和日期上下文记录公开任务；缺失/冲突不造零。金融四文件仅在 main 确认后绑定 digest；运维日记独立写固定 `ops/overseas-run-journal` 分支的唯一普通 JSON，不 checkout/执行分支代码、不借金融 index、更不推进 main 使精确 CI 失效。固定可信 pre-push hook 核本次服务端通告的旧 OID/本地新 OID/唯一 ref，仍是普通推送、不是 main 与 ops 的跨 ref 事务；main 后变可留下已写日记但必须失败、不回滚或重试。金融结果和 CI dispatch 失败分轴；未知 push/已观察 ref 变化不重试。不要把合成/mock Git 门禁当成实际远端留存或自然恢复。
- 缺失值不得用 `0` 代替；评分覆盖率低于 70% 时不得输出总分或星级。
- 后端缓存回退最多允许 7 天并必须返回 `stale`/数据年龄；指数估值超过 7 天不得参与信号。
- 组合历史只能使用全部成分都有净值的共同日期，禁止用前向填充制造零收益。
- 前端 API 请求必须经过统一超时层；大于 1 MB 的静态集合应使用清单与分片加载。
- Iteration 21 的 AI 筛选是严格校验后的条件提案，必须显示全部生效条件并由用户确认；任何 unsupported 阻断整次执行，禁止静默部分筛选。BYOK POST 不自动重试，自由文本 AI 暂停期间不得恢复旧缓存或以规则 fallback 冒充模型输出。
- 基金经理跳转优先使用公开经理 ID，姓名只作展示和旧数据兜底，避免同名或包含关系误匹配。
- 持仓提醒必须用行情时间/信号变化组成稳定事件指纹，禁止仅靠生成时间或展示文案去重。
- 前端直连第三方公开接口时，要接入容灾/源状态机制。
- 主导航保持“首页 / 选基 / 自选”三项；资产、对比、回测和组合实验室能力保留路由，不因入口隐藏而删除。
- 中文界面优先使用系统宋体与系统无衬线字体，不依赖 Google Fonts 等国内不稳定的线上字体服务。
- 不在代码、日志、文档示例中写真实密钥或 Token。

## 项目边界

- `FundVal`（蜉蝣基金）和 `pan`（盘中宝）是纯前端盘中估值工具。
- 本项目负责选基评分、择时信号、资产页、回测实验室、数据故事和体检报告。
