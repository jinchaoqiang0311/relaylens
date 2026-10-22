/**
 * test_ranking_render.js —— 榜单页渲染断言(四种渲染态全覆盖)
 *   A 兜底态(fetch 失败) B 真实数据态 C 演示模式(DMO)  D 站方声明支付数据
 *   关键守门:①默认榜单不得出现任何虚构站点 ②参照系行必须存在且标"不适用/未测"而非空白
 *           ③CNY 源价不得被二次汇率折算 ④家数脚注必须与实际渲染一致(历史上写死过"18 家")
 */
const fs = require("fs"), vm = require("vm");
const HTML = "relaylens-home/ranking.html";
const html = fs.readFileSync(HTML, "utf8");
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])[0];
const SITES = JSON.parse(fs.readFileSync("relaylens-home/data/sites.json", "utf8"));

let all = true;
function check(name, cond, extra) { console.log((cond ? "✅ " : "❌ ") + name + (extra ? "  " + extra : "")); return !!cond; }

/* 一次渲染 = 一个新的 vm 上下文;pending 里排的是页面 setTimeout 回调,由调用方手动驱动 */
function runPass(payload, search) {
  const elems = {}, pending = [];
  function mkEl(id) {
    const e = { className: "", _innerHTML: "", id, style: {}, children: [],
      set innerHTML(v) { this._innerHTML = v; if (v === "") this.children = []; },   // 清空必须连 children 一起清,否则两次 render 的行会累积
      get innerHTML() { return this._innerHTML; },
      addEventListener() {}, appendChild(c) { e.children.push(c); }, setAttribute() {},
      querySelector() { return { textContent: "" }; }, getAttribute() { return ""; },
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false } } };
    return e;
  }
  const el = id => elems[id] || (elems[id] = mkEl(id));
  const tabs = {};
  ["all", "code", "office", "ecom", "drama", "image", "biz", "risk"].forEach(s => {
    tabs[s] = { _scene: s, classList: { add() {}, remove() {} }, addEventListener() {}, getAttribute: k => k === "data-scene" ? s : "" };
  });
  /* 三态 Tab(PRD §2):记录 click 监听,测试可驱动切换 L2/L1/L0 */
  const tierTabs = {};
  ["L2", "L1", "L0"].forEach(t => {
    const listeners = [];
    tierTabs[t] = { _tier: t, classList: { add() {}, remove() {} },
      addEventListener(ev, f) { if (ev === "click") listeners.push(f); },
      getAttribute: k => k === "data-tier" ? t : "", _click: () => listeners.forEach(f => f()) };
  });
  const doc = { getElementById: el,
    querySelectorAll: sel => sel.includes("sceneTabs") ? Object.values(tabs) : sel.includes("tierTabs") ? Object.values(tierTabs) : [],
    querySelector: s => { const m = /data-scene="([a-z]+)"/.exec(s); return m ? tabs[m[1]] : el(String(s).replace(/\W/g, "_")); },
    createElement: () => mkEl("_c" + Math.random()), addEventListener() {}, title: "" };
  const ctx = { document: doc, location: { search: search || "", href: "" }, navigator: { clipboard: null },
    console: { log() {}, warn() {}, error() {} }, Math, JSON, Date, String, Number, Array, Object, RegExp, Error, isFinite,
    parseFloat, parseInt, encodeURIComponent, decodeURIComponent,
    performance: { now: () => 0 }, requestAnimationFrame: () => {}, setTimeout: (f) => { pending.push(f); return 0; }, clearTimeout: () => {},
    history: { replaceState() {} }, window: { scrollTo() {} },
    fetch: payload ? () => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) })
      : () => Promise.reject(new Error("no-fetch-in-test")) };
  vm.runInContext(script, vm.createContext(ctx));
  const rowsOf = () => (elems["tbody"] ? elems["tbody"].children : []).map(c => String(c._innerHTML));
  const cardsOf = () => (elems["mCards"] ? elems["mCards"].children : []).map(c => String(c._innerHTML));
  return { elems, pending, rowsOf, cardsOf, drain: () => pending.splice(0).forEach(f => { try { f(); } catch (e) { console.log("  ⚠ 定时器回调抛错:" + e.message); } }),
    clickTier: t => tierTabs[t]._click() };
}
const tick = () => new Promise(r => setImmediate(() => setImmediate(r)));
const rowWith = (rows, re) => (rows.find(r => re.test(r)) || "");

