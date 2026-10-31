/* 诚实度守卫 —— 防「空数据出结论 / 硬编码证据编号 / 门面数字编造」复发。
   背景(2026-10-23 发现并修复,已在线上存在近三周):
   ① detail.html 的 buildDetailFromSync 对全部 9 个在册实测站返回 rounds:[],
      而 renderRounds 无条件渲染「通过 10/10 · 偏差 0.00% ✓」—— 给每个真站凭空贴满分对账单;
      且它把 batchCap 覆写成硬编码演示批次号 RL-RC-0929-0114(applySyncDetail 刚写好的
      真实权重/更新时间立刻被盖掉);偏差百分比用 Math.random()*2+3 现编。
   ② ranking.html 页头写死「实测站点 47 / 累计检测批次 2,904」(同期真实值 12 / 3499),
      「最后更新」直接取访客本机时钟 new Date()。
   一个卖「计费诚实度」的站,自己的数字不能是假的 —— 这条比任何功能都重要(AGENTS.md 红线 10)。 */
const fs = require("fs"), vm = require("vm");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.log("FAIL " + m); } }

const HOME = __dirname + "/relaylens-home";
const detail = fs.readFileSync(HOME + "/detail.html", "utf8");
const ranking = fs.readFileSync(HOME + "/ranking.html", "utf8");
const payload = JSON.parse(fs.readFileSync(HOME + "/data/sites.json", "utf8"));

/* 抽真实函数源码跑,不复写逻辑(复写会漂) */
function grab(src, name) {
  const i = src.indexOf("function " + name);
  if (i < 0) return null;
  let d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === "{") d++; else if (src[j] === "}" && --d === 0) break; }
  return src.slice(i, j + 1);
}

/* 最小 DOM 桩 */
function makeDom() {
  const els = {};
  return {
    els,
    doc: {
      getElementById: (id) => (els[id] = els[id] || {
        _t: "", _h: "",
        set textContent(v) { this._t = v; }, get textContent() { return this._t; },
        set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; },
        style: {}, addEventListener() {},
      }),
      querySelector: () => null, title: "",
    },
  };
}

/* —— ① detail.html:空 rounds 必须是诚实空态,不得出结论 —— */
console.log("【detail 逐轮对账:空数据不许出结论】");
const rrSrc = grab(detail, "renderRounds");
ok(!!rrSrc, "renderRounds 存在");
ok(rrSrc && !/Math\.random/.test(rrSrc), "renderRounds 不用 Math.random 现编偏差");
ok(rrSrc && /!rounds\.length/.test(rrSrc), "有空数据分支");

if (rrSrc) {
  const sites = Object.keys(payload.details || {});
  ok(sites.length > 0, "sites.json 有 details(否则本测试无对象可验)");
  for (const name of sites) {
    const { doc } = makeDom();
    const ctx = { document: doc, Math, String, parseFloat, isFinite, JSON, D: null };
    vm.createContext(ctx);
    const bds = grab(detail, "buildDetailFromSync");
    vm.runInContext(bds + "\n" + rrSrc, ctx);
    vm.runInContext(`D=buildDetailFromSync(${JSON.stringify(name)},${JSON.stringify(payload.details[name])});renderRounds();`, ctx);
    const body = doc.getElementById("panelBody").innerHTML;
    const cap = doc.getElementById("batchCap").textContent;
    const hasFakeConclusion = /通过\s*\d+\/\d+/.test(body) || /偏差\s*[0-9.]+%/.test(body);
    ok(!hasFakeConclusion, name + " 空 rounds 时不得出现「通过 n/n」「偏差 x%」结论行");
    ok(!/RL-RC-0929|20260929-114/.test(cap + body), name + " 不得显示硬编码演示批次号");
  }
  /* 有真数据时仍要能出结论(证明空态分支没有把正常路径一起干掉) */
  const { doc } = makeDom();
  const ctx = { document: doc, Math, String, parseFloat, isFinite, JSON, D: null };
  vm.createContext(ctx);
  vm.runInContext(rrSrc, ctx);
  vm.runInContext(`D={rounds:[{r:1,model:"m",in:1,cached:0,out:1,should:"¥1.00",actual:"¥1.00",ok:1},
    {r:2,model:"m",in:1,cached:0,out:1,should:"¥1.00",actual:"¥1.20",ok:0}]};renderRounds();`, ctx);
  const b2 = doc.getElementById("panelBody").innerHTML;
  ok(/通过\s*1\/2/.test(b2), "有数据时仍出真实结论(通过 1/2)");
  ok(/偏差\s*10\.00%/.test(b2), "偏差按应扣/实扣实算 = 10.00%,不是随机数");
}

/* —— ② 全站:不得在页面脚本里用 Math.random 造数字 —— */
console.log("【全站:不许用随机数造数字】");
/* 先剥注释 —— 否则「本测试为什么禁用 Math.random / 为什么不再写 ¥86,400」这类说明文字会被自己判红。
   HTML 注释也必须剥:blacklist 的统计带上方就挂着一条解释这段沿革的 <!-- ... -->。 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
for (const f of fs.readdirSync(HOME).filter(x => x.endsWith(".html"))) {
  const src = stripComments(fs.readFileSync(HOME + "/" + f, "utf8"));
  // speedprobe.js 用 Math.random 生成图表 groupId,那是标识符不是数字,不算
  const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");
  const bad = scripts.split("\n").filter(l => /Math\.random/.test(l) && !/gid|id|uuid|token/i.test(l));
  ok(bad.length === 0, f + " 内联脚本用 Math.random 造数字 → " + (bad[0] || "").trim().slice(0, 70));
}

/* —— ③ ranking 页头:数字必须由数据驱动,最后更新必须来自 meta —— */
console.log("【ranking 页头门面数字】");
ok(/id="ph-sites"/.test(ranking) && /id="ph-batches"/.test(ranking) && /id="ph-updated"/.test(ranking),
   "三个门面数字都有 id(才可能被数据驱动)");
