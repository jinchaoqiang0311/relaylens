/**
 * update-rounds.cjs —— 回填站点「逐轮对账」rounds(最新 N 笔真实消费日志)
 * 数据源:管理面 /api/log/self 最新 N 笔(type=2);应扣 = 站方公示计费重算(与 reconcile-logs 同口径)
 * 写入:relaylens-home/data/sites.json → details.<site>.rounds / roundsMeta
 * 运行:node scripts/update-rounds.cjs <site> [N](默认 20)——单次运行只打 2 次 API(定价+日志)
 */
const fs = require("node:fs");
const path = require("node:path");

const SITE_CONF = {
  aicost: { base: "https://www.aicost.me", tokenEnv: "AICOST_ACCESS_TOKEN", uidEnv: "AICOST_USER_ID", file: "sites.json" },
  aixoras: { base: "https://aixoras.com", tokenEnv: "AIXORAS_ACCESS_TOKEN", uidEnv: "AIXORAS_USER_ID" },
};
const SITE = process.argv[2];
const CONF = SITE_CONF[SITE];
const N = Number(process.argv[3] || 20);
if (!CONF) { console.error("用法: node scripts/update-rounds.cjs <" + Object.keys(SITE_CONF).join("|") + "> [N]"); process.exit(1); }
const QUOTA_PER_USD = 500000;

(function loadEnv() {
  const f = path.join(__dirname, "..", "config", "secrets", "sites.env");
  if (!fs.existsSync(f)) { console.error("缺少 config/secrets/sites.env"); process.exit(1); }
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
})();
const H = { "Authorization": "Bearer " + process.env[CONF.tokenEnv], "New-API-User": String(process.env[CONF.uidEnv]), "Cache-Control": "no-store" };

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
    const cr = coef("cr");
    tiers.push({ name: m[1], input: p, output: c, cacheRead: cr != null && isFinite(cr) ? cr : null });
  }
  if (!tiers.length) return null;
  const th = /\(\s*len\s*(?:<|<=)\s*([\d_]+)\s*\?/.exec(expr);
  return { tiers, threshold: th ? Number(th[1].replace(/_/g, "")) : null };
}

function expectedQuota(log, pm) {
  const pr = pm.models.get(log.model_name);
  if (!pr) return { err: "模型不在公示价表" };
  const gr = pm.groupRatio[log.group];
  if (!(gr > 0)) return { err: "分组倍率缺失:" + log.group };
  let other = {}; try { other = log.other ? JSON.parse(log.other) : {}; } catch { }
  const pT = log.prompt_tokens || 0, cT = log.completion_tokens || 0, cacheT = other.cache_tokens || 0;
  const pNc = cacheT > pT ? pT : Math.max(0, pT - cacheT);
  const mult = other.service_tier === "priority" ? 2.5 : 1;
  if (pr.quota_type === 1) return { exp: Math.round((pr.model_price || 0) * gr * QUOTA_PER_USD * mult) };
  if (pr.billing_mode === "tiered_expr") {
    const t = parseTiers(pr.billing_expr || "");
    if (!t) return { err: "表达式无法解析" };
    const len = pT + cT;
    const tier = t.threshold != null && len >= t.threshold ? t.tiers[t.tiers.length - 1] : t.tiers[0];
    const perM = pNc * tier.input + cT * tier.output + cacheT * (tier.cacheRead || 0);
    return { exp: Math.round(perM / 1e6 * gr * QUOTA_PER_USD * mult) };
  }
  const cr = pr.cache_ratio != null && pr.cache_ratio > 0 ? pr.cache_ratio : 1;
  return { exp: Math.round((pNc + cacheT * cr + cT * (pr.completion_ratio || 1)) * (pr.model_ratio || 0) * gr) };
}

const fmtY = q => { const y = q / QUOTA_PER_USD; return "¥" + (y < 1 ? y.toFixed(4) : y.toFixed(2)); };

