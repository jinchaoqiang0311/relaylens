/* 站方完整价格表 → CNY(通用版)
 * 用法: node gen-station-cny.cjs <pricing.json> <充值比例¥/1$额度> <输出前缀>
 * 规则(与探针解析器同源):
 *   tiered_expr: 基础价 = billing_expr 第一个 tier 体系数($/M);model_ratio 是占位
 *   普通:       基础输入 = model_ratio × $2;输出 = ×completion_ratio;缓存读 = ×cache_ratio
 *   按次(quota_type≠0): 单价 = model_price(美元额度) × 组倍率 × 充值比例
 *   到手价 = 基础价 × 组倍率 × 充值比例
 */
const fs = require("fs");
const [SRC, RATIO_S, PREFIX] = process.argv.slice(2);
if (!SRC || !RATIO_S || !PREFIX) { console.error("用法: node gen-station-cny.cjs <json> <ratio> <prefix>"); process.exit(1); }
const RATIO = Number(RATIO_S);

const j = JSON.parse(fs.readFileSync(SRC, "utf8"));
const GR = j.group_ratio || {};

function parseTier(expr) {
  if (!expr) return null;
  const m = /tier\(\s*["'][^"']*["']\s*,([^)]*)\)/.exec(expr);
  const body = m ? m[1] : (/tier\(/.test(expr) ? null : expr);
  if (!body) return null;
  const c = v => { const k = new RegExp("\\b" + v + "\\s*\\*\\s*([\\d.]+)").exec(body); return k ? Number(k[1]) : null; };
  const p = c("p"), o = c("c");
  if (!p || !o) return null;
  return { in: p, out: o, cr: c("cr"), cw: c("cc") };
}
const f = v => v == null ? "" : (v < 0.01 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2));

const rows = [], models = [];
for (const m of j.data || []) {
  const tiered = m.billing_mode === "tiered_expr" ? parseTier(m.billing_expr) : null;
  const perCall = m.quota_type !== 0;
  let baseIn = null, baseOut = null, baseCr = null;
  if (!perCall) {
    if (tiered) { baseIn = tiered.in; baseOut = tiered.out; baseCr = tiered.cr; }
    else if (m.model_ratio > 0) { baseIn = m.model_ratio * 2; baseOut = baseIn * (m.completion_ratio || 1); baseCr = m.cache_ratio > 0 ? baseIn * m.cache_ratio : null; }
  }
  const groups = (m.enable_groups || []).filter(g => GR[g] != null);
  const entry = { model: m.model_name, mode: perCall ? "按次" : tiered ? "分档表达式" : "倍率", baseIn, baseOut, baseCr, groups: [] };
  for (const g of groups) {
    const r = GR[g];
    const row = { model: m.model_name, group: g, grpRatio: r, mode: entry.mode };
    if (perCall) row.unitCny = (m.model_price || 0) * r * RATIO;
    else if (baseIn != null) {
      row.inCny = baseIn * r * RATIO;
      row.outCny = baseOut * r * RATIO;
      row.crCny = baseCr != null ? baseCr * r * RATIO : null;
    }
    if (row.inCny != null || row.unitCny != null) { rows.push(row); entry.groups.push(row); }
  }
  models.push(entry);
}

const head = "模型,计费方式,分组(渠道),组倍率,输入到手¥/M,输出到手¥/M,缓存读到手¥/M,按次价¥/次";
const csv = [head, ...rows.map(r => [r.model, r.mode, `"${r.group}"`, r.grpRatio,
  r.inCny != null ? r.inCny.toFixed(4) : "", r.outCny != null ? r.outCny.toFixed(4) : "", r.crCny != null ? r.crCny.toFixed(4) : "",
  r.unitCny != null ? r.unitCny.toFixed(4) : ""].join(","))].join("\r\n");
fs.writeFileSync(`outputs/${PREFIX}-CNY.csv`, "\uFEFF" + csv);

const md = [];
md.push(`# ${PREFIX} 完整价格表(CNY)\r\n`);
md.push(`> 来源:${new Date().toISOString().slice(0, 10)} 探针实时抓取站方 /api/pricing(${(j.data || []).length} 模型 × ${Object.keys(GR).length} 分组)。`);
md.push(`> 到手价 = 基础价 × 组倍率 × 充值比例 ¥${RATIO}/1$额度。`);
md.push(`> 「分档表达式」模型真实价在 billing_expr 系数(model_ratio 为占位);「倍率」模型基础价 = model_ratio × $2/M。\r\n`);
md.push("| 模型 | 计费方式 | 基础输入 $/M | 基础输出 $/M | 在售组数 | 最低输入到手 ¥/M(所在组) | 最高输入到手 ¥/M |");
md.push("|---|---|---|---|---|---|---|");
for (const e of models) {
  if (e.mode === "按次") { md.push(`| ${e.model} | 按次计费 | — | — | ${e.groups.length} | ${(e.groups[0] && ("¥" + f(e.groups[0].unitCny) + "/次")) || "—"} | |`); continue; }
  if (e.baseIn == null || !e.groups.length) { md.push(`| ${e.model} | ${e.mode} | ${f(e.baseIn) || "?"} | ${f(e.baseOut) || "?"} | ${e.groups.length} | ${e.groups.length ? "" : "无可售分组"} | |`); continue; }
  const lo = e.groups.reduce((a, b) => a.inCny <= b.inCny ? a : b);
  const hi = e.groups.reduce((a, b) => a.inCny >= b.inCny ? a : b);
  md.push(`| ${e.model} | ${e.mode} | $${f(e.baseIn)} | $${f(e.baseOut)} | ${e.groups.length} | **¥${f(lo.inCny)}**(${lo.group}) | ¥${f(hi.inCny)}(${hi.group}) |`);
}
md.push("\n## 分组倍率表(站方 group_ratio 原样)\n");
md.push("| 组 | " + Object.keys(GR).join(" | ") + " |");
md.push("|---".repeat(Object.keys(GR).length + 1) + "|");
md.push("| 倍率 | " + Object.keys(GR).map(g => GR[g]).join(" | ") + " |");
fs.writeFileSync(`outputs/${PREFIX}-CNY.md`, md.join("\r\n"));
console.log(`[${PREFIX}] 模型 ${models.length} · 模型×渠道 ${rows.length} 行 · 分组 ${Object.keys(GR).length}`);
