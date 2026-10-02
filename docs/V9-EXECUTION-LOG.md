# v9.0.0 执行记录

记录日期：2026-09-30（Asia/Shanghai）。依据 [统筹升级方案](V9.0.0-UPGRADE-PLAN.md) 实施，不是 v9 发布说明。

## 当前状态

Iteration 18 的本地基础已实现并验证。阶段出口未通过；不得迁移真实持仓或授予正式发布资格。版本仍为 `8.0.0`，基线为 `706b6ade3cec000319e4dd5eb6bd7d6cb7c510ad`；实施前重新读取的 GitHub main 与该基线一致。本批代码尚未 commit/push，未改变线上服务、数据库或旧 Gist。

| 工作项 | 已落地 | 未完成的出口 |
| --- | --- | --- |
| I18-01 | 核对正常访问路径，已确认 Turso 登录；本批日志未打印真实 Token | Turso 新凭据生成、Render 配置/验证、旧凭据撤销；页面内容控制超时 |
| I18-02 | Owner 会话 JSON 合同、初版同步/证据合同、权限与 `fund_only` 聚合不变量 | 同步字段封闭校验、任务/schema 迁移合同与对应实现；初版合同不等于接口已实现 |
| I18-03 | 后端会话路由、私人读取鉴权、内存会话、前端登录/退出、私有请求取消与清理 | 安全初始化生产 Owner 密码、部署并验收生产私人读取；多设备真实业务流程 |
| I18-04 | 专属本地 SQLite 的真实 Holding → Evidence → Policy → Decision 仓储链、幂等/故障重放、跨进程读回 | 生产应用路径隔离、Turso 不确定提交、实际 Render 重启读回 |
| I18-05 | 本地 SQLite backup 到不同文件后，经同仓储核对字段投影/引用/约束/摘要 | Turso 独立旁路恢复、受控生产导出与真实 RPO/RTO |
| I18-06 | 正式证据/独立当前元数据合同、严格 HMAC/过期/资源漂移验证器及只读 CLI；正式 gate 继续失败关闭 | 受保护真实操作执行器、证据生成器、正式 workflow 接入 |

Iteration 19–21 尚未完成：未新增真实持仓编辑、云同步、Gist 数据/机器消费者迁移；I20-01 指数重试/列选择的局部逻辑已修复，但数据源恢复、其他定期任务与连续自然观察未通过。私人 API 消费与注销清理已为后续工作铺路，但不算整个个人决策闭环已通过。

## 本批实现

- 后端新增 `service/owner_sessions.py`，提供 `/api/v2/owner/session` 的 POST/GET/DELETE。30 分钟短会话、最多 8 个；服务端仅存 Token 摘要，重启即失效。Owner 只获得声明的私人 scope，不可进入 Admin/Worker 运维写接口。保留机器私人读取兼容。
- 独立 `OWNER_PASSWORD_HASH` 使用随机盐 PBKDF2-HMAC-SHA256，600,000–2,000,000 次；初始化密码 15 个 Unicode 字符起、最多 512 UTF-8 字节。登录 body/异常不回显密码；登录限频、校验并发与输入尺寸有界。密码哈希变化立即撤销原会话。
- 会话与私人响应（包含鉴权失败）使用 `no-store`；CORS 保持明确来源。`render.yaml` 声明 `OWNER_PASSWORD_HASH` 且固定 `--workers 1`，没有写入任何真实值或自动修改云端配置。进程内限频与会话不能作为多实例方案使用。
- 前端新增模块私有内存会话和 Vant 登录面板。Owner Token 不进入 localStorage/sessionStorage/URL/SW；只向审核过的私人 API 附加 Bearer。退出/到期/401 清理快照、取消请求、拒绝迟到响应。公开行情保持可用；不将 Admin Token 交给浏览器个人分析。
- 请求层统一覆盖 fetch 和 JSON 解析的取消/超时，并正确处理 204/205。采用既有主题与三项主导航，没有增加依赖。
- `tools/persistence_candidate.py` 仅允许工具独占创建的本地候选数据库和 `v9-acceptance-*` namespace；拒绝远端 URL、旧数据库和未标记 schema。receipt 明确 `durable=false`、`formal_release_verified=false`，不能用于正式放行。

权限、错误和证据边界详见 [V9-CONTRACTS.md](V9-CONTRACTS.md)。旧 Gist/PAT 路径为兼容保留，不能提前撤销或删除。

## 本轮验证证据

以下结果均来自本次实施，不复用历史测试数量。

| 验证 | 结果 | 范围/限制 |
| --- | --- | --- |
| 后端完整 `python -m pytest -o addopts='' -q` | 717 passed，36.25 秒 | Windows / Python 3.14.4；33,561 条依赖弃用警告，非生产 Python 3.12 环境证明 |
| 最后 workflow/version/Owner cache 契约复核 | 26 passed | 声明式部署修改后重新运行；不是新增 26 个用例 |
| 独立 Owner/缓存/写权限安全复核 | 未发现阻断问题；82 passed | 重叠测试不累加到 717；额外深嵌套合成 JSON 统一 422、无输入回显；未访问云端 |
| 前端完整 `npm run test` | 35 文件 / 260 passed | 包含真实 Vue 组件挂载、会话与权限/竞态测试 |
| `npm run type-check` | passed | 不能替代运行时验收 |
| `npm run build` 与 PWA 构建门禁 | passed / 7 检查通过 | 不证明用户已安装的旧 PWA 升级或真实手机离线恢复 |
| 移动 viewport 390×844 本地 UI | 登录 → 退出 204 → 刷新仍未登录；存储无 Owner Token | 合成密码、空自选、隔离 SQLite；不是实际手机或云端持仓旅程 |
| 仓储工具专项与既有 storage/v8_repo/工具回归 | 61 passed | 新本地工具测试 22 个；跨进程与旁路恢复包含在测试内，不额外累加到 717 |
| `git diff --check` / 三份 JSON 解析 | passed | Git 提示 LF/CRLF 转换，不当作错误 |

本地 UI 的登录/退出/刷新旅程最后截图保存在执行机 Temp 中，文件为 `fund-compass-v9-owner-local-smoke.png`，SHA256 `4050a46d9ceaa2ce1c408a72aca8568d4091f0e4a6cf1b7fbae3506808b47923`。临时本地 API/Vite 测试进程已停止，合成测试库保留在 Temp，不触碰真实数据库。截图证明未登录清理后的页面，不包含真实私人资产。

## 继续执行 · 2026-09-30

本轮在上一轮本地基础上新增/复核以下结果，前述 717 个用例属于上一轮记录，不冒充当前数量。

### I18-06 验签预检

