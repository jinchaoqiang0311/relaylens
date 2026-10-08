/**
 * test_onboarding_render.js —— 入驻/认领页渲染与 schema 合规断言
 * 关键:表单生成的 payload 必须符合 shared/onboarding.schema.json(七件事的数据地基),
 * 校验逻辑必须真的拦截(空表单/坏邮箱/未勾额度规则都要 fail,不能带病提交)。
 */
const fs = require("fs"), vm = require("vm");
const DIR = "C:/Users/Administrator/.qwenworkcn/workspace/mugbtmedrrtj5xkw/relaylens-home/";
const SCHEMA = JSON.parse(fs.readFileSync("C:/Users/Administrator/.qwenworkcn/workspace/mugbtmedrrtj5xkw/relaylens/shared/onboarding.schema.json", "utf8"));

function runPage(file, formValues, submitId) {
  const html = fs.readFileSync(DIR + file, "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");
  const captured = {}, texts = {}, values = Object.assign({}, formValues);
  const checked = {}, handlers = {};
  const mk = id => {
    const n = {
      id, style: {}, className: "", children: [], href_: "",
      classList: { add(c) { n.className += " " + c }, remove(c) { n.className = n.className.split(" ").filter(x => x !== c).join(" ") }, toggle() {}, contains: () => false },
      appendChild() {}, addEventListener(ev, fn) { handlers[id + "::" + ev] = fn },
      setAttribute() {}, getAttribute: () => "", querySelector: () => mk("_q"), querySelectorAll: sel => sel.includes("input:checked")
        ? Object.keys(checked).filter(k => checked[k]).map(k => ({ value: k })) : [],
      insertBefore() {}, firstChild: {}, open() {},
    };
    Object.defineProperty(n, "innerHTML", { get: () => captured[id] || "", set(v) { captured[id] = String(v) } });
    Object.defineProperty(n, "textContent", { get: () => texts[id] || "", set(v) { texts[id] = String(v) } });
    Object.defineProperty(n, "value", { get: () => values[id] || "", set(v) { values[id] = v } });
    Object.defineProperty(n, "checked", { get: () => !!checked[id], set(v) { checked[id] = v } });
    Object.defineProperty(n, "href", { get: () => n.href_, set(v) { n.href_ = v } });
    return n;
  };
  const ctx = {
    document: {
      getElementById: mk, querySelector: () => mk("_d"),
      // 页面用 querySelectorAll("#fDirs input:checked") 收集勾选方向;须按作用域过滤,
      // 否则 fQuota 等元素勾选会混进方向列表(真实浏览器按选择器作用域返回)
      querySelectorAll: sel => sel.includes("input:checked") && sel.includes("fDirs")
        ? Object.keys(checked).filter(k => checked[k] && !/^f[A-Z]/.test(k)).map(k => ({ value: k })) : [],
      createElement: () => mk("_c"), addEventListener() {}, title: "",
    },
    location: { search: "", href: "" }, navigator: { clipboard: null },
    console: { log() {}, warn() {}, error() {} }, window: {},
    Math, JSON, Date, String, Number, Array, Object, RegExp, Error, encodeURIComponent, decodeURIComponent,
    setTimeout: () => 0, clearTimeout() {}, fetch: () => new Promise(() => {}),
  };
  vm.runInContext(scripts, vm.createContext(ctx));
  const fire = (id, ev) => {
    const fn = handlers[id + "::" + (ev || "click")];
    if (!fn) throw new Error("no handler: " + id);
    fn();
  };
  if (submitId) fire(submitId, "click");
  return { captured, texts, values, checked, fire };
}

let pass = 0, failN = 0;
const check = (n, c, d) => { (c ? pass++ : failN++); console.log(`  ${c ? "✓" : "✗"} ${n}${d ? " · " + d : ""}`); };