(async () => {
  /* ============ A. 兜底态:fetch 失败,只剩 2 行实测种子 ============ */
  console.log("\n【A 兜底态(fetch 失败)】");
  const A = runPass(null);
  await tick(); A.drain();
  const ar = A.rowsOf();
  all &= check("兜底态只有 2 行实测种子(虚构站不默认上架)", ar.length === 2, `${ar.length} 行`);
  all &= check("虚构站名在默认态绝迹", !/RelayAPI|TopAPI|鑫旺Neko|Orbelis/.test(ar.join("")));
  all &= check("兜底态无 undefined / NaN 漏字", !/undefined|NaN/.test(ar.join("")));
  all &= check("未评分/未测中文占位", /未评分|未测/.test(ar.join("")));
  const footA = (A.elems["rankFoot"] ? A.elems["rankFoot"]._innerHTML : "").replace(/<[^>]+>/g, "");
  all &= check("兜底态脚注标明「内置快照·非实时」而不是装作实时数据",
    /2 行中转站/.test(footA) && /页面内置快照/.test(footA) && /非实时/.test(footA), footA.slice(0, 70));

  /* ============ B0. 三态默认态(真实数据,不强制分层) ============
     PRD §2:默认落在实测榜;L1 站不给分只给信号卡;实测榜<5 行时观察榜预告条出现 */
  console.log("\n【B0 三态默认态(真实数据)】");
  const nL2 = SITES.realSites.filter(r => r.level !== "passive" && ((r.tier && r.tier.all) || "L2") === "L2").length;
  const nL1 = SITES.realSites.filter(r => r.level !== "passive" && r.tier && r.tier.all === "L1").length;
  const nL0 = SITES.realSites.filter(r => r.level === "passive").length;
  const B0 = runPass(SITES);
  await tick(); B0.drain();
  const b0r = B0.rowsOf();
  const b0relay = b0r.filter(r => /class="nm"/.test(r) && !/rk-anchor/.test(r)).length;
  all &= check("默认落在实测榜:中转行 = L2 站数", b0relay === nL2, `${b0relay} 行 vs L2=${nL2}`);
  all &= check("L1 站绝不在默认实测榜出现(不给分是铁律)", !/观察中|已验证 \d+\/\d+ 项/.test(b0r.join("")));
  const ws = B0.elems["watchStrip"] ? B0.elems["watchStrip"]._innerHTML : "";
  /* 预告条只在「实测榜不足 5 行 且 存在观察榜站」时出现;没有观察站时正确地不渲染 */
  const wsExpected = nL1 > 0 && nL2 < 5;
  all &= check(wsExpected ? "实测榜<5 行且有观察站:预告条出现并列出完成度" : "无观察站或实测榜充足:预告条不出现",
    wsExpected ? (/正在攒数据/.test(ws) && /\d+%/.test(ws)) : ws === "");
  all &= check("三态 Tab 计数与数据同源",
    String(B0.elems["cntL2"].textContent) === String(nL2) && String(B0.elems["cntL1"].textContent) === String(nL1) && String(B0.elems["cntL0"].textContent) === String(nL0),
    `L2=${B0.elems["cntL2"].textContent}/L1=${B0.elems["cntL1"].textContent}/L0=${B0.elems["cntL0"].textContent} vs ${nL2}/${nL1}/${nL0}`);
  B0.clickTier("L1");
  const b0l1 = B0.rowsOf().filter(r => /class="nm"/.test(r) && !/rk-anchor/.test(r));
  all &= check("观察榜 Tab:每行 L1 站都渲染信号卡(观察中,评分列无分数大字;其余列的 ok/bad 大字不受限)",
    b0l1.length === nL1 && b0l1.every(r => /观察中/.test(r) && /已验证 \d+\/\d+ 项/.test(r)) &&
    b0l1.every(r => !/rc-big s-/.test(r)),
    `${b0l1.length} 行`);
  if (nL1 > 0) {
    const l1row = rowWith(b0l1, />aicost<|>aixoras</);
    all &= check("信号卡样本进度 = 真实 n/need 且给出差距", /\d+\/\d+/.test(l1row) && /距出分还差/.test(l1row));
  }
  B0.clickTier("L0");
  const b0l0 = B0.rowsOf().filter(r => /class="nm"/.test(r) && !/rk-anchor/.test(r));
  all &= check("监测中 Tab:行数 = passive 站数,徽章为监测中",
    b0l0.length === nL0 && b0l0.every(r => /bf-passive/.test(r) && !/bf-real|bf-l1/.test(r)), `${b0l0.length} 行`);

  /* ============ B. 真实数据态(L2 行级断言,forceL2 保证 L2 分支可测) ============ */
  console.log("\n【B 真实数据态(L2 视图)】");
  const forceL2 = p => { const c = JSON.parse(JSON.stringify(p)); c.realSites.forEach(r => { if (r.tier) r.tier.all = "L2"; }); return c; };
  const B = runPass(forceL2(SITES));
  await tick(); B.drain();
  const br = B.rowsOf();
  const relay = br.filter(r => /class="nm"/.test(r) && !/rk-anchor/.test(r)).length;
  const anchor = br.filter(r => /rk-anchor/.test(r)).length;
  const sep = br.filter(r => /以下为参照系/.test(r)).length;
  all &= check("实测榜中转行 = 非 passive 站数(已强制 L2)", relay === SITES.realSites.filter(x => x.level !== "passive").length, `${relay} 行`);
  all &= check("参照行 = referenceSites 数", anchor === SITES.referenceSites.length, `${anchor} vs ${SITES.referenceSites.length}`);
  all &= check("参照系前有一条分隔说明", sep === 1);
  const ax = rowWith(br, />aixoras</), aic = rowWith(br, />aicost</);
  all &= check("aixoras 亮出微信+支付宝两枚 logo", /aria-label="微信支付"/.test(ax) && /aria-label="支付宝"/.test(ax));
  const axAt = (SITES.realSites.find(r => r.name === "aixoras") || {}).commerce?.at;   // 核实日期随 commerce.verified 变,从 payload 推导
  all &= check("aixoras logo 悬浮标人工核实+日期且不自称站方声明",
    axAt && new RegExp("人工核实\\(" + axAt + "\\)").test((ax.match(/<div class="paylogos"[^>]*>/) || [""])[0]) &&
    !/站方入驻声明/.test((ax.match(/<div class="paylogos"[^>]*>/) || [""])[0]) && /pay-src/.test(ax));
  all &= check("aicost 卡密降级为文字芯片(不硬凑品牌 logo)",
    /class="paylogos"[\s\S]{0,300}?rc-chip[^>]*>卡密</.test(aic) && !/aria-label="微信支付"/.test(aic));
  all &= check("真实数据:72h 走势如实标注样本覆盖(有样本给 n/12 段,不足则明说)",
    /\d+\/12 段有样本\(6h\/格\)/.test(ax) || /走势样本不足\(\d+\/12 段\)/.test(ax));
  all &= check("走势列标题已随采样密度改口径", /72H 可用率 \/ 趋势/.test(html) && !/24H 可用率/.test(html));
  /* 2026-10-22 起 PF 只留 P50 中位数(P95 已移除,见 f238257),并展示忙/闲双桶值 ——
     期望串按 payload 现算(与页面 ttftDual 同构),不写死数字;同时守住「均值口径」的页面披露。 */
  const axS = SITES.realSites.find(r => r.name === "aixoras") || {};
  const fmtB = ms => ms == null ? null : (ms < 1000 ? Math.round(ms) + "ms" : (ms / 1000).toFixed(1) + "s");
  const wantDual = (axS.ttftWorkMs == null && axS.ttftOffMs == null) ? null
    : (axS.ttftOffMs == null ? "忙 " + fmtB(axS.ttftWorkMs) + " · 闲未测"
      : axS.ttftWorkMs == null ? "忙未测 · 闲 " + fmtB(axS.ttftOffMs)
        : "忙 " + fmtB(axS.ttftWorkMs) + " · 闲 " + fmtB(axS.ttftOffMs));
  all &= check("真实数据:首字延迟忙/闲双桶 · 逐笔 · 容差口径",
    (!wantDual || ax.includes(wantDual)) && /逐笔判定/.test(ax) && /max\(2 quota, 1%\)/.test(ax),
    wantDual || "无双桶样本");
  all &= check("首字延迟列公示「忙/闲中位数均值」口径(P95 已下线)", /忙\/闲两时段中位数的均值/.test(ax));
  all &= check("真实数据:分组口径可见(分数仅代表实测分组)", /分数仅代表实测分组/.test(ax));
  const opTd = (ax.match(/<td class="rich"><div class="op-col">([\s\S]*?)<\/div><\/td>\s*$/) || ["", ""])[1]
    || (ax.slice(ax.lastIndexOf("op-col")) );
  all &= check("操作列同时含「测试详情」与「测速直达」两个按钮",
    /op-detail[^>]*>测试详情</.test(opTd) && /sp-btn/.test(opTd) && /测速直达/.test(opTd));
  all &= check("测速按钮不再留在流式列内(避免一行两个入口)",
    !/(真流式|假流式)[\s\S]{0,400}class="sp-btn"/.test(ax.replace(/<td class="rich"><div class="op-col">[\s\S]*$/, "")));
  all &= check("旧「实测详情」文案已统一为「测试详情」", !/实测详情</.test(html));
  /* 价格断言一律从 payload 推导,不写死站名 —— 站方补了充值比例后"哪家给人民币价"会变 */
  const declared = SITES.realSites.filter(r => r.effPrice != null);
  const dRow = rowWith(br, new RegExp(">" + declared[0].name + "<"));
  all &= check("已声明比例的站:主价是 ¥ 到手价并写明算式",
    new RegExp("¥" + String(declared[0].effPrice).replace(".", "\\.") + "/M").test(dRow) && /到手 ¥/.test(dRow) && /比例 ¥/.test(dRow),
    declared[0].name + " ¥" + declared[0].effPrice);
  // 模型名与分组随价格变化(最便宜的那个会变),从 payload 取,不写死
  all &= check("报价旁标出模型与来源分组(可回溯站方页面)",
    !!declared[0].priceModel && !!declared[0].priceGroup &&
    dRow.includes(declared[0].priceModel) && dRow.includes(declared[0].priceGroup),
    `${declared[0].priceModel} · ${declared[0].priceGroup}`);
  /* 两种「未声明」必须分开判(2026-10-21 用户拍板):
     CNY 公示价站(heyroute 价格页直接写 ¥ 单价)→ 页面上的 ¥ 就是到手价,说「不给人民币价」是自相矛盾的假话;
     只给美元额度价又没声明比例的站 → 才说「不给人民币价」。未进入当前视图时用源码分支兜底。 */
  const isCny = r => !!(r.priceSrc && r.priceSrc.src === "CNY");
  const cnyDirect = SITES.realSites.filter(r => r.price && r.effPrice == null && isCny(r));
  const usdNoRatio = SITES.realSites.filter(r => r.price && r.effPrice == null && !isCny(r));
  const rowOrSrc = r => rowWith(br, new RegExp(">" + r.name + "<")) || html;
  all &= check("CNY 公示价站明说「即到手价 · 不乘充值比例」(不谎称不给人民币价)",
    cnyDirect.length ? cnyDirect.every(r => /站方人民币公示价 · 即到手价/.test(rowOrSrc(r)))
      : /站方人民币公示价 · 即到手价/.test(html), cnyDirect.map(r => r.name).join(","));
  all &= check("有标价但比例未声明的站明说「不给人民币价」(无此类站时校验代码分支)",
    usdNoRatio.length ? usdNoRatio.every(r => /充值比例未声明 · 不给人民币价/.test(rowOrSrc(r)))
      : /充值比例未声明 · 不给人民币价/.test(html), usdNoRatio.map(r => r.name).join(","));
  all &= check("全表不出现按 1$=¥7.1 乘出来的假主价", !/¥(6\.39|12\.43|4\.97|53\.25|79\.88)/.test(br.join("")));
  const jq = rowWith(br, />jiuqingyun</);
  all &= check("不用充值比例做风险判断(比例风险标已撤,只看测得出的量)", !/⚠ 比例/.test(jq) && !/⚠ 比例/.test(html));
  all &= check("「到手 ¥」只出现在声明过比例的站行里(不凭空造人民币价)",
    br.filter(r => /到手 ¥/.test(r)).every(r => SITES.realSites.some(x => x.effPrice != null && new RegExp(">" + x.name + "<").test(r))));
  all &= check("示例站显式标未对账/未测(默认态不伪装) —— 现已撤下,改为断言参照行不伪装",
    /不适用/.test(br.join("")) && /未测/.test(br.join("")));

  /* 参照系行细节 */
  const zg = rowWith(br, /智谱/), ds = rowWith(br, /DeepSeek 官方/), or = rowWith(br, /OpenRouter/);
  all &= check("参照行:三个都是真实站点(非虚构)", zg.length > 0 && ds.length > 0 && or.length > 0);
  all &= check("参照行:不参与排名(锚标 + 分隔说明文字)", /不参与中转榜排名/.test(br.join("")) && /rk-anchor/.test(zg));
  all &= check("参照行:「不适用」与「未测」是两种样式", /rc-na/.test(zg) && /rc-un/.test(zg));
  all &= check("参照行:大数字的标题就是「可达率」(不冒充中转榜可用率)", /class="rc-s">可达率 · \d+ 次/.test(zg));
  all &= check("参照行:智谱保持站方人民币标价 ¥0.8/M(未被汇率二次加工)",
    /¥0\.8\/M/.test(zg) && /站方以人民币标价/.test(zg));
  all &= check("参照行:美元额度站标「站方以美元额度标价」", /\$0\.3\/M/.test(ds) && /站方以美元额度标价/.test(ds));
  all &= check("参照行:无档案则不给假详情入口", !/实测详情/.test(zg) && /同模型报价/.test(zg));
  const foot = B.elems["rankFoot"] ? B.elems["rankFoot"]._innerHTML : "";
  // 结构守门:属性引号未闭合就遇 ">" 会让浏览器吞掉 </td><td> 造成列合并错位(比价页中过一次)
  const badAttr = br.map((r, i) => (r.match(/<[a-zA-Z]+[^>]*?="[^"]*>/g) || []).map(x => `行${i + 1}: ${x.slice(0, 60)}`)).flat();
  all &= check("渲染 HTML 无未闭合引号属性(防列合并错位)", badAttr.length === 0, badAttr.slice(0, 2).join(" | "));
  all &= check("每行格数与表头一致(含 colspan 的分隔行除外)", br.every(r => {
    const td = (r.match(/<td\b/g) || []).length;
    return td === (html.match(/<th[ >]/g) || []).length || /colspan=/.test(r);   // 参照系分隔行就是 colspan=10
  }));
  const footB = foot.replace(/<[^>]+>/g, "");
  const nBilling = SITES.realSites.filter(x => x.level !== "passive").length;
  const nPassive = SITES.realSites.filter(x => x.level === "passive").length;
  all &= check("脚注三态计数与 Tab 同源(实测榜/观察榜/监测中/参照系)",
    new RegExp("实测榜 " + nBilling + " 行").test(footB) && new RegExp("监测中 " + nPassive + " 行").test(footB) &&
    /另有 3 行官方\/聚合参照系/.test(footB), footB.slice(0, 110));
  /* 监测中的站在 L0 Tab 里:切过去断言 */
  B.clickTier("L0");
  const brL0 = B.rowsOf();
  const wolf = rowWith(brL0, />WO</), passiveRow = wolf || rowWith(brL0, /监测中/);
  all &= check("监测中的站:徽章写「监测中」且不谎称实测", /badge-flag bf-passive"[^>]*>监测中</.test(passiveRow) && !/badge-flag bf-real/.test(passiveRow));
  all &= check("监测中的站:计费测试列说人话,不出现「逐笔判定 未测 / 容差」账单行话",
    !/逐笔判定/.test(passiveRow) && !/容差 max/.test(passiveRow) && /未做账单级实测/.test(passiveRow));
  B.clickTier("L2");   // 复位,后续演示模式断言在新 pass 里,互不影响
  const visible = html.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");
  all &= check("页面对外文案里没有写死的家数(注释除外)", !/18 家|47 家/.test(visible));
  /* 移动卡片也覆盖到参照行 */
  all &= check("移动卡片含参照卡(不参与排名标注)", /不参与排名/.test(B.cardsOf().join("")));

  /* ============ C. 演示模式 ============ */
  console.log("\n【C 演示模式 ?demo=1】");
  const C = runPass(SITES, "?demo=1");
  await tick(); C.drain();
  const cr = C.rowsOf();
  all &= check("演示模式补回 16 家虚构站(L2 真实行 + 演示行并存)",
    cr.filter(r => /class="nm"/.test(r) && !/rk-anchor/.test(r)).length === nL2 + 16,
    `${cr.filter(r => /class="nm"/.test(r) && !/rk-anchor/.test(r)).length} 行 vs ${nL2 + 16}`);
  all &= check("演示横幅 class 点亮", C.elems["demoBanner"] && C.elems["demoBanner"].className === "on");
  const banner = (html.match(/id="demoBanner"[^>]*>([\s\S]*?)<\/div>/) || ["", ""])[1];
  all &= check("横幅明说这些站是虚构的、不可据此充值", /虚构/.test(banner) && /不要据此做任何充值决策/.test(banner));
  all &= check("示例站显式标未对账/未测(不伪装)", /未对账/.test(rowWith(cr, /RelayAPI/)) && /未测|样本不足/.test(rowWith(cr, /RelayAPI/)));
  all &= check("运营年限仍可见(示例站 3.2 年)", /运营 3\.2 年/.test(cr.join("")));
  all &= check("无 commerce 声明的示例站不出现任何支付 logo", !/paylogos/.test(rowWith(cr, /RelayAPI/)));
  all &= check("脚注改口:16 行为虚构", /16 行为演示用虚构站点/.test(C.elems["rankFoot"]._innerHTML));

  /* ============ D. 站方声明的支付数据 ============ */
  console.log("\n【D 站方声明支付数据】");
  const WITHPAY = JSON.parse(JSON.stringify(SITES));
  WITHPAY.realSites.forEach((r, i) => { if (i === 0) r.commerce = { pay: "支付宝 / 微信 / USDT / 对公转账", ratio: "¥7.2 = 1 美元额度", minTopUp: "¥10", invoice: null, refund: null, src: "declared", at: "2026-10-01" }; });
  const D = runPass(WITHPAY);
  await tick(); D.drain();
  const d0 = SITES.realSites[0];
  D.clickTier(d0.level === "passive" ? "L0" : ((d0.tier && d0.tier.all) || "L2"));   // 切到 realSites[0] 实际所在层(它可能已升 L2)
  const dr = D.rowsOf();
  const withPay = rowWith(dr, /aria-label="支付宝"/);
  all &= check("声明后渲染微信+支付宝+USDT 三枚 SVG", /aria-label="微信支付"/.test(withPay) && /aria-label="USDT"/.test(withPay));
  all &= check("未识别方式降级为文字芯片(对公转账)", /对公转账/.test(withPay));
  all &= check("src=declared 标注站方入驻声明且无人工核实角标", /站方入驻声明/.test(withPay) && !/pay-src/.test(withPay));
  all &= check("商业信息列:有值时三行紧凑展开(起充/比例/退款)", /cc-row/.test(withPay) && /起充/.test(withPay) && /比例/.test(withPay) && /退款/.test(withPay));

  /* ============ E. 静态源码与设计约束 ============ */
  console.log("\n【E 静态源码约束】");
  const s = html;
  const t = (n, c) => { all &= check(n, c); };
  t("四个列名已按最新口径更新且旧名绝迹",
    ["计费测试", "72H 可用率 / 趋势", "流式 · 首字延迟", "注入 · 指纹验真"].every(x => s.includes(x)) &&
    !["\>计费诚实 <span", "24H SLA", "24H 可用率", "\>延迟 · 流式 <span", "\>注入 · 指纹 <span"].some(x => s.includes(x)));
  t("不得存在「其他」整列", !/>其他<\/th>/.test(s));
  t("商业信息独立成列 + 芯片仍服务移动卡片", /commerceCell\(s\)/.test(s) && /commerceChips\(s\)/.test(s));
  t("详情页 basic 读 commerce 并标未声明",
    /det\.commerce/.test(fs.readFileSync("relaylens-home/detail.html", "utf8")) &&
    /未声明\(待站方入驻填写\)/.test(fs.readFileSync("relaylens-home/detail.html", "utf8")));
  t("数据页加宽、正文页保持可读行宽",
    /max-width:1560px/.test(s) && /max-width:1000px/.test(fs.readFileSync("relaylens-home/method.html", "utf8")));
  t("站点列已收窄且不重复自己列的指标", /width:188px/.test(s) && /\^实测对账\/.*\^\^?注入|!\/\^实测对账/.test(s));
  t("标签行不平铺(nowrap+hidden) 且最多 2 枚", /\.rc-tags\{[^}]*white-space:nowrap[^}]*overflow:hidden/.test(s) && /list\.slice\(0,2\)/.test(s));
  t("测试详情按钮不复用 .sp-btn 类(避免被测速脚本捕获阶段吞掉)", /class=\"op-btn op-detail\"/.test(s) && !/class=\"sp-btn op-detail\"/.test(s));
  t("详情为直接跳转(抽屉已回退)", !/RLDrawer|dr-scrim|详情抽屉/.test(s) && /location\.href="detail\.html\?site="\+encodeURIComponent\(s\.name\)/.test(s));
  t("「不适用」与「未测」样式色不同", /\.rc-na\{[^}]*var\(--faint\)/.test(s) && /\.rc-un\{[^}]*var\(--warn\)/.test(s));
  t("三态 Tab / 信号卡 / 预告条组件齐备(PRD §2)",
    /id="tierTabs"/.test(s) && /scoreCell\(s,sc\)/.test(s) && /renderWatchStrip/.test(s) && /bf-l1/.test(s));
  t("信号卡文案不含编造的批次概念(只有真实 n/need)", /距出分还差/.test(s) && !/距出分还差 \d+ 批/.test(s));
  t("参照行不进排序列表(SITES 与 REFS 全程分离)", /var REFS=\[\]/.test(s) && /REFS=payload\.referenceSites/.test(s) && !/concat\(REFS\)/.test(s) && /REFS\.filter\(/.test(s));
  t("演示模式默认关且只由 URL/按钮开启", /var DEMO_ON=.*demo=1/.test(s) && !/DEMO_ON\s*=\s*true/.test(s));
  t("测速按钮为主操作样式", /background:#0d9488;color:#fff/.test(fs.readFileSync("relaylens-home/assets/speedprobe.css", "utf8")));
  t("方法页定义了三种空值语义", /不适用<\/b>\(灰虚线\)/.test(fs.readFileSync("relaylens-home/method.html", "utf8")));
  t("方法页说明参照系两把尺子不可横比", /两把尺子/.test(fs.readFileSync("relaylens-home/method.html", "utf8")));

  console.log(all ? "\n全部通过" : "\n有失败项");
  process.exit(all ? 0 : 1);
})();
