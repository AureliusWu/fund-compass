# PR #4：仅合并代码，暂停部署

## 授权与范围（2026-10-28）

用户明确选择“仅合并代码，先暂停自动部署”。这只将未完成的上线验收从本次代码合并的前置条件中延期，不将它们标记为通过，也不授予 v9.0.0 发布资格。应用版本保持 **8.0.0**，不创建 v9 Tag/Release、不执行云迁移、不删除旧 Gist、不切换生产 Worker。

正式发布仍为 **BLOCKED**：远端数据库迁移、跨重启耐久与独立恢复，真实 Chrome/旧 PWA/多设备旅程，生产消费者与旧状态切换，自然交易窗口及周期任务观察，以及原有性能与资源预算债务均须另行完成。

## 持久部署控制

- Pages：`ci.yml` 的 `deploy` 与 `candidate_smoke` 仅在仓库变量 `AUTO_DEPLOY_ENABLED == 'true'` 时允许执行。未设置或 `false` 均暂停；GitHub 字符串比较不区分大小写。该控制覆盖 main push 和生成数据后显式触发的 workflow_dispatch，不依赖某一次提交的 skip 标记。
- `resolve`、后端、前端、Worker 测试/构建/依赖审计继续执行；数据任务的计划与推送不关闭。
- `formal_smoke` 保持独立、显式手动触发及原 `enforce_persistence: true`，不因暂停而放宽。它是审计，不是暂停期间的部署入口。
- Render 必须另行将两个既存服务的 **Auto-Deploy → Off**：`fund-compass-api`（`srv-d8v0t26rnols73fq6beg`）和 `fund-compass-api-v8-candidate`（`srv-dab7g0n40ujc73a2ma50`）。仓库变量不控制 Render，修改 YAML 也不证明既存服务设置已变。
- **Blueprint Auto Sync 必须独立设为 No**。服务 Off 不能阻止 Blueprint 配置同步触发部署；`render.yaml` 中显式 `autoDeployTrigger: 'off'` 也不能替代此平台设置。涉及 Blueprint 文件的下一次 main 更新前必须先确认 Auto Sync=No，不能仅复查服务设置后直接合并。

合并前必须读回两个服务均已关闭自动部署，确认无排队/进行中的部署，并核对新 PR head 的 CI。合并使用普通 GitHub 合并，不强制、不跳过 CI；保留原分支。合并后再核 PR/main 身份、CI 仍执行且 Pages 发布跳过、Render live SHA 未被此次代码合并改变。

## 合并前暂停核验（2026-10-28）

已设置并读回 GitHub 仓库变量 `AUTO_DEPLOY_ENABLED=false`；但该变量只有在新守卫进入 main 后才会影响 main 的 CI，不能声称旧 main 已因此暂停 Pages。

初次读取两个服务仍为 yes/commit；Chrome 后续虽已登录，控制工具因无法可靠识别网址而停止，没有提取连接器凭据或代造 Token。用户随后亲自关闭两个服务的自动部署。代理经 Render 连接器重新读回两者均为 **`autoDeploy=no`、`autoDeployTrigger=off`**；服务设置更新时间分别为 `2026-10-28T08:22:16.800798Z`（原服务）和 `2026-10-28T08:22:26.050428Z`（候选服务）。服务保持运行，没有暂停实例或改动套餐、环境变量、数据库。

合并前部署列表的最新项均为 live，commit=`80d01717faeb5a21cd1240ea6d8142e3320f5ae4`，没有更新的排队/进行中部署；候选 deployment=`dep-dbg9mfc9v7es73e7imp0`，原服务 deployment=`dep-dbg9mfc9v7es73e7imkg`。Pages 实际 `release.json` 也仍指向该 SHA。这是“线上保留旧代码”的比对基线，不是 API 业务可用性或数据耐久验收。