(async () => {
  console.log("\n【onboarding.html · schema 合规】");
  const OK = {
    fName: "测试站 Alpha", fDomain: "https://alpha.example.com",
    fPrimary: "claude-kiro渠道 | claude-opus-5, claude-sonnet-5 | 倍率\ntest-tier | gpt-5.5 | 阶梯",
    fSpecial: "特价Claude | claude-opus-5 | 倍率",
    fEmail: "ops@alpha.example.com", fTg: "@alpha", fNotes: "",
    fPay: "支付宝 / USDT", fRatio: "1$=¥7.2", fMinTopUp: "¥10", fInvoice: "增值税普票", fRefund: "未消费可退",
  };
  // 用合法值直接构造上下文:先设勾选,再触发提交(页面经 textContent 输出 payload)
  const A = runPage("onboarding.html", OK);
  A.checked["fQuota"] = true; A.checked["text"] = true;
  A.fire("fSubmit");
  let payload = null;
  if (A.texts["fJson"]) payload = JSON.parse(A.texts["fJson"]);

  check("生成 payload(合法输入通过校验)", !!payload, payload ? "" : "提交未产出");
  if (payload) {
    check("schema 版本标记 = " + SCHEMA.version, payload.schema === "relaylens-onboarding/" + SCHEMA.version, payload.schema);
    check("status=applied", payload.status === "applied");
    check("域名规整(去尾斜杠)", payload.domain === "https://alpha.example.com", payload.domain);
    check("directions 含已选值", Array.isArray(payload.directions) && payload.directions.includes("text"), JSON.stringify(payload.directions));
    check("分组解析:主力 2 组 + 特价 1 组", payload.declared_groups.length === 3, JSON.stringify(payload.declared_groups.map(g => g.name + ":" + g.tier)));
    const t = payload.declared_groups.find(g => g.name === "test-tier");
    check("计费模式识别(阶梯)", t && t.billing === "tiered");
    check("模型列表拆分", payload.declared_groups[0].models.length === 2);
    check("额度规则已确认落档", payload.accept_quota_rules === true);
    check("联系结构化", payload.contact.email === OK.fEmail && payload.contact.tg === "@alpha");
    check("商业声明进入 payload(schema commerce)", payload.commerce && payload.commerce.recharge_ratio === OK.fRatio && Array.isArray(payload.commerce.pay_methods), JSON.stringify(payload.commerce));
  }

  console.log("\n【onboarding.html · 校验拦截】");
  // 空表单:不应产出 payload,且错误提示可见
  const B = runPage("onboarding.html", {}, "fSubmit");
  check("空表单被拦截(无 payload)", !B.captured["fJson"]);
  check("拦截给出原因", /请填写站点名称/.test(B.texts["fErr"] || ""), (B.texts["fErr"] || "").slice(0, 30));
  // 缺额度勾选
  const C = runPage("onboarding.html", Object.assign({}, OK, { }), "fSubmit");
  C.checked["text"] = true;
  check("未勾额度规则被拦截", !C.captured["fJson"], (C.texts["fErr"] || "").slice(0, 30));

  console.log("\n【claim.html】");
  const D = runPage("claim.html", { cDomain: "https://alpha.example.com/", cEmail: "a@alpha.example.com", cReason: "申诉 09-29 偏差" }, "cSubmit");
  let claim = null; if (D.texts["cJson"]) claim = JSON.parse(D.texts["cJson"]);
  check("生成认领 payload", !!claim);
  if (claim) {
    check("schema 标记正确", claim.schema === "relaylens-claim/" + SCHEMA.version);
    check("域名去尾斜杠", claim.site_domain === "https://alpha.example.com", claim.site_domain);
    check("状态 claim_requested", claim.status === "claim_requested");
  }
  const E = runPage("claim.html", { cDomain: "not-a-url", cEmail: "bad" }, "cSubmit");
  check("坏域名/坏邮箱被拦截", !E.captured["cJson"]);

  console.log("\n【两页静态断言】");
  const obHtml = fs.readFileSync(DIR + "onboarding.html", "utf8");
  const clHtml = fs.readFileSync(DIR + "claim.html", "utf8");
  check("入驻页展示两阶段(阶段二预览可见)", /阶段二 · 受理后需要什么/.test(obHtml) && /API 端点/.test(obHtml));
  check("额度规则三条件完整呈现", /指定(的)?测试账号/.test(obHtml) && /不低于 ¥10/.test(obHtml) && /仅用于(公开)?评测/.test(obHtml));
  check("特价分组说明(不进主评分)", /特价榜/.test(obHtml) && /不进主评分/.test(obHtml));
  check("声明-检测-验证体系表述", /按声明定制检测矩阵|按声明定制/.test(obHtml));
  check("认领页域名验证为硬门槛", /relaylens-verify\.txt/.test(clHtml) && /防冒领/.test(clHtml));
  check("认领页写明不影响评分", /不影响.*评分|不改变任何检测口径/.test(clHtml));

  console.log(`\n${failN === 0 ? "✓ 全部通过" : "✗ 有失败"} · ${pass} 通过 / ${failN} 失败`);
  process.exit(failN ? 1 : 0);
})();
