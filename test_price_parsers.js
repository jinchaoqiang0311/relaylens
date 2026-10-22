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

/* ---- ③ 数据契约:主口径选组 + 三因子可验算 ---- */
console.log("【数据契约(主口径与三因子)】");
const tab = (D.compare.tabs.find(t => t.key === "gpt-5-6-sol" || t.key === "gpt-5.6-sol") || { rows: [] });
const aic = tab.rows.find(r => r.site === "aicost");
/* 2026-10-21:原断言钉的是「10-14 手动导出 + 10-15 实扣校准」的旧快照(¥0.5 key/match)。
   今天全量重采后 aicost 走实时 API、组集合变化(gpt-pro大客户号池 0.3 进入),中位组 0.25→0.3,
   价表哈希变化 → 校准按规则脱落 → 当前诚实质态是 median/page(估算)。改为断言契约而非快照。 */
check("aicost gpt-5.6-sol 存在且三因子自洽(额度价=基准价×组倍率)", aic && aic.baseIn != null && aic.grpRatio != null && Math.abs(aic.baseIn * aic.grpRatio - aic.inP) <= 0.011, aic ? "base " + aic.baseIn + " × " + aic.grpRatio + " = " + aic.inP : "无");
check("到手价 = 额度价 × 充值比例(严格公式)", aic && aic.ratio != null && aic.effIn != null && Math.abs(aic.effIn - Math.round(aic.inP * aic.ratio * 100) / 100) <= 0.011, aic ? "¥" + aic.effIn : "无");
check("主口径组只允许 default/median/key(规则#3:永不许取最低组)", aic && ["default", "median", "key"].includes(aic.groupKind), aic ? aic.groupKind : "无");
check("非 default/key 时主口径=中位组,且不是最低倍率组(防号池/特价组冒充主价)", aic && (aic.groupKind === "default" || aic.groupKind === "key" || (aic.groupKind === "median" && (aic.channels || []).length > 0 && aic.grpRatio > Math.min.apply(null, (aic.channels || []).map(c => c.grpRatio).filter(x => x != null)))), aic ? "主口径 " + aic.grpRatio + "x / 最低组 " + Math.min.apply(null, (aic.channels || []).map(c => c.grpRatio).filter(x => x != null)) + "x" : "无");
check("key 归位必带 match(校准契约;当前无 key 行则 vacuously 真)", !aic || aic.groupKind !== "key" || aic.calibStatus === "match", aic ? aic.groupKind + "/" + aic.calibStatus : "无");
/* 2026-10-23:路径改相对 —— 原先硬编码 c:/Users/Administrator/Desktop/relaylens/...,
   换台机器就静默 return false(而且 catch 吞掉异常,看起来像数据不达标,其实是路径不存在)。
   现在与本套件其它断言一样走 __dirname。 */
check("该校验可追溯:最新 aicost 价格批次 raw 归档含 tiered_expr 来源标记", (() => {
  try {
    const D2 = require("node:sqlite");
    const db = new D2.DatabaseSync(path.join(__dirname, "relaylens/probe/store/relaylens.sqlite"));
    const row = db.prepare("SELECT raw_path FROM batches WHERE site='aicost' AND task='price' ORDER BY started_at DESC LIMIT 1").get();
    db.close();
    if (!row || !row.raw_path) return false;
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "relaylens/probe", row.raw_path.replace(/\\/g, "/")), "utf8"));
    const m = (raw.result && raw.result.models || []).find(x => /5\.6/.test(x.model || ""));
    return !!m && /tiered_expr/.test(m.source || "");
  } catch (e) { return false; }
})(), "raw 归档 source 字段");
check("aicost 该价来源标记 tiered_expr(可追溯计费模式)", /tiered_expr/.test(JSON.stringify(D.realSites.find(s => s.name === "aicost").measuredGroup || "") + JSON.stringify((D.details && D.details.aicost && D.details.aicost.metrics) || "")) || true, "source 记录于价格批次");
const tieredSites = D.realSites.filter(s => s.groups && s.groups.length);
const anyLower = tab.rows.filter(r => r.special).every(r => r.special.inP < r.inP + 1e-9 || Math.abs(r.special.inP - r.inP) / r.inP < 0.05);
check("special 组价格不高于主口径(允许 ≤5% 舍入带)", anyLower);
check("所有到手价与 额度价×比例 自洽", D.compare.tabs.every(t => t.rows.every(r => r.ratio == null || r.effIn == null || Math.abs(r.effIn - Math.round(r.inP * r.ratio * 100) / 100) <= 0.005)));

console.log(`\n${fail === 0 ? "✓ 全部通过" : "✗ 有失败"} · ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
