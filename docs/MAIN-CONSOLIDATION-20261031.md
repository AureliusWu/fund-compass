# 单 main 收拢：固定归档与代码合并边界

用户授权顺序：验证并合并候选代码，再归档日志、迁移日志存储并清理分支；自动部署保持关闭。这不是 v9 发布或生产切换，应用仍为 8.0.0。

## 已完成的候选代码门禁

- 候选 `1c7eadeb728d0bc5a1008a2bae08f42e38b32906` 已包含原候选四提交与最新 main `19dd534ff8e6b69459cd68a42db53b3483d316cc`，无冲突。
- [PR #10](https://github.com/AureliusWu/fund-compass/pull/10) 已于 2026-10-31 13:38:23（Asia/Shanghai）合并为 `c5833abf561ca84ca332ee955db42766ab5a8327`。
- [PR CI 41171961476](https://github.com/AureliusWu/fund-compass/actions/runs/41171961476)：resolve/backend/frontend/worker 全通过。Linux/Python3.12 后端 5111 passed、16 skipped、2 warnings（556.07s）；三项部署/冒烟按暂停开关跳过，不是上线验收。
- 本地前端 3443 passed，类型检查/生产构建/PWA 7/7 通过；Worker 182 passed、类型检查及 Wrangler dry-run 通过。审计前端仅4条 low，Worker 0，中危以上均0；不以此认证 Wrangler 内嵌风险已修复。
- Windows/Python3.14.4 首次全量 4794 passed、333 setup errors（1054.51s）。根因是导出命令未关 core.autocrlf，源码初始即 CRLF。保留原失败 XML，不修改业务、测试、pins 或预算；显式 `git -c core.autocrlf=false archive` 新导出后，三文件362 passed（102.88s），逐测试核对覆盖全部333原错误，另29重复，不重复计数。不能把这些结果冒称一次干净 Windows 全量通过。
- main 默认工厂、前端、render.yaml 未被候选改变；Worker 候选仍须显式开启。已有包体增长/云冷启动未测警告保留。

## 冻结的旧日志和恢复证明

- `overseas-accuracy` 暂停且 active/queued 均为空后，冻结时间 `2026-10-31T05:38:49Z`，workflow ID `310460010`，最后原生运行编号84（run `41063460281`，attempt1，结论 failure）。
- 旧 ref `ops/overseas-run-journal` 固定 tip `1688994475d61c3f5df933012362a457ae9acde4`，完整3个提交；末端唯一 JSON 为1408字节，SHA256 `fd107482608e951d310b8422df9e1a14c664cd6d362b70580a2823f351698040`。
- 仓库固定原字节种子及闭集 manifest 位于 `docs/archive/overseas-run-journal-20261031.json`、`docs/archive/overseas-journal-cutover-20261031.json`；种子禁换行转换，不改失败、null、日期或原source SHA。
- 3条旧事件均为 zero_effective/delayed_same_day/qualified_data=null，后两条 audit_rejected。归档/只读存储检查不能把它们变为自然成功。
- 仓库外目录：`D:\给人类看的\司南基金分支归档\2026-10-31-main-consolidation`。
  - `candidate-1c7eade.bundle` SHA256 `277f9ca4d6994d5ade25895d9c4044396107e53c095007bb4808c2941f2f9f55`。
  - `overseas-journal-1688994.bundle` SHA256 `8a3c448e3933370b49749b0d85d7e39f528cae6a55f44e7d4135b4e8c915c107`。
  - 两份均为自包含完整历史，独立临时 bare 仓库恢复、原 tip 核对与 `git fsck --full --strict` 通过。旧日志还从恢复仓库导出 JSON，SHA256与归档种子独立核对。

## 日志切换及删除条件

实现与局限见 [OVERSEAS-JOURNAL-ARTIFACTS.md](OVERSEAS-JOURNAL-ARTIFACTS.md)。相关独立本地回归549 passed（artifact113/journal110/runner78/workflow248），0failure/error/skip；此为代码证明，不是实际云端载体证明。

日志改动须经 PR CI 后合入；随后两次**新的** main `journal_check_only=true` dispatch，分别证明固定 seed 首次恢复及前次实际 Artifact 恢复，原 SHA/1408字节/3事件须保持，不能生成金融事件。两轮完成、旧ref仍为固定 tip且备份恢复已核后，才删除旧ops引用；恢复原schedule，最终独立核仅main及部署暂停。执行结果记录于对应日志收拢PR及仓库外 `ACCEPTANCE.json`，不通过改协议/旧归档追写历史。

## 未开启的发布门禁

不恢复 Pages/Render/Blueprint 自动部署，不改套餐、不新建付费资源；Artifact受原仓库额度/90天保留限制。旧数据库/Gist不动，原未知COMMIT ACK不改写/重放。旧源停写和最终增量、业务写后重启读回、provider独立恢复、Chrome/旧PWA/多设备、自然Cron/真实通知、正式v9发布仍须独立完成。
