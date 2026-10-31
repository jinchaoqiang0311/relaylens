# RelayLens API Worker (Cloudflare Workers + D1)

数据导出 API 后端:免费端点代理静态数据并做过滤;Pro 端点从 D1 读历史批次与原始流水;自助发放 API Key(含 7 天 Pro 试用)。

## 端点(与 api.html 页面承诺一致)

| 端点 | 鉴权 | 说明 |
|---|---|---|
| GET /api/v1/ranking?scene=&model=&fields= | 无 | 场景分榜,fields 白名单瘦身 |
| GET /api/v1/prices?model=&honest_only= | 无 | 比价数据 |
| GET /api/v1/blacklist?state= | 无 | 黑名单档案 |
| GET /api/v1/meta | 无 | 数据版本与更新时间 |
| POST /api/register | 无(限 5 次/分/IP) | 发放 key,仅一次明文返回 |
| GET /api/v1/batches?site=&since=&until=&rounds= | Bearer | 历史批次(LIMIT 500) |
| GET /api/v1/receipts/{batchId} | Bearer | 单批次原始流水 |
| GET/POST /api/v1/webhooks | Bearer(Pro) | 变更告警登记 |

限速:免费 60/min/IP,Pro 600/min/key。所有响应带 updated/version/license(CC BY 4.0)。

## 部署步骤(一次性,约 10 分钟)

1. 注册/登录 Cloudflare(免费套餐),安装 wrangler:
   npm install -g wrangler
   wrangler login
2. 创建 D1 数据库,把输出的 database_id 填进 wrangler.toml:
   wrangler d1 create relaylens
3. 建表:
   wrangler d1 execute relaylens --remote --file=schema.sql
4. 导入数据(超过 10MB 时按 BEGIN/COMMIT 边界拆块):
   node relaylens\probe\scripts\export-api-data.cjs > api-worker\export.sql
   cd api-worker
   wrangler d1 execute relaylens --remote --file=export.sql
5. 部署:
   wrangler deploy
6. 记下输出的 workers.dev 地址,回填 relaylens-home/api.html 顶部 RL_API_BASE,重新构建发布。

## 日常数据刷新(每次发布后)

   node relaylens\probe\scripts\export-api-data.cjs > api-worker\export.sql
   cd api-worker
   wrangler d1 execute relaylens --remote --file=export.sql

D1 免费额度:5GB 存储 / 500 万行读每天,当前规模余量极大。

## 安全要点

- 数据库只存 key 的 SHA-256,明文仅在注册响应出现一次;
- 注册接口按 IP 限每分钟 5 次;
- 写操作(webhooks 登记)要求真 Pro tier,试用期只放行 GET;
- 查询全参数化,无拼接 SQL。