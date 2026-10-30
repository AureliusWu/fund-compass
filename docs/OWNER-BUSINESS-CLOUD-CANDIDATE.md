# 显式完整业务云仓储候选接线

本轮仍为应用 **8.0.0**。普通 `main`、本地连接工厂、旧 Owner-only 云 profile、默认 Worker 与部署暂停不变。本文件描述受限候选代码，不是已上线、已迁移、已恢复或 v9 发布声明。

## 能力边界

`service.owner_business_candidate_app.create_turso_owner_business_candidate_app(url, token, ...)` 只接受调用者显式 URL/Token，构造和启动零 I/O，不发现环境数据库凭据、不补表、不迁移、不发通知。真实请求才进入有界 HTTP driver。

它挂载本轮的私人业务与 Worker 封闭入口：

| 权限 | 路径 | 固定操作 |
| --- | --- | --- |
| Owner 密码/会话 | `/api/v2/owner/session` | 登录、退出 |
| Owner 指定 scope 与单独同步同意 | `/api/v2/owner/sync`、`/requests/{request_id}` | 原包写、完整分页变更、原回执核对 |
| Owner `run_personal_analysis` 与分析同意；回执需 `read_private` | `/api/v2/owner/analysis`、`/requests/{request_id}` | 完整服务端来源分析、原回执核对 |
| Owner `read_private` | `/api/v2/private/portfolio/policy-state` | 当前/未来/历史 Policy 只读快照 |
| Worker/Admin | `/api/v2/worker/portfolio/*` | source、显式 cache prepare/原回执、Evidence/原回执、task prepare/claim/finish/status |

这不是 `main` 的 drop-in replacement：**不包含旧公共基金详情、其它 Admin/结算 API 或 Render 健康检查路径**，`/health` 和旧 `/api/health` 均不在此候选 app。不能直接改原 Render `startCommand` 或全站前端 `API_BASE` 后宣称全部消费者已切换。普通应用同名本地路由仍用原生 SQLite adapter，原路径/完整 schema 守卫不放松。

固定 CORS 来源与请求 header 闭集沿用原应用，不接受调用者增加来源，也不授予权限。Owner 会话与登录限频仍进程内存态，因此只适合单 API 进程；不能据此开启多 worker。

## 仓储接缝与失败合同

HTTP 层只绑定三类明确的 analysis/Policy/machine repository protocol，以及原有三操作 sync protocol；没有 HTTP SQL、通用执行或任意方法分发入口。

- 原本地 `build_*_router(connection_factory)` 保留，分别包装拥有连接及 close 的本地 adapter；已有 main 调用不变。
- 新 `build_*_repository_router(repository)` 共享相同 body/query、权限、scope、consent、速率与私有响应处理。完整候选 app 将它们显式接到 `TursoBusinessEngine` 的四个 facade。
- 只有真正授权回调的异常可原样返回；driver 异常、关闭异常与私人详情不外泄。已接受的写入、提交响应或 close 失败均不能作回滚证明。
- 原请求 ID/hash、业务版本、完整来源 revision/SHA 与 Policy/Evidence 引用分别保留。revision 不是 Holding/Policy/Decision 版本。
- 未知写入只核原回执或原任务状态，不自动重试、不换身份。回执缺失不证明未提交；`claimed=false` 或读回已有 attempt 不授予再次发送。
- 权限在操作前、受保护提交回调、操作后重新核验。提交后撤销只隐藏私人成功，不撤回已发生提交；重新登录只能核原回执，不能重放原包。

## 验证口径

`test_owner_business_candidate_app.py` 使用真实 ASGI、真实有界 driver、真实 HTTP 和本次独占的本地 SQLite/Hrana 服务。只替代公开详情采集源及可观察的网络故障，不替代仓储业务结果。覆盖固定路由/构造启动零 I/O、权限/scope/同意/CORS、source/Policy/sync 三操作、冷缓存→Evidence→分析/原回执→task→单次 claim，以及响应丢失/close 失败/撤权后的只读核对和 no-replay。

上述是 owned-loopback 功能证据，**不等于实际 Turso 的能力、容量、耐久、迁移/恢复、生产浏览器或自然定时任务验收**。测试通过数字、精确源码身份与真实迁移门禁另记本轮交付报告，不能由此文件的能力描述推断 PASS。实际切换仍需独立保护备份、停写/排空、一次迁移与原包核对、受控恢复和旧发送状态去重验收；旧 Gist 不因本候选接线被删除或重新开放。
