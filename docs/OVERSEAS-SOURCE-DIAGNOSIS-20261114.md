# 海外零预测：只读诊断结果

2026-11-14 北京时间 15:30，从同仓库 GitHub Actions 运行 `43571359655` 实际读取配置的 `FUND_API_BASE` 和已有公开主源，未写入预测、金融账本、数据库或日记。

三只基金的 API 和公开主源日期均为 2026-11-12，日期一致 3/3。以最近交易观察日 2026-11-13 对照，三条记录均为 `axis_base_ahead`：目标净值已经公布，不能再作为事前预测写入。

这一结果证明当前 API 没有落后于当前主源，不重建前几日的历史响应。结合连续自然任务约晚八小时才创建的服务器记录，执行过晚是当前最有证据支持的原因；不能将当前来源读回声称为历史响应的完整复现。

## 处理边界

- 已修复历史列表已知目标净值时仍可预测的漏洞；本次新增独立只读诊断与七项无网络合同测试。
- 原预测日期轴、96 小时门槛、不可变金融账本、四文件 Artifact 协议、schedule 和部署暂停均保留。
- `overseas-source-diagnosis.yml` 可手动运行，输出仅日期直方图和固定计数；失败不打印原响应或 endpoint，401/403/429 停止后续源访问。
- 原自然调度仍未恢复准时。GitHub 官方说明 schedule 可能延迟；UTC 06:35 的配置本身与北京时间 14:35 一致，不能凭约八小时的历史延迟擅改 UTC 偏移。
- 若改用独立准时调度器，需要单独验证真实时钟来源、事前捕获、幂等及日记兼容；现有部署暂停时不启用或发布 Worker。今天为周六，不伪造一次自然交易窗口成功。

官方说明：https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule

## 本次实际证据

- 只读工作流：`https://github.com/AureliusWu/fund-compass/actions/runs/43571359655`
- Artifact：`overseas-source-diagnosis-43571359655`，固定汇总 `api_primary_aligned=3`、`axis_base_ahead=3`。
- 无网络测试：7 passed；工作流真实源读取成功。诊断任务 success 不代表海外预测流水线 success。
