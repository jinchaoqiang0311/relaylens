/**
 * reconcile-logs.cjs —— new-api 系中转站逐笔扣费对账(零新增花费,多站点)
 * 数据源:站方管理面 /api/log/self 的真实消费日志(每笔含实扣 quota + tokens + 分组)
 * 口径:应扣 = 站方公示计费(分层表达式 / 标准 ratio / 按次)× tokens ÷ 1M × 组倍率 × 500000(1$=500000 quota)
 * 运行:node scripts/reconcile-logs.cjs <site>(aicost | aixoras);密钥读 config/secrets/sites.env
 */
const fs = require("node:fs");
const path = require("node:path");

const SITE_CONF = {
  aicost: { base: "https://www.aicost.me", tokenEnv: "AICOST_ACCESS_TOKEN", uidEnv: "AICOST_USER_ID" },
  aixoras: { base: "https://aixoras.com", tokenEnv: "AIXORAS_ACCESS_TOKEN", uidEnv: "AIXORAS_USER_ID" },
};
const SITE = process.argv[2];
const CONF = SITE_CONF[SITE];
if (!CONF) { console.error("用法: node scripts/reconcile-logs.cjs <" + Object.keys(SITE_CONF).join("|") + ">"); process.exit(1); }
const QUOTA_PER_USD = 500000;

(function loadEnv() {
  const f = path.join(__dirname, "..", "config", "secrets", "sites.env");
  if (!fs.existsSync(f)) { console.error("缺少 config/secrets/sites.env"); process.exit(1); }
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
})();
const TOKEN = process.env[CONF.tokenEnv], UID = process.env[CONF.uidEnv];
if (!TOKEN || !UID) { console.error("sites.env 缺 " + CONF.tokenEnv + " / " + CONF.uidEnv); process.exit(1); }
const H = { "Authorization": "Bearer " + TOKEN, "New-API-User": String(UID), "Cache-Control": "no-store" };

async function getJson(url) {
  const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(url + " → HTTP " + r.status);
  return r.json();
}

async function loadPricing() {
  const j = await getJson(CONF.base + "/api/pricing");
  if (!j || !j.success || !Array.isArray(j.data)) throw new Error("/api/pricing 结构异常");
  return { models: new Map(j.data.map(m => [m.model_name, m])), groupRatio: j.group_ratio || {} };
}

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
  if (!pr) return { err: "模型不在公示价表" };
  const gr = pm.groupRatio[log.group];
  if (!(gr > 0)) return { err: "分组倍率缺失:" + log.group };
  let other = {}; try { other = log.other ? JSON.parse(log.other) : {}; } catch { }
  const pT = log.prompt_tokens || 0, cT = log.completion_tokens || 0;
  const cacheT = other.cache_tokens || 0;
  const pNc = Math.max(0, pT - cacheT);
  const mult = other.service_tier === "priority" ? 2.5 : 1;
  if (pr.quota_type === 1) return { exp: Math.round((pr.model_price || 0) * gr * QUOTA_PER_USD * mult), detail: "按次" };
  if (pr.billing_mode === "tiered_expr") {
    const t = parseTiers(pr.billing_expr || "");
    if (!t) return { err: "表达式无法解析" };
    const len = pT + cT;
    const tier = t.threshold != null && len >= t.threshold ? t.tiers[t.tiers.length - 1] : t.tiers[0];
    const perM = pNc * tier.input + cT * tier.output + cacheT * (tier.cacheRead || 0);
    return { exp: Math.round(perM / 1e6 * gr * QUOTA_PER_USD * mult), detail: "tier:" + tier.name };
  }
  const cr = pr.cache_ratio != null && pr.cache_ratio > 0 ? pr.cache_ratio : 1;
  /* new-api 标准口径:model_ratio 直接乘 token 数(1 ratio = $2/M = 1 quota/token),不做 /1e6×500000 换算 */
  const perM = (pNc + cacheT * cr + cT * (pr.completion_ratio || 1)) * (pr.model_ratio || 0);
  return { exp: Math.round(perM * gr), detail: "standard" };
}

async function pullAllLogs() {
  const all = [];
  let page = 1;
  for (;;) {
    const j = await getJson(CONF.base + "/api/log/self?type=2&p=" + page + "&page_size=1000");
    const items = j && j.data && j.data.items || [];
    all.push(...items);
    const total = j.data.total || all.length;
    process.stdout.write(`\r  拉取日志 ${all.length}/${total}`);
    if (all.length >= total || items.length === 0) break;
    page++;
    if (page > 50) break;
  }
  console.log("");
  return all;
}

