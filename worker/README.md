# 司南基金 Cloudflare Worker

工作日北京时间 14:30 读取私有 Gist 自选，获取盘中估值与司南决策摘要，通过 Server酱推送。

## 变量

`wrangler.toml` 已包含普通变量 `GIST_ID` 与 `FUND_API_BASE`。以下必须使用 Cloudflare Secret：

```bash
npx wrangler secret put GIST_TOKEN
npx wrangler secret put WECHAT_SENDKEY
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put WORKER_TOKEN
```

`ADMIN_TOKEN` 使用密码管理器生成的至少 32 位随机字符串，只用于保护 `POST /test`。`WORKER_TOKEN` 必须与后端环境中的同名 Secret 完全一致，只用于调用组合决策接口。

正式 Cron 为北京时间工作日 14:30 与 14:40；Cloudflare 的星期编号是 `1=周日`，因此配置使用 `MON-FRI` 消除歧义。二者共享 `14:30` 发送槽位：首次成功后补偿任务自动跳过，首次失败时 14:40 再尝试一次。

## 部署

```bash
npm install
npm run check
npm test
npm run deploy
```

部署后访问 `/health` 只能看到各变量是否存在，不会泄露值。公开只读接口
`GET /estimates?codes=000001,000002` 仅接受 1–50 个六位基金代码，并只为司南/蜉蝣
GitHub Pages 与本地开发源开放浏览器跨域访问。它不会接收任意上游 URL，也不会返回 Secret。
交易日优先返回盘中估值表；非交易日或估值表不可用时，按代码读取最近两条正式净值，
返回 `est_kind=official_nav`、对应净值日期和最近正式净值涨跌，不伪装成当日实时估值。
为兼容既有客户端，`items` 只包含数值可用的基金；无法回退的代码列在
`unavailable_codes`，详情列在 `unavailable_items`，不会把空净值塞入旧数值列表。
`GET /holdings?code=005844` 仅接受单个六位基金代码，由 Worker 为东方财富重仓接口
补齐来源标头，返回最多十只重仓股、占净值比例和季度披露截止日期；结果缓存 30 分钟。

手动测试：

```bash
curl -X POST "https://sinan-estimate-push.<subdomain>.workers.dev/test" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

正式推送由 Worker Cron 承担；`.github/workflows/manual-estimate-push.yml` 仅保留手动应急入口。
