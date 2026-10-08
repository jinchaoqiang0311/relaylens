/* aicost 完整价格表 → CNY
 * 规则(与探针解析器同源):
 *   tiered_expr 模型: 基础价 = billing_expr 第一个 tier 体系数(单位 $/M tokens)
 *   普通模型:        基础价 = model_ratio × $2;输出 = 输入 × completion_ratio;缓存读 = 输入 × cache_ratio
 *   按次计费(quota_type≠0): 单价 = model_price(美元额度/次)
 *   渠道价 = 基础价 × 组倍率;CNY 到手 = 渠道价 × 充值比例(aicost 声明 ¥1 = 1 美元额度 → ×1)
 */
const fs = require("fs");
const path = require("path");
const SRC = "relaylens/probe/store/manual-imports/aicost-pricing-20261003.json";
const RATIO_CNY_PER_USD = 1; // aicost  commerce: ¥1 = 1 美元额度(人工核实 2026-10-02)

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

const rows = [];   // 长表:模型×渠道
const models = []; // 摘要
for (const m of j.data || []) {
  const tiered = m.billing_mode === "tiered_expr" ? parseTier(m.billing_expr) : null;
  const perCall = m.quota_type !== 0;
  let baseIn = null, baseOut = null, baseCr = null;
  if (!perCall) {
    if (tiered) { baseIn = tiered.in; baseOut = tiered.out; baseCr = tiered.cr; }
    else if (m.model_ratio > 0) { baseIn = m.model_ratio * 2; baseOut = baseIn * (m.completion_ratio || 1); baseCr = m.cache_ratio > 0 ? baseIn * m.cache_ratio : null; }
  }
  const groups = (m.enable_groups || []).filter(g => GR[g] != null);
  const entry = { model: m.model_name, mode: perCall ? "按次" : tiered ? "分档表达式" : "倍率", baseIn, baseOut, baseCr, perCallPrice: perCall ? m.model_price : null, groups: [] };
  for (const g of groups) {
    const r = GR[g];
    const row = { model: m.model_name, group: g, grpRatio: r, mode: entry.mode };
    if (perCall) { row.unitCny = baseNull(m.model_price * r * RATIO_CNY_PER_USD); }
    else if (baseIn != null) {
      row.inCny = baseIn * r * RATIO_CNY_PER_USD;
      row.outCny = baseOut * r * RATIO_CNY_PER_USD;
      row.crCny = baseCr != null ? baseCr * r * RATIO_CNY_PER_USD : null;
    }
    if (row.inCny != null || row.unitCny != null) { rows.push(row); entry.groups.push(row); }
  }
  models.push(entry);
}
function baseNull(v) { return v; }

// CSV(长表,Excel 友好)
const head = "模型,计费方式,分组(渠道),组倍率,输入到手¥/M,输出到手¥/M,缓存读到手¥/M,按次价¥/次";
const csv = [head, ...rows.map(r => [r.model, r.mode, `"${r.group}"`, r.grpRatio,
  r.inCny != null ? r.inCny.toFixed(4) : "", r.outCny != null ? r.outCny.toFixed(4) : "", r.crCny != null ? r.crCny.toFixed(4) : "",
  r.unitCny != null ? r.unitCny.toFixed(4) : ""].join(","))].join("\r\n");
fs.writeFileSync("outputs/aicost-全量价格表-CNY.csv", "\uFEFF" + csv);

// Markdown 摘要:模型 → 基础价 + 最低渠道 + 渠道数
const md = [];
md.push("# aicost 完整价格表(CNY)\r\n");
md.push(`> 来源:2026-10-03 站方已登录浏览器导出的 /api/pricing 全量(74 模型 × ${Object.keys(GR).length} 分组)。`);
md.push(`> 到手价 = 基础价 × 组倍率 × 充值比例;aicost 公示充值比例 **¥1 = 1 美元额度**(人工核实 2026-10-02),故 CNY 数=额度价数字。`);
md.push(`> 计费口径:「分档表达式」模型的真实价在 billing_expr 系数里(model_ratio=37.5 是占位);「倍率」模型基础价 = model_ratio × $2/M。\r\n`);
md.push("| 模型 | 计费方式 | 基础输入 $/M | 基础输出 $/M | 在售组数 | 最低输入到手 ¥/M(所在组) | 最高输入到手 ¥/M |");
md.push("|---|---|---|---|---|---|---|");
for (const e of models) {
  if (e.mode === "按次") { md.push(`| ${e.model} | 按次计费 | — | — | ${e.groups.length} | ${(e.groups[0] && ("¥" + f(e.groups[0].unitCny) + "/次")) || "—"} | |`); continue; }
  if (e.baseIn == null || !e.groups.length) { md.push(`| ${e.model} | ${e.mode} | ${f(e.baseIn) || "?"} | ${f(e.baseOut) || "?"} | 0 | 无可售分组 | |`); continue; }
  const lo = e.groups.reduce((a, b) => a.inCny <= b.inCny ? a : b);
  const hi = e.groups.reduce((a, b) => a.inCny >= b.inCny ? a : b);
  md.push(`| ${e.model} | ${e.mode} | $${f(e.baseIn)} | $${f(e.baseOut)} | ${e.groups.length} | **¥${f(lo.inCny)}**(${lo.group}) | ¥${f(hi.inCny)}(${hi.group}) |`);
}
md.push("\n## 分组倍率表(站方 group_ratio 原样)\n");
md.push("| 组 | " + Object.keys(GR).join(" | ") + " |");
md.push("|---".repeat(Object.keys(GR).length + 1) + "|");
md.push("| 倍率 | " + Object.keys(GR).map(g => GR[g]).join(" | ") + " |");
fs.writeFileSync("outputs/aicost-全量价格表-CNY.md", md.join("\r\n"));

console.log("模型数:", models.length, "| 模型×渠道行数:", rows.length, "| 分组数:", Object.keys(GR).length);
console.log("已写 outputs/aicost-全量价格表-CNY.csv / .md");
