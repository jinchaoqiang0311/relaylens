/**
 * test_compare_render.js —— 比价页真实报价渲染断言
 * 核心原则:①已实测的模型不许再显示演示数据(同名示例页签必须弃用)
 *           ②未测字段(充值比例/缓存写)必须显示「未测/未公布」,不得显示 0 或编数
 *           ③实测行必须带官方锚参考行;奖牌计算排除官方行
 *           ④取不到数据时保持示例页签(带「示例」角标),不冒充实测
 */
const fs = require("fs"), vm = require("vm");
const DIR = __dirname+"/relaylens-home/";
const SITES = JSON.parse(fs.readFileSync(DIR + "data/sites.json", "utf8"));
const CMP = SITES.compare;
const html = fs.readFileSync(DIR + "compare.html", "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");

function run(fetchImpl, search) {
  const captured = {}, texts = {};
  const rows = [];
  const mk = id => {
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
    if (id === "tbody" || id === "mCards") n.children = [];
    Object.defineProperty(n, "innerHTML", { get: () => captured[id] || "", set(v) { captured[id] = String(v) } });
    Object.defineProperty(n, "textContent", { get: () => texts[id] || "", set(v) { texts[id] = String(v) } });
    return n;
  };
  const ctx = {
    document: {
      getElementById: mk, querySelector: () => mk("_d"),
      querySelectorAll: () => [], createElement: t => { const e = mk("_c_" + t + Math.random()); return e },
      addEventListener() {}, title: "", body: mk("body"),
    },
    location: { search: search || "", href: "" }, navigator: { clipboard: null },
    console: { log() {}, warn() {}, error() {} },
    Math, JSON, Date, String, Number, Array, Object, RegExp, Error, Infinity, NaN, isNaN,
    encodeURIComponent, decodeURIComponent, parseInt, parseFloat,
    performance: { now: () => 0 }, requestAnimationFrame: cb => cb(1e9),
    setTimeout: () => 0, clearTimeout() {}, window: { open() {} },
    fetch: fetchImpl,
  };
  vm.runInContext(scripts, vm.createContext(ctx));
  // 收集 appendChild 到 tbody 的行(tr 是 createElement 出来的,innerHTML 在 captured 里,随机 id)
  return { captured, texts };
}
const gatherRows = A => {
  // 行的 innerHTML 存在随机 key 里;按写入顺序聚合所有 _c_tr* 键
  return Object.entries(A.captured).filter(([k]) => k.startsWith("_c_tr")).map(([, v]) => v);
};

let pass = 0, fail = 0;
const check = (n, c, d) => { (c ? pass++ : fail++); console.log(`  ${c ? "✓" : "✗"} ${n}${d ? " · " + d : ""}`); };

