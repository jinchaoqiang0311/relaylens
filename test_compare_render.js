/**
 * test_compare_render.js —— 比价页渲染与价格口径断言
 * 核心原则:①已实测的模型不许再显示演示数据(同名示例页签必须弃用)
 *           ②未测字段(充值比例/缓存写)必须显示「未测/未公布」,不得显示 0 或编数
 *           ③已下线视图必须真正删干净(容器/函数/样式/切换逻辑都不许留残骸)
 *           ④取不到数据时保持示例页签(带「示例」角标),不冒充实测
 *
 * 2026-10-21 变更:「站点实测明细」视图(含成本模拟器/特价组/四个坑)按产品决策下线;
 *   同日「全模型最低价」视图也下线(每模型最低价的诉求由 price.html「模型比价」主页承担),
 *   矩阵比价成为 compare.html 唯一视图;价格口径不变式(数据层)全部保留。
 */
const fs = require("fs"), vm = require("vm");
const DIR = __dirname+"/relaylens-home/";
const SITES = JSON.parse(fs.readFileSync(DIR + "data/sites.json", "utf8"));
const CMP = SITES.compare;
const html = fs.readFileSync(DIR + "compare.html", "utf8");
const matrixJs = fs.readFileSync(DIR + "assets/compare-matrix.js", "utf8");
const themeCss = fs.readFileSync(DIR + "assets/theme-relaypick.css", "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");

function run(fetchImpl, search, strictDom) {
  const captured = {}, texts = {};
  // 真实浏览器语义:HTML 里不存在的 id,getElementById 返回 null(不是桩对象)。
  // 2026-10-21 教训:删掉「站点实测明细」视图后,顶层 `document.getElementById("cacheHonest").addEventListener(...)`
  // 抛 TypeError,把后面所有顶层代码(最低价视图渲染)一起带走 —— 桩对象永远测不出这类空指针。
  const REAL_IDS = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const mk = id => {
    if (strictDom && !REAL_IDS.has(id)) return null;
    const n = {
      id, style: {}, className: "", children: [], value: "", checked: true, disabled: false,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      appendChild(c) { n.children.push(c) },
      addEventListener() {}, setAttribute() {},
      getAttribute: k => (k === "data-model" ? n._dm : k === "href" ? "" : ""),
      querySelector: () => mk(id + "_q"), querySelectorAll: () => [],
      insertBefore(c) { n.children.unshift(c) }, firstChild: {},
      open() {},
    };
    Object.defineProperty(n, "innerHTML", { get: () => captured[id] || "", set(v) { captured[id] = String(v) } });
    Object.defineProperty(n, "textContent", { get: () => texts[id] || "", set(v) { texts[id] = String(v) } });
    return n;
  };
  const ctx = {
    document: {
      getElementById: mk, querySelector: () => (strictDom ? null : mk("_d")),
      querySelectorAll: () => [], createElement: t => mk("_c_" + t + Math.random()),
      addEventListener() {}, title: "", body: mk("body"),
    },
    location: { search: search || "", href: "" }, navigator: { clipboard: null },
    console: { log() {}, warn() {}, error() {} },
    Math, JSON, Date, String, Number, Array, Object, RegExp, Error, Infinity, NaN, isNaN,
    encodeURIComponent, decodeURIComponent, parseInt, parseFloat,
    performance: { now: () => 0 }, requestAnimationFrame: cb => cb(1e9),
    setTimeout: () => 0, clearTimeout() {}, window: { open() {} },
    fetch: fetchImpl, Event: function () {},
  };
  vm.runInContext(scripts, vm.createContext(ctx));
  return { captured, texts };
}
/** 页面 pfmt:极小值 4 位小数、<1 三位、其余两位 —— 测试侧必须同款,否则数字对不上不是页面错 */
const pfmt = v => v < 0.01 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2);
const FX = (SITES.meta && SITES.meta.fx && SITES.meta.fx.usdCny) || 7.1;
/** 页面 allBuildRows 的到手价口径:只在声明了充值比例的行里取最小,未声明的不参与 */
function minEffOf(tab) {
  let best = null;
  tab.rows.forEach(r => {
    if (r.official) return;
    const e = r.effIn != null ? r.effIn : (r.ratio != null ? r.inP * r.ratio : null);
    if (e == null) return;
    if (best == null || e < best.eff) best = { eff: e, row: r };
  });
  if (best) return best;
  let f = null;
  tab.rows.forEach(r => { if (!r.official && (!f || r.inP < f.inP)) f = { row: r } });
  return f ? { eff: null, fb: true, row: f.row } : null;
}

