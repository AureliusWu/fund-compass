# Owner-only Turso ASGI 候选接线

应用仍为 **8.0.0**；main 的普通本地 SQLite 工厂和线上部署保持不变。

`service.owner_sync_candidate_app.create_turso_owner_sync_candidate_app(url, token, *, timeout_seconds=8, operation_seconds=30)`
是可直接交给 ASGI server 的独立应用工厂，不是默认 main、迁移工具或部署开关。
URL/数据库 Token 只认显式参数，不发现环境凭据；构造及 ASGI startup 均不开库、不发 HTTP。
它只挂现有 Owner session 和三类同步路由，不挂 health、分析、Policy 或 Worker 写入，也不启用跨源访问。
登录仍遵守独立 Owner 密码/会话配置，数据库 Token 不授予浏览器权限；会话与限频仍要求单进程。

main 继续调用原 `build_owner_sync_router(connection_factory)`，现在通过
`LocalOwnerSyncRepository` 进入共同 `build_owner_sync_repository_router(repository)`。
本地 adapter 保留原工厂、每操作独立连接/关闭，以及工厂失败与提交后/close 失败的不同 unknown 边界。
候选使用已有 `TursoOwnerSyncRepository`，不重新实现 SQL、schema 或事务。
两者共享同一 Owner scope、显式同意、有界正文/查询、线程池内与返回前权限复核、私密响应禁止缓存合同。
仅真正权限复核的内部哨兵异常可穿透仓储边界；工厂/driver 任意 HTTPException 同样脱敏，
本地获取失败不伪称提交，已进入写入或关闭失败仍保留 unknown。

远端每次操作仍只接受 **core schema-table 9 + 完整 Owner-only 五表**及原逐表可选合同。
旧 schema8、额外/部分 schema、完整 analysis/machine 扩展都拒绝；无补 DDL、自动迁移、重试或本地 fallback。
30 秒是既有协作总预算，不是网络/SQLite 的硬终止保证。未知写只核原 id/hash 回执，缺失不是回滚证明。

针对性测试贯通实际 ASGI、真实 Owner 登录、现有真实 HTTP adapter 与拥有的 loopback SQLite/Hrana 模拟器，
覆盖幂等/分页合同、原回执、HTTP 提交响应丢失、撤销、Owner 权限与 schema 拒绝。
这不是实际 Turso 的 JSON1/TEMP/配额、云提交耐久、跨重启/恢复、真实 Chrome/PWA 或正式发布证明。
真正接入/迁移/发送/生产切换仍需新的明确确认及独立门禁；没有恢复自动部署或删除 Gist。
