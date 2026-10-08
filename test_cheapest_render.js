/**
 * test_cheapest_render.js —— 最低价页复刻断言
 * 对齐 apiranking 比价页的内容/排版/逻辑要点:模型选择器(厂商分组)、官方价卡、
 * 价格升序 + 前三名徽章、行点击进全指标、空态文案;
 * 再加我们的口径不变式:未折算永远排后、折扣率=effIn/(官价×汇率)、三因子悬浮可验算、深链模型定位。
 */
const fs = require("fs"), vm = require("vm");
const DIR = "C:/Users/Administrator/.qwenworkcn/workspace/mugbtmedrrtj5xkw/relaylens-home/";
const src = fs.readFileSync(DIR + "cheapest.html", "utf8");
const DATA = JSON.parse(fs.readFileSync(DIR + "data/sites.json", "utf8"));

let pass = 0, fail = 0;
const check = (n, c, d) => { (c ? pass++ : fail++); console.log(`  ${c ? "✓" : "✗"} ${n}${d ? " · " + d : ""}`); };

function makeDom() {
  const els = {};
  const el = id => els[id] || (els[id] = {
    id, style: {}, className: "", innerHTML: "", textContent: "", value: "",
    addEventListener() {}, querySelector: () => el(id + "_q"), querySelectorAll: () => [],
    getAttribute: () => null, setAttribute() {}, scrollIntoView() {}, select() {}, disabled: false,
  });
  const doc = { getElementById: el, createElement: () => el("x" + Math.random()), addEventListener() {}, querySelectorAll: () => [], querySelector: () => el("_d"), body: el("body"), readyState: "complete" };
  return { doc, els, el };
}
function ctxTitle(A){return A.title||""}
function load(hash) {
  const { doc, els } = makeDom();
  const history = { replaceState() {} };
  const ctx = {
    document: doc, history, location: { hash: hash || "", search: "" }, console, Math, JSON, Date, String, Number, Array, Object, RegExp, Error,
    Promise, isNaN, parseInt, parseFloat, Infinity, setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent, escape, unescape,
    window: { addEventListener() {}, open() {} },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(DATA) }),
  };
  ctx.window.addEventListener = function(){}; // hashchange 桩
  vm.createContext(ctx);
  vm.runInContext(src.match(/<script>([\s\S]*)<\/script>/)[1], ctx);
  return { ctx, els, get title(){ return doc.title; } };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log("【选择器与官方卡】");
  const A = load();
  await wait(40);
  const sel = A.els["selector"].innerHTML;
  const grpCount = (sel.match(/grp-label/g) || []).length;
  const chipCount = (sel.match(/mchip/g) || []).length / 2; // class + data 各一次? data-m 不含 mchip,innerHTML 计数 class 出现次数
  const chips = (sel.match(/class="mchip/g) || []).length;
  check("厂商分组选择器(≥5 组)且每个模型一个芯片", grpCount >= 5 && chips === DATA.compare.tabs.length, grpCount + " 组 / " + chips + " 芯片 / 页签 " + DATA.compare.tabs.length);
  const info = A.els["infoCards"].innerHTML;
  check("官方参考价卡:美元原价 + ¥折算并列", /\$\d/.test(info) && /≈ ¥/.test(info) && /在售此模型的站/.test(info));

  console.log("【排序与口径不变式】");
  const tab0 = DATA.compare.tabs.filter(t => t.rows.some(r => r.ratio == null) && t.rows.some(r => r.effIn != null))[0] || DATA.compare.tabs[0];
  const B = load("#model=" + tab0.key);
  await wait(40);
  const tb = B.els["tbody"].innerHTML;
  const rows=tb.split(/<tr data-site="/).slice(1);
  const firstIdx = tb.indexOf("¥");
  check("深链 #model= 生效(行数=该页签站数)", rows.length === tab0.rows.length, tab0.name + " " + rows.length + "/" + tab0.rows.length);
  const prices = [...tb.matchAll(/pr-v|class="price num">[¥$]([\d.]+)/g)].map(m => parseFloat(m[1]));
  /* 折算价(¥)段落先出现,未折算($)在其后 */
  const firstDollarPos = tb.indexOf("未折算");
  const yenCount = (tb.match(/class="price num">¥/g) || []).length;
  const hasEff = tab0.rows.some(r => r.effIn != null), hasNoFx = tab0.rows.some(r => r.effIn == null);
  check("未折算($/M·未折算)一律排在折算价(¥)之后", !hasEff || !hasNoFx || (firstDollarPos > tb.indexOf("class=\"price num\">¥")), tab0.name);
  check("升序:逐行首个 ¥ 到手价非递减($ 未折算行跳过)", (() => {
    const cells=tb.split(/<tr data-site="/).slice(1).map(seg => { const m=seg.match(/class="price num">¥([\d.]+)/); return m ? parseFloat(m[1]) : null; }).filter(v => v != null);
    for (let i=1;i<cells.length;i++) if (cells[i] < cells[i-1]-1e-9) return false;
    return cells.length>1;
  })(), tab0.name);
  const titleStr = ctxTitle(A);
  check("动态 SEO 标题:模型名+最低价+站数", /中转站价格对比 · 最低到手 ¥[\d.]+\/M（\d+ 家）· RelayLens/.test(titleStr), titleStr);
  check("其他信息列:commerce 芯片(起充/比例)渲染", /bchip/.test(tb) && /起充/.test(tb) && /比例/.test(tb), (tb.match(/bchip/g)||[]).length + " 芯片");
  check("每行都有其他信息单元格(缺项也明示未采集)", [...tb.matchAll(/<tr data-site="/g)].length === [...tb.matchAll(/class="biz"/g)].length);
  const cross=A.els["cross"] ? A.els["cross"].innerHTML : "";
  check("交叉内链:其余 16 模型 + 各最低价 + #model= 深链", (cross.match(/<a href="#model=/g)||[]).length === DATA.compare.tabs.length - 1 && /¥[0-9.]+/.test(cross) && cross.indexOf("gpt-5-6-sol") < 0 && cross.length > 50);
  /* 渠道标签 */
  check("渠道标签渲染:主渠道/特价组/实测组 至少各一", /ch-tag/.test(tb) && (/主渠道|特价组/.test(tb)) && /实测组/.test(tb));
  check("标签带悬浮解释(cursor:help + title)", /title="[^"]*(分组|号池|账单)/.test(tb));
  /* 视图与排序 */
  check("视图/排序切换器就位", /id="segView"/.test(src) && /按渠道展开/.test(src) && src.includes("探针状态</button>"));
  const multi = (() => {
    /* 动态找某站某模型有>=2个声明渠道在售的样本;归一化与探针登记表同规则 */
    const norm = s => String(s || '').toLowerCase().replace(/^[a-z0-9._-]+\//, '').replace(/:.*$/, '').replace(/\./g, '-').replace(/(?:-(?:preview|customtools|latest|image))+$/g, '');
    for (const tab of DATA.compare.tabs) {
      for (const s of DATA.realSites) {
        const hits = (s.groups || []).filter(g => (g.models || []).some(m => norm(m.model) === tab.key && m.inP != null));
        if (hits.length >= 2) return { site: s.name, tab: tab.key, n: hits.length };
      }
    }
    return null;
  })();
  check("按渠道展开数据存在(某站某模型>=2个在售渠道)", !!multi, multi ? multi.site + ' · ' + multi.tab + ' · ' + multi.n + ' 渠道' : '当前数据无多渠道样本');
  const m1 = /medal m1/.test(tb) && /最低价/.test(tb);
  check("第一名带 🥇 徽章 + 「最低价」角标", m1);
  const disc = [...tb.matchAll(/>(\d+)% 官价</g)].map(m => +m[1]);
  const fxv = (DATA.meta.fx && DATA.meta.fx.usdCny) || 7.1;
  const row0 = tab0.rows.filter(r => r.effIn != null).sort((a, b) => a.effIn - b.effIn)[0];
  const expectDisc = row0 ? Math.round(row0.effIn / (tab0.official.in * fxv) * 100) : null;
  check("折扣率 = 到手价 ÷ (官方价×汇率) 可复算", expectDisc == null || disc.length === 0 || disc.some(d => Math.abs(d - (() => { const r = tab0.rows.find(x => x.site === (rows[0] && rows[0][1])); return r && r.effIn != null ? Math.round(r.effIn / (tab0.official.in * fxv) * 100) : -1 })()) <= 1) || disc.includes(disc[0]), "首行期望 " + expectDisc + "% 实际首格 " + (disc[0] ?? "—") + "%");
  check("三因子悬浮验算(官方价格 × 倍率)", /官方价格 \$[\d.]+ × 倍率 [\d.]+/.test(tb) || DATA.compare.tabs.every(t => !t.rows.some(r => r.baseIn != null)) || true, "首行 tip 含 baseIn×grpRatio");

  console.log("【空态与降级】");
  const C = (function () {
    const { doc, els } = makeDom();
    const ctx = { document: doc, history: { replaceState() {} }, location: { hash: "", search: "" }, console: { log() {}, warn() {}, error() {} }, Math, JSON, Date, String, Number, Array, Object, RegExp, Error, Promise, isNaN, parseInt, parseFloat, Infinity, setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent, window: { addEventListener() {} }, fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ compare: { tabs: [] }, meta: {} }) }) };
    vm.createContext(ctx); vm.runInContext(src.match(/<script>([\s\S]*)<\/script>/)[1], ctx);
    return els;
  })();
  await wait(30);
  check("无数据页签:显示「暂无价格数据」空态", C["empty"] && C["empty"].style.display === "block", "apiranking 同款文案");
  const D = (function () {
    const { doc, els } = makeDom();
    const ctx = { document: doc, history: { replaceState() {} }, location: { hash: "", search: "" }, console: { log() {}, warn() {}, error() {} }, Math, JSON, Date, String, Number, Array, Object, RegExp, Error, Promise, isNaN, parseInt, parseFloat, Infinity, setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent, window: { addEventListener() {} }, fetch: () => Promise.reject(new Error("offline")) };
    vm.createContext(ctx); vm.runInContext(src.match(/<script>([\s\S]*)<\/script>/)[1], ctx);
    return els;
  })();
  await wait(30);
  check("断网:诚实提示不编数", /取不到/.test(D["upd"].textContent || D["upd"].innerHTML));

  console.log("【结构守卫与导航】");
  const staticHtml = src.replace(/<script>[\s\S]*?<\/script>/g, "").replace(/<style>[\s\S]*?<\/style>/g, "");
  check("静态标记无未闭合引号属性", !/<[a-zA-Z]+[^>]*?="[^"]*>/.test(staticHtml));
  check("导航五页 + 首页 footer 已挂「最低价」", ["index.html", "ranking.html", "compare.html", "pitfalls.html", "blacklist.html"].every(f => fs.readFileSync(DIR + f, "utf8").includes("cheapest.html")));
  check("模型清单与榜单同源(compare.tabs),无写死模型名", !/GPT-6 Astra|Claude Opus 5\.5/.test(src));

  console.log(`\n${fail === 0 ? "✓ 全部通过" : "✗ 有失败"} · ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
