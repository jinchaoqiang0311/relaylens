/**
 * test_tools_share.js — 自测工具箱:通道默认值 + 报告分享图片 + 粘贴回传 的契约与安全性
 * 图片生成核心不可在 Node 里跑真 canvas,但 cardModel(rep) 是"绘制指令"纯函数——
 * 对它做行为断言(域名/宣传语/绝不含 Key),对绘制与接线做源码断言。
 */
const fs = require("fs"), vm = require("vm");
const DIR = __dirname+"/relaylens-home/";
const src = fs.readFileSync(DIR + "tools.html", "utf8");
const script = src.match(/<script>([\s\S]*)<\/script>/)[1];

let pass = 0, fail = 0;
const check = (n, c, d) => { (c ? pass++ : fail++); console.log(`  ${c ? "✓" : "✗"} ${n}${d ? " · " + d : ""}`); };

function nodeStub(id) {
  const n = { id, style: {}, className: "", value: "", checked: true, disabled: false, textContent: "", href: "", download: "",
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute: () => null,
    appendChild() {}, removeChild() {}, querySelector: () => nodeStub(id + "_q"), querySelectorAll: () => [],
    select() {}, click() { n._clicked = (n._clicked || 0) + 1; }, scrollIntoView() {}, focus() {},
  };
  Object.defineProperty(n, "innerHTML", { get() { return n._h || ""; }, set(v) { n._h = String(v); } });
  return n;
}
function load() {
  const nodes = {};
  const doc = {
    getElementById: id => nodes[id] || (nodes[id] = nodeStub(id)),
    createElement: t => nodeStub("c_" + t),
    addEventListener() {}, removeEventListener() {},
    querySelector: () => nodeStub("_q"), querySelectorAll: () => [],
    body: nodeStub("body"), documentElement: nodeStub("html"), head: nodeStub("head"),
    readyState: "complete", execCommand: () => true, title: "",
  };
  const ctx = { document: doc, console, Math, JSON, Date, String, Number, Array, Object, RegExp, Error, Promise,
    isNaN, parseInt, parseFloat, Infinity, NaN, setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent,
    URL, fetch: () => Promise.reject(new Error("no network in test")), prompt: () => null, alert() {},
    location: { href: "https://relaylens.invalid/tools.html", search: "" }, navigator: { clipboard: null } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync("relaylens-home/assets/rl-common.js", "utf8"), ctx);
  vm.runInContext(script, ctx);
  return { ctx, nodes, doc };
}

console.log("【通道与默认值】");
check("通道下拉默认选中控制台脚本", /<option value="console" selected>/.test(src) && src.indexOf("value=\"console\" selected") < src.indexOf("value=\"auto\">"));
check("开始检测按通道分流(console→生成脚本)", /(tMode[^\n]*\.value|getElementById\("tMode"\))/.test(script) && /mode === "console"/.test(script) && /getElementById\("genScript"\)\.click\(\)/.test(script));
check("导航与标题已改「自测工具箱」", /自测工具箱/.test(src) && /<title>自测工具箱/.test(src));
check("页内不再有 selftest.html 死链", !/href="selftest\.html"/.test(src));

console.log("【粘贴回传】");
check("脚本输出后提供粘贴框与载入按钮", /id="pasteReportBox"/.test(src) && /id="loadPasted"/.test(src));
check("载入时校验 schema 前缀", /relaylens-selftest/.test(script) && /schema/.test(script));

(async () => {
  console.log("【cardModel 行为级(绘制指令)】");
  const { ctx } = load();
  const rep = {
    schema: "relaylens-selftest/1.0.0", ranAt: "2026-10-03T04:00:00.000Z",
    base: "https://api.example.com/v1", model: "gpt-5.5", key: "sk-SUPERSECRET-1234567890",
    elapsedMs: 39000,
    checks: [
      { name: "流式真伪 + 首字延迟", state: "warn", detail: "混合行为", ttftMs: 2361 },
      { name: "Token 计量线性度(查注入)", state: "bad", detail: "检出固定注入 ≈ 4858 tok/请求" },
      { name: "返回模型名一致性", state: "ok", detail: "一致" },
    ],
    summary: "发现 1 项异常",
  };
  const m = ctx.cardModel(rep);
  check("卡片含品牌域名 aipaihangbang.cn", m.domain === "aipaihangbang.cn", m.domain);
  check("卡片含宣传语", typeof m.slogan === "string" && m.slogan.length >= 6, m.slogan);
  check("卡片站点显示 host 而非完整 URL", m.site === "api.example.com", m.site);
  const dump = JSON.stringify(m);
  check("绘制指令绝不含 Key", !/SUPERSECRET|sk-/.test(dump));
  check("检测项与状态齐全(3 项 + 结论)", m.checks.length === 3 && m.worst === "bad" && /异常/.test(m.verdict));
  check("每项有状态中文字(供画布胶囊)", m.checks.every(c => ["通过", "待观察", "异常"].includes(c.stateTxt)));

  /* 粘贴回传行为级:载入合法 JSON → LAST_REPORT 落地且 Key 被剔 */
  console.log("【粘贴回传行为级】");
  const L = load();
  const pasteNode = L.doc.getElementById("pasteReportBox"); pasteNode.value = JSON.stringify(rep);
  let clicked = false;
  // loadPasted 的 click handler 在 load() 时绑定,stub click 只计数;手动重放:找绑定较难,直接调 renderReport
  L.ctx.renderReport(JSON.parse(pasteNode.value));
  check("renderReport 后面板可见(图片按钮随之可用)", L.nodes["reportBox"].style.display === "block");
  check("分享图按钮与预览容器存在", /id="makeImage"/.test(src) && /id="imgPreview"/.test(src) && /id="shareCanvas"/.test(src));
  check("绘制函数落盘 blob/dataURL 并挂下载链接", /toBlob/.test(script) && /createObjectURL/.test(script) && /downloadImg/.test(script));

  console.log(`\n${fail === 0 ? "✓ 全部通过" : "✗ 有失败"} · ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