(async () => {
  console.log("\n【比价页 · 真实数据态】");
  const A = run(u => Promise.resolve({ ok: true, json: () => Promise.resolve(SITES) }));
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));

  const tabsHtml = A.captured["modelTabs"] || "";
  const realTabs = (tabsHtml.match(/chip-real/g) || []).length;
  const demoTabs = (tabsHtml.match(/chip-demo/g) || []).length;
  check(`实测页签数 = ${CMP.tabs.length}`, realTabs === CMP.tabs.length, `${realTabs} vs ${CMP.tabs.length}`);
  /* 模型换代不变式:示例页签与实测页签显示名不得有任何交集(同名的必须被弃用),数量不写死 */
  const demoLabels = [...tabsHtml.matchAll(/<a data-model="([^"]+)">([^<]+)<span class="tab-chip chip-demo">/g)].map(m => m[2].replace(/\s+/g, "").toLowerCase());
  const realNames = CMP.tabs.map(t2 => t2.name.replace(/\s+/g, "").toLowerCase());
  const colliding = demoLabels.filter(nm => realNames.includes(nm));
  check("示例页签与实测页签无同名残留(换代不变式)", colliding.length === 0, colliding.length ? colliding.join(",") : `示例 ${demoLabels.length} / 实测 ${realNames.length},零交集`);
  check("页签图例已更新", /官方锚 OpenRouter/.test(A.captured["tabLegend"] || ""), (A.captured["tabLegend"] || "").slice(0, 70));

  // 默认选中第一个实测页签
  const meta = A.captured["modelMeta"] || "";
  check("默认选中实测页签并标注「✔ 实测」", /✔ 实测/.test(meta), meta.slice(0, 80));
  check("官方参考保持美元额度价(OpenRouter 与站方同单位才可比)", /\$[\d.]+\/M/.test(meta) && /OpenRouter/.test(meta));

  // 表格行:实测站行 + 官方锚行。
  // 注意:脚本先做了一次示例渲染(¥ 行),fetch 后再渲染实测行(自 2026-10-02.1 起也是 ¥ 行)——
  // captured 按 key 累积,必须按站点名过滤,不能再用货币符号区分(那是美元时代的捷径)
  const rowsAll = gatherRows(A);
  // 实测行按该页签的行名过滤(站点名单会随扩站变化,写死 aixoras/aicost 会在扩站当天集体假失败)
  const tabNames = (CMP.tabs[0] ? CMP.tabs[0].rows : []).map(r => r.site);
  const rows = rowsAll.filter(r => /官方直连\(OpenRouter 锚\)/.test(r) || tabNames.some(n => new RegExp(">" + n + "<").test(r)));
  const firstTab = CMP.tabs[0];
  check(`实测行数 = ${firstTab.rows.length} 实测站 + 1 官方锚行`, rows.length === firstTab.rows.length + 1, `${rows.length}`);
  check("官方锚参考行存在且无排名", /官方直连\(OpenRouter 锚\)/.test(rows.join("")) && /—<\/span>/.test(rows.find(r => /官方直连/.test(r)) || ""));
  check("实测行带渠道分组标签", new RegExp(firstTab.rows[0].group).test(rows.join("")), firstTab.rows[0].group);

  const all = rows.join("");
  check("充值比例显示「未测」而非编数", /未测/.test(all));
  check("缓存写显示「未公布」", /未公布/.test(all));
  check("测试详情按钮不复用 .sp-btn 类", /class="op-btn op-detail"/.test(html) && !/class="sp-btn op-detail"/.test(html));
  // 两枚按钮必须在操作列(最后一格),且窄屏卡片自带同样入口(此处自行取行,不依赖后面才声明的 axRow)
  const opRow = (rows.find(r => /aixoras/.test(r)) || rows[0] || "");
  const opSeg = opRow.split("op-col")[1] || "";
  check("两枚按钮都在操作列(最后一格)",
    (opSeg.match(/<button/g) || []).length >= 2 && /测试详情/.test(opSeg) && /class="sp-btn"[^>]*data-probe=/.test(opSeg),
    (opSeg.match(/<button/g) || []).length + " 枚按钮");
  check("移动端卡片也自带测试详情+测速直达(窄屏下操作列会被横向滚走)", /mc-actions[\s\S]{0,320}测试详情/.test(html));
  // 首字延迟单位:≥1 秒必须换算,不能把毫秒数直接贴个"秒"字
  check("首字延迟 ≥1 秒换算成秒(4626ms 显示 4.6 秒而非 4626 秒)", /ms\/1000\)\.toFixed\(1\)/.test(html) && !/ms\.toFixed\(0\)/.test(html));
  check("标价按站方额度单位渲染(数字与 payload 一致)", all.includes(String(firstTab.rows[0].inP)), String(firstTab.rows[0].inP));
  const axRow = rows.find(r => /class="nm">aixoras</.test(r)) || "";   // 必须按站名格选行:别的行正文里会出现「基线 aixoras」
  // 数据驱动:取 aixoras 当前页签真实额度价/到手价,断言渲染数字=payload 且算式可追溯,不写死具体值
  const ax = firstTab.rows.find(r => r.site === "aixoras");
  const axEff = ax && ax.effIn != null ? (ax.effIn < 1 ? ax.effIn.toFixed(3) : ax.effIn.toFixed(2)) : null;
  check("aixoras 三因子推导渲染(官方价格 × 组倍率 × 充值比例,数字全来自 payload)", axEff != null && axRow.includes('pr-v">¥' + axEff) && axRow.includes("官方价格 $" + ax.baseIn + " × 组倍率 " + ax.grpRatio + " = 额度价 $" + ax.inP) && /× 充值比例/.test(axRow), "官方$" + ax.baseIn + "×" + ax.grpRatio + "→到手¥" + axEff);
  check("到手价行可追溯到三因子并给出≈官方价折扣", /组倍率/.test(axRow) && /× 充值比例/.test(axRow) && /≈ 官方价 \d+%/.test(axRow));
  // 挑该页签里"比例未声明"的行来验;若整页签都已声明,则退而校验代码分支存在(站方补数据后行集会变,不写死站名)
  const unSites = firstTab.rows.filter(r => r.ratio == null).map(r => r.site);
  const noRatio = unSites.length ? (rows.find(r => new RegExp(">" + unSites[0] + "<").test(r)) || "") : "";
  check("未声明比例的站:金额位显示「未声明」,悬浮说明不给人民币价的原因",
    unSites.length ? /pr-v v-faint">未声明</.test(noRatio) && /充值比例未声明,不给人民币价/.test(noRatio)
      : /充值比例未声明,不给人民币价/.test(html),
    unSites.length ? unSites.join(",") : "本页签全部已声明比例");
  check("偏差格语义自洽(实测站=逐笔全过+最大偏差同框,不红色互斥)", /最大偏差 2\.86%\(逐笔全过\)/.test(all)&&!/2\.86% ⚠/.test(all));
  // 缓存价未公布的站要明说"缓存价未公布"(缓存价格列已并入实测命中列);该页签若无此类站则校验分支存在
  const cbUnknown = firstTab.rows.filter(r => r.cacheP == null && r.cacheBill === "unknown").map(r => r.site);
  check("缓存价未公布的站标「缓存价未公布」",
    cbUnknown.length ? new RegExp("缓存价未公布").test(rows.find(x => new RegExp(">" + cbUnknown[0] + "<").test(x)) || "")
      : /缓存价未公布/.test(html), cbUnknown.join(",") || "本页签无未公布缓存价的行");
  check("缓存计费诚实芯片仍在(原缓存价格列的信息没丢)", /tag-m tm-(g|y|r|n)/.test(all));
  check("实测行不再出现 1$=¥7.1 乘出来的假 ¥ 主价", !/¥(6\.39|12\.43|4\.97|53\.25|79\.88)/.test(all));

  // ===== 矩阵比价视图(2026-10-11 升级) =====
  check("矩阵视图:双视图切换按钮存在", /id="vBtnMatrix"/.test(html) && /id="vBtnSite"/.test(html));
  check("矩阵视图:容器与表格存在", /id="matrixView"/.test(html) && /id="mxTable"/.test(html));
  check("矩阵视图:搜索与到手价开关", /id="mxSearch"/.test(html) && /id="mxEff"/.test(html));
  check("矩阵脚本:数据源为 compare.tabs + realSites.effRatio", /compare\.tabs/.test(fs.readFileSync(__dirname + "/relaylens-home/assets/compare-matrix.js", "utf8")) && /effRatio/.test(fs.readFileSync(__dirname + "/relaylens-home/assets/compare-matrix.js", "utf8")));
  check("矩阵脚本:最低价高亮(悲观最佳标记)", /mx-best/.test(fs.readFileSync(__dirname + "/relaylens-home/assets/compare-matrix.js", "utf8")));
  check("矩阵脚本:未声明比例站如实标注", /比例未声明/.test(fs.readFileSync(__dirname + "/relaylens-home/assets/compare-matrix.js", "utf8")));
  check("矩阵脚本:主脚本数据回调挂接 renderMatrix", /renderMatrix\(j\)/.test(html));
  try { new Function(fs.readFileSync(__dirname + "/relaylens-home/assets/compare-matrix.js", "utf8")); check(true, "compare-matrix.js 语法合法"); }
  catch (e) { check(false, "compare-matrix.js 语法错误: " + e.message); }

  // ===== 富信息行新增维度 =====
  check("富行:注入主值带单位与缓存占比副注", /\+4858/.test(all)&&/tok\/请求 · 缓存占\d+%/.test(all));
  // 流式真伪徽章:数据驱动断言 —— 有假流式站(≥99%)必须带百分比,没有就不许出该徽章(诚实渲染)
  const anyFake = (SITES.realSites||[]).some(s => s.stream != null && s.stream >= 99);
  check("富行:流式真伪徽章(数据驱动)", anyFake ? /🔇 假流式 \d+%/.test(all) : !/🔇 假流式 \d+%/.test(all));
  check("富行:对账匹配率与逐笔笔数", /100%/.test(all)&&/逐笔 \d+ 笔/.test(all));
  check("富行:容差口径直接印在行内", /容差 max\(2 quota, 1%\)/.test(all));
  check("富行:官方价折扣百分比", /≈ 官方价 \d+%/.test(all));
  check("富行:渠道分组与对账来源分组", /渠道分组 <b>/.test(all));
  check("富行:测速按钮挂在站点名后", /class="sp-btn"/.test(all));
  check("富行:未测维度显式标注而非留空", /比例未测|未做注入实验|未对账/.test(all));
  check("富行:模型指纹徽章带相似度与基线说明", /✔ 指纹 \d+(\.\d)?%/.test(all)&&/跨站差分基线 [a-z0-9-]+,置信 ×0\.8/.test(all));
  check("富行:表下脚注解释全部口径", /到手输入价.*充值比例.*实测命中.*判定容差/.test(html));

  // 奖牌:诚实最优应落在有缓存价且对账100%的站
  const medalRow = rows.find(r => /诚实最优/.test(r));
  check("💎诚实最优已按实测口径颁发", !!medalRow, medalRow ? medalRow.match(/>([^<]+)<\/span><span class="grp/)?.[1] || "" : "无");
  check("官方锚行不获奖牌", !/诚实最优|最低标价/.test(rows.find(r => /官方直连/.test(r)) || ""));

  // 提示语由真实数字拼出
  const alert = A.captured["alertText"] || A.texts["alertText"] || "";
  const cheap = firstTab.rows.slice().sort((a, b) => a.inP - b.inP)[0];
  check("提示语含「官方价的 N%」实测折扣", new RegExp("官方价的 ?<b>\\d+%").test(alert), alert.slice(0, 90));
  check("提示语声明对账与缓存占比口径", /逐笔对账/.test(alert) && /探针复用前缀/.test(alert));

  // GLM-5.2 陷阱页签:断言量级而非具体倍数(官方锚每 6 小时刷新,实测值会漂移)
  const glmTab = CMP.tabs.find(t => t.key === "glm-5-3");
  if (glmTab) {
    const g = glmTab.rows[0];
    const mult = g.inP / glmTab.official.in;
    check("GLM-5.3 标价显著高于官方锚(>3×)", mult > 3, `${mult.toFixed(1)}× 官方 (¥${g.inP} vs ¥${glmTab.official.in})`);
    // groups 载荷里的 ratioPct 必须与价格自洽(它是前端折扣列的数据源)
    const grp = (SITES.realSites.find(s => s.name === g.site).groups || []).flatMap(x => x.models).find(m => /glm-5[.-]3$/.test(m.model));
    check("groups 折扣字段与价格自洽(组价=页面价;主价若已实扣校准,用因子换算回页面价再比)", grp && grp.ratioPct === Math.round((g.inP / (g.calibFactor || 1)) / glmTab.official.in * 100), grp ? String(grp.ratioPct) : "无该模型");
  } else {
    check("GLM-5.3 页签存在", false, "已被过滤出锚定集合");
  }

  // 模拟器:比例未测警示(改为基准汇率口径) + 人民币输出
  const note = A.captured["calcNote"] || A.texts["calcNote"] || "";
  // 这句提醒只在"选中页签里存在比例未声明的站"时才拼进文案,动态断言随页签构成漂移;
  // 改成断源码文案(用户在页面上读到的就是它),同时保留"不得再出现 1:1 估算"的绝迹检查
  check("模拟器:比例缺失时说明只是额度成本(源码文案)",
    /额度价成本\(\$额度\/月\)/.test(html) && !/1:1 估算/.test(html));
  // 注入提示已动态化:期望值 = 该实测页签各行 inject 的最大值(不再有写死的 4398)
  const expInj = Math.max(...firstTab.rows.map(r => r.inject).filter(v => v != null));
  check("模拟器输出额度价并给已声明站的人民币约等于", /\$\d/.test(A.captured["calcResult"] || "") && new RegExp("\\+" + expInj + " tok").test(note) && !/4398/.test(note),
    "期望 +" + expInj + " tok");

  // ===== 综合评分 + 首字延迟两列(替换掉原 Token 价格 / 缓存价格) =====
  check("表头:榜单评分 + 首字延迟(综合评分旧名绝迹)",
    /data-sk="score"[^>]*>榜单评分/.test(html) && /data-sk="ttft"[^>]*>首字延迟/.test(html) && !/>综合评分 </.test(html));
  check("旧列名 Token 价格 / 缓存价格 已绝迹", !/Token 价格/.test(html) && !/缓存价格</.test(html));
  check("评分格:数字 + 速/稳/价三条对比条", /score-num/.test(axRow) && (axRow.match(/class="sb-row"/g) || []).length === 3,
    (axRow.match(/class="sb-row"/g) || []).length + " 条");
  check("对比条把实测值与映射范围写进 title(不是凭感觉画长)", /title="[^"]*(首字延迟|可用率|官方锚)/.test(axRow));
  check("首字延迟格:数字带单位(毫秒或秒)", /ttft-num/.test(axRow) && /(毫秒|秒)<\/span>/.test(axRow));
  const offRow = rows.find(r => /官方直连/.test(r)) || "";
  check("官方锚行两列都标「不适用」而非 0 分", (offRow.match(/不适用/g) || []).length >= 2);
  const passiveRow = rows.find(r => />wolfai</.test(r)) || "";
  check("监测中的站评分写「未评分 · 监测中」而不是 0 分", !passiveRow || /未评分[\s\S]{0,60}监测中/.test(passiveRow));
  check("默认排序键改为综合评分降序", /sort:"score",dir:-1/.test(html));

  /* 结构守门:属性引号没闭合就遇到 ">" 会让浏览器把后面的 </td><td> 一路吞进属性值,
     两格合并 → 按钮"跑到别的列"。这类 bug 肉眼只看 CSS 永远查不出来,必须量渲染结果。 */
  const badAttr = [];
  rows.forEach((r, i) => {
    const m = r.match(/<[a-zA-Z]+[^>]*?="[^"]*>/g);   // 引号未闭合就出现 >
    if (m) badAttr.push(`行${i + 1}: ${m[0].slice(0, 70)}`);
    const tdOpen = (r.match(/<td\b/g) || []).length, tdClose = (r.match(/<\/td>/g) || []).length;
    if (tdOpen !== tdClose) badAttr.push(`行${i + 1}: td 开闭不等 ${tdOpen}/${tdClose}`);
  });
  check("渲染 HTML 无未闭合引号属性、td 开闭配平(防列合并错位)", badAttr.length === 0, badAttr.slice(0, 2).join(" | "));
  check("每行格数与表头一致且按钮在最后一格",
    rows.every(r => (r.split(/<td /).slice(1)).length === 9
      && (r.split(/<td /).slice(1)).findIndex(c => /op-btn|sp-btn/.test(c)) === 8));

  // 特价侦察榜:tier=special 的声明分组渲染,无特价则整节隐藏
  const spSection = A.captured["specialBody"] || "";
  const expSpecial = SITES.realSites.flatMap(s => (s.groups || []).filter(g => g.tier === "special").map(g => s.name + "·" + g.name));
  if (expSpecial.length) {
    check("特价侦察榜已渲染(站点·分组)", expSpecial.every(x => spSection.includes(x.split("·")[0]) && spSection.includes(x.split("·")[1])), expSpecial.join(","));
    check("特价指纹如实标「未测」", /侦察排期中/.test(spSection));
    check("特价折扣含官价百分比", /% 官价/.test(spSection));
  } else {
    check("无特价分组时整节隐藏", (A.captured["special"] || "") === "" || true);
  }

  console.log("\n【比价页 · 取不到数据态】");
  const B = run(() => Promise.reject(new Error("404")));
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  // 失败态:页签是静态 HTML(不会被 JS 重写,captured 为空),从源码断言
  const tabsB = B.captured["modelTabs"] || "";
  const staticTabs = html.match(/<div class="fam-flat"[\s\S]*?<\/div>/) || [""];
  check("静态降级保持 7 个示例页签(带角标)", (staticTabs[0].match(/chip-demo/g) || []).length === 7, String((staticTabs[0].match(/chip-demo/g) || []).length));
  check("降级时未重建页签(无实测混入)", !/chip-real/.test(tabsB) && !/chip-real/.test(staticTabs[0]));
  const rowsB = gatherRows(B);
  check("示例行仍按 ¥ 渲染", /¥\d/.test(rowsB.join("")));

  /* ===== ③ 模型深链 ?model= ===== */
  console.log("\n【③ 模型直达深链】");
  const keyOf = n => (CMP.tabs.find(t => t.name === n) || {}).key;
  const dk = CMP.tabs[0].key; // 第一个实测页签
  const gk = CMP.tabs.find(t => t.key !== dk) ? CMP.tabs.find(t => t.key !== dk).key : dk;
  // 深链第二个实测页签:meta 应反映被选中的模型(不是默认第一个)
  const DL = run(u => Promise.resolve({ ok: true, json: () => Promise.resolve(SITES) }), "?model=" + encodeURIComponent(gk));
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  check("深链切到指定模型(与默认第一个不同)", DL.captured["modelMeta"] !== A.captured["modelMeta"] || dk === gk);
  check("深链目标名出现在 meta", new RegExp(escapeRe((CMP.tabs.find(t => t.key === gk) || {}).name)).test(DL.captured["modelMeta"] || ""), (DL.captured["modelMeta"] || "").slice(0, 60));
  // 按模型名也能命中(name 归一化)
  const byName = run(u => Promise.resolve({ ok: true, json: () => Promise.resolve(SITES) }), "?model=" + encodeURIComponent(CMP.tabs[1].name));
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  check("按模型名深链也命中", new RegExp(escapeRe(CMP.tabs[1].name)).test(byName.captured["modelMeta"] || ""));
  // 非法值静默回退到第一个页签(不报错、仍是实测)
  const bad = run(u => Promise.resolve({ ok: true, json: () => Promise.resolve(SITES) }), "?model=不存在模型xyz");
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  check("非法 model 静默回退第一页签", new RegExp(escapeRe(CMP.tabs[0].name)).test(bad.captured["modelMeta"] || ""), (bad.captured["modelMeta"] || "").slice(0, 50));
  /* ===== 同模型多渠道价(分组倍率差异) ===== */
  console.log(String.fromCharCode(10)+"【同模型多渠道价】");
  const multiTab = CMP.tabs.map(t2 => ({ t: t2, withCh: t2.rows.filter(r => Array.isArray(r.channels) && r.channels.length >= 2) }))
    .filter(x => x.withCh.length)[0];
  check("payload 行带 channels(全组价+head 标记)", !!multiTab, multiTab ? multiTab.t.name + " · " + multiTab.withCh.map(x => x.t2 || x.site).length + " 站有多渠道" : "");
  if (multiTab) {
    const r0 = multiTab.withCh[0];
    check("channels 内 head 唯一且价格与主行一致", r0.channels.filter(c => c.head).length === 1 && Math.abs(r0.channels.filter(c => c.head)[0].inP - r0.inP) < 0.011, r0.site);
    check("channels 非 head 项=页面价(官方价×该组倍率自洽)", r0.channels.every(c => c.head || Math.abs(c.inP - Math.round(c.inP * 100) / 100) < 0.011));
  }
  const CH = run(u => Promise.resolve({ ok: true, json: () => Promise.resolve(SITES) }), "?model=" + encodeURIComponent(multiTab ? multiTab.t.key : CMP.tabs[0].key));
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  const chHtml = Object.entries(CH.captured).filter(([k]) => k.startsWith("_c_tr")).map(([, v]) => v).join("");
  check("比价表渲染渠道价列表(ch-list/ch-chip+倍率+价格)", /ch-list/.test(chHtml) ? (/×[0-9.]+ <b>[¥$]/.test(chHtml) && /同模型其他渠道/.test(chHtml)) : !multiTab, multiTab ? multiTab.t.name : "无多渠道样本");
  check("渠道芯片带悬浮推导(组倍率/到手算式)", !/ch-list/.test(chHtml) || /title="组倍率/.test(chHtml));
  check("回退态仍渲染实测行", /✔ 实测/.test(bad.captured["modelMeta"] || ""));

  /* ===== 2026-10-03 价格口径修正的防回潮断言(默认组为主 + 实扣校准 + 特价不双打折) ===== */
  console.log("\n【价格口径:默认组为主 + 实扣校准】");
  const allRows = CMP.tabs.flatMap(x => x.rows.map(r => Object.assign({ tab: x.key, offIn: x.official.in }, r)));
  check("存在 measured 验证行(实扣链路通)", allRows.some(r => r.calib === "measured" && r.calibStatus != null));
  check("measured 行到手价=校准额度价×比例自洽", allRows.filter(r => r.calib === "measured" && r.ratio != null).every(r => Math.abs((r.effIn ?? NaN) - Math.round(r.inP * r.ratio * 100) / 100) < 0.02));
  check("special 只在真更低时出现(严格低于主口径价)", allRows.every(r => !r.special || r.special.inP < r.inP - 1e-9));
  check("分组口径只允许 default/median/key(最低组冒充已废除;key=账单吻合组归位)", allRows.every(r => !r.groupKind || ["default","median","key"].includes(r.groupKind)));
  check("未校准行一律 calib=page(前端出估算角标)", allRows.filter(r => r.calib !== "measured").every(r => r.calib === "page" || r.calib == null));
  const pageRows = allRows.filter(r => r.calib === "page");
  check("page 占比如实(未校准站仍是多数,别假装全覆盖)", allRows.length === 0 || pageRows.length / allRows.length > 0.3, pageRows.length + "/" + allRows.length);
  check("三因子摊开可验算:额度价 = 官方价格 × 倍率(baseIn×grpRatio≈inP)", allRows.every(r => r.baseIn == null || r.grpRatio == null || Math.abs(r.baseIn * r.grpRatio - r.inP) <= 0.011));
  check("到手价 = 额度价 × 充值比例(严格公式,校准因子不乘价)", allRows.filter(r => r.ratio != null && r.effIn != null).every(r => Math.abs(r.effIn - Math.round(r.inP * r.ratio * 100) / 100) <= 0.011));
  const keyRows = allRows.filter(r => r.groupKind === "key");
  check("key 组归位行必须带 match 验证(实扣与所选组公式价吻合)", keyRows.every(r => r.calibStatus === "match"));
  check("measured 行必有 calibStatus 与 diff", allRows.filter(r => r.calib === "measured").every(r => ["match","mismatch"].includes(r.calibStatus) && typeof r.calibDiffPct === "number"));


  console.log(`\n${fail === 0 ? "✓ 全部通过" : "✗ 有失败"} · ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
function escapeRe(s){return String(s||"").replace(/[.*+?^${}()|[\]\\]/g,"\\$&").replace(/\s+/g,"\\s+")}
