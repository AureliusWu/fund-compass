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

正式 Cron 为北京时间工作日 14:30 与 14:40；二者共享 `14:30` 发送槽位。首次成功后补偿任务自动跳过，首次失败时 14:40 再尝试一次。

## 部署

```bash
npm install
npm run check
npm test
npm run deploy
```

部署后访问 `/health` 只能看到各变量是否存在，不会泄露值。手动测试：

```bash
curl -X POST "https://sinan-estimate-push.<subdomain>.workers.dev/test" \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

确认 Worker 正常推送后，禁用 `.github/workflows/estimate-push.yml` 的 `schedule`，保留手动触发作为应急兜底。
