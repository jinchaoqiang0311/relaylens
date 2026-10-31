# 手动导出规程(aicost / uptoken / heyroute)

定价接口在登录墙内的站,用浏览器 Console 脚本导出,文件放本目录,**文件名前缀决定用途**。

aicost 的 `/api/pricing` 需登录 session(不走 sk key),所以定价与流水用浏览器 Console 脚本导出。
导出文件放本目录,**文件名前缀决定用途**:

- `aicost-pricing-YYYYMMDD.json` → 定价(解析器 `src/parsers/aicost.ts` 自动读最新一份)
- `aicost-logs-YYYYMMDD.json` → 消费流水(缓存命中率/对账数据源)

## 定价导出(在已登录 aicost.me 的任意页面 F12 → Console 运行)

> ⚠ 认证头已据 aicost 前端源码(`/assets/index-*.js`)核实:
> - `New-API-User` = `localStorage.user.id`(注意大小写,**不是** `new-api-user`)
> - `Authorization: Bearer <token>` = `localStorage.user.token`
> 旧版用 `new-api-user`+`uid` 会 401,已废弃。

```js
// 也可以直接运行同目录 export-aicost-pricing.js
(async () => {
  const raw = localStorage.getItem("user");
  if (!raw) { console.error("✗ 未找到 localStorage.user —— 请先在 aicost.me 登录"); return; }
  let u;
  try { u = JSON.parse(raw); } catch { console.error("✗ localStorage.user 不是合法 JSON"); return; }
  if (!u.id || !u.token) { console.error("✗ localStorage.user 缺少 id/token,请重新登录:", u); return; }
  const headers = {
    "New-API-User": String(u.id),
    "Authorization": "Bearer " + u.token,
    "Cache-Control": "no-store",
  };
  const r = await fetch("/api/pricing", { credentials: "include", headers });
  if (!r.ok) { console.error("✗ HTTP", r.status, "—— 请确认已登录"); return; }
  const j = await r.json();
  if (!j.success || !Array.isArray(j.data)) { console.error("✗ 返回异常:", j); return; }
  const d = new Date();
  const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  const name = "aicost-pricing-" + ymd + ".json";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(j)], { type: "application/json" }));
  a.download = name; a.click();
  console.log("✅ 导出", name, "· 模型", j.data.length, "· 分组", Object.keys(j.group_ratio || {}).length, "· tiered_expr", j.data.filter(m => m.billing_mode === "tiered_expr").length, "个");
})();
```

## 流水导出(缓存命中/对账用,分页拉 10 页)

```js
(async () => {
  const items = [];
  for (let p = 1; p <= 10; p++) {
    const r = await fetch(`/api/log/self?p=${p}&page_size=100&type=2`, { credentials: 'include' });
    if (!r.ok) break;
    const j = await r.json();
    const list = (j.data && (j.data.items || j.data)) || [];
    if (!list.length) break;
    items.push(...list);
    if (list.length < 100) break;
  }
  const d = new Date();
  const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const name = 'aicost-logs-' + ymd + '.json';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ items })], { type: 'application/json' }));
  a.download = name; a.click();
  console.log('✅ 导出', name, '·', items.length, '笔');
})();
```

## uptoken 定价导出(2026-10-17 实测可用)

uptoken 是 Aether 面板,价格接口三级校验:cookie 会话 → `x-client-device-id` 设备头 →
`/api/auth/refresh` 换的 Bearer token。**在已登录 uptoken.top 的任意页面** F12 → Console 运行:

```js
// uptoken: 登录态换 token 后拉账号可见模型价(USD/1M)
(async () => {
  const d = localStorage.getItem("aether_client_device_id");
  if (!d) { console.error("✗ 未找到 aether_client_device_id,请先登录 uptoken.top"); return; }
  const rr = await fetch("/api/auth/refresh", { method: "POST", credentials: "include", headers: { "x-client-device-id": d } });
  if (!rr.ok) { console.error("✗ refresh HTTP", rr.status, "—— 请确认已登录"); return; }
  const { access_token } = await rr.json();
  const r = await fetch("/api/users/me/available-models?limit=1000", {
    headers: { Authorization: "Bearer " + access_token, "x-client-device-id": d },
  });
  if (!r.ok) { console.error("✗ HTTP", r.status); return; }
  const j = await r.json();
  const dt = new Date();
  const ymd = dt.getFullYear() + String(dt.getMonth() + 1).padStart(2, "0") + String(dt.getDate()).padStart(2, "0");
  const name = "uptoken-pricing-" + ymd + ".json";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(j)], { type: "application/json" }));
  a.download = name; a.click();
  console.log("✅ 导出", name, "· 模型", (j.models || []).length);
})();
```

解析器 `src/parsers/uptoken.ts` 自动读最新一份 `uptoken-pricing-*.json`。

## 导出后

把文件发我(或放进 `store/manual-imports/`),我跑 `once --task=price` 重解析 + sync + 发布。
定价文件只含公开定价结构,**不含任何 Key/账户信息**;流水含你自己的消费明细,按需脱敏。
