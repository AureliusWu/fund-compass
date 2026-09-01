# 司南基金 v8.0.0 测试报告

日期：2026-09-01（Asia/Shanghai）
测试对象：基于 `759afcb56eb7323d1e1fe3f02f6517815eab59bf` 的 v8.0.0 本地发布候选；最终提交 SHA 在 commit 后由 CI、Pages、Render 和 Worker 外部证据绑定，本文不写不可实现的自引用 SHA。

## 环境

- Windows / PowerShell
- Python 3.14.4（生产目标 Python 3.12）
- Node.js 24.14.0 / npm 11.9.0
- Git 2.54.0.windows.1

## 最终本地门禁

| 范围 | 结果 | 证据 |
|---|---|---|
| Backend 全量 | PASS | 557 tests collected；全量 100% 通过；含 Linux 空库首请求 health 隔离回归 |
| Python 依赖 | PASS | `pip check`：No broken requirements found |
| Frontend 全量 | PASS | 34 files / 236 tests |
| Frontend 类型 | PASS | `vue-tsc --noEmit` |
| Frontend production build | PASS | Vite 1065 modules；7.76 s；PWA precache 61 entries / 685.81 KiB |
| Frontend production audit | PASS | npm 官方 registry：0 vulnerabilities |
| Worker 全量 | PASS | 3 files / 144 tests |
| Worker 类型 | PASS | `tsc --noEmit` |
| Worker dry-run | PASS | upload 114.28 KiB / gzip 26.58 KiB；未部署 |
| Worker production audit | PASS | npm 官方 registry：0 vulnerabilities；非强制锁文件安全升级后复测 |
| 版本、工作流、持久化契约 | PASS | 103 focused tests |
| 本地 Chrome 合成 smoke | PASS | 首页/详情、匿名脱敏、stale/估值/持仓不可用状态；console 0 error/warn |
| 性能回归 | PASS | 交替 3 轮；构建中位 -0.96%，JS+CSS gzip +0.47% |
| diff whitespace | PASS | `git diff --check` 无错误；仅 Windows 行尾转换提示 |

Backend 唯一警告是 Starlette TestClient 的上游弃用提示，不影响本次结果；后续应迁移到新测试客户端接口。

性能对比以 `759afcb` 为基线，同机、同依赖并按 B/C/B/C/B/C 交替执行三轮。Vite 中位数 8.36 → 8.28 秒，墙钟中位数 12.884 → 13.042 秒（+1.22%）；JS gzip 379,442 → 381,498 B（+0.54%），CSS gzip 62,870 → 62,891 B（+0.03%），无新依赖，均低于 10% 警告阈值。样本量仅三次，结论为方向性。

## 重点回归

- official NAV 7 天边界、超龄拒绝、日期轴不一致拒绝。
- canonical estimate wire：正式净值与 unavailable 的估值字段保持 `null`。
- 旧组合决策请求哈希、原响应重放、in-progress 与 payload 冲突。
- Gist 发送前检查点失败与 14:40 exactly-once 补偿。
- SQLite schema/索引/唯一约束/外键漂移、并发写、备份恢复和跨进程读回。
- 匿名 `force=true` 无法绕过 TTL；公开错误不泄露内部异常。
- 私人读取鉴权、限流和查询上限。
- 指数 stale 值隐藏、5 分钟缓存边界、不延长缓存年龄。
- 持仓 12 小时内存/本地缓存边界、披露日展示、未来/超龄/缺失日期失败关闭。
- 随机 Origin 不再创建 Worker 新缓存分区；合法 Pages/localhost CORS 保持。

## 数据源实测

`python tools/enrich_index_valuation.py` 对真实乐咕/AKShare 上游执行三次有限重试，六个核心指数只获得三个完整 PE/PB 结果，进程返回失败且没有改写 `index-valuation.json`。旧快照日期 2026-08-21；以 2026-09-01 计 11 天，超过应用 7 天门槛。后端和部署 smoke 必须呈现 `stale=true / usable=false`，决策改用明确降级路径。

## 尚未执行的生产门禁

- 候选 Render Free、Pages、Worker 的最终 exact-SHA 部署；$0/月候选服务已创建，尚待最终提交。
- 三组独立 Secret 已写入候选 Render；Cloudflare / GitHub Actions 尚待同步。
- 三端统一使用 `https://fund-compass-api-v8-candidate.onrender.com` 并验证地址一致性。
- Free API health 明确返回 `ephemeral / durable=false`；数据库重启可能丢失，V8 生产持久化硬门禁为 `BLOCKED / NOT_MET`，不能降级为警告或声称通过。
- 生产浏览器主流程、控制台、API/Worker canonical smoke。
- 发布构建对应的自然 14:30/14:40 Cron 与物理设备验收。

用户已撤销 Render Starter 和 1 GB 持久盘的付费授权，本次不会创建收费资源，也不会执行或宣称跨重启持久库读回。其余项目仍可在候选提交和部署阶段验证；没有证据时状态只能是 `NOT_RUN`，不能沿用旧版本结果。由于 V8 persistence gate 仍要求真实 `durable=true`，即使其他门禁通过，正式发布状态也必须保持 `BLOCKED`，不得创建 v8.0.0 标签。
