# aicost 手动导出规程

aicost 的 `/api/pricing` 需登录 session(不走 sk key),所以定价与流水用浏览器 Console 脚本导出。
导出文件放本目录,**文件名前缀决定用途**:

- `aicost-pricing-YYYYMMDD.json` → 定价(解析器 `src/parsers/aicost.ts` 自动读最新一份)
- `aicost-logs-YYYYMMDD.json` → 消费流水(缓存命中率/对账数据源)

## 定价导出(在已登录 aicost.me 的任意页面 F12 → Console 运行)

```js
(async () => {
  const uid = (JSON.parse(localStorage.getItem('uid') || 'null') || localStorage.getItem('user_id') || '');
  const tryFetch = h => fetch('/api/pricing', { credentials: 'include', headers: h });
  let r = await tryFetch({});
  if (!r.ok) {
    const hd = uid ? { 'new-api-user': String(uid) } : {};
    r = await tryFetch(hd);
  }
  if (!r.ok) { console.error('HTTP', r.status, '——请确认已登录 aicost.me;若 401,把 Console 里 localStorage 的 uid 打出来加 new-api-user 头'); return; }
  const j = await r.json();
  if (!j.success || !Array.isArray(j.data)) { console.error('返回异常:', j); return; }
  const d = new Date();
  const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const name = 'aicost-pricing-' + ymd + '.json';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(j)], { type: 'application/json' }));
  a.download = name; a.click();
  console.log('✅ 导出', name, '· 模型', j.data.length, '个 · 分组', Object.keys(j.group_ratio || {}).length, '组 · 计费模式含 tiered_expr:',
    j.data.filter(m => m.billing_mode === 'tiered_expr').length, '个');
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

## 导出后

把文件发我(或放进 `store/manual-imports/`),我跑 `once --task=price` 重解析 + sync + 发布。
定价文件只含公开定价结构,**不含任何 Key/账户信息**;流水含你自己的消费明细,按需脱敏。
