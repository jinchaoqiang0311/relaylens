/**
 * test_index_trust_render.js —— 首页信任数据渲染断言
 * 目的很单纯:首页门面数字必须**要么真、要么显式「—」**,一个编出来的数都不许留。
 * 断言三件事:①真实统计正确落到 DOM ②旧假数(47 家 / ¥128,600 / ¥0.82)彻底绝迹
 *            ③取不到数据时保持「—」占位,绝不回退到假数
 */
const fs = require("fs"), vm = require("vm");
const DIR = "C:/Users/Administrator/.qwenworkcn/workspace/mugbtmedrrtj5xkw/relaylens-home/";
const SITES = JSON.parse(fs.readFileSync(DIR + "data/sites.json", "utf8"));
const html = fs.readFileSync(DIR + "index.html", "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");
const S = SITES.meta.stats;

function run(fetchImpl) {
  const captured = {}, texts = {};
  const mk = id => {
    const n = {
      id, style: {}, className: "", children: [], value: "", disabled: false,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      appendChild(c) { n.children.push(c) }, addEventListener() {}, setAttribute() {},
      // applyTrust 会用 insertBefore 插卡片;桩子缺这个方法时,页面里的 catch 会把它吞成"没数据",
      // 表现为一堆莫名其妙的 undefined 断言失败 —— 补齐 DOM 桩,别用假通过掩盖
      insertBefore() {}, replaceChildren() {}, remove() {}, firstChild: null,
      getAttribute: k => (k === "href" ? (n._href || "") : ""),
      querySelector: () => mk("_q"), querySelectorAll: () => [],
      select() {},
    };
    Object.defineProperty(n, "innerHTML", {
      get: () => captured[id] || "",
      set(v) { captured[id] = String(v); if (/_href="(.*?)"/.test(String(v))) n._href = RegExp.$1; },
    });
    Object.defineProperty(n, "textContent", { get: () => texts[id] || "", set(v) { texts[id] = String(v) } });
    return n;
  };
  const board = mk("board");
  board.querySelectorAll = sel => (sel === ".sb-item" ? [{ getAttribute: k => k === "href" ? "detail.html?site=RelayAPI" : "", setAttribute() {} }] : []);
  board.firstChild = { };
  const byId = { board };
  const ctx = {
    document: {
      getElementById: id => byId[id] || (byId[id] = mk(id)),
      querySelector: () => mk("_d"), querySelectorAll: () => [],
      createElement: t => mk("_c_" + t), addEventListener() {}, title: "", body: mk("body"),
      execCommand() {},
    },
    location: { search: "", href: "" }, navigator: { clipboard: null },
    console: { log() {}, warn() {}, error: (...a) => { if (process.env.V) console.log("[页面错误]", ...a); } },
    Math, JSON, Date, String, Number, Array, Object, RegExp, Error, isFinite, parseInt, parseFloat, Infinity,
    encodeURIComponent, decodeURIComponent,
    performance: { now: () => 0 },
    // rAF 立即以足够大的时间戳回调 → countUp 一次到位写入终值(否则动画永不完成)
    requestAnimationFrame: cb => cb(1e9),
    setTimeout: () => 0, clearTimeout() {},
    fetch: fetchImpl,
  };
  vm.runInContext(scripts, vm.createContext(ctx));
  return { captured, texts };
}

let pass = 0, fail = 0;
const check = (n, c, d) => { (c ? pass++ : fail++); console.log(`  ${c ? "✓" : "✗"} ${n}${d ? " · " + d : ""}`); };

