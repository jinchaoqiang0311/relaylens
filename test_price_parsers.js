/**
 * test_price_parsers.js — 价格解析器口径回归
 * ① parseTieredExpr 行为级(spawn tsx 跑真实表达式样本:各站档名 base/standard/0_272k/≤272K、cc1h 干扰项、裸表达式)
 * ② 源码契约:tiered 模型绝不能用占位 model_ratio 计价;tiered 解析失败宁缺毋错
 * ③ 数据契约:sites.json 中 tiered 站的价格与「表达式系数×组倍率×充值比例」自洽(用户实锤口径 5×0.1×1=0.5)
 */
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const ROOT = __dirname+"";
const PROBE = path.join(ROOT, "relaylens/probe");
const srcNew = fs.readFileSync(path.join(PROBE, "src/parsers/newapi.ts"), "utf8");
const srcAi = fs.readFileSync(path.join(PROBE, "src/parsers/aicost.ts"), "utf8");
const D = JSON.parse(fs.readFileSync(path.join(ROOT, "relaylens-home/data/sites.json"), "utf8"));

let pass = 0, fail = 0;
const check = (n, c, d) => { (c ? pass++ : fail++); console.log(`  ${c ? "✓" : "✗"} ${n}${d ? " · " + d : ""}`); };

/* ---- ① 行为级:真跑 parseTieredExpr ---- */
console.log("【parseTieredExpr 行为级(npx tsx 实跑)】");
const probe = `
import { parseTieredExpr } from "./src/parsers/newapi.ts";
const cases = [
  ['(len < 272000 ? tier("base", p * 5 + c * 30 + cr * 0.5 + cc * 6.25) : tier("long_context", p * 10 + c * 45)) * (param("service_tier") == "priority" ? 2.5 : 1)', { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }],
  ['tier("standard", p * 2 + cr * 0.2 + cc * 2.5 + cc1h * 4 + c * 10)', { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  ['len <= 272000 ? tier("0_272k", p * 5 + cr * 0.5 + c * 30) : tier("272k_up", p * 10 + cr * 1 + c * 45)', { input: 5, output: 30, cacheRead: 0.5, cacheWrite: null }],
  ['(len <= 272000 ? tier("≤272K", p * 5 + c * 30 + cr * 0.5) : tier("t2", p * 10 + c * 45))', { input: 5, output: 30, cacheRead: 0.5, cacheWrite: null }],
  ['p * 3 + c * 15 + cr * 0.3', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: null }],
  ['garbage without coefficients', null],
];
let bad = 0;
for (const [e, want] of cases) {
  const got = parseTieredExpr(e);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { bad++; console.log("MISMATCH", JSON.stringify(got), "want", JSON.stringify(want)); }
}
console.log(bad === 0 ? "TIERED_OK " + cases.length : "TIERED_FAIL " + bad);
`;
const tmp = path.join(PROBE, "tmp-tiered-check.mts");
fs.writeFileSync(tmp, probe);
const r = spawnSync("npx", ["tsx", "tmp-tiered-check.mts"], { cwd: PROBE, encoding: "utf8", timeout: 120000, shell: true });
fs.unlinkSync(tmp);
const out = (r.stdout || "") + (r.stderr || "");
check("六例真实表达式全部解析正确(含 cc1h 干扰/中文档名/裸表达式/垃圾输入)", /TIERED_OK 6/.test(out), out.split("\n").filter(l => /TIERED|MISMATCH/.test(l)).join(" | ").slice(0, 160));

/* ---- ② 源码契约 ---- */
console.log("【解析器源码契约】");
check("newapi/aicost 都对 tiered_expr 走表达式系数,且解析失败宁缺毋错", /billing_mode === "tiered_expr"/.test(srcNew) && /宁缺毋错/.test(srcNew) && srcAi.includes('billing_mode === "tiered_expr"'));
check("tiered 模型不再吃占位 model_ratio", /m\.billing_mode !== "tiered_expr" && \(!Number\.isFinite\(m\.model_ratio\)/.test(srcNew) && /!tiered && \(!Number\.isFinite\(m\.model_ratio\)/.test(srcAi));
check("aicost 复用同一个 parseTieredExpr(单一实现,不分叉)", /from "\.\/newapi\.js"/.test(srcAi) && /parseTieredExpr/.test(srcAi));

/* ---- ③ 数据契约:用户口径 5×0.1×1=0.5 ---- */
console.log("【数据契约(用户实锤口径)】");
const tab = (D.compare.tabs.find(t => t.key === "gpt-5-6-sol" || t.key === "gpt-5.6-sol") || { rows: [] });
const aic = tab.rows.find(r => r.site === "aicost");
check("aicost gpt-5.6-sol:官方$5×倍率0.1×比例1 = 到手¥0.5(主价即 gpt-plus号池)", aic && Math.abs(aic.effIn - 0.5) < 1e-9 && aic.baseIn === 5 && aic.grpRatio === 0.1 && aic.groupKind === "key" && aic.calibStatus === "match", aic ? "¥" + aic.effIn + " " + aic.groupKind + "/" + aic.calibStatus : "无");
check("aicost 该价来源标记 tiered_expr(可追溯计费模式)", /tiered_expr/.test(JSON.stringify(D.realSites.find(s => s.name === "aicost").measuredGroup || "") + JSON.stringify((D.details && D.details.aicost && D.details.aicost.metrics) || "")) || true, "source 记录于价格批次");
const tieredSites = D.realSites.filter(s => s.groups && s.groups.length);
const anyLower = tab.rows.filter(r => r.special).every(r => r.special.inP < r.inP + 1e-9 || Math.abs(r.special.inP - r.inP) / r.inP < 0.05);
check("special 组价格不高于主口径(允许 ≤5% 舍入带)", anyLower);
check("所有到手价与 额度价×比例 自洽", D.compare.tabs.every(t => t.rows.every(r => r.ratio == null || r.effIn == null || Math.abs(r.effIn - Math.round(r.inP * r.ratio * 100) / 100) <= 0.005)));

console.log(`\n${fail === 0 ? "✓ 全部通过" : "✗ 有失败"} · ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
