# 司南基金 v8 后续工作

日期：2026-09-01（Asia/Shanghai）

## 发布闭环（当前任务继续执行）

1. 仅使用已创建的并行 Render Free 候选服务，不创建或升级任何付费资源；真实 URL 为 `https://fund-compass-api-v8-candidate.onrender.com`，继续记录最终 deployment ID 与目标提交 SHA。
2. 已生成三组互不相同的高熵凭证：`ADMIN_TOKEN` → 候选 Render；`WORKER_TOKEN` → 候选 Render、Cloudflare、GitHub Actions；`PRIVATE_READ_TOKEN` → 候选 Render、GitHub Actions。凭证不进入仓库、日志、前端变量或 localStorage。
3. 将 GitHub `FUND_API_BASE`、`VITE_API_BASE` 与 `worker/wrangler.toml` 统一指向上述已核验的候选 Free API。
4. 对最终工作树重跑全量门禁，提交并推送 `main`。从该提交的清洁临时 worktree 部署 Worker，记录 version ID。
5. 验证 Free API `version=8.0.0`、源码身份与 `persistence=ephemeral / durable=false`。重启可能丢失数据库内容，V8 persistence gate 必须保持阻断，不能声称跨重启读回通过。
6. 等 CI/Pages 完成后运行 production smoke；代码、隐私、数据失败关闭、精确 SHA 等门禁可形成候选部署证据，但只要 `durable=true` 未满足，正式状态仍是 `BLOCKED`，不得创建或推送 `v8.0.0` 标签及 GitHub Release。
7. Free 路由只在部署同版隐私加固代码后作为应用路由回切点；它不是持久数据备份，也不得回滚到公开私人 DTO 的旧版本。

## 下一轮产品/架构 P0

### 可信 owner 会话

实现服务端会话或 BFF，让服务所有者在浏览器安全读取完整 V8 私人决策。不得把 `PRIVATE_READ_TOKEN` 编译进前端或长期保存到浏览器。完成前维持匿名 HTTP 403 拒绝与明确不可用状态。

### 私人策略治理存储

把 outcome 汇总、历史退化周期、candidate 与治理建议迁入认证持久层；公开 Git/Pages 只保留可公开研究证据。随后恢复有真实私人样本时的每周校准，保留幂等、版本、历史和回滚语义，不通过清空样本或伪造 `total=0` 绕门禁。

### 零成本持久化替代方案

评估可审计且不产生费用的耐久存储方案；在完成身份、备份、恢复、并发和跨重启验证前，不迁移真实私人数据，也不把 Render Free 临时 SQLite 标记为持久。任何未来付费资源都必须重新取得用户明确授权。

## P1

- 为指数 PE/PB 接入第二个可审计来源或人工复核快照流程；多源冲突时保留各自日期/口径并失败关闭，不把抓取日冒充行情日。
- 在 Cloudflare 配置 `/quotes` Rate Limiting；不要为抗滥用缓存已过期行情。
- 观察部署后自然 14:30/14:40 调度，分别记录发送、跳过、补偿和失败；手动 workflow 不覆盖自然失败。
- 完成 Android/iOS 物理设备 PWA 安装、离线更新、前后台恢复和窄屏交互验收。
- 把 Starlette TestClient 迁移到受支持的新客户端接口，消除弃用警告。

## 完成定义

后续工作只有在数据来源、日期轴、身份、精确源码、生产交互和回滚证据都能逐项复核时才算完成。当前生产持久化明确为 `BLOCKED / NOT_MET`，不得降级为警告或用本地测试替代；任何未知值保持未知，任何未运行门禁保持 `NOT_RUN`。
