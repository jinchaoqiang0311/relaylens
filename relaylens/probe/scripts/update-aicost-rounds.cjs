/**
 * update-aicost-rounds.cjs —— 把 aicost 最新真实消费日志回填为详情页「逐轮对账」rounds
 * 数据源:管理面 /api/log/self 最新 N 笔(type=2);应扣 = 站方公示计费重算(同 reconcile 脚本口径)
 * 写入:relaylens-home/data/sites.json → details.aicost.rounds(页面 buildDetailFromSync 透传)
 * 运行:node scripts/update-aicost-rounds.cjs [N](默认 14)
 */
const fs = require("node:fs");
const path = require("node:path");

const BASE = "https://www.aicost.me";
const QUOTA_PER_USD = 500000;
const N = Number(process.argv[2] || 14);

(function loadEnv() {
  const f = path.join(__dirname, "..", "config", "secrets", "sites.env");
  if (!fs.existsSync(f)) { console.error("缺少 config/secrets/sites.env"); process.exit(1); }
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
})();
const H = { "Authorization": "Bearer " + process.env.AICOST_ACCESS_TOKEN, "New-API-User": String(process.env.AICOST_USER_ID), "Cache-Control": "no-store" };

/* 分层表达式:两档系数 + 阈值(镜像 parseTieredExpr) */
function parseTiers(expr) {
  if (!expr) return null;
  const tiers = [];
  const re = /tier\(\s*["']([^"']*)["']\s*,([^)]*)\)/g;
  let m;
  while ((m = re.exec(expr))) {
    const body = m[2];
    const coef = v => { const k = new RegExp("\\b" + v + "\\s*\\*\\s*([\\d.]+)").exec(body); return k ? Number(k[1]) : null; };
    const p = coef("p"), c = coef("c");
    if (p == null || c == null || p <= 0 || c <= 0) return null;
    const cr = coef("cr"), cc = coef("cc");
    tiers.push({ name: m[1], input: p, output: c, cacheRead: cr != null && isFinite(cr) ? cr : null });
  }
  if (!tiers.length) return null;
  const th = /\(\s*len\s*(?:<|<=)\s*([\d_]+)\s*\?/.exec(expr);
  return { tiers, threshold: th ? Number(th[1].replace(/_/g, "")) : null };
}

function expectedQuota(log, pm) {
  const pr = pm.models.get(log.model_name);
  if (!pr) return null;
  const gr = pm.groupRatio[log.group];
  if (!(gr > 0)) return null;
  let other = {}; try { other = log.other ? JSON.parse(log.other) : {}; } catch { }
  const pT = log.prompt_tokens || 0, cT = log.completion_tokens || 0, cacheT = other.cache_tokens || 0;
  const pNc = Math.max(0, pT - cacheT);
  const mult = other.service_tier === "priority" ? 2.5 : 1;
  if (pr.quota_type === 1) return Math.round((pr.model_price || 0) * gr * QUOTA_PER_USD * mult);
  if (pr.billing_mode === "tiered_expr") {
    const t = parseTiers(pr.billing_expr || "");
    if (!t) return null;
    const len = pT + cT;
    const tier = t.threshold != null && len >= t.threshold ? t.tiers[t.tiers.length - 1] : t.tiers[0];
    const perM = pNc * tier.input + cT * tier.output + cacheT * (tier.cacheRead || 0);
    return Math.round(perM / 1e6 * gr * QUOTA_PER_USD * mult);
  }
  const cr = pr.cache_ratio != null && pr.cache_ratio > 0 ? pr.cache_ratio : 1;
  return Math.round(((pNc + cacheT * cr + cT * (pr.completion_ratio || 1)) * (pr.model_ratio || 0)) / 1e6 * gr * QUOTA_PER_USD);
}

const fmtY = q => { const y = q / QUOTA_PER_USD; return "¥" + (y < 1 ? y.toFixed(4) : y.toFixed(2)); };

(async () => {
  /* 公示价:live 优先,失败回退本地最新手动导入 */
  let pricing;
  try {
    const j = await (await fetch(BASE + "/api/pricing", { headers: H, signal: AbortSignal.timeout(15000) })).json();
    if (!(j && j.success && Array.isArray(j.data))) throw new Error("结构异常");
    pricing = { models: j.data, groupRatio: j.group_ratio || {}, src: "live" };
    console.log("公示价:live /api/pricing," + j.data.length + " 模型");
  } catch (e) {
    const dir = path.join(__dirname, "..", "store", "manual-imports");
    const f = fs.readdirSync(dir).filter(x => x.startsWith("aicost-pricing") && x.endsWith(".json")).sort().pop();
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    pricing = { models: j.data, groupRatio: j.group_ratio || {}, src: "manual:" + f };
    console.log("公示价:live 失败(" + e.message + "),回退 " + f);
  }
  const pm = { models: new Map(pricing.models.map(m => [m.model_name, m])), groupRatio: pricing.groupRatio };

  const lj = await (await fetch(BASE + "/api/log/self?type=2&p=1&page_size=" + N, { headers: H, signal: AbortSignal.timeout(15000) })).json();
  const items = (lj.data && lj.data.items) || [];
  const rounds = [];
  items.forEach((l, i) => {
    const exp = expectedQuota(l, pm);
    if (exp == null) return;
    const dev = exp > 0 ? Math.abs(l.quota - exp) / exp : 0;
    rounds.push({ r: rounds.length + 1, model: l.model_name, in: l.prompt_tokens || 0, cached: (() => { try { return JSON.parse(l.other || "{}").cache_tokens || 0; } catch { return 0; } })(), out: l.completion_tokens || 0, should: fmtY(exp), actual: fmtY(l.quota), ok: dev <= 0.01 ? 1 : 0 });
  });
  console.log("重算 " + rounds.length + "/" + items.length + " 笔(其余因模型/倍率缺失跳过)");

  const f = path.join(__dirname, "..", "..", "..", "relaylens-home", "data", "sites.json");
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  d.details.aicost.rounds = rounds;
  d.details.aicost.roundsMeta = { src: "管理面逐笔消费日志(最新 " + rounds.length + " 笔)", pricing: pricing.src, pulledAt: new Date().toISOString() };
  fs.writeFileSync(f, JSON.stringify(d, null, 1));
  console.log("已写入 details.aicost.rounds(" + rounds.length + " 轮)→ " + path.basename(f));
  rounds.slice(0, 5).forEach(r => console.log("  #" + r.r, r.model, r.should, "→", r.actual, r.ok ? "✓" : "✗"));
})().catch(e => { console.error("失败:", e.message); process.exit(1); });