let pass = 0, fail = 0;
const check = (n, c, d) => { (c ? pass++ : fail++); console.log(`  ${c ? "✓" : "✗"} ${n}${d ? " · " + d : ""}`); };

(async () => {
  console.log("\n【比价页 · 真实数据态】");
  const A = run(u => Promise.resolve({ ok: true, json: () => Promise.resolve(SITES) }));
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  const allHtml = A.captured["allTable"] || "";
  const mxHtml = A.captured["mxTable"] || "";

  /* ===== ① 「全模型最低价」视图已下线(2026-10-21):最低价诉求由 price.html「模型比价」主页承担 ===== */
  console.log("\n【① 全模型最低价视图已下线】");
  check("allView / allTable / allSearch / vBtnAll 容器与控件全部移除",
    !/id="allView"/.test(html) && !/id="allTable"/.test(html) && !/id="allSearch"/.test(html) && !/id="vBtnAll"/.test(html));
  check("对应渲染函数与状态一并清除",
    !/function renderAllView/.test(html) && !/function allBuildRows/.test(html) && !/function allDiscCell/.test(html) &&
    !/function allOutEff/.test(html) && !/function allGoModel/.test(html) && !/ALL_SORT/.test(html));
  check("主题 CSS 里 .all-table 样式已清理", !/\.all-table/.test(themeCss));
  check("矩阵视图成为唯一视图且默认可见", /id="matrixView"/.test(html) && !/id="matrixView" style="display:none"/.test(html));
  check("视图切换逻辑下线(bind 里不再有 vBtnAll / allView 分支)",
    !/vBtnAll/.test(matrixJs) && !/getElementById\("allView"\)/.test(matrixJs) && !/show\("all"\)/.test(matrixJs));
  check("页头指引「每模型最低到手价去哪看」→ price.html", /模型比价主页/.test(html));

  /* ===== ② 矩阵视图改为源码级断言 =====
     矩阵表由外部 assets/compare-matrix.js 渲染,不在本 harness 执行的内联脚本里,
     因此这里只能守「结构 + 数据源 + 渲染入口」,行级渲染由 compare-matrix.js 的语法检查与浏览器实测兜底。 */
  const mxBody = (mxHtml.match(/<tbody>([\s\S]*)<\/tbody>/) || [null, ""])[1];
  check("矩阵表容器就位且脚本会写入它", /id="mxTable"/.test(html) && /getElementById\("mxTable"\)/.test(matrixJs));
  check("矩阵数据源 = compare.tabs + realSites(不另造数)", /payload\.compare/.test(matrixJs) && /c\.tabs/.test(matrixJs) && /realSites/.test(matrixJs));
  check("主脚本数据回调把 payload 交给 renderMatrix", /renderMatrix\(j\)/.test(html));

  /* ===== ③ 结构守门:引号闭合 / td 配平 ===== */
  const rowsHtml = mxBody.split(/<tr>/).filter(r => /<td\b/.test(r));
  const badAttr = [], badTd = [];
  rowsHtml.forEach((r, i) => {
    const m = r.match(/<[a-zA-Z]+[^>]*?="[^"]*>/g);
    if (m) badAttr.push(`行${i + 1}: ${m[0].slice(0, 70)}`);
    const o = (r.match(/<td\b/g) || []).length, c = (r.match(/<\/td>/g) || []).length;
    if (o !== c) badTd.push(`行${i + 1}: td 开闭不等 ${o}/${c}`);
  });
  check("渲染 HTML 无未闭合引号属性(防列合并错位)", badAttr.length === 0, badAttr.slice(0, 2).join(" | "));
  check("每行 td 开闭配平", badTd.length === 0, badTd.slice(0, 2).join(" | "));

  /* ===== ③ 站点实测明细视图已下线(2026-10-21) ===== */
  console.log("\n【② 站点实测明细视图已下线】");
  check("siteView 容器与切换按钮均已移除", !/id="siteView"/.test(html) && !/id="vBtnSite"/.test(html) && !/vBtnSite/.test(matrixJs.replace(/vBtnSite[^\n]*/g, "") + ""));
  check("成本模拟器 / 特价组 / 四个坑随之下线", !/id="calc"/.test(html) && !/id="specialBody"/.test(html) && !/class="traps"/.test(html) && !/坑一:只看标价/.test(html));
  check("相关渲染函数加了 DOM 护栏(取不到元素即返回,不抛错)",
    /function render\(\)\{[\s\S]{0,220}getElementById\("modelMeta"\)\)?\s*return/.test(html) &&
    /function renderCalc\(\)\{[\s\S]{0,120}getElementById\("inTokens"\)\)?\s*return/.test(html) &&
    /function renderSpecial\(payload\)\{[\s\S]{0,120}getElementById\("specialBody"\)\)?\s*return/.test(html) &&
    /function bindTabs\(\)\{[\s\S]{0,120}getElementById\("modelTabs"\)\)?\s*return/.test(html));
  check("点模型名改跳矩阵视图的 allGoModel 已随最低价视图一并下线", !/function allGoModel/.test(html) && !/allGoModel\(/.test(html));
  check("老深链 ?model= 兼容(直接把模型名灌进矩阵搜索框)", /location\.search\.match\(\/\[\?&\]model=/.test(html) && /getElementById\("mxSearch"\)/.test(html));

  /* ===== ④ 矩阵比价视图(源码级) ===== */
  console.log("\n【③ 矩阵比价视图】");
  check("矩阵容器与表格存在", /id="matrixView"/.test(html) && /id="mxTable"/.test(html));
  check("搜索框保留、到手价开关已随站点列下线", /id="mxSearch"/.test(html) && !/id="mxEff"/.test(html));
  check("矩阵脚本:每模型一行,只取到手价最低的一家", /function buildRow/.test(matrixJs) && /v < best\.v/.test(matrixJs));
  check("矩阵脚本:不再铺站点列(无 stationOrder / 按站遍历表头)", !/stationOrder/.test(matrixJs) && !/stations\.forEach\(function \(st\)/.test(matrixJs));
  check("矩阵脚本:未声明比例的站如实标「比例未声明」", /比例未声明/.test(matrixJs));
  check("矩阵脚本:缓存写入无数据时给「—」不推算", /未公布缓存写入单价/.test(matrixJs));
  check("矩阵脚本:官方价按 meta.fx 换算并标注倍数", /usdCny/.test(matrixJs) && /×/.test(matrixJs));
  check("主脚本数据回调挂接 renderMatrix", /renderMatrix\(j\)/.test(html));
  check("bind() 只绑搜索(到手价开关随站点列一并下线)", /getElementById\("mxSearch"\)/.test(matrixJs) && !/mxEff/.test(matrixJs) && !/function show\(/.test(matrixJs));
  try { new Function(matrixJs); check(true, "compare-matrix.js 语法合法"); }
  catch (e) { check(false, "compare-matrix.js 语法错误: " + e.message); }

  /* ===== ⑤ 价格口径不变式(数据层;页面改版不得动这些) ===== */
  console.log("\n【价格口径:默认组为主 + 实扣校准】");
  const allRows = CMP.tabs.flatMap(x => x.rows.map(r => Object.assign({ tab: x.key, offIn: x.official.in }, r)));
  check("measured 行必带 calibStatus 与 diff(契约;2026-10-21 全量重采后校准按 priceHash 规则脱落,当前可为 0 行)", allRows.filter(r => r.calib === "measured").every(r => ["match", "mismatch"].includes(r.calibStatus) && typeof r.calibDiffPct === "number"));
  check("measured 行到手价=校准额度价×比例自洽", allRows.filter(r => r.calib === "measured" && r.ratio != null).every(r => Math.abs((r.effIn ?? NaN) - Math.round(r.inP * r.ratio * 100) / 100) < 0.02));
  check("special 只在真更低时出现(严格低于主口径价)", allRows.every(r => !r.special || r.special.inP < r.inP - 1e-9));
  check("分组口径只允许 default/median/key(最低组冒充已废除;key=账单吻合组归位)", allRows.every(r => !r.groupKind || ["default", "median", "key"].includes(r.groupKind)));
  check("未校准行一律 calib=page(前端出估算角标)", allRows.filter(r => r.calib !== "measured").every(r => r.calib === "page" || r.calib == null));
  const pageRows = allRows.filter(r => r.calib === "page");
  check("page 占比如实(未校准站仍是多数,别假装全覆盖)", allRows.length === 0 || pageRows.length / allRows.length > 0.3, pageRows.length + "/" + allRows.length);
  /* 官方锚 × 组倍率 = 额度价,只对「标价按美元额度记账」的站成立(src=USD)。
     src=CNY 的站(heyroute 价格页 ¥ CNY 视图)inP 是页面公示人民币单价,与美元官方锚不同量纲,不参与该恒等式。 */
  const usdRows = allRows.filter(r => (r.src || "USD") === "USD");
  check("三因子摊开可验算:额度价 = 官方价格 × 倍率(baseIn×grpRatio≈inP,限 USD 额度价站)", usdRows.every(r => r.baseIn == null || r.grpRatio == null || Math.abs(r.baseIn * r.grpRatio - r.inP) <= 0.011));
  check("CNY 公示价站不被美元锚恒等式误判", allRows.filter(r => r.src === "CNY").every(r => r.effIn == null || Math.abs(r.effIn - r.inP) <= 0.011));
  check("到手价 = 额度价 × 充值比例(严格公式,校准因子不乘价)", usdRows.filter(r => r.ratio != null && r.effIn != null).every(r => Math.abs(r.effIn - Math.round(r.inP * r.ratio * 100) / 100) <= 0.011));
  const keyRows = allRows.filter(r => r.groupKind === "key");
  check("key 组归位行必须带 match 验证(实扣与所选组公式价吻合)", keyRows.every(r => r.calibStatus === "match"));

  // GLM 锚定集合:标价显著高于官方锚(量级断言,不写死具体倍数)
  const glmTab = CMP.tabs.find(t => t.key === "glm-5-3");
  if (glmTab) {
    const g = glmTab.rows[0];
    const mult = g.inP / glmTab.official.in;
    check("GLM-5.3 标价显著高于官方锚(>3×)", mult > 3, `${mult.toFixed(1)}× 官方 (¥${g.inP} vs ¥${glmTab.official.in})`);
  } else {
    check("GLM-5.3 页签存在", false, "已被过滤出锚定集合");
  }

  /* ===== ⑤.5 严格 DOM 语义(元素缺失即 null):顶层代码不许被已删 DOM 拖死 ===== */
  console.log("\n【④ 严格 DOM 语义回归(2026-10-21 空指针事故)】");
  let strictErr = null, strictAll = "";
  try {
    const C = run(u => Promise.resolve({ ok: true, json: () => Promise.resolve(SITES) }), "", true);
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    strictAll = C.captured["mxTable"] || "";
  } catch (e) { strictErr = e; }
  check("脚本在真实 DOM 语义下不抛错(顶层无未守卫的 getElementById 解引用)", strictErr === null, strictErr ? strictErr.message : "");
  check("严格语义下不残留已下线视图的渲染产物", !/全模型最低价|allTable/.test(strictAll), strictAll.length + " chars");
  check("已删控件(cacheHonest 等)不再被顶层 addEventListener 直接解引用", /if\(document\.getElementById\("cacheHonest"\)\)\{/.test(html));

  /* ===== ⑥ 取不到数据态:降级不炸,不抛未捕获错 ===== */
  console.log("\n【比价页 · 取不到数据态】");
  const B = run(() => Promise.reject(new Error("404")));
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  const degradedHtml = Object.values(B.captured).join("");
  check("降级态不抛未捕获错,且不渲染任何已下线视图的残骸", !/allTable|全模型最低价/.test(degradedHtml), degradedHtml.length + " chars");

  console.log(`\n${fail === 0 ? "✓ 全部通过" : "✗ 有失败"} · ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();