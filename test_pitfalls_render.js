/**
 * test_pitfalls_render.js —— 避坑指南页渲染与诚实性断言
 * 钉三件事:①六个案例位全部数据驱动(数字必须等于 sites.json 现值,页面内不硬编码站名/数值)
 *          ②措辞守口径(复核信号≠定论,含站方干扰的免责只在数据有 note 时出现)
 *          ③取数失败时显示「暂无实测」而不是编造;结构守卫同款
 * 另测:③compare ?model= 深链与首页模型入口的源码契约。
 */
const fs = require("fs"), vm = require("vm");
const DIR = __dirname+"/relaylens-home/";
const src = fs.readFileSync(DIR + "pitfalls.html", "utf8");
const DATA = JSON.parse(fs.readFileSync(DIR + "data/sites.json", "utf8"));

let pass = 0, fail = 0;
const check = (n, c, d) => { (c ? pass++ : fail++); console.log(`  ${c ? "✓" : "✗"} ${n}${d ? " · " + d : ""}`); };

function makeDom() {
  const els = {};
  const el = id => els[id] || (els[id] = { id, style: {}, innerHTML: "", textContent: "", className: "", addEventListener() {} });
  const doc = { getElementById: el, createElement: () => el("a" + Math.random()), addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, body: el("body"), readyState: "complete" };
  return { doc, el, els };
}
function load(fetchImpl) {
  const { doc, els } = makeDom();
  const ctx = { document: doc, console, Math, JSON, Date, String, Number, Array, Object, RegExp, Error, Promise, isNaN, parseInt, parseFloat, Infinity, setTimeout, clearTimeout, fetch: fetchImpl };
  vm.createContext(ctx);
  vm.runInContext(src.match(/<script>([\s\S]*)<\/script>/)[1], ctx);
  return { ctx, els };
}
const okFetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(DATA) });
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  /* ---- 静态结构 ---- */
  console.log("【静态结构】");
  check("六个案例位齐备", ["case-swap", "case-stream", "case-inject", "case-price", "case-avail", "case-cache"].every(id => src.includes('id="' + id + '"')));
  check("每类陷阱有识别方法块", (src.match(/class="detect"/g) || []).length === 6);
  check("无硬编码站名(页面正文不出现 aicost/fluxionai/wolfai)", !/(aicost|fluxionai|wolfai|aixoras|jiuqingyun)/.test(src.replace(/data\/sites\.json/g, "")));
  check("无硬编码实测数字(84/62.3/4858/3959/33.3 等)", !/\b(62\.3|84\.5|4858|3959|33\.3|31\.9)\b/.test(src));
  check("含案例声明(疑似非定论/可申诉/可能已整改/匿名声明)", /复核信号而非定论/.test(src) && /申诉通道/.test(src) && /可能已经改好/.test(src) && /案例一律匿名/.test(src));
  check("引流自测工具箱/榜单/比价看板(比价走规范挂载路径 /price/)",
    /tools.html#selftest/.test(src) && /ranking\.html/.test(src) && /href="\/price\//.test(src) && !/href="selftest\.html"/.test(src));
  check("假流式教学含「短答案测不出来」口径", /回短话也是一次到齐|测不出来/.test(src) && /200~300 字/.test(src));
  check("价格陷阱含「比例和单价是一套组合拳」", /兑换比例和?单价是一套|比例与?单价是一套/.test(src));

  /* ---- 渲染(真实数据) ---- */
  console.log("【案例位数据驱动(渲染级)】");
  const { els } = load(okFetch);
  await wait(30);
  const R = DATA.realSites;
  const failSite = R.filter(s => s.fp === "fail" && s.fpDetail && typeof s.fpDetail.similarity === "number").sort((a, b) => a.fpDetail.similarity - b.fpDetail.similarity)[0];
  const mixed = R.filter(s => typeof s.stream === "number" && s.stream > 0 && s.stream < 100)[0];
  const topInj = R.filter(s => typeof s.inject === "number" && s.inject > 200).sort((a, b) => b.inject - a.inject)[0];
  const topTo = R.filter(s => typeof s.timeout === "number" && s.timeout > 0).sort((a, b) => b.timeout - a.timeout)[0];
  const honest = R.filter(s => s.audit && s.audit.matchPct === 100 && s.audit.verified > 0);

  if (failSite) check("掉包案例=相似度数值在、站名不在(匿名)", els["case-swap"].innerHTML.includes(failSite.fpDetail.similarity + "%") && !els["case-swap"].innerHTML.includes(failSite.name), failSite.fpDetail.similarity + "% 已匿名");
  else check("掉包案例:无判负站则显示暂无", /暂无实测|尚无/.test(els["case-swap"].innerHTML));
  check("掉包案例:note 存在才提网关拦截", (failSite && failSite.fpDetail.note) ? /网关|拦截/.test(els["case-swap"].innerHTML) : !/内容审计/.test(els["case-swap"].innerHTML));

  if (mixed) check("流式案例=伪流占比在、站名不在", els["case-stream"].innerHTML.includes(mixed.stream + "%") && !els["case-stream"].innerHTML.includes(mixed.name), mixed.stream + "% 已匿名");
  // 数据驱动:存在混合/伪流站时案例须含缓冲等待区间;没有时须如实显示"暂无"
  const mixedArr = R.filter(s => typeof s.stream === "number" && s.stream > 0 && s.stream < 100);
  const fakeArr = R.filter(s => s.stream === 100);
  if (mixedArr.length || fakeArr.length) check("流式案例含缓冲实测首字区间(文字性表述)", /26~54|数十秒/.test(els["case-stream"].innerHTML));
  else check("无伪流站时如实显示暂无", /没发现憋整段/.test(els["case-stream"].innerHTML));

  if (topInj) check("注入案例=注入数值在、站名不在", els["case-inject"].innerHTML.includes(String(topInj.inject)) && !els["case-inject"].innerHTML.includes(topInj.name), "+" + topInj.inject + " 已匿名");

  if (topTo) check("超时案例=超时率在、站名不在", els["case-avail"].innerHTML.includes(topTo.timeout + "%") && !els["case-avail"].innerHTML.includes(topTo.name), topTo.timeout + "% 已匿名");
  else check("超时案例:无显著超时→暂无", /暂无实测|未发现/.test(els["case-avail"].innerHTML));

  check("对账案例:笔数真实且全部匿名", honest.length ? String(honest.every(h => !els["case-cache"].innerHTML.includes(h.name))) === "true" && honest.every(h => els["case-cache"].innerHTML.includes(String(h.audit.verified))) : /暂无/.test(els["case-cache"].innerHTML), honest.map(h => h.audit.verified).join("/") + " 笔");
  check("数据更新时间戳渲染", /数据更新于/.test(els["dataAt"].textContent), els["dataAt"].textContent);
  console.log("【全局匿名】");
  const allNames = R.map(s => s.name).filter(Boolean);
  const renderedAll = ["case-swap","case-stream","case-inject","case-price","case-avail","case-cache"].map(id => els[id].innerHTML).join(" ");
  check("六个案例位渲染后不含任何在营站名", !allNames.some(n => renderedAll.includes(n)));
  const anyHard = ["62.3", "4858", "33.3%"].filter(x => els["case-swap"].innerHTML.includes(x) && !String(failSite && failSite.fpDetail.similarity).startsWith(x.replace("%", "")));
  check("渲染值与数据源一致(无越界旧数)", anyHard.length === 0, anyHard.join(","));

  /* ---- 取数失败诚实降级 ---- */
  console.log("【降级诚实性】");
  const bad = load(() => Promise.reject(new Error("offline")));
  await wait(30);
  check("断网:案例位全部「暂无实测」,不出任何站名/数字", ["case-swap", "case-stream", "case-inject", "case-price", "case-avail", "case-cache"].every(id => /暂无实测/.test(bad.els[id].innerHTML)));

  /* ---- ③ 深链与入口契约 ---- */
  console.log("【模型直达:深链与首页入口】");
  /* compare.html 已于 2026-10-28 下线;单模型直达由看板 #cmp: 深链承担,
     pitfalls 的价格陷阱案例从 compare.html?model=gpt-5-6-sol 改为看板深链(规范名用点号 gpt-5.6-sol)。 */
  check("价格陷阱案例链到看板单模型对比(#cmp:gpt-5.6-sol)", /href="\/price\/#cmp:gpt-5\.6-sol"/.test(src));
  const idx = fs.readFileSync(DIR + "index.html", "utf8");
  check("首页含模型选择控件(源自 compare.tabs)", /id="model-select"/.test(idx) && /compare\.tabs/.test(idx));
  check("首页按所选模型取价读 effIn(人民币到手价)", /r\.effIn/.test(idx) && /priceFor/.test(idx));
  check("首页保留进入模型比价看板入口", /href="\/price\/"/.test(idx));
  check("首页模型数据缺失时给占位而非崩溃", /暂无报价数据/.test(idx));

  /* ---- 结构守卫(只看静态 HTML:JS 字符串拼接里的 class="…" 不算渲染产物) ---- */
  const staticHtml = src.replace(/<script>[\s\S]*?<\/script>/g, "").replace(/<style>[\s\S]*?<\/style>/g, "");
  check("静态标记无未闭合引号属性", !/<[a-zA-Z]+[^>]*?="[^"]*>/.test(staticHtml));
  /* 渲染产物守卫:六个案例的 innerHTML 拼出来的标签必须闭合(引号成对/无吞掉的 td) */
  const rendered = Object.keys(els).map(k => String(els[k].innerHTML || "")).join("");
  check("渲染产物无未闭合引号属性", !/<[a-zA-Z]+[^>]*?="[^"]*>/.test(rendered));

  console.log(`\n${fail === 0 ? "✓ 全部通过" : "✗ 有失败"} · ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