- `tools/storage_release_evidence.py` 使用标准库，严格验签并绑定受保护执行器独立取得的当前元数据；拒绝 scope/资源/SHA/schema/配置/boot/生成器 run 漂移、重复字段、额外字段、非有限值、日期/恢复不一致和过期记录。
- `tools/verify_storage_evidence.py` 只读取受限文件，key/key_id 仅取专用环境配置；拒绝已知机器/provider 凭据复用、非法 Unicode 配置与不合法输入，不打印秘密、文件路径或 payload。独立安全复核发现的复用漏检/编码异常已修复并补回归。
- 没有任意 payload 签名入口、数据库写入、网络调用或正式放行。CLI 成功仍明确 `formal_release_verified=false`。执行器尚未真实完成生产链，因此保持旧正式 workflow 和 gate 阻断，不把验签通过当成存储耐久证明。

### I20-01 局部修复与源状态

- 当前 symbol 的有界重试缓存成功 PE/PB，只在真实源日期完全相同时组装；不跨候选、任务或旧产物拼接。
- 只接受精确“滚动市盈率”“市净率”列和唯一日期列；拒绝静态 PE、等权、中位数、未知或重复列。继续保持六核心 6/6、30 条分位样本门槛、真实零/空值与失败不覆盖旧文件。
- 新增 25 个用例；没有改实际指数 artifact、依赖版本、workflow 或 unsupported 合同。
- 只读诊断确认 9/28 [run 36385342158](https://github.com/AureliusWu/fund-compass/actions/runs/36385342158) 核心 3/6。AKShare [官方修复](https://github.com/akfamily/akshare/commit/72de989c36072d9c45b6d9cd1d7f0e8ccb9cb504) 只改进 403/缺 CSRF 的错误诊断，不能解除访问限制。
- 本轮无凭据低频请求在 `2026-09-30T07:49:19Z` 观测两个官方公开页面均为 403；已停止该源请求，没有换出口、代理或尝试绕过。这个时间是探测时间，不是行情源日期。当前 artifact 实际日期仍为 2026-08-21，未把它改成今日。

### 本轮集成验证

| 检查 | 本次结果 | 证据范围 |
| --- | --- | --- |
| 后端全量 pytest | 990 passed / 43.29 秒 | Windows / Python 3.14.4；39,479 条既有依赖弃用警告，不替代 Python 3.12 CI |
| 验证器与 CLI | 201 + 47 passed | 已包含在 990；全部合成数据，无真实 key/云请求 |
| 指数富集/加载器/workflow 定向 | 108 passed | 与全量重叠，新增 25；不等于免费源恢复 |
| 前端全量测试 | 35 文件 / 260 passed | 本轮重新运行 |
| 前端类型检查 / 构建 / PWA | passed / passed / 7 of 7 | 本轮重新运行；非旧客户端升级验收 |
| Worker 测试 / 类型检查 | 3 文件 / 144 passed / passed | 未部署，未验证自然 Cron |
| diff 格式 / 四份 JSON 解析 | passed | 只有 Git LF/CRLF 提示 |
| GitHub main | 仍为 `706b6ade3cec000319e4dd5eb6bd7d6cb7c510ad` | 本轮重新读取远端；未 push |
| Render 浏览器 | Free、Live、部署 `706b6ad` | 用户重新打开后已可读；未查看或回显 Secret 值 |
| API health HTTP | 初次 20 秒读取超时/失败；再次读取 200 / 2,687 ms | `2026-09-30T08:10:20Z`、8.0.0 / `706b6ad`、libsql / turso_candidate / durable=false；仅 health 通过，不等于整体验收 |
| Turso 浏览器 | 当前 `app.turso.tech/login` | 登录页已保留供用户完成登录，未操作 Token/套餐 |

本轮额外函数基线：合成验签输入 1,631 bytes，未预热 5 次为 `0.2608 / 0.2238 / 0.2271 / 0.1943 / 0.1916 ms`，p50 `0.2238 ms`，nearest-rank p95 `0.2608 ms`。仅本地函数执行，无 HTTP/磁盘/云；没有旧实现同条件基线，不给出性能回退判定。

本轮有限数据检查仍为 `CONDITIONALLY TRUSTED`：公开 health 再次确认指数源日期 `2026-08-21`、`usable=false`，过期降级保持真实，没有发布新指数数据。不是逐基金金融准确性认证。线上 smoke/正式发布仍为 `BLOCKED`：未部署本批代码，生产 Owner 旅程、自然 Cron、应用写入跨重启与独立恢复未验收。

尚未完成真实生产生成器、凭据轮换、Owner 初始化、重启/恢复和自然任务出口；版本仍为 8.0.0，未 commit/push/tag/release，未删除 Gist。

## 性能首批基线

仅测密码哈希和校验函数，用于约束本地轻量实现。Windows / Python 3.14.4，默认 600,000 次、各 5 次、未预热；计时不含 HTTP、网络、冷启动或数据库。P95 为小样本 nearest-rank，即最大值。没有同条件旧实现基线，不给出“无性能回退”结论。

| 函数 | 5 次毫秒样本 | p50 / p95（毫秒） |
| --- | --- | --- |
| `hash_owner_password` | 360.185 / 403.945 / 364.579 / 356.900 / 353.181 | 360.185 / 403.945 |
| 合成密码校验并创建会话 | 354.105 / 368.154 / 382.418 / 375.747 / 358.299 | 368.154 / 382.418 |

生产 warm/cold、请求数量、包体与同设备前后对比继续留在 I21-04，不以此函数基线放行正式性能门禁。

## 访问阻塞与后续执行顺序

上一轮 Render 页面选择超时；用户重新打开后已恢复 Render 正常读取。此前新开的 Turso 标签停在登录页；本次用户完成登录后，正常标签清单已返回标题 `Databases | aureliuswu` 与 `https://app.turso.tech/aureliuswu`。登录状态已确认，不能再把当前阻塞描述为“未登录”。

本次浏览器控制仍在 `Emulation.setFocusEmulationEnabled` 超时；支持的页面选择、可访问性读取与 DOM 读取未获得数据库内容。已停止重复读取，保留用户标签，待刷新/恢复控制连接后继续。没有确认目标数据库/组，没有生成、复制、部署或撤销 Token，也没有修改套餐或平台 Secret。用户给定的候选文件仅包含数据库访问材料，不是组织管理凭据；没有用其绕过权限或枚举秘密。

补充轮换前的范围核对：Turso [数据库 API](https://docs.turso.tech/api-reference/databases/invalidate-tokens) 定义的是使指定数据库的全部授权 Token 失效，并说明需要短暂中断；[CLI invalidate 文档](https://docs.turso.tech/cli/db/tokens/invalidate) 另外提示所在组的全部 Token 也会失效。这些操作不是“只撤销旧 Token”，也会使操作前生成的新 Token 失效。实际 UI 尚不可读，不能假定其作用范围或存在单 Token 撤销能力。必须先确认具体入口、数据库/组和全部消费者；全量失效及中断须取得明确范围授权，不能从一般升级授权推导。

本次只更新执行记录与方案中的上述操作边界，未改业务代码，未重跑全量测试；前述测试数量仍属于各自记录的实施轮次。旧凭据的读取失败也不能独立证明撤销成功，须结合平台明确操作结果、可辨认的鉴权拒绝与同资源新凭据成功对照；`inspect`/health 的只读成功不证明写权限或耐久。

### 用户刷新后的连接复查 · 2026-09-30

用户回复“已刷新”后，在同一 IAB 连接重新检查：首次标签清单为空；按支持的恢复方式尝试在同一浏览器打开 Turso，调用 40 秒超时；随后正常连接清单确认新标签标题仍为 `Databases | aureliuswu`、URL 仍为组织数据库首页。对该新标签的页面绑定同样 40 秒超时并重置工具会话。没有取得数据库列表/管理按钮，刷新与新标签没有解决内容控制故障。Chrome/Edge 清单同时报告连接读取失败，未切换浏览器或尝试未支持的控制方法。

已经停止重复尝试。本次未输入/复制凭据、未调用管理 API、未执行生成或失效操作、未关闭用户标签，也未改变数据库、Render 配置或套餐。官方 [浏览器扩展连接排查](https://learn.chatgpt.com/docs/chrome-extension#troubleshooting) 包含重启浏览器/桌面应用的恢复建议，但未针对当前 IAB 超时给出确定修复；下一次用户重启桌面应用后重新打开当前聊天及 Turso 是恢复尝试，不是保证。不要要求重复登录或发送 Token，不清除浏览器数据/扩大权限来绕过问题。

并行只读枚举了仓库内的数据库 Token 消费者，未读取 `.env`、环境变量值、Temp 凭据或云端 Secret：

| 消费者 | 代码证据 | 轮换影响 |
| --- | --- | --- |
| Render API | `render.yaml:4,21-24`；`backend/database/db.py:529-535,942-952` | 仓库声明候选服务 `fund-compass-api-v8-candidate`，须由用户在受保护环境配置更新并重部署；真实服务/副本仍待平台核对 |
| API 仓储与 health | `backend/service/repo.py:10`、`backend/service/v8_repo.py:14`；`backend/main.py:337-354` | 共用 API 连接，没有独立数据库 Token；health 的 30 秒缓存不能证明新凭据已加载 |
| 本地候选 CLI | `tools/turso_candidate.py:53-83` | 从受控环境读取 URL/Token 并直接连接；若继续使用，需同步其秘密材料，不能打印或通过聊天交接 |
| Actions 与 Worker | `.github/workflows/` 未发现 Turso URL/Token 注入或候选 CLI 调用；`worker/src/index.ts:38` 与 `worker/wrangler.toml:17` | 通过 API 与独立机器鉴权访问，不因数据库轮换去改 Worker/Private Read Token；API 中断仍可能影响任务 |
| 验签/本地仓储工具 | `tools/verify_storage_evidence.py:37-41,133-141`；`tools/persistence_candidate.py:84-92` | 前者只禁止签名 key 复用数据库凭据；后者仅本地 SQLite，均不构成额外 Turso 网络消费者或远端验收 |

这不是完整平台资产清单。无法从仓库排除同组其他数据库/应用、手工创建的旧 Render 服务或预览实例、外部 CI/调度/备份工具，以及本机独立环境；不得只按仓库声明的一个 Render 服务执行全组失效。本轮仅文档更新及只读检查，没有改业务代码或重跑测试；I18-01 和正式发布仍未通过。

1. 用户刷新已验证未恢复连接；下一步由用户重启桌面应用，再打开当前聊天与 Turso，恢复正常页面控制后核对目标数据库/组。密码和 Token 不应粘贴到聊天，凭据输入、确认与提交由用户在正常受保护页面完成。
2. 先确认平台实际撤销语义。若支持精确撤销单个旧 Token，才采用新凭据部署验证 → 精确撤销旧凭据 → 新旧凭据对照；若只有全量失效，先取得明确范围/短暂中断授权，确认全部消费者，再执行失效 → 生成替代凭据 → 用户更新受保护配置 → 重部署验证。核对新部署标识及 health 的 30 秒缓存，不能仅凭缓存响应证明换钥生效；在初始化 Owner 前核对账号配置和免费套餐，不启用付费超额。
3. 完成生产验收 namespace 的应用读取隔离，进行受控业务写入 → Render 实际重启 → 应用读回，再做不同远端资源的恢复；保证普通 latest/outcomes/训练/通知不读到测试记录。
4. 验签器已具备本地拒绝回归；继续实现受保护执行器/可信生成器，把真实证据接入正式 workflow，再关闭 Iteration 18 出口。不能用人工签合成 fixture 放行。
5. 再按方案推进持仓/同步/机器消费者与数据任务。最后才同步 `9.0.0`、候选/自然观察/正式发布和旧 Gist 退出。

当前下一步需要正常平台访问及安全密码初始化，不能靠改 `durable=true`、降低门槛或自动改版本绕过。

## 继续执行 · 2026-10-01：候选错误诊断与远端基线同步

### 本次变更

修复 `backend/database/turso.py` 与 `tools/turso_candidate.py` 把 HTTP 拒绝、限流、服务错误全部混为通用失败的诊断缺口。适配器新增 `sqlite3.OperationalError` 子类，只携带严格整数状态和固定脱敏消息；CLI 仅信任精确适配器异常类型，401/403/429/5xx 分别输出固定码。传输错误、其他状态、伪造属性、子类、缺失/篡改状态仍通用失败，不解析提供方文本。

非 200 不读取正文、不跟随重定向，失败后连接不可复用，不自动重试。响应与会话清理保留原始错误，独立清理失败脱敏；关闭时无论清理成功与否都清除连接状态。提交/批量/关闭失败不能打印成功或 `committed=true`，也不能据此倒推请求一定未执行。401/403 只说明本次被拒，不证明 Token 撤销。使用说明已同步至 [TURSO-CANDIDATE.md](TURSO-CANDIDATE.md)。

全部新增回归使用合成地址/凭据与本地 SQLite 或模拟响应；覆盖严格类型短路、恶意比较/字符串化对象、非 200 不读正文、清理错误优先级、各阶段 CLI 脱敏和禁止重放。独立只读代码复审未发现阻断问题，其建议的 204、整数子类和恶意状态对象覆盖已补足。

### Git 与重新验证

本轮只读获取远端后发现 main 从 `706b6ad` 更新为 `fcfb140928ea1904f784da9f2e664c7eded89f74`。新增提交为 `github-actions[bot]` 的“更新海外估值精度账本”，仅涉及四份海外数据文件，与本地修改不重叠。已执行安全快进；同步前后的 42 个未提交文件 SHA256 全部相同，未覆盖原有工作。以下最终验证在快进后的本地脏工作区进行，不把远端自动数据提交当作 v9 发布。

| 检查 | 本次结果 | 边界 |
| --- | --- | --- |
| 后端全量 pytest | 1,081 passed / 44.29 秒 | Windows / Python 3.14.4；40,339 条既有依赖弃用警告，不替代 Python 3.12 CI |
| Turso/候选配置/本地隔离定向 | 159 passed / 7.19 秒 | 与全量重叠；合成数据，无云写入 |
| 前端测试 | 35 文件 / 260 passed | 本轮重新运行 |
| 前端类型检查、构建、PWA | passed / passed / 7 of 7 | 未部署本地修改；非旧客户端升级验收 |
| Worker 测试与类型检查 | 3 文件 / 144 passed / passed | 未部署，未验收自然 Cron |
| HTTP/清理/CLI 复审 | passed | 只读代码审查；没有真实凭据或云操作 |

本轮没有创建 v9 commit、push、Tag 或 Release，没有删除 Gist、生成/读取/撤销 Token、修改云配置/数据库或启用付费能力。版本仍为 8.0.0，v9 修改保留在本地。

### 当前公开生产观察

公开 API health 第一次请求在 20,195 ms 后失败/超时；第二次在 `2026-10-01T11:41:02Z` 返回 HTTP 200、JSON、656 ms。响应为 8.0.0、Render commit `fcfb140928ea1904f784da9f2e664c7eded89f74`、启动时间 `2026-10-01T19:39:17.923593+08:00`、libsql / `turso_candidate` / `durable=false`。这只能确认本次健康读取与候选身份，不能证明冷启动原因、换钥生效、生产应用跨重启读回或整体 smoke 成功。

指数估值仍为来源 `legulegu`、日期 `2026-08-21`、41 天、`usable=false`、`mapped_usable_indices=0`。过期降级保持真实，没有将缺失值补零或发布新的指数数据。有限检查结论仍为 `CONDITIONALLY TRUSTED`；未执行逐基金金融正确性认证。

### 本地函数性能对照

使用同一机器上的 HEAD 旧适配器（测量时为 `706b6ad`；远端新增提交未改适配器）与当前实现，纯模拟 `_pipeline`，每组先预热 100 次，再交替测 5 对、每样本 5,000 次。单位为每次微秒；p95 为 5 样本 nearest-rank 最大值。请求/响应全部模拟，无网络、磁盘、数据库和凭据访问。首次基准因模拟 Session 缺少 headers 失败，补齐模拟后重测；失败样本未计入结果。

| 状态 | 旧 / 新 p50（μs） | 旧 / 新 p95（μs） | 观察 |
| --- | --- | --- | --- |
| 200 | 1.1909 / 1.2656 | 1.2406 / 1.2904 | p50 +0.0747 μs，约 +6.3% |
| 401 | 1.4828 / 1.8665 | 1.5173 / 1.9003 | p50 +0.3837 μs，约 +25.9% |
| 503 | 1.5308 / 1.8414 | 1.7192 / 2.1244 | p50 +0.3106 μs，约 +20.3% |

这是严格校验和专用异常带来的可测函数开销上升，不宣称“无回退”；也不能用微秒模拟样本推导线上总延迟。生产 warm/cold、配额、流量和同设备旅程仍留在 I21-04 验收。

### 浏览器阻塞与下一道隔离门禁

本次支持的浏览器清单返回 IAB 空列表，Chrome 连接读取失败。在同一 IAB 新建 Turso 导航，`Page.navigate` 超时；随后仅获得 about:blank 标题和 Turso 组织首页地址。再次正常页面绑定 30 秒超时并重置工具会话，没有获得数据库内容。不能把旧轮次的登录状态或本次 URL 当作今日已登录/目标资源确认。已停止重复尝试，未切换连接方式或使用原生/CDP/配置文件绕过。

并行仓储审查确认：现有本地验收工具依赖**独占、带标记的完整 SQLite 数据库**，不是生产表内 namespace 隔离。它拒绝远端和混合数据库，未发现其已向生产写入验收记录的证据。但如果未来直接把合成链写入普通生产表，可能进入 latest/history/outcomes、同级比较、策略汇总、组合引用和通知 claim，并冲突于全局 Policy 前驱链。

I18-04 的后续实现必须先完成独立隔离设计与受控增量 schema 迁移：不可变 scope 元数据和记录保存同事务注册；跨 scope 引用拒绝；Policy 链 tip 按 scope 独立；业务默认查询在 ORDER/LIMIT 前排除验收记录（包括按 ID 和显式结算）；通知 claim 拒绝验收；受保护探针只允许明确验收 namespace，不伪造生产净值或成熟 Outcome。用旧 schema 副本验证迁移，再单独验收远端兼容性；不能把启动校验或 `initialize --candidate` 当作已实现增量迁移。

现有每周旧策略校准读取的是 legacy `repo.decision_outcomes`，不是 V8 Outcome；上述是未来混写风险，不声称当前隔离本地 fixture 已污染生产训练。

平台连接、精确凭据轮换与生产 Owner 初始化尚未完成；实际应用写入 → Render 重启/重部署 → 应用读回、独立远端恢复、可信证据生成器/正式 workflow 和自然任务观察继续未完成。I18-01/04/05/06 出口及正式发布仍 `BLOCKED`，不降低门禁或自动升级版本。

本轮重新查询并读取 OpenAI Docs 的 [浏览器扩展排查](https://learn.chatgpt.com/docs/chrome-extension#troubleshooting) 与 [内置 Browser](https://learn.chatgpt.com/docs/browser) 页面。前者提供重启浏览器/桌面应用等建议，后者确认内置浏览器由 Computer Use 操作，但没有给出本次 `Page.navigate` 超时的确定修复。用户重启桌面应用、回到此聊天并重新打开 Turso 后可再检查，这是恢复尝试而非保证；无需发送密码/Token，不清除用户数据或扩大权限来绕过。

## 再次继续 · 2026-10-01：同事务保留 fixture 防误写

完成 I18-04 的一个本地防守子项，不勾选其生产出口。`persistence_verification.py` 的统一 guard 已接入 `v8_repo.py` 四类 root 及组合/Outcome/组合 Outcome/通知写入。直接保留输入在远端连接前拒绝；既存引用在当前事务核对，去掉 Decision 自身的版本标记仍不能包裹合成祖先。Policy 不得继承验收 tip，混合通知批在任何 claim/duplicate 返回之前全批拒绝。

本地例外验证与写入共用 `BEGIN IMMEDIATE` 和同一 conn，不另开预检连接来授权。只允许当前 namespace 的精确 fixture；检查实际 main 文件、源码指纹、schema/immutable trigger、全部表 population 及已存完整前缀。标记本地库拒绝普通 root 和全部派生写；普通库拒绝保留 provenance。不按基金 `999999` 或自由文案识别。连接资源错位、源/标记/schema/trigger 漂移、混合数据、同 namespace 改份额且重算正确 ID、未标记既存重放等均失败且无新增记录。两连接合成测试确认 guard 与 INSERT 之间竞争写入不能提交。

为避免逐 component 的新远端请求，持久化决策及 E/H/P 祖先用一个参数化 JOIN 加载；普通远端 guard 不查询 marker。关联 JSON 的 IDs/基金必须与 SQL 投影一致，否则拒绝而不是选择另一链。通知原来的 existence lookup 被 lineage lookup 替代，响应字段增加但请求次数未由该替换增加；组合/Outcome 的额外读与 payload/扫描量仍需实际远端预算验收。

候选 CLI 同时修复以异常类名字符串识别可信错误的问题：只信正常导入的精确 VerificationError/ArgumentError 类型、内建异常 args 槽中的单个原生字符串及固定 allowlist，不调用 `str(exc)`。同名假类、子类、未知/私密文本、多 args、非字符串及自定义字符串操作均降级为固定通用失败；失败不输出成功、路径或私账。保留已有已知安全码和参数退出语义。

两路只读设计审查完成；CLI 实施分支在额度限制后中断，已保存的改动由主代理检查并补齐回归。没有购买额度、变更计费或把设计审查称作最终实现的独立复审。新源指纹覆盖仓储、verifier 和 CLI；旧本地 receipt 因源码变化按合同拒绝，不更新旧 marker/删除旧文件来通过。

### 本次验证

- 最终后端全量：**1,171 passed / 50.31 秒**，Windows / Python 3.14.4，42,386 条依赖弃用警告；不替代部署使用的 Python 3.12 CI。
- 最终边界/CLI/本地候选/V8 定向：142 passed / 21.57 秒，包含在全量中；全程合成数据，无真实云写入。
- 新增 90 项合成回归已纳入全量；包括投影漂移、精确重放、资源错位、并发锁、隐藏引用、六类通知阶段/整批原子拒绝、派生结果拒绝和 CLI 脱敏。初次新组合测试的 ID 未包含模型规范化字段，修正测试生成方式后重跑，没有放宽仓储 ID 断言。
- 本轮未改前端/Worker，未重新运行其全量、构建或真实设备验收；上一小节的 260/144/PWA 结果属于上一轮。
- HEAD/GitHub main 再读均为 `fcfb140928ea1904f784da9f2e664c7eded89f74`，本批仍未 commit/push/tag/release/deploy。schema 和正式持久化 gate 不变。

### 本地性能对照

本机临时合成 SQLite 文件，HEAD 旧仓储与当前实现，同一 business fixture；每实现预热 20 次，再交替 5 对样本，每样本 20 次真实事务写入。包括 Python/SQL/本机磁盘提交，不含 HTTP、Turso、冷启动或真实私人数据。

| 普通路径 | 旧 / 新 p50 ms | 旧 / 新 p95 ms | median 变化 / 本地预算 |
| --- | --- | --- | --- |
| 持仓写入 | 17.7281 / 17.3300 | 18.2012 / 17.9980 | -2.2% / PASS |
| scheduled 通知记录 | 16.4376 / 16.8527 | 17.0362 / 17.9594 | +2.5% / PASS |

持仓旧 5 样本：17.4472/17.7448/17.7281/18.2012/13.3986，新：17.2458/17.3300/17.9980/17.5003/14.0947；通知旧：16.2426/16.3993/16.7391/16.4376/17.0362，新：16.2975/16.9978/15.9170/16.8527/17.9594。p95 是小样本 nearest-rank 最大值，变化仅方向性，不宣称显著加速或完整无回退。没有既有通用性能 artifact 目录，本次原始样本记录于本节；生产延迟、JOIN payload/配额和扫描量仍未测。

### 线上观察和阻塞

浏览器新清单能看到 IAB 的 about:blank / Turso 首页地址，但 Edge 连接读取失败；选择该 IAB 标签仍 30 秒超时并重置会话。没有页面内容/数据库/Token 界面证据，停止重复操作，仍不能确认当前登录或作用范围。computer-use 安全边界继续暂停平台变更。

公开 health 第一次 `2026-10-01T12:33:56Z` 在 20,185 ms 后失败/超时；第二次 `2026-10-01T12:36:39Z` 返回 200 / 615 ms，8.0.0 / `fcfb140`、libsql / turso_candidate / durable=false。指数仍 `2026-08-21`、41 天、usable=false。只读健康恢复不解释首次失败原因，不证明凭据轮换、写权限、生产跨重启或整个 smoke；未改变过期数据或缺失值语义。有限数据结论 `CONDITIONALLY TRUSTED`。

这不是完整生产 scope、普通读取/原始 SQL/legacy 隔离或所有虚构数据的识别系统。未检查真实私人 source/account 是否与新保留前缀冲突，部署前需受控兼容核对。平台目标/凭据、生产 Owner、真实写入重启读回、独立远端恢复、证据生成器/workflow 和自然 Cron 仍未验收；正式发布 **BLOCKED**。版本仍为 8.0.0，未新建云资源、改云数据/配置、读取凭据或删除 Gist。

## 持续推进 · 2026-10-01：I21-02 请求与条件提案本地加固

用户再次授权按 v9 统筹方案持续执行。本轮保留现有 I18 改动与版本 8.0.0，独立推进 I21-02 的可本地验收子项。HEAD 和 GitHub main 在本轮开始及集成后重新查询均为 `fcfb140928ea1904f784da9f2e664c7eded89f74`。没有将版本号或局部测试当作正式资格，没有新建付费服务、升级套餐、调用真实 BYOK 模型或删除旧 Gist。

### 修复与合同

- 从既有 API 层提取共享 `fetchWithDeadline` / `requestJson`，保留 API no-store、204/205 与 Owner 取消兼容。deadline 包含 fetch、正文和解码；transport 忽略 abort 也会停止等待，迟到结果不能返回成功。
- 两类 AI provider 接入 30 秒总 deadline 和 caller signal；正文以流式读取限定 64 KiB、文本输出 16384 UTF-16 单元。HTTPS、无 URL 凭据/查询/片段、redirect error、credentials omit；不读取失败 body、不展示上游 error.message，不自动重试收费 POST。用户取消不保证提供方取消计费，UI 明确披露。
- 新增 `contracts/nl-filter-spec-v1.json`，运行时封闭校验单对象、未知/重复/转义同名字段、类型/枚举、有限数值、收益/费率边界及 unsupported 长度。拒绝类型转换、外围解释/代码块和部分条件执行。数字是用户确认的筛选阈值，基金收益仍来自已验证静态数据，不接受模型创造的基金数字或买卖动作。
- Screen 先验证非空且新鲜的排行再调用可选 AI；展示原需求、全条件、默认排序和数据日期，用户确认才筛选。编辑需求、取消、切模式、卸载会取消/作废待执行提案，旧 success/catch/finally 不覆盖新状态；重复按钮/键盘发送不重发同一运行请求。确认时再次检查日期，失败 finally 不再隐式发第二次静态加载。
- Screener/Managers 集合加载有独立 12 秒总 deadline（包括分片 hash）、每次最多 6 个并发分片，乱序完成按 manifest 顺序组装，失败/取消停止排队项及活动兄弟请求。只有 manifest 404 可回旧文件，503/超时/格式/hash 错不偷换代次。保留原 schema、集合/分片 hash、去重和金融 null 规则。
- Screener 内存命中重算北京日历新鲜度；Enrich fetch+JSON 6 秒、命中仍核对披露年龄；精度报告 fetch+JSON 12 秒，失败 null 不永久缓存，force generation 与 caller 取消互不串请求，消费数值形状校验避免字符串 toFixed 崩溃。
- 自由文本 `llmInterpret` / `generateStorySummary` 暂停，直接调用也固定拒绝且无网络。详情/故事页明确暂停，不恢复/展示/写入旧 `sinan_ai_text`；保留用户旧缓存和配置，不删除数据、不用规则 fallback 冒充模型结果。规则解读对评分 eligible、评分与信号 coverage、stale 和非有限值保持边界；缺超额不补零，真实零仅表示该历史区间持平，详情底部回测说明同步中立化。

这按照 data-reliability-audit 的来源/新鲜度/缺值边界收口，并采用 release-checklist 的“局部代码与正式验收分开”原则。严格条件合同和人工审核不能证明模型完整理解了自然语言；没有真实第三方模型调用/CORS 成功证据。

### 本次最终验证

| 项目 | 结果与范围 |
| --- | --- |
| 前端全量 | **42 文件 / 446 passed**；包含真实 SFC 自定义 renderer 的输入/点击/确认/取消/卸载，不是物理浏览器 |
| 前端类型/构建 | type-check、build 通过；**PWA artifact 校验 7/7**，不替代已安装旧 PWA 升级 |
| 后端全量 | **1171 项全部通过**；本轮重新运行，1171 collect-only 核对一致；Python 3.14.4 / 42,386 条依赖弃用警告，仍不替代 Python 3.12 CI |
| Worker | **3 文件 / 144 passed**；check、Wrangler `--dry-run` 通过；114.28 KiB / gzip 26.58 KiB，不是线上 deploy |
| Git | diff --check 通过，仅 LF/CRLF 提示；依赖与版本文件无本轮修改 |

故障/边界覆盖包括：AI fetch/body 永久 pending、忽略 abort、预取消/流式取消、正文超限、配置/响应形状、固定 HTTP 脱敏与零自动重试；非法/重复 JSON、真实零阈值/缺收益、unsupported 整次拒绝；静态预检未完成时取消/编辑/卸载后不启动付费解析；新旧提案倒序完成与确认前跨日过期；分片 body/hash/最终集合 hash 超时、超过 6 个分片的乱序和队列取消、404/503 区分、失败后恢复及缓存跨日。

最终另一路只读实现复审覆盖共享 request/static-collection、AI/条件合同、四个 loader、规则解读与三页完整 diff，未发现本轮新增 P0/P1 阻断；未编辑、访问真实配置或重跑全量。独立复审与主代理测试一致接受本节的有限边界，不放行生产或抹除历史缺口。

初次 Screen 测试因自定义 host 缺少 Vue v-model 所需的 addEventListener/getRootNode 失败，补齐合成 host 的实际 input 事件处理后重跑；没有改生产指令或放松业务断言。并发测试最初错误要求已完成的失败 HTTP 响应信号也取消，修正为只检查尚在途的兄弟请求；没有改变运行边界。子项测试均已纳入最终 446，不重复相加。

### 本地包体对照 · 非完整 I21-04

performance-regression-check 的比较点为本轮修改前已有本地 `dist`（`2026-10-01T11:42:53.122Z`），不是干净 HEAD/正式 release。最终产物 `2026-10-01T13:23:56.249Z`。同机、同 Node/zlib、排除 source map，统计 dist 内全部 JS/CSS；两侧各重复读取同一产物 3 次一致，不是 3 次独立构建或旅程测速。

| 指标 | 修改前 / 最终 | 增幅 | 局部判定 |
| --- | --- | --- | --- |
| JS/CSS raw bytes（58 文件） | 1,274,874 / 1,281,149 | +0.49% | PASS（<20%） |
| JS/CSS gzip bytes | 456,340 / 458,752 | +0.53% | PASS（<20%） |
| 主 index JS raw / gzip bytes | 222,974 / 224,337；83,800 / 84,250 | +0.61% / +0.54% | PASS |
| 最大 echarts JS raw / gzip | 532,397 / 182,300（两侧相同） | 0% | 未增加 |

主要变化来自共享取消/清理、严格校验及确认 UI；自由文本逻辑移除抵消部分增量，没有新增依赖。这里不报告 DOM/LCP、真实交互延迟、网络 transferred bytes、冷/热请求量或统计显著性。真实大集合在慢网络 12 秒内完成、全局多 loader 并发预算、生产 warm/cold 和设备旅程仍未测。

### 平台阻塞、数据缺口与下一步

浏览器清单本轮可见两个 IAB Turso 首页标签，其中一个标题为 Databases；Chrome 连接返回 `nodeRepl.fetch request failed`。支持的 `getTab` 绑定实际页面再次 30 秒超时并重置会话，未获得页面正文/库名/组/费用设置/Token 操作证据。按 computer-use 安全边界停止平台操作，不通过 profile/cookie/CDP/Secret 提取绕过。已请求用户只核对候选数据库名称、组和其他消费者，不发送 Token；全库/组失效必须先核对并明确授权影响范围，凭据输入/确认/提交须由用户接手。标签标题/地址和历史登录都不证明当前轮换或资源范围已确认。

本轮没有重新运行线上 smoke 或读取真实基金记录与独立权威金融源。有限本地数据/交互结论为 **CONDITIONALLY TRUSTED**，不是全应用金融准确性认证。旧 Story 页缺净值/成本补零、部分今日数据合计和日期/覆盖缺口，以及 legacy 独立评分/信号卡片统一门禁，仍待 I19-05/I20-02；自由文本暂停不修复这些原有数字。Screen 非 NL 的初始化排行/经理/基础列表生命周期、top10 穿透请求、经理日期 UI 和完整精度元数据合同也未在本轮收口。

I21-02 为本地子项通过，整个工作项未勾选。I18-01/04/05/06、生产 Owner 初始化、真实写入→宿主重启→应用读回、独立远端恢复、受保护证据生成器/workflow，I19 持仓/同步/行动链和 I20 自然产出，以及 I21 实际设备/部署验收仍未完成。正式发布继续 **BLOCKED**；三端版本仍 8.0.0，本批代码未 commit/push/tag/release/deploy。

## 2026-10-01 · 自主推进：直连路线与下一批硬化

用户要求自主实现目标、尽量不重复询问。按 release-checklist、data-reliability-audit 和 performance-regression-check 分开代码、实库只读、候选/正式证据；不启用付费资源，不降低安全门禁。

### 已解除数据库页面依赖

从用户此前明确提供的确切本机配置读取候选 URL/Token，只向工具子进程环境注入，不输出原文件/地址/凭据，也未搜索其他密钥位置。该文件不是带标准变量名的 dotenv 格式；按唯一候选 URL 与唯一凭据格式解析并核对候选主机后，`tools/turso_candidate.py --timeout 20 inspect` 实际成功：schema 8、20 张表、27,947 只公开基金，scope 为 `database_probe_only`、`formal_release_verified=false`。

全程仅只读，没有业务写入、私人账本读取、schema 迁移、凭据轮换/撤销、平台或费用设置变化。Dashboard/Chrome/MCP/CLI 登录失败不再阻断 SQL 子项；现有 Token 可读不代表安全轮换或耐久门禁完成。旧已超时 CLI 授权链接不复用。

### 本地与远端基线

`origin/main` 实时为 `5daddec42d599ce45cd88d72ad00e990c092aeaf`。确认仅三项海外公开/审核数据更新且不与 dirty 文件重叠后，从 `fcfb140` 安全 fast-forward；所有原有 v9 修改保留，无 reset/清理/强推。新 scope 合同尚未在远端迁移，本批不得直接推 main 触发 Render 自动部署。

### 经理索引日期与请求生命周期 · I20-02 / I21-02 子项

生产工具 `tools/managers.py` 的 `updated/fetched_at` 是采集时间，并非任职回报或在管规模的基准日。新增兼容 `loadManagers()` 的 `loadManagerDataset()`，保留采集日、可得采集时间、来源和 `valueDate=null`；manifest 没有的时间不从加载时钟补造。年龄按北京时间日历重算，缺失/非法/未来日期保持未知，超过 7 天只是索引历史查阅警告，不把指标宣称为当前表现。

Screen 展示采集日、年龄和“指标基准日未知”；基金数量注明“采集时在管”。本地午夜 timer 更新显示，不轮询源，卸载/切模式清理 timer、取消经理请求并拒绝迟到回调。缓存跨日不发新请求，空 fallback 集合拒绝。三文件定向 **55 passed**、type-check 通过；后续以集成结果为准。

本轮实际读取公开 Pages manager manifest/首分片：schema 2、采集日 2026-09-28、4,347 条，代表公开 ID `30777698`，manifest 没有 fetched_at、record 没有指标日期。独立读取天天基金源接口 HTTP 200，找到同 ID、12 个源字段；只核对实体/源格式与日期合同，没有宣称当前数值与历史快照一致。原始数值仍按来源历史展示，不作为实时准确性认证。

Story 缺值/覆盖及日期边界、周校准有界 GET 与私人产物防公开、不可变 root scope 旁表及默认读取隔离正在独立实现/复审。完成后的集成结果与确切范围续记，不预先勾选工作项。

## 2026-10-02 · 冻结快照集成验收

本批代码完成本地集成，继续 v9 目标，不将候选进度冒充正式发布。软件三端仍 8.0.0；物理数据库 schema 因隔离合同独立升至 9。线上真实只读 inspect 仍为 schema 8，未执行远端迁移/业务写入。

### 实现与边界

- I18-04 本地隔离：四类 root 显式 scope 与不可变元数据同事务提交；V8 默认读取先通过 production 视图再排序/limit，涵盖 latest/history/peer/结算/通知读取。循环或孤立 Policy、跨 scope 引用及 malformed/scalar 组合 JSON 不进入生产路径；远端 acceptance 写保持关闭。
- 旧 SQLite 8→9 迁移验证 typed 模型、稳定 ID/摘要、SQL 投影、引用/前驱链及 source-health/派生人口完整性，异常整批回滚，原 payload/ID 不变。已有 schema 9 缺 scope 要求显式修复，不静默重分类。独立只读复审及 88 项定向测试未发现漏筛/同事务缺陷；不替代全局原始 SQL/legacy 隔离。
- 本地备份生成在迁移锁之前，只是点时备份，不能当作并发精确回滚前像。真实迁移必须冻结写入，或实现锁内前像核验；Turso 受控增量迁移尚未实现，startup/initialize 会拒绝旧 schema 8，因此本批不得直接推 main 自动部署。
- Story 不再将缺净值/成本/日变动补零，完整覆盖才发布组合值，部分定价小计明确披露；日变动/排行需同一来源日和明确新鲜度，信号/评分需独立 evidence 与覆盖/日期门禁。所有来源日期采用完整语法和日历/时钟校验，拒绝垃圾尾部/非法时分秒与偏移；只保留来源年月日，不推断时区或改变 QDII 日期。报告生成时间单列，自由文本 AI 继续暂停。
- 周校准 GET 有界三次/150 秒总预算、单次 45 秒、8 MiB 正文与逐 read1 socket 预算；鉴权/坏 JSON/合同不重试，错误固定脱敏。没有私人 sink 时 workflow 明确 `BLOCKED_PRIVATE_SINK_REQUIRED`，不公开 upload/commit、不中断隐私保护换绿色 conclusion。此为读取/泄露风险修复，不宣称自然周任务已恢复产出。

### 最终质量门禁

| 验证 | 最终结果 | 证据范围 |
| --- | --- | --- |
| 后端 Windows | **1243 passed / 68.96 秒**，Python 3.14.4 | 隔离本地合成库，清除子进程宿主凭据 |
| 后端 Linux | **1243 passed / 79.14 秒**，Python 3.12.3 / SQLite 3.45.1 | WSL Ubuntu 24.04 隔离 venv；前后 source fingerprint 未变，与部署 Python 主次版本匹配，不是云端 CI/业务验收 |
| 前端 | **43 文件 / 491 passed**，type-check、build、**PWA 7/7** | 真实 SFC 合成 renderer；不替代物理浏览器/已安装 PWA 升级 |
| Worker | **3 文件 / 144 passed**，check、Wrangler dry-run | 本轮代码未变；114.28 KiB / gzip 26.58 KiB；未实际部署 |
| Git | diff --check 通过 | 仅 CRLF 提示；有限改动路径秘密模式检查无命中，不称全仓安全审计 |

后端两平台均有一个现有 Starlette/httpx 弃用警告，不为消除警告做无关依赖升级。先前 Linux 全套唯一失败在最终源码冻结后单项 1/1、整文件 22/22 和原顺序全套 1243/1243 均不复现；旧合成库 marker 与最终源码不符、保留合法持仓/Evidence 前缀。该状态与运行期间源码漂移守卫拒绝一致，但历史安全码未捕获，不断言精确触发点、不改守卫/marker 绕过。

### 局部包体对照

同机同压缩方法，只统计 dist/assets 的 JS/CSS（55 文件），两侧各三次重复读取同一产物，不是独立构建或真实旅程。修改前 raw 1,251,537 / gzip 451,252 bytes；最终 raw **1,264,368** / gzip **455,171** bytes，分别 **+1.03% / +0.87%**，局部预算 PASS（<20%）。与前节含 sw/workbox 的 58 文件口径不同，不能混用；无新依赖。未测真实 warm/cold、交互、跨网性能或扫描配额。

### 继续顺序与发布限制

将本批保存到独立 v9 升级分支，不推 main、不触发 Render/Pages 自动部署，不创建正式 Tag/Release。随后推进 I19-01 本地持仓表单/校验与明确待同步状态，以及显式 Turso 8→9 迁移/恢复工具的候选演练。真实私人数据上传仍需明确启用；凭据轮换、生产 Owner、应用写入→宿主重启→读回、独立远端恢复、正式 workflow/可信执行器、I19 同步/行动链和自然观察等缺口未关闭，正式发布状态 **BLOCKED**，v9 目标保持进行中。

## 2026-10-02 · I19 输入、隐私与离线迁移演练

前一批已经提交并推送到独立分支 `feat/v9-foundation-hardening`：`762c6a7ad56e1f34429f955b8cf97f292a5d63a2`。main 仍为 `5daddec42d599ce45cd88d72ad00e990c092aeaf`，没有通过主分支自动部署绕过远端 schema 8 与本地 schema 9 的差异。用户要求自主完成、尽量不重复询问；继续使用现有免费资源，不新增订阅或付费超额。

### 本批实现

- I19-01：自选页支持仅关注/持仓、账户、份额、成本净值和目标权重；同基金跨账户保持独立。严格解析拒绝负数、非有限值和类型转换，未知成本/目标保持 null，真实零份额可保存。账户改名同时保留旧 key 墓碑，冲突、存储失败、旧编辑副本不覆盖现有记录；删除持仓需要确认。
- 本地修改保留 `local_pending`，不会因 legacy Gist 上传成功冒充服务端 revision。首页和详情的私人当前行动在存在本地待确认输入时暂不展示，历史入口保留。这只是本地输入保护，完整 Holding/Policy/Decision/策略引用门禁仍待 I19-04/05。
- 共享 `fund_only` 聚合不再跨账户取最后一行或把未知份额补零；缺成本不算伪加权成本，缺目标不自动归一化。Story、Assets、Lab 对缺份额、非法/重复账户、坏本地存储及金额溢出阻断完整组合、权重和快照；非有限显示统一为未知。有效零经济持仓保持明确空状态，不制造有价组合。
- Gist PAT 不等于上传同意。旧同步需要独立、默认关闭的明确同意；撤销、换 Token、外部标签页撤销、超时、同文件新请求都取消/作废迟到结果。只允许封闭 DTO，不回显上游错误；详情不发送本地私人持仓，Lab 的私人 POST 暂待受限 Owner 接口。保留旧数据/PAT，不删除或偷偷上传。
- 自选与手动资产拒绝已观察到的旧标签页覆盖；外部事件只重载，不回写/自动上传。手动资产云端空集合不等于删除，缺少云项不删除本地项；本地变更期间迟到下载不提交。保存读回冲突时不恢复旧 raw 覆盖另一标签页的新值。原生 localStorage get/set 不是跨标签原子事务，本批不作线性一致性承诺。
- 新增离线 `turso_scope_upgrade` 的 plan/rehearse：只读明确 SQLite 快照、固定仓库 DDL 比对、typed 数据/rowid/引用/人口与摘要验证、私有内存逻辑备份恢复和应用仓储读回。无 apply 子命令，不读凭据、不访问远端、不执行输入 DDL、不调用真实应用初始化；证据固定为 `local_turso_schema_migration_rehearsal`，远端迁移/恢复和正式资格均为 false。

### 当前平台事实 · 只读

直接 SQL schema 元数据核对成功，不再依赖超时 Dashboard：远端 schema 8，54 个核心对象均匹配，另有 `turso_candidate_probe_v1` 与 `universe_import_state` 两张项目原有辅助表，分别与候选探针和全集导入工具的固定 DDL 匹配。只输出合同匹配状态，不读取私人账本行或打印 SQL/配置。当前离线合同仍拒绝这两张 extra；下一切片须显式纳入固定可选 profile 并测试，禁止任意前缀白名单。

Render 专用连接已实际读取候选服务和部署，无需浏览器登录：`srv-dab7g0n40ujc73a2ma50`，free、单实例、main/自动部署；最新 live `dep-dav6acrncjis73da03e0` 为上述 main SHA，2026-10-01T13:52:03.67132Z 完成。线上启动命令尚未应用 feature 分支的单 worker 显式限制，Owner 密码材料尚未初始化。此为平台部署元数据，不是本批上线、完整 smoke 或业务耐久验收。

本批未新增云资源、修改环境/计费、迁移云表、写业务/验收记录、轮换/撤销凭据、触发部署或删除旧 Gist。现有 Token 可读不证明权限最小化、轮换或有效期门禁完成。

### 冻结源码最终验证

| 门禁 | 结果 | 范围 |
| --- | --- | --- |
| 后端 Windows | **1308 passed / 78.16 秒**，Python 3.14.4 | 独立合成 DB 与 basetemp；子进程移除宿主凭据；48,171 条 pytest_asyncio/FastAPI 依赖弃用警告 |
| 后端 Linux | **1308 passed / 81.38 秒**，Python 3.12.3 / SQLite 3.45.1 | WSL Ubuntu 24.04 任务 venv，1 条依赖弃用警告；不是云端 CI |
| 前端全量 | **48 文件 / 657 passed / 4.39 秒** | 最后一个手动资产交错写入回归纳入全量；SFC 合成 renderer，不是物理浏览器 |
| 前端类型/构建 | type-check、build、**PWA 7/7** 通过 | 1088 modules / 11.01 秒；自动组件声明包含新表单、门禁和 Vant 输入组件 |

Linux 第一次同一冻结后端全量为 1307 passed / 1 failed：恢复 CLI 返回 `invalid_receipt_timestamps`。保留失败；单项复跑 1 passed / 3.20 秒、原 receipt 只读重放及原顺序全量均通过。122 个后端/工具/合同/workflow 源文件前后摘要为 `2ba87d662beddccca5a3de25beddff166a3bdb7214bd1513cf7ed691cdd30d43`，未漂移。控制时钟为 observed 时间之前 1 微秒可复现相同安全拒绝；真实首次墙钟回退仅为推断，未证明。不改时间守卫、原 receipt 或标记以换通过。

最终 `dist/assets` 的 JS/CSS 为 56 文件，raw **1,308,951**、gzip **466,698** bytes。对照修改前 55 文件 raw 1,264,368、gzip 452,359，分别 **+3.53% / +3.17%**，局部预算 PASS（<20%）。同机 Node v24.14.0/zlib 默认 gzip，两侧各重复读取同一产物三次一致，不是三次独立构建或旅程测速。前节 gzip 455,171 为旧压缩口径，不用于此次差值。没有新增依赖，真实设备/warm/cold/请求量未验收。

Git diff-check 通过，仅 CRLF 提示；45 个有限改动路径的常见秘密模式扫描无命中，不称全仓安全审计。Worker 本批没有改动；前批 144 项/check/dry-run 属于前批证据，不声称本次实际 deploy。

### 后续实现边界

I19-02 已完成只读设计复审：同步模型、独立 `owner-sync-schema-1` 扩展、当前状态/changes/幂等 receipt 同事务；字段 revision 防止 A→B→A 绕过，墓碑生命周期防止旧设备复活，原响应精确重放，提交结果未知仅查询 receipt。先实现隔离合成库中的仓储/失败测试，再接受限 Owner HTTP；不把新表加入自动启动迁移，也不扩张 Admin/Worker 权限。远端批次需真正 CAS 失败中止与提交协调，不能把本地事务称作远端验收。

三端应用版本仍 8.0.0，schema 9 独立管理。整个 I19-01/02、I18 持久化出口、真实 Owner/设备/PWA、自然任务观察和正式 v9 发布未完成；工作项仍未勾选，正式发布 **BLOCKED**，总目标继续进行中。