ok(!/<div class="v num">47<\/div>/.test(ranking), "不再写死「实测站点 47」");
ok(!/<div class="v num">2,904<\/div>/.test(ranking), "不再写死「累计检测批次 2,904」");
ok(!/getElementById\("ph-updated"\)\.textContent=pad\(now/.test(ranking), "最后更新不再取访客本机时钟 new Date()");

const fps = grab(ranking, "fillPhStats");
ok(!!fps && /meta\.stats/.test(fps), "fillPhStats 从 meta.stats 取数");
ok(fps && /batchesTotal/.test(fps), "累计批次取 meta.stats.batchesTotal(sync.ts 产出)");
ok(fps && /sitesRegistered/.test(fps), "站点数取 meta.stats.sitesRegistered");
ok(/fillPhStats\(payload\)/.test(ranking), "applyRealData 里调用了 fillPhStats");

const ups = grab(ranking, "setPhUpdated");
ok(!!ups && /meta\.updated/.test(ups), "setPhUpdated 取 meta.updated(探针落库时间)");
ok(ups && !/new Date\(\)/.test(ups), "setPhUpdated 不用 new Date()");

/* —— ④ 门面数字与证据源对账(有 batchesTotal 时才校验,避免 sync 未重跑时误报) —— */
console.log("【门面数字与证据源对账】");
const S = (payload.meta && payload.meta.stats) || {};
if (S.batchesTotal != null) {
  ok(/^\d+$/.test(String(S.batchesTotal)), "meta.stats.batchesTotal 是整数");
} else {
  console.log("  · meta.stats.batchesTotal 尚缺(需在 probe 下跑 npx tsx cli.ts sync);页面此时显示「—」,属诚实降级");
}

/* —— ⑤ 黑名单页统计带:五个数必须由本页 ARCHIVES/CLEARED 推导 ——
   2026-10-23 前写死「黑名单在列 4 / 受损 ¥86,400」,而同页 ARCHIVES 实际是 black 2、
   逐案可核实受损合计 ¥79,400(差额 ¥7,000 全站无出处)。同属红线 10。 */
console.log("【blacklist 统计带:由 ARCHIVES 推导,不许写死】");
const bl = fs.readFileSync(HOME + "/blacklist.html", "utf8");
const blStrip = stripComments(bl);
for (const id of ["stDead", "stBlack", "stReview", "stLoss", "stCleared"]) {
  ok(bl.includes('id="' + id + '"'), "统计带有 id " + id + "(才可能被数据驱动)");
}
ok(!/class="v num">[0-9]/.test(blStrip), "统计带不再写死数字");
ok(!/¥86,400/.test(blStrip), "不再写死「¥86,400」(ARCHIVES 逐案只有 ¥79,400)");
ok(/function fillStats\s*\(/.test(bl), "有 fillStats");
/* 「定义了但没调用」是这类改动最典型的翻车:首屏五个数会永远停在 —,得点一下筛选才出来 */
ok(/fillStats\s*\(\s*\)/.test(blStrip.replace(/function fillStats\s*\(\s*\)/g, "")),
   "fillStats 被调用(不只是定义)");
const blFill = grab(bl, "fillStats");
ok(!!blFill && /ARCHIVES\.filter/.test(blFill), "fillStats 由 ARCHIVES 现算");
ok(blFill && /CLEARED\.length/.test(blFill), "摘牌数取自 CLEARED 数组(有据可查,不是一个裸数字)");
ok(blFill && !/loss/.test(blFill) === false, "受损额累加 loss 字段");
/* loss 与 facts 里的「累计约 ¥N」必须一致 —— 两处都是人写的,会漂 */
{
  const arrSrc = (() => { const i = bl.indexOf("var ARCHIVES="); let d = 0, j = bl.indexOf("[", i);
    for (; j < bl.length; j++) { if (bl[j] === "[") d++; else if (bl[j] === "]" && --d === 0) break; }
    return bl.slice(bl.indexOf("[", i), j + 1); })();
  const ARCHIVES = vm.runInNewContext("(" + arrSrc + ")", { });
  const withLoss = ARCHIVES.filter(a => typeof a.loss === "number");
  ok(withLoss.length > 0, "ARCHIVES 至少有一条带 loss");
  for (const a of withLoss) {
    const m = (a.facts || []).join(" ").match(/累计约 ¥([\d,]+)/);
    ok(!!m && Number(m[1].replace(/,/g, "")) === a.loss,
       a.name + " 的 loss(" + a.loss + ")与 facts 文案一致");
  }
  const sum = withLoss.reduce((s, a) => s + a.loss, 0);
  ok(sum === 79400, "受损合计 = ¥" + sum.toLocaleString() + "(旧写死值 ¥86,400 多出的 ¥7,000 全站无出处)");
}

console.log("honesty_guard: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
