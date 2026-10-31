/**
 * 由 {site}-pricing-live.json 生成全量可读价格表(markdown)
 * 口径同 newapi 解析器: 非表达式价=$2/M×model_ratio×组倍率; tiered_expr 取首档系数×组倍率
 * 主口径: 默认组(默认/普通用户/normal)优先, 无则中位组
 */
const fs = require("fs");
const path = require("path");

const IMPORT_DIR = path.join(__dirname, "..", "store", "manual-imports");
const OUT = path.join(IMPORT_DIR, "PRICE-TABLE.md");

const DEFAULT_RE = /^(default|默认|普通用户|normal)$/i;

function parseTiered(expr) {
  if (!expr) return null;
  let body = null;
  const first = /tier\(\s*["'][^"']*["']\s*,([^)]*)\)/.exec(expr);
  if (first) body = first[1];
  else if (!/tier\(/.test(expr)) body = expr;
  if (!body) return null;
  const coef = (v) => { const k = new RegExp("\\b" + v + "\\s*\\*\\s*([\\d.]+)").exec(body); return k ? Number(k[1]) : null; };
  const p = coef("p"), c = coef("c");
  if (p == null || c == null || !isFinite(p) || !isFinite(c) || p <= 0 || c <= 0) return null;
  const cr = coef("cr");
  return { input: p, output: c, cacheRead: cr != null && isFinite(cr) ? cr : null };
}

function round(n) { return Math.round(n * 1e8) / 1e8; }

function build(site, body) {
  const data = body.data || [];
  const gr = body.group_ratio || {};
  const rows = [];
  for (const m of data) {
    const tiered = m.billing_mode === "tiered_expr" ? parseTiered(m.billing_expr || "") : null;
    let headKind = "n/a";
    let inU, outU, cacheU;
    if (m.quota_type !== 0) {
      headKind = `按次$${m.model_price}`;
      inU = outU = cacheU = null;
    } else if (tiered) {
      const gs = (m.enable_groups || []).filter((g) => gr[g] !== undefined);
      if (!gs.length) { headKind = "无组倍率"; }
      else {
        const def = gs.find((g) => DEFAULT_RE.test(g));
        let hg = def, kind = def ? "default" : "median";
        if (!def) { const s = [...gs].sort((a, b) => gr[a] - gr[b]); hg = s[Math.floor(s.length / 2)]; }
        const r = gr[hg];
        inU = round(tiered.input * r); outU = round(tiered.output * r);
        cacheU = tiered.cacheRead != null ? round(tiered.cacheRead * r) : null;
        headKind = `${hg}(${kind})`;
      }
    } else if (Number.isFinite(m.model_ratio) && m.model_ratio > 0) {
      const gs = (m.enable_groups || []).filter((g) => gr[g] !== undefined);
      if (!gs.length) { headKind = "无组倍率"; }
      else {
        const def = gs.find((g) => DEFAULT_RE.test(g));
        let hg = def, kind = def ? "default" : "median";
        if (!def) { const s = [...gs].sort((a, b) => gr[a] - gr[b]); hg = s[Math.floor(s.length / 2)]; }
        const r = gr[hg];
        inU = round(m.model_ratio * r * 2);
        outU = round(m.model_ratio * r * 2 * (m.completion_ratio || 1));
        cacheU = (m.cache_ratio !== undefined && m.cache_ratio > 0) ? round(m.model_ratio * r * 2 * m.cache_ratio) : null;
        headKind = `${hg}(${kind})`;
      }
    } else { headKind = "ratio无效"; }
    rows.push({ m, headKind, inU, outU, cacheU });
  }
  return rows;
}

function md(site, body, rows) {
  const lines = [`## ${site}  (${rows.length} 个模型, capturedAt=${(body.pricing_version ? "version " + body.pricing_version : "manual")})`, ""];
  lines.push("| 模型 | 计费 | 主口径组 | 输入 $/M | 输出 $/M | 缓存读 $/M |");
  lines.push("|------|------|---------|--------|--------|-----------|");
  for (const r of rows) {
    const mode = r.m.quota_type !== 0 ? "按次" : (r.m.billing_mode || "token");
    const f = (x) => (x == null ? "—" : x);
    lines.push(`| \`${r.m.model_name}\` | ${mode} | ${r.headKind} | ${f(r.inU)} | ${f(r.outU)} | ${f(r.cacheU)} |`);
  }
  return lines.join("\n");
}

const sites = process.argv.slice(2).length ? process.argv.slice(2) : ["memecode", "aixoras", "aicost"];
let out = `# 全量价格表 (生成于 ${new Date().toISOString()})\n\n> 口径: 默认组优先,无默认取中位组; 非表达式价=$2/M×model_ratio×组倍率; tiered_expr 取首档系数×组倍率。缓存读=输入×cache_ratio(仅 cache_ratio>0)。\n`;
for (const site of sites) {
  const fp = path.join(IMPORT_DIR, `${site}-pricing-live.json`);
  if (!fs.existsSync(fp)) { out += `\n## ${site}\n\n(缺失 ${site}-pricing-live.json,先跑 fetch-full-prices.cjs)\n`; continue; }
  const body = JSON.parse(fs.readFileSync(fp, "utf8"));
  const rows = build(site, body);
  out += "\n" + md(site, body, rows) + "\n";
}
fs.writeFileSync(OUT, out);
console.log("已生成:", OUT);
for (const site of sites) {
  const fp = path.join(IMPORT_DIR, `${site}-pricing-live.json`);
  if (fs.existsSync(fp)) { const b = JSON.parse(fs.readFileSync(fp, "utf8")); console.log(`  ${site}: ${(b.data || []).length} 模型`); }
}
