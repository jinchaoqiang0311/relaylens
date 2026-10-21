// aicost 定价导出(已登录 aicost.me 页面 → F12 → Console 粘贴运行)
// 认证: session cookie(自动带) + New-API-User = localStorage.user.id
//   前端 XJe(): 无 token 时不发 Authorization,故 token 可选; 有则带上 Bearer
(async () => {
  const raw = localStorage.getItem("user");
  if (!raw) { console.error("✗ 未找到 localStorage.user —— 请先登录 aicost.me"); return; }
  let u;
  try { u = JSON.parse(raw); } catch { console.error("✗ localStorage.user 非 JSON,请清掉重登"); return; }
  console.log("ℹ user 字段:", Object.keys(u).join(","));

  const id = u.id ?? u.user_id ?? u.userId ?? u.uid;
  if (id === undefined || id === null || id === "") { console.error("✗ user 缺少 id 字段,登录态不完整"); return; }

  const headers = { "New-API-User": String(id), "Cache-Control": "no-store" };
  const token = u.token ?? u.accessToken ?? u.access_token ?? u.session_token;
  if (token) headers["Authorization"] = "Bearer " + token;

  const r = await fetch("/api/pricing", { credentials: "include", headers });
  if (!r.ok) { console.error("✗ HTTP", r.status, "—— 请确认已登录(必要的话 localStorage.clear() 后重登)"); return; }
  const j = await r.json();
  if (!j.success || !Array.isArray(j.data)) { console.error("✗ 返回异常:", j); return; }

  const d = new Date();
  const ymd = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
  const name = "aicost-pricing-" + ymd + ".json";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(j)], { type: "application/json" }));
  a.download = name; a.click();
  console.log("✅ 导出", name, "· 模型", j.data.length, "· 分组", Object.keys(j.group_ratio || {}).length, "· tiered_expr", j.data.filter((m) => m.billing_mode === "tiered_expr").length, "个");
})();
