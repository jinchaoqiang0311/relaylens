/**
 * test_method_audit_render.js —— method.html ⑥ 公开审计区块渲染断言
 * 两态都测:①有 audit.json 时如实渲染 ②取不到时给空态而非编造记录
 */
const fs = require("fs"), vm = require("vm");
const DIR = "C:/Users/Administrator/.qwenworkcn/workspace/mugbtmedrrtj5xkw/relaylens-home/";
const AUD = JSON.parse(fs.readFileSync(DIR + "data/audit.json", "utf8"));
const html = fs.readFileSync(DIR + "method.html", "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");

function buildCtx(fetchImpl) {
  const captured = {};
  const mk = id => {
    const n = { id, style: {}, className: "", textContent: "", children: [],
      classList: { add(c) { n.className += " " + c }, remove() {}, toggle() {}, contains: () => false },
      appendChild(c) { n.children.push(c) }, addEventListener() {}, setAttribute() {}, getAttribute: () => "",
      querySelector: () => mk("_q") };
    Object.defineProperty(n, "innerHTML", { get: () => captured[id] || "", set: v => { captured[id] = String(v) } });
    // textContent 与 innerHTML 分开记:页面两条路径各用其一(成功态写 HTML,降级态写纯文本)
    Object.defineProperty(n, "textContent", { get: () => captured[id + "::text"] || "", set: v => { captured[id + "::text"] = String(v) } });
    return n;
  };
  const ctx = {
    document: { getElementById: mk, querySelector: () => mk("_d"), querySelectorAll: () => [], createElement: () => mk("_c"), addEventListener() {}, title: "" },
    location: { search: "", href: "" }, navigator: { clipboard: null }, console: { log() {}, warn() {}, error() {} },
    Math, JSON, Date, String, Number, Array, Object, RegExp, Error, setTimeout: fn => fn(), clearTimeout() {},
    encodeURIComponent, decodeURIComponent, fetch: fetchImpl,
  };
  vm.runInContext(scripts, vm.createContext(ctx));
  return { ctx, captured };
}

let pass = 0, fail = 0;
const check = (n, c, d) => { (c ? pass++ : fail++); console.log(`  ${c ? "✓" : "✗"} ${n}${d ? " · " + d : ""}`); };

(async () => {
  console.log("\n【method.html ⑥ 审计区块 · 有数据态】");
  let got = null;
  const A = buildCtx(u => { got = u; return Promise.resolve({ ok: true, json: () => Promise.resolve(AUD) }) });
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  const list = A.captured["al-list"] || "", bar = A.captured["al-chain-txt"] || "";
  check("请求的是 data/audit.json", got === "data/audit.json", String(got));
  check("链校验通过态如实呈现", AUD.chain.ok ? /校验通过/.test(bar) : /校验失败/.test(bar), bar.replace(/<[^>]+>/g, "").slice(0, 40));
  check("条数取自真实链", new RegExp("累计 <b>" + AUD.chain.total + "</b>").test(bar));
  const items = (list.match(/class="al-item"/g) || []).length;
  check("渲染条目数 = min(12, 公开摘要数)", items === Math.min(12, AUD.entries.length), `${items} vs ${Math.min(12, AUD.entries.length)}`);
  check("快照噪声不对外展示", !/config\.snapshot/.test(list));
  check("人工/自动两类 actor 有区分", /人工操作/.test(list) && /自动记录/.test(list));
  check("每条带链上哈希前缀", /#[0-9]+ · [0-9a-f]{16}/.test(list));
  check("无 undefined / NaN 漏字", !/undefined|NaN/.test(list + bar));
  check("不显示任何密钥", !/sk-[A-Za-z0-9]{8,}/.test(list));

  console.log("\n【method.html ⑥ 审计区块 · 取不到数据态】");
  const B = buildCtx(() => Promise.reject(new Error("404")));
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  const list2 = B.captured["al-list"] || "";
  check("降级为空态而非编造记录", /尚未生成/.test(list2) && !/al-item/.test(list2), list2.replace(/<[^>]+>/g, " ").slice(0, 40));
  check("降级时链状态同步改口", /暂无可校验记录/.test(B.captured["al-chain-txt::text"] || ""), B.captured["al-chain-txt::text"]);

  console.log("\n【商业信息来源披露(方法页静态文案)】");
  const page = fs.readFileSync(DIR + "method.html", "utf8");
  check("方法页说明商业信息不可探测且分两档来源", /商业信息分两档来源/.test(page) && /没有任何探测路径能验证/.test(page));
  check("人工核实档明确「不是站方承诺」并给出充值前动作", /标 ※ 的内容不是站方承诺/.test(page) && /收银台实时显示为准/.test(page));
  check("未取得字段一律未声明,不猜不占位", /不猜、不留灰位/.test(page));

  console.log(`\n${fail === 0 ? "✓ 全部通过" : "✗ 有失败"} · ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