Pages 暂停合同先在旧 YAML 上 RED，再在新 YAML 上 GREEN；本机 workflow contract 及独立复审重跑均为 **248 passed**。未设/false/非 true 值、push/dispatch、PR/非 main 与 formal 分流均有测试。整个新 head 仍须真实 PR CI 后才合并，合并身份以 GitHub 原生记录为准。

## 合并结果与 Blueprint 异常（2026-10-28）

PR #4 已于 `2026-10-28T08:32:39Z`（北京时间16:32:39）普通合并为 `db5ac3207c54e866c94044af7f8372dbc757023d`，父为80d01717与e2a2dbd。实际 tree=`905d4975ed12c4a375bc850b0436a1b9b820d538`，与通过的 PR CI 测试快照dc4283d相同。[PR CI 40656654547](https://github.com/AureliusWu/fund-compass/actions/runs/40656654547)：backend4586/2warnings/252.53s、frontend3443/120文件/type/build/PWA、Worker148/check/dry-run均通过；frontend审计4low、无中危及以上，Worker0。部署/两类smoke跳过，不是生产验收。

**暂停检查遗漏了独立的 Blueprint Auto Sync。** main 同时合入的 Blueprint 配置差异为单 worker 启动参数及 Owner 密码 Secret 声明；合并后平台产生 `trigger=blueprint_sync` 的候选部署 `dep-dbgr6bfb9u1s7392hid0`，候选服务实际读回变为yes/commit，原服务仍no/off。官方规范称省略 autoDeployTrigger 应保留已有服务值，因此不能仅凭省略字段断言“按默认值必然重置”；实际设置改变的内部原因仍需平台同步日志确认。配置同步可独立部署及本次原生 trigger 已确证，不受 Pages 开关控制。参考 [Blueprint 自动同步](https://render.com/docs/infrastructure-as-code#disabling-automatic-sync) 与 [autoDeployTrigger 规范](https://render.com/docs/blueprint-spec#autodeploytrigger)。

该部署于 `2026-10-28T08:33:50.151847Z` 以 **update_failed** 结束；随后部署列表仍保留80d01717为live，未观察到新代码成功上线。Pages release.json同样仍为80d01717。没有据平台live宣称API可用/数据库未发生任何变化或正式验收完成。原在途尝试与失败不能抹除，不能把此次操作总结为“完全未触发部署”。

主代理已通知用户关闭 Blueprint Auto Sync、再次关闭候选 Auto-Deploy，并停止后续 main 配置推送。下一源码防线是显式声明字符串off及回归合同；这是仓库配置，不证明平台 Auto Sync 已关闭。控制未核齐前仍为 **deployment hold INCOMPLETE / formal release BLOCKED**，不再尝试重部署或自动恢复。

随后候选设置于 `2026-10-28T08:36:40.678482Z` 再次变为no/off，原服务仍no/off；这是代理实际读回，不代替 Blueprint Auto Sync 的独立确认。防复发补丁在独立修复分支中显式声明off，原 YAML 的新文件合同先RED（缺字段失败），修复后 persistence/workflow 合同共 **263 passed**；测试拒绝缺失、commit、checksPass、YAML布尔与旧字段混用，保留免费/单服务/单进程/秘密配置原约束。仅可先推送修复分支进行PR CI，不在 Auto Sync 未确认前再次更新 main。

实际状态可能变化，后续执行必须重新读取；不得从本文推断当前云设置。

## 恢复部署

只有在取得针对后续部署的授权并完成相应上线门禁后，才分别恢复 Blueprint Auto Sync、Render 自动部署和 Pages 仓库变量。恢复时选定同一精确 main SHA，先核 CI、存储兼容、备份/恢复与回滚点，再部署和执行真实冒烟。恢复开关不等于发布验收通过；不要为“解冻”而关闭 schema、权限、未知提交或持久性守卫。

暂停期间，公开站点与 API 不会自动获得 main 的新代码和静态数据制品；原生产 Worker 与其既有任务保持不变，旧线上数据新鲜度仍须独立关注。