(async () => {
  /* 公示价:live 优先,失败回退本地最新手动导入 */
  let pricing;
  try {
    const j = await (await fetch(CONF.base + "/api/pricing", { headers: H, signal: AbortSignal.timeout(15000) })).json();
    if (!(j && j.success && Array.isArray(j.data))) throw new Error("结构异常");
    pricing = { models: j.data, groupRatio: j.group_ratio || {}, src: "live /api/pricing" };
    console.log("公示价:live," + j.data.length + " 模型");
  } catch (e) {
    const dir = path.join(__dirname, "..", "store", "manual-imports");
    const f = fs.readdirSync(dir).filter(x => x.startsWith(SITE + "-pricing") && x.endsWith(".json")).sort().pop();
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    pricing = { models: j.data, groupRatio: j.group_ratio || {}, src: "manual:" + f };
    console.log("公示价:live 失败(" + e.message + "),回退 " + f);
  }
  const pm = { models: new Map(pricing.models.map(m => [m.model_name, m])), groupRatio: pricing.groupRatio };

  const lj = await (await fetch(CONF.base + "/api/log/self?type=2&p=1&page_size=" + N, { headers: H, signal: AbortSignal.timeout(15000) })).json();
  const items = (lj.data && lj.data.items) || [];
  const rounds = [];
  items.forEach(l => {
    const r = expectedQuota(l, pm);
    if (r.err) { console.log("  跳过:", l.model_name, r.err); return; }
    const dev = r.exp > 0 ? Math.abs(l.quota - r.exp) / r.exp : 0;
    let cacheT = 0; try { cacheT = JSON.parse(l.other || "{}").cache_tokens || 0; } catch { }
    rounds.push({ r: rounds.length + 1, model: l.model_name, in: l.prompt_tokens || 0, cached: cacheT, out: l.completion_tokens || 0,
      should: fmtY(r.exp), actual: fmtY(l.quota), ok: dev <= 0.01 ? 1 : 0,
      act: l.quota, exp: r.exp });
  });
  const matched = rounds.filter(r => r.ok).length;
  console.log("重算 " + rounds.length + "/" + items.length + " 笔,精确匹配 " + matched + " 笔");
  rounds.slice(0, 8).forEach(r => console.log("  #" + r.r, r.model.padEnd(22), "实" + r.act, "应" + r.exp, r.ok ? "✓" : "✗ 偏差 " + (r.exp ? +((r.act - r.exp) / r.exp * 100).toFixed(1) + "%" : "—")));

  const f = path.join(__dirname, "..", "..", "..", "relaylens-home", "data", "sites.json");
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  d.details[SITE].rounds = rounds.map(function(r){ return { r: r.r, model: r.model, in: r.in, cached: r.cached, out: r.out, should: r.should, actual: r.actual, ok: r.ok }; });
  d.details[SITE].roundsMeta = { src: "管理面逐笔消费日志(最新 " + rounds.length + " 笔)", pricing: pricing.src, pulledAt: new Date().toISOString() };
  /* 原子写 + 收缩熔断:防异常导出截断整份数据(与探针 atomicWriteJson 同语义) */
  (function atomic(file, data, guard){
    var j = JSON.stringify(data, null, 1), tmp = file + ".tmp";
    fs.writeFileSync(tmp, j);
    if (fs.existsSync(file)) { var old = fs.statSync(file).size; if (old > 1024 && j.length < old * (1 - guard)) { fs.renameSync(tmp, file + ".rejected-" + Date.now()); throw new Error("收缩熔断:" + file + " 缩水超 " + Math.round(guard * 100) + "%,线上文件未动"); } }
    fs.renameSync(tmp, file);
  })(f, d, 0.5);
  console.log("已写入 details." + SITE + ".rounds(" + rounds.length + " 轮)");
})().catch(e => { console.error("失败:", e.message); process.exit(1); });
