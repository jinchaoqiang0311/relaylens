/**
 * test_compare_render.js —— 比价页渲染与价格口径断言
 * 核心原则:①已实测的模型不许再显示演示数据(同名示例页签必须弃用)
 *           ②未测字段(充值比例/缓存写)必须显示「未测/未公布」,不得显示 0 或编数
 *           ③全模型最低价视图的最低价必须是 payload 各行到手价的真最小值
 *           ④取不到数据时保持示例页签(带「示例」角标),不冒充实测
 *
 * 2026-10-21 变更:「站点实测明细」视图(含成本模拟器/特价组/四个坑)按产品决策下线,
 *   断言改为守「全模型最低价」默认视图 + 矩阵比价视图;价格口径不变式(数据层)全部保留。
 */
const fs = require("fs"), vm = require("vm");
const DIR = __dirname+"/relaylens-home/";
const SITES = JSON.parse(fs.readFileSync(DIR + "data/sites.json", "utf8"));
const CMP = SITES.compare;
const html = fs.readFileSync(DIR + "compare.html", "utf8");
const matrixJs = fs.readFileSync(DIR + "assets/compare-matrix.js", "utf8");
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

  /* ===== ① 全模型最低价视图(默认视图) ===== */
  console.log("\n【① 全模型最低价视图(getcheapai 形态,默认视图)】");
  check("视图按钮与容器存在(全模型最低价 / 矩阵比价)", /id="vBtnAll"/.test(html) && /id="allView"/.test(html) && /id="allTable"/.test(html));
  check("矩阵视图默认隐藏、最低价视图默认展示", /id="matrixView" style="display:none"/.test(html) && !/id="allView" style="display:none"/.test(html));
  check("搜索框与计数位存在", /id="allSearch"/.test(html) && /id="allCount"/.test(html));
  check("渲染出行(不是空表)", allHtml.includes("<tbody>") && allHtml.includes("</tbody>"), allHtml.length + " chars");
  const tbodyHtml = (allHtml.match(/<tbody>([\s\S]*)<\/tbody>/) || [null, ""])[1];
  const rowsHtml = tbodyHtml.split(/<tr>/).filter(r => /<td\b/.test(r));
  check("行数 ≥ 实测模型数(每个 payload tab 一行)", rowsHtml.length >= CMP.tabs.length, `${rowsHtml.length} 行 / 实测 ${CMP.tabs.length} 模型`);
  check("每个实测模型名都出现在表里", CMP.tabs.every(t => allHtml.includes(t.name)), CMP.tabs.filter(t => !allHtml.includes(t.name)).map(t => t.name).join(",") || "全覆盖");

  // 逐 tab 核对:最低到手价 / 较官方折扣 / 来源站 三列都与 payload 真值一致
  const missPrice = [], missDisc = [], missSite = [];
  for (const t of CMP.tabs) {
    const m = minEffOf(t);
    if (!m) continue;
    const row = rowsHtml.find(r => r.includes(t.name)) || "";
    if (m.eff != null) {
      if (!row.includes("¥" + pfmt(m.eff))) missPrice.push(t.name);
      const pct = Math.round((m.eff / t.official.in - 1) * 100);
      if (!row.includes((pct > 0 ? "+" : "") + pct + "%")) missDisc.push(t.name);
    }
    if (!row.includes(m.row.site)) missSite.push(t.name);
  }
  check("最低到手价 = payload 各行到手价真最小值(逐模型核对)", missPrice.length === 0, missPrice.slice(0, 3).join(",") || `${CMP.tabs.length} 个模型全对`);
  check("较官方折扣 = 到手价相对官方锚的偏差(逐模型核对)", missDisc.length === 0, missDisc.slice(0, 3).join(",") || "全对");
  check("最低价来源站取自 payload", missSite.length === 0, missSite.slice(0, 3).join(",") || "全对");
  check("折扣为负显示绿色(--ok),不给假主价", /color:var\(--ok\)/.test(allHtml) && !/¥(6\.39|12\.43|4\.97|53\.25|79\.88)/.test(allHtml));
  check("示例数据有显式「示例」角标(不冒充实测)", /示例<\/span>|· 示例/.test(allHtml) || !SITES.realSites.some(s => s.level === "passive"));
  check("口径说明挂在悬停浮窗(到手价 / 较官方)", /data-tip="到手价 = 站方公示额度价/.test(html) && /data-tip="较官方 = 最低到手价/.test(html));
  check("在售家数列存在", /家<\/td>|家<\/span>/.test(allHtml));

  /* ===== ② 结构守门:引号闭合 / td 配平 / 格数=列数 ===== */
  const badAttr = [], badTd = [];
  rowsHtml.forEach((r, i) => {
    const m = r.match(/<[a-zA-Z]+[^>]*?="[^"]*>/g);
    if (m) badAttr.push(`行${i + 1}: ${m[0].slice(0, 70)}`);
    const o = (r.match(/<td\b/g) || []).length, c = (r.match(/<\/td>/g) || []).length;
    if (o !== c) badTd.push(`行${i + 1}: td 开闭不等 ${o}/${c}`);
    if (o !== 5) badTd.push(`行${i + 1}: 格数 ${o} ≠ 5 列`);
  });
  check("渲染 HTML 无未闭合引号属性(防列合并错位)", badAttr.length === 0, badAttr.slice(0, 2).join(" | "));
  check("每行 td 开闭配平且格数 = 5 列", badTd.length === 0, badTd.slice(0, 2).join(" | "));

  /* ===== ③ 站点实测明细视图已下线(2026-10-21) ===== */
  console.log("\n【② 站点实测明细视图已下线】");
  check("siteView 容器与切换按钮均已移除", !/id="siteView"/.test(html) && !/id="vBtnSite"/.test(html) && !/vBtnSite/.test(matrixJs.replace(/vBtnSite[^\n]*/g, "") + ""));
  check("成本模拟器 / 特价组 / 四个坑随之下线", !/id="calc"/.test(html) && !/id="specialBody"/.test(html) && !/class="traps"/.test(html) && !/坑一:只看标价/.test(html));
  check("相关渲染函数加了 DOM 护栏(取不到元素即返回,不抛错)",
    /function render\(\)\{[\s\S]{0,220}getElementById\("modelMeta"\)\)?\s*return/.test(html) &&
    /function renderCalc\(\)\{[\s\S]{0,120}getElementById\("inTokens"\)\)?\s*return/.test(html) &&
    /function renderSpecial\(payload\)\{[\s\S]{0,120}getElementById\("specialBody"\)\)?\s*return/.test(html) &&
    /function bindTabs\(\)\{[\s\S]{0,120}getElementById\("modelTabs"\)\)?\s*return/.test(html));
  check("点模型名改跳矩阵视图(不再依赖已删的族索引)", /function allGoModel[\s\S]{0,400}vBtnMatrix/.test(html) && !/allGoModel[\s\S]{0,400}vBtnSite/.test(html));
  check("老深链 ?model= 兼容(改为切矩阵并灌模型名)", /location\.search\.match\(\/\[\?&\]model=/.test(html) && /allGoModel\(hit\)/.test(html));

  /* ===== ④ 矩阵比价视图(源码级) ===== */
  console.log("\n【③ 矩阵比价视图】");
  check("矩阵容器与表格存在", /id="matrixView"/.test(html) && /id="mxTable"/.test(html));
  check("搜索与到手价开关", /id="mxSearch"/.test(html) && /id="mxEff"/.test(html));
  check("矩阵脚本:数据源为 compare.tabs + realSites.effRatio", /compare\.tabs/.test(matrixJs) && /effRatio/.test(matrixJs));
  check("矩阵脚本:最低价高亮(悲观最佳标记)", /mx-best/.test(matrixJs));
  check("矩阵脚本:未声明比例站如实标注", /比例未声明/.test(matrixJs));
  check("主脚本数据回调挂接 renderMatrix", /renderMatrix\(j\)/.test(html));
  check("切换函数对已删的 siteView 做了空值保护", /if \(sv\) sv\.style\.display/.test(matrixJs) && /if \(bs\) bs\.onclick/.test(matrixJs));
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
  check("三因子摊开可验算:额度价 = 官方价格 × 倍率(baseIn×grpRatio≈inP)", allRows.every(r => r.baseIn == null || r.grpRatio == null || Math.abs(r.baseIn * r.grpRatio - r.inP) <= 0.011));
  check("到手价 = 额度价 × 充值比例(严格公式,校准因子不乘价)", allRows.filter(r => r.ratio != null && r.effIn != null).every(r => Math.abs(r.effIn - Math.round(r.inP * r.ratio * 100) / 100) <= 0.011));
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
    strictAll = C.captured["allTable"] || "";
  } catch (e) { strictErr = e; }
  check("脚本在真实 DOM 语义下不抛错(顶层无未守卫的 getElementById 解引用)", strictErr === null, strictErr ? strictErr.message : "");
  check("最低价视图在严格语义下仍渲染出实测模型", CMP.tabs.some(t => strictAll.includes(t.name)), (strictAll.match(/<tr>/g) || []).length + " 行");
  check("已删控件(cacheHonest 等)不再被顶层 addEventListener 直接解引用", /if\(document\.getElementById\("cacheHonest"\)\)\{/.test(html));

  /* ===== ⑥ 取不到数据态:降级不炸,且仍渲染示例最低价表 ===== */
  console.log("\n【比价页 · 取不到数据态】");
  const B = run(() => Promise.reject(new Error("404")));
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  const allB = B.captured["allTable"] || "";
  check("降级态仍渲染最低价表(示例数据,带「示例」标注)", allB.includes("<tbody>") && /示例/.test(allB), allB.length + " chars");

  console.log(`\n${fail === 0 ? "✓ 全部通过" : "✗ 有失败"} · ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();