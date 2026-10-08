/**
 * test_selector_render.js —— 选型顾问引擎功能断言
 * 重点不是"能渲染",而是三件容易做错的事:
 *   ① 硬约束真的排除了(要真流式时,假流式站必须出局且给出理由)
 *   ② 成本真的含注入(短任务下注入占比必须可见)
 *   ③ 不越界声称(没有能力基准数据,就不说"哪个模型更强")
 */
const fs = require("fs"), vm = require("vm");
const DIR = "C:/Users/Administrator/.qwenworkcn/workspace/mugbtmedrrtj5xkw/relaylens-home/";
const SITES = JSON.parse(fs.readFileSync(DIR + "data/sites.json", "utf8"));
const html = fs.readFileSync(DIR + "selector.html", "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");

function run(fetchImpl, values) {
  const captured = {}, texts = {};
  const vals = Object.assign({ sScene: "code", sReq: "1000", sIn: "2000", sOut: "400", sHit: "50", sTtft: "999", sBudget: "", sModel: "" }, values || {});
  const checked = {};
  const mk = id => {
    const n = { id, style: {}, className: "", value: vals[id] != null ? vals[id] : "", checked: !!checked[id], type: id === "sStream" ? "checkbox" : "text", children: [], addEventListener() {}, appendChild() {}, querySelector: () => mk("_q"), querySelectorAll: () => [], getAttribute: () => "", setAttribute() {}, open() {}, focus() {}, select() {},
      classList: { add(c) { n.className += " " + c }, remove(c) { n.className = (n.className || "").split(" ").filter(x => x && x !== c).join(" ") }, toggle() {}, contains: () => false } };
    n.disabled = false;
    Object.defineProperty(n, "innerHTML", { get: () => captured[id] || "", set(v) { captured[id] = String(v) } });
    Object.defineProperty(n, "textContent", { get: () => texts[id] || "", set(v) { texts[id] = String(v) } });
    Object.defineProperty(n, "value", { get: () => vals[id] != null ? vals[id] : "", set(v) { vals[id] = v } });
    Object.defineProperty(n, "checked", { get: () => !!checked[id], set(v) { checked[id] = v } });
    return n;
  };
  const ctx = {
    document: { getElementById: mk, querySelector: () => mk("_d"), querySelectorAll: () => [], createElement: () => mk("_c"), addEventListener() {}, title: "", execCommand: () => true },
    location: { search: "", href: "" }, navigator: { clipboard: null },
    console: { log() {}, warn() {}, error() {} },
    Math, JSON, Date, String, Number, Array, Object, RegExp, Error, Promise, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, Infinity,
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: cb => cb(1e9), performance: { now: () => 0 },
    fetch: fetchImpl, window: {},
  };
  vm.runInContext(scripts, vm.createContext(ctx));
  return { ctx, captured, texts, vals, checked };
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
const ok = () => Promise.resolve({ ok: true, json: () => Promise.resolve(SITES) });

let pass = 0, fail = 0;
const check = (n, c, d) => { (c ? pass++ : fail++); console.log(`  ${c ? "✓" : "✗"} ${n}${d ? " · " + d : ""}`); };

(async () => {
  const firstModel = SITES.compare.tabs[0].key;
  console.log("\n【模型下拉与权重表】");
  const A = run(ok);
  await flush();
  const modelOpts = A.captured["sModel"] || "";
  check("模型下拉由实测锚定模型填充", SITES.compare.tabs.every(t => modelOpts.includes(t.key)), `${(modelOpts.match(/<option/g) || []).length} 项`);
  check("标注每家有几站有报价", /家站有报价/.test(modelOpts));
  check("权重表渲染并标数据来源", /真实成本\(含注入\)/.test(A.captured["wTable"] || "") && /SSE 流式探针实测/.test(A.captured["wTable"] || ""));

  console.log("\n【① 硬约束真排除:要真流式 → 假流式站出局】");
  const B = run(ok, { sModel: firstModel, sStream: true });
  B.checked["sStream"] = true;
  await flush(); vm.runInContext("run()", B.ctx);
  const resB = B.captured["resBox"] || "";
  const allFake = SITES.compare.tabs[0].rows.every(r => (SITES.realSites.find(s => s.name === r.site) || {}).stream >= 50);
  if (allFake) {
    check("两家均假流式 → 无推荐且给出说明", /没有满足你当前约束的选项/.test(resB), resB.slice(0, 50));
    check("被排除项写明「假流式」及后果", /被排除的选项/.test(resB) && /假流式/.test(resB) && /逐字渲染/.test(resB));
  } else {
    check("至少一家真流式时给出推荐", /class="pick/.test(resB));
  }

  console.log("\n【② 成本含注入】");
  const C = run(ok, { sModel: firstModel, sIn: "150", sOut: "80", sHit: "0", sReq: "20000" });
  await flush(); vm.runInContext("run()", C.ctx);
  const resC = C.captured["resBox"] || "";
  check("渲染推荐卡片", (resC.match(/class="pick/g) || []).length >= 1, `${(resC.match(/class="pick/g) || []).length} 张`);
  check("成本明细含注入部分", /注入部分/.test(resC) && /固定注入/.test(resC));
  check("短任务下提示比标价贵多少", /比只看标价贵 <b>\d+%/.test(resC), (resC.match(/比只看标价贵 <b>(\d+)%/) || [])[1] + "%");
  check("月成本按日请求×30 计算", /\/月<\/b>/.test(resC));
  check("未公布缓存价时给出保守假设提示", !/未公布缓存价/.test(resC) || /按输入价计/.test(resC));

  console.log("\n【③ 不越界声称】");
  const bannedClaims = ["最强模型", "模型排行", "能力第一", "智商", "benchmark 冠军", "哪个模型最好"];
  const hits = bannedClaims.filter(w => html.includes(w));
  check("不声称哪个模型更强", hits.length === 0, hits.join(" "));
  check("明确声明不转发流量", /不转发你的流量|不做流量转发/.test(html));
  check("明确声明无能力基准", /没有跑过能力基准|没有能力基准数据/.test(html));
  check("分组口径提醒存在", /同一站的其他分组|实测分组/.test(resC) || /口径提醒/.test(resC));

  console.log("\n【预算与延迟约束】");
  const D = run(ok, { sModel: firstModel, sBudget: "0.01", sReq: "1000" });
  await flush(); vm.runInContext("run()", D.ctx);
  check("超预算被排除并写明金额", /超出预算/.test(D.captured["resBox"] || ""));
  const E = run(ok, { sModel: firstModel, sTtft: "2" });
  await flush(); vm.runInContext("run()", E.ctx);
  check("延迟不满足被排除(TTFT 均 >2s)", /首字延迟 .*超出你设的 2s 上限/.test(E.captured["resBox"] || ""), (E.captured["resBox"] || "").slice(0, 40));

  console.log("\n【数据缺失不做假回退】");
  const F = run(() => Promise.reject(new Error("404")));
  await flush();
  check("读不到数据时显式报错", /读不到实测数据/.test(F.captured["resBox"] || ""));
  check("报错文案点明宁可不给也不假算", /假的成本测算比不给建议更糟/.test(F.captured["resBox"] || ""));

  console.log(`\n${fail === 0 ? "✓ 全部通过" : "✗ 有失败"} · ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