(async () => {
  console.log("[" + SITE + "] 拉取公示价…");
  const pm = await loadPricing();
  console.log("  模型 " + pm.models.size + " 个,分组 " + Object.keys(pm.groupRatio).length + " 个");
  console.log("拉取全部消费日志…");
  const logs = await pullAllLogs();
  const rows = logs.filter(l => l.type === 2 && l.quota > 0);

  let sumA = 0, sumE = 0, ok = 0, skip = {}, drift = 0, exprChecked = 0;
  const perModel = new Map(), anomalies = [];
  for (const l of rows) {
    const r = expectedQuota(l, pm);
    if (r.err) { skip[r.err.split(":")[0]] = (skip[r.err.split(":")[0]] || 0) + 1; continue; }
    sumA += l.quota; sumE += r.exp;
    const dev = r.exp > 0 ? (l.quota - r.exp) / r.exp : (l.quota ? 1 : 0);
    if (Math.abs(dev) <= 0.01) ok++;
    else if (anomalies.length < 200) anomalies.push({ at: l.created_at, model: l.model_name, group: l.group, act: l.quota, exp: r.exp, dev: +(dev * 100).toFixed(2) });
    let s = perModel.get(l.model_name) || { n: 0, act: 0, exp: 0, bad: 0 };
    s.n++; s.act += l.quota; s.exp += r.exp; if (Math.abs(dev) > 0.01) s.bad++;
    perModel.set(l.model_name, s);
    let other = {}; try { other = l.other ? JSON.parse(l.other) : {}; } catch { }
    if (other.expr_b64) {
      exprChecked++;
      let logExpr = ""; try { logExpr = Buffer.from(other.expr_b64, "base64").toString("utf8"); } catch { }
      const cur = (pm.models.get(l.model_name) || {}).billing_expr || "";
      if (logExpr && cur && logExpr.trim() !== cur.trim()) drift++;
    }
  }

  const devPct = sumE > 0 ? (sumA - sumE) / sumE * 100 : null;
  const usd = q => +(q / QUOTA_PER_USD).toFixed(4);
  const audited = Array.from(perModel.values()).reduce((s, v) => s + v.n, 0);
  const badTotal = Array.from(perModel.values()).reduce((s, v) => s + v.bad, 0);
  const report = {
    site: SITE, ranAt: new Date().toISOString(), source: "管理面逐笔消费日志(全量)",
    logsTotal: logs.length, consumeRows: rows.length,
    audited, skipped: skip,
    actualQuota: sumA, expectedQuota: sumE,
    actualUsd: usd(sumA), expectedUsd: usd(sumE),
    deviationPct: devPct == null ? null : +devPct.toFixed(4),
    matchRatePct: audited ? +((audited - badTotal) / audited * 100).toFixed(3) : null,
    exprDrift: { checked: exprChecked, mismatch: drift },
    perModel: Array.from(perModel.entries()).map(([k, s]) => ({ model: k, n: s.n, actualUsd: usd(s.act), expectedUsd: usd(s.exp), devPct: s.exp ? +((s.act - s.exp) / s.exp * 100).toFixed(4) : null, bad: s.bad })).sort((a, b) => b.n - a.n),
    anomalies
  };
  const out = path.join(__dirname, "..", "store", "audit", SITE + "-reconcile-" + new Date().toISOString().slice(0, 10) + ".json");
  fs.writeFileSync(out, JSON.stringify(report, null, 1), "utf8");

  console.log("\n===== " + SITE + " 逐笔扣费对账 =====");
  console.log("消费日志 " + rows.length + " 笔 · 跳过 " + JSON.stringify(skip));
  console.log("实扣合计 $" + usd(sumA) + " · 应扣合计 $" + usd(sumE) + " · 总偏差 " + (devPct == null ? "—" : devPct.toFixed(4) + "%"));
  console.log("逐笔匹配率(|偏差|≤1%):" + report.matchRatePct + "% · 表达式漂移 " + drift + "/" + exprChecked);
  console.log("Top 模型:");
  report.perModel.slice(0, 8).forEach(m => console.log("  " + m.model.padEnd(26) + " " + String(m.n).padStart(5) + " 笔  $" + m.actualUsd + " / 应 $" + m.expectedUsd + "  偏差 " + (m.devPct == null ? "—" : m.devPct + "%") + (m.bad ? "  异常 " + m.bad : "")));
  if (anomalies.length) console.log("异常样例:\n  " + anomalies.slice(0, 5).map(a => a.model + " 实" + a.act + " 应" + a.exp + " " + a.dev + "%").join("\n  "));
  console.log("报告落盘: " + out);
})().catch(e => { console.error("对账失败:", e.message); process.exit(1); });
