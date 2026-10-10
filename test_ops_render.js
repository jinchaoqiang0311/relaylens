/**
 * test_ops_render.js —— ops.html 渲染级断言(不是只测「语法+能跑」)
 * 用真实 data/ops.json + data/audit.json 喂页面,断言渲染出来的 HTML 本身。
 * 重点防三类事故:①null 被渲染成 0 / undefined ②未测项被臆造 ③CPS 明文泄漏进页面
 */
const fs = require("fs"), vm = require("vm");
const DIR = __dirname+"/relaylens-home/";

const OPS = JSON.parse(fs.readFileSync(DIR + "data/ops.json", "utf8"));
const AUD = JSON.parse(fs.readFileSync(DIR + "data/audit.json", "utf8"));
// 真实链里唯一的人工条目是最早的 chain.init,而公开摘要按「新→旧」只下发最近 30 条 —— 按全量判断会假失败。
// 把最新一条改标人工,让「人 · 名字」这条美化逻辑真的被走到(其余条目仍是 probe 自动)。
if (AUD.entries && AUD.entries.length) AUD.entries[0].actor = "human:测试员";
const html = fs.readFileSync(DIR + "ops.html", "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);

// --- DOM stub:记录每个 id 的 innerHTML ---
const captured = {};
function makeEl(id) {
  const node = {
    id, innerHTML: "", textContent: "", style: {}, className: "",
    _children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, appendChild(c) { node._children.push(c) },
    setAttribute() {}, getAttribute: () => "",
    querySelector(sel) { const k = id + "::" + sel.replace(/\W/g, "_"); return captured[k] || (captured[k] = makeEl(k)); },
  };
  Object.defineProperty(node, "innerHTML", {
    get() { return captured[id] || ""; },
    set(v) { captured[id] = String(v); },
  });
  return node;
}
const doc = {
  getElementById: id => makeEl(id),
  querySelector: s => makeEl(s.replace(/\W/g, "_")),
  querySelectorAll: () => [],
  createElement: () => makeEl("_tmp" + Math.random()),
  addEventListener() {}, title: "",
};
const ctx = {
  document: doc, location: { search: "", href: "" }, console: { log() {}, error() {} },
  Math, JSON, Date, String, Number, Array, Object, Promise, Set, Map, RegExp, Error, Infinity, NaN, isNaN, parseInt, parseFloat,
  setTimeout: (fn) => fn(), clearTimeout() {}, requestAnimationFrame: () => {},
  fetch: (u) => Promise.resolve({
    ok: true,
    json: () => Promise.resolve(String(u).includes("audit") ? AUD : OPS),
  }),
};
new vm.Script(scripts.join("\n"), { filename: "ops.html" });
vm.runInContext(scripts.join("\n"), vm.createContext(ctx));

let pass = 0, fail = 0;
const check = (name, cond, detail) => { (cond ? pass++ : fail++); console.log(`  ${cond ? "✓" : "✗"} ${name}${detail ? " · " + detail : ""}`); };
const H = id => captured[id] || "";

(async () => {
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  console.log("\n【ops.html 渲染断言】");

  // 0) 数据齐备时绝不允许掉进「无法读取看板数据」错误态 —— 这条能精确定位渲染中途抛异常
  check("ops 图例随采样节拍(无 24–48h 旧档)",!H("kpis").includes("24–48h"));
  check("未掉入错误兜底态(渲染全程无抛异常)", !H("kpis").includes("无法读取看板数据"), H("kpis").includes("无法读取") ? H("kpis").replace(/<[^>]+>/g, " ").slice(0, 160) : "");

  // 1) 队列条数与数据一致,且紧急度 class 正确
  const qRows = (H("queue").match(/class="qrow /g) || []).length;
  check("待复核队列条数 = 数据条数", qRows === OPS.queue.length, `${qRows} vs ${OPS.queue.length}`);
  const critRows = (H("queue").match(/qrow critical/g) || []).length;
  check("critical 条目数正确", critRows === OPS.counts.critical, `${critRows} vs ${OPS.counts.critical}`);
  check("队列不静默清空(有数据就必须渲染行)", OPS.queue.length === 0 || qRows > 0);

  // 2) 矩阵行数 = 站点数,列数 = 6 探针 + 3
  const mRows = (H("matrix") || "").length;
  const bodyKey = Object.keys(captured).find(k => k.includes("matrix") && k.includes("tbody"));
  const matrixHtml = bodyKey ? captured[bodyKey] : "";
  const trs = (matrixHtml.match(/<tr>/g) || []).length;
  check("矩阵行数 = 实测站数", trs === OPS.sites.length, `${trs} vs ${OPS.sites.length}`);
  check("矩阵渲染了未测态而非空白", /未测/.test(matrixHtml) || OPS.sites.every(s => Object.values(s.tasks).every(Boolean)));

  // 3) null 绝不渲染成 0 或 undefined
  const all = Object.values(captured).join("\n");
  check("无 undefined 漏字", !/undefined/.test(all));
  check("无 NaN 漏字", !/NaN/.test(all));
  check("无 [object Object] 漏字", !/\[object Object\]/.test(all));

  // 4) 覆盖率条数 = 站点 × 6 桶,未达标用「未达标」不用假绿
  const covBars = (H("coverage").match(/class="covbar /g) || []).length;
  check("覆盖率条数 = 站点×6", covBars === OPS.sites.length * 6, `${covBars}`);
  const miss = OPS.sites.reduce((n, s) => n + s.coverage.filter(c => !c.ok).length, 0);
  const missRendered = (H("coverage").match(/未达标/g) || []).length;
  check("未达标桶数正确标注", missRendered === miss, `${missRendered} vs ${miss}`);

  // 5b) 三种「没有数字」必须可区分:未建模 ≠ 数据不足不出分 ≠ 真得分
  let nullScenes = 0, unmodeled = 0;
  for (const s of OPS.sites) for (const sc of OPS.scenes) {
    if (!(sc.key in s.scores)) unmodeled++;
    else if (s.scores[sc.key] === null) nullScenes++;
  }
  // 只数分数格里的「无分」值,站名后的「· 无分场景:…」说明文字不算
  const noScore = (H("scores").match(/class="sv">无分</g) || []).length;
  const noModel = (H("scores").match(/class="sv">未建模</g) || []).length;
  check("数据不足场景显示「无分」", noScore === nullScenes, `${noScore} vs ${nullScenes}`);
  check("未参与计算场景显示「未建模」而非「无分」", noModel === unmodeled, `${noModel} vs ${unmodeled}`);
  const refs = OPS.sites.filter(s => s.kind === "reference");
  check("看板已登记参照系站点(官方/聚合)", refs.length === 3, refs.map(s => s.name).join(","));
  check("参照系一格「无分」都不产生:范畴不同不是数据不足",
    refs.every(s => Object.keys(s.scores).length === 0) && (H("scores").match(/参照系 · 不参与评分/g) || []).length === refs.length);
  check("实测站仍带 kind=measured 且分数未被参照系改动",
    OPS.sites.filter(s => s.kind === "measured").every(s => Object.keys(s.scores).length > 0));

  // 6) 审计流:快照噪声不出现在公开摘要里
  check("公开摘要不含 config.snapshot 噪声", !AUD.entries.some(e => e.action === "config.snapshot"));
  const logRows = (H("audit").match(/class="lrow"/g) || []).length;
  check("审计条目渲染数 = 公开摘要数", logRows === Math.min(AUD.entries.length, 30), `${logRows} vs ${Math.min(AUD.entries.length, 30)}`);
  const hasHuman = AUD.entries.some(e => String(e.actor).startsWith("human:"));
  check("人工条目渲染为「人 · 名字」而非原始 actor 串", hasHuman ? /人 · /.test(H("audit")) && !/human:/.test(H("audit")) : true,
    hasHuman ? "已美化" : "本批无人工条目");
  check("审计 seq 有渲染", /#\d/.test(H("audit")));

  // 7) 隐私红线:CPS 明文与密钥绝不进渲染结果或公开 JSON
  const promoRaw = fs.existsSync(DIR + "data/../config/promo.yaml") ? "" : (() => {
    try { return fs.readFileSync(__dirname+"/relaylens/probe/config/promo.yaml", "utf8"); } catch { return ""; }
  })();
  const urls = [...promoRaw.matchAll(/url:\s*"?([^"\s]+)"?/g)].map(m => m[1]).filter(u => u.startsWith("http"));
  const leaks = urls.filter(u => all.includes(u) || JSON.stringify(AUD).includes(u));
  check("CPS 明文链接零泄漏" + (urls.length ? `(${urls.length} 条待检)` : "(promo.yaml 无实链)"), leaks.length === 0, leaks.join(" "));
  check("公开 JSON 不含 key/sk 字样", !/sk-[A-Za-z0-9]{8,}/.test(JSON.stringify(AUD) + JSON.stringify(OPS)));

  // 8) 链状态如实呈现
  check("链校验状态如实呈现", H("chain-cap").includes(AUD.chain.ok ? "链校验通过" : "链校验失败"));
  check("KPI 渲染 5 张卡", (H("kpis").match(/class="kpi /g) || []).length === 5);

  console.log(`\n${fail === 0 ? "✓ 全部通过" : "✗ 有失败"} · ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
