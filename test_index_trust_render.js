/**
 * test_index_trust_render.js —— 首页(选站比价工作台)渲染断言
 * 2026-10-22 整页重构为 RelayIndex 风格比价工作台后重写。
 * 核心不变:①真实统计正确落到 DOM ②比价表渲染真实站点(分数/价格) ③数据不足显式标注,不编造
 *           ④取不到数据时保持静态「—」与诚实失败语,绝不回退假数
 */
const fs = require("fs"), vm = require("vm");
const DIR = __dirname + "/relaylens-home/";
const SITES = JSON.parse(fs.readFileSync(DIR + "data/sites.json", "utf8"));
const html = fs.readFileSync(DIR + "index.html", "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");
const S = SITES.meta.stats;

function run(fetchImpl) {
  const captured = {}, texts = {};
  const byId = {};
  const mk = id => {
    const n = {
      id, style: {}, className: "", children: [], value: "", checked: false, disabled: false, hidden: false,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      appendChild(c) { n.children.push(c) }, addEventListener() {}, setAttribute() {},
      insertBefore() {}, replaceChildren() {}, remove() {}, firstChild: null,
      getAttribute: () => "", querySelector: () => mk("_q"), querySelectorAll: () => [],
    };
    Object.defineProperty(n, "innerHTML", { get: () => captured[id] || "", set(v) { captured[id] = String(v); } });
    Object.defineProperty(n, "textContent", { get: () => texts[id] || "", set(v) { texts[id] = String(v); } });
    return n;
  };
  const ctx = {
    document: {
      getElementById: id => (byId[id] || (byId[id] = mk(id))),
      querySelector: () => mk("_d"), querySelectorAll: () => [],
      createElement: t => mk("_c_" + t), addEventListener() {}, title: "", body: mk("body"),
    },
    location: { search: "", href: "" }, navigator: { clipboard: null },
    console: { log() {}, warn() {}, error: (...a) => { if (process.env.V) console.log("[页面错误]", ...a); } },
    Math, JSON, Date, String, Number, Array, Object, RegExp, Error, isFinite, parseInt, parseFloat, Infinity,
    encodeURIComponent, decodeURIComponent,
    requestAnimationFrame: cb => cb(1e9),
    setTimeout: () => 0, clearTimeout() {},
    fetch: fetchImpl,
  };
  const __ctx = vm.createContext(ctx); vm.runInContext(fs.readFileSync("relaylens-home/assets/rl-common.js", "utf8"), __ctx); vm.runInContext(scripts, __ctx);
  return { captured, texts };
}

let pass = 0, fail = 0;
const check = (n, c, d) => { (c ? pass++ : fail++); console.log(`  ${c ? "✓" : "✗"} ${n}${d ? " · " + d : ""}`); };

(async () => {
  console.log("\n【首页 · 真实数据态】");
  const A = run(u => Promise.resolve({ ok: true, json: () => Promise.resolve(SITES) }));
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  const t = A.texts, rowsHtml = A.captured["provider-rows"] || "";

  check(`收录中转站 = ${S.sitesRegistered}`, t["st-sites"] === String(S.sitesRegistered), t["st-sites"]);
  check(`账单级实测 = ${S.sitesPaidMeasured}`, t["st-measured"] === String(S.sitesPaidMeasured), t["st-measured"]);
  check(`逐笔核验 = ${S.reconcileVerified}`, t["st-verified"] === String(S.reconcileVerified), t["st-verified"]);
  check("结果计数含家数", /显示 \d+ \/ \d+ 家/.test(t["result-count"] || ""), t["result-count"]);

  const realNames = SITES.realSites.map(s => s.name);
  const shown = realNames.filter(n => rowsHtml.includes(n));
  check("比价表渲染全部真实中转站", shown.length === realNames.length, `${shown.length}/${realNames.length}`);
  /* 分数从 payload 现算,不写死 —— 探针每跑一轮综合分就会变(aixoras 曾 75,补采健康样本后 79),
     写死数字只会让"数据是活的"变成"测试是坏的" */
  const ax = SITES.realSites.find(s => s.name === "aixoras");
  const axScore = ax && ax.score ? ax.score.all : null;
  check(`表格含真实综合分(aixoras ${axScore ?? "—"})`,
    axScore == null || (new RegExp(">" + axScore + "<").test(rowsHtml) && /aixoras/.test(rowsHtml)), String(axScore));
  check("价格列用人民币到手价(¥)", /¥/.test(rowsHtml), "");
  check("详情链接指向真实站点", /detail\.html\?site=/.test(rowsHtml), "");
  check("模型真伪列渲染指纹结论", /指纹通过|存疑|未通过|未测/.test(rowsHtml), "");

  const hasNullScore = SITES.realSites.some(s => !(s.score && s.score.all != null));
  check("有未评分站 → 表格显式「数据不足」", !hasNullScore || /数据不足/.test(rowsHtml), "");

  const refHtml = A.captured["ref-rows"] || "";
  check("官方/聚合参照单独成区", (SITES.referenceSites || []).length === 0 || /参照/.test(refHtml), refHtml.slice(0, 40));

  const banned = ["RelayAPI", "128,600", "¥0.82", "已实测 47", "47 家", "RLSAVE15", "今日专属", "虚构示例", "均为虚构"];
  const hay = html + JSON.stringify(A.texts) + JSON.stringify(A.captured);
  const found = banned.filter(b => hay.includes(b));
  check(`旧假数/虚构演示绝迹(查 ${banned.length} 项)`, found.length === 0, found.join(" | "));

  console.log("\n【首页 · 取不到数据态】");
  const B = run(() => Promise.reject(new Error("http 500")));
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  const statKeys = ["st-sites", "st-measured", "st-verified", "st-upd", "fresh-time"];
  const wrote = statKeys.filter(k => B.texts[k] !== undefined);
  check("统计位不被写入任何值(失败不回落假数)", wrote.length === 0, "误写入: " + wrote.join(","));
  check("失败时表格显示诚实失败语(非假站)", /数据加载失败/.test(B.captured["provider-rows"] || "") && !/aixoras/.test(B.captured["provider-rows"] || ""), "");
  check("失败语明确「不展示编造示例数据」", /不展示编造的示例数据/.test(B.captured["provider-rows"] || ""), "");
  check("静态默认值就是「—」", html.includes('id="st-sites">—</span>'), "");
  check("降级后无假数", !["47 家", "RelayAPI", "¥0.82"].some(b => (JSON.stringify(B.texts) + JSON.stringify(B.captured)).includes(b)));

  console.log(`\n${fail === 0 ? "✓ 全部通过" : "✗ 有失败"} · ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