(async () => {
  console.log("\n【首页 · 真实数据态】");
  const A = run(u => Promise.resolve({ ok: true, json: () => Promise.resolve(SITES) }));
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  const t = A.texts, H = id => A.captured[id] || "";

  check(`信任横幅站数 = ${S.sitesRegistered}`, t["st-sites"] === String(S.sitesRegistered), t["st-sites"]);
  check(`逐笔核验笔数 = ${S.reconcileVerified}`, t["st-verified"] === String(S.reconcileVerified), t["st-verified"]);
  check(`报价条目数 = ${S.priceLineItems}`, t["st-models"] === String(S.priceLineItems), t["st-models"]);
  check(`今日更新 = ${S.batchesToday}`, t["st-upd"] === String(S.batchesToday), t["st-upd"]);
  check("无分/未测的桶不显示数字", /^\d+$/.test(t["st-sites"] || ""));

  // 场景卡
  check("编程卡用真实对账笔数", t["mx-code"] === S.reconcileVerified + " 笔", t["mx-code"]);
  check("电商卡用真实注入值", t["mx-inj"] === "+" + Math.max(...SITES.realSites.map(x => x.inject)), t["mx-inj"]);
  check("短剧卡报真实最大单笔(万字)", /万/.test(t["mx-maxtok"] || "") && t["mx-maxtok"] !== "—", t["mx-maxtok"]);
  check("生图卡显式承认未实测", /尚未实测/.test(html.match(/<span class="metric">图像指纹探针[\s\S]{0,40}/)[0]));
  check("企业卡显式承认未实测", /尚未实测/.test(html.match(/<span class="metric">开票与主体[\s\S]{0,40}/)[0]));

  // 证据面板
  const e = SITES.evidence, r0 = e.rows[0];
  check("证据面板站点 = 实测站(非 RelayAPI)", t["ev-site"].startsWith(e.site) && !/RelayAPI/.test(t["ev-site"]), t["ev-site"]);
  check("批次号取真实 ID", t["ev-batch"].includes(e.batchId), t["ev-batch"]);
  check("模型名非占位", t["ev-model"] === r0.model && t["ev-model"] !== "—", t["ev-model"]);
  check("输入 token 带缓存明细", t["ev-in"].includes(r0.inTok.toLocaleString()) && /其中缓存命中/.test(t["ev-in"]), t["ev-in"]);
  check("应扣/实扣都是真实 quota", t["ev-exp"].includes(r0.expectedQuota.toLocaleString()) && t["ev-act"].includes(r0.actualQuota.toLocaleString()), t["ev-exp"] + " / " + t["ev-act"]);
  check("偏差渲染成 ±x.xx%", /^[+-]?\d\.\d{2}%$/.test(t["ev-dev"]), t["ev-dev"]);
  check("汇总条给可验证笔数", /可验证 \d+\/\d+ 笔/.test(t["ev-match"] || ""), (t["ev-match"] || "").slice(0, 70));
  const tabs = (H("ev-tabs").match(/<button/g) || []).length;
  check("样本切换标签数 = 样本数", tabs === e.rows.length, `${tabs} vs ${e.rows.length}`);

  // 看板:实测前插 + 示例标注
  const boardHtml = JSON.stringify(A.captured["board::_c_a"] || "") + H("_c_a");
  check("实测站卡片带「实测」标", /tag-real/.test(boardHtml), boardHtml.slice(0, 60));
  check("示例站卡片带「示例」标", /tag-demo/.test(html));
  const MARKUP = html.replace(/<script>[\s\S]*?<\/script>/g, "");   // 注释里允许提到旧假数,渲染层不允许
  check("示例站不再显示编造的「12 分钟前」", !/分钟前/.test(MARKUP) && /未接入探针/.test(MARKUP));

  // 绝迹检查:整页源码 + 渲染产物里都不许再出现这些假数
  const banned = ["128,600", "¥0.82", "已实测 47", ">47<", "47 家", "本周标红", "可开票站 <b>11", "影响用户预估 300", "已验证 API Key", "每 6 小时自动执行付费测试", "自动标红下架"];
  const hay = html + JSON.stringify(A.texts) + JSON.stringify(A.captured);
  const found = banned.filter(b => hay.includes(b));
  check(`旧假数绝迹(查 ${banned.length} 项)`, found.length === 0, found.join(" | "));
  check("SEO 描述已改写(无 47 家)", !/已实测47家/.test(html));

  console.log("\n【首页 · 推荐位】");
  // ① 当前真实数据(无合作站)→ 必须显示诚实空态,不得有编造优惠码
  const recWrap = A.captured["recWrap"] || "";
  const noPromo = !(SITES.recommendations || []).length;
  if (noPromo) {
    check("无合格合作站 → 显示空态而非假卡片", /当前没有合作推荐位/.test(recWrap), recWrap.slice(0, 40));
    check("空态给出入驻/认领入口", /onboarding\.html/.test(recWrap) && /claim\.html/.test(recWrap));
    check("空态说明「实测通过才能进」", /只有实测通过的站点才能进入/.test(recWrap));
  }
  const fakeCodes = ["RLSAVE15", "TOP20", "ZFREE8"];
  const rendered = JSON.stringify(A.texts) + JSON.stringify(A.captured);
  const leakedCodes = fakeCodes.filter(c => rendered.includes(c) || html.includes(c));
  check("旧编造优惠码全站绝迹(源码+渲染)", leakedCodes.length === 0, leakedCodes.join(" "));
  check("编造的「今日专属:RelayAPI 首充85折」浮动码已移除", !/今日专属:RelayAPI/.test(html));
  check("浮动福利条默认隐藏", /id="floatCta"[^>]*display:none/.test(html));

  // ② 注入一条合作数据 → 卡片必须用真实字段渲染且外链带 sponsored 标记
  const withPromo = JSON.parse(JSON.stringify(SITES));
  withPromo.recommendations = [{ name: "aixoras", url: "https://aixoras.com/signup?aff=TEST", coupon: "REAL10", couponDesc: "首充 9 折" }];
  const C = run(u => Promise.resolve({ ok: true, json: () => Promise.resolve(withPromo) }));
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  const rec2 = C.captured["recWrap"] || "";
  check("有合作站时渲染真实卡片", /aixoras/.test(rec2) && /含推广链接/.test(rec2));
  check("外链带 rel=nofollow sponsored", /rel="nofollow sponsored noopener"/.test(rec2));
  check("aff 链接原样输出(不吞参数)", /aff=TEST/.test(rec2));
  check("真实优惠码渲染", /REAL10/.test(rec2));
  check("卡片指标取实测值(注入/对账)", /\+4858 tok/.test(rec2) && /逐笔对账/.test(rec2));

  console.log("\n【首页 · 取不到数据态】");
  const B = run(() => Promise.reject(new Error("http 500")));
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  const statKeys = ["st-sites", "st-verified", "st-models", "st-upd", "mx-code", "mx-inj", "ev-model", "ev-in", "ev-exp", "ev-act", "ev-dev"];
  const wrote = statKeys.filter(k => B.texts[k] !== undefined || B.captured[k] !== undefined);
  check("统计位与证据面板不被写入任何值(JS 未回落假数)", wrote.length === 0, "误写入: " + wrote.join(","));
  check("非数据依赖的时间戳仍正常渲染", /数据截至/.test(B.texts["live-time"] || "") && /同步中/.test(B.texts["last-check"] || ""), B.texts["last-check"]);
  check("统计位静态默认值就是「—」", /id="st-sites">—<\/b>/.test(MARKUP) && /id="st-upd">—<\/b>/.test(MARKUP));
  check("无数据时面板保持静态占位「等待实测数据」", /等待实测数据/.test(MARKUP) && B.captured["ev-match"] === undefined);
  check("降级后源码仍无假数", !["128,600", "¥0.82", "47 家"].some(b => (JSON.stringify(B.texts) + JSON.stringify(B.captured)).includes(b)));

  console.log(`\n${fail === 0 ? "✓ 全部通过" : "✗ 有失败"} · ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
