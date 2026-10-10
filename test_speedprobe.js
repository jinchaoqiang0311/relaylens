/**
 * test_speedprobe.js —— 测速直达逻辑与诚实性断言
 * 规格第 9 章列了 10 条"原项目踩过别再踩"的坑,这里把可自动化的几条钉成测试:
 *   #1 浏览器探测必须串行  #2 必须 no-store + 时间戳防缓存
 *   #3 runId 作废  #4/#5 不得把非实时数字谎称实时
 */
const fs = require("fs"), vm = require("vm");
const DIR = __dirname+"/relaylens-home/";
const src = fs.readFileSync(DIR + "assets/speedprobe.js", "utf8");

let pass = 0, fail = 0;
const check = (n, c, d) => { (c ? pass++ : fail++); console.log(`  ${c ? "✓" : "✗"} ${n}${d ? " · " + d : ""}`); };

function makeDom() {
  const el = (tag) => {
    const n = { tag, children: [], style: {}, _attrs: {}, className: "", innerHTML: "", textContent: "" };
    n.appendChild = c => { n.children.push(c); return c };
    n.removeChild = c => { n.children = n.children.filter(x => x !== c) };
    n.setAttribute = (k, v) => { n._attrs[k] = v };
    n.getAttribute = k => n._attrs[k];
    n.addEventListener = () => {};
    n.querySelector = () => null;
    n.querySelectorAll = () => [];
    n.closest = () => null;
    n.parentNode = { removeChild() {} };
    return n;
  };
  return { el, document: { createElement: el, addEventListener() {}, removeEventListener() {}, getElementById: () => null, body: el("body"), readyState: "complete" } };
}
function load(extra) {
  const d = makeDom();
  const ctx = Object.assign({
    document: d.document, window: {}, console: { log() {}, warn() {}, error() {} },
    Math, JSON, Date, String, Number, Array, Object, RegExp, Error, Promise, isNaN, parseInt, parseFloat, Infinity,
    setTimeout, clearTimeout, AbortController: global.AbortController, URL,
    performance: { now: () => Date.now() },
  }, extra || {});
  vm.runInContext(src, vm.createContext(ctx));
  return { ctx, RL: ctx.window.RLSpeedProbe || ctx.RLSpeedProbe };
}

(async () => {
  console.log("\n【统计口径】");
  const { RL } = load();
  check("median 奇数取中位", RL.median([300, 100, 200]) === 200);
  check("median 偶数取均值", RL.median([100, 200]) === 150);
  check("median 空数组返回 null", RL.median([]) === null);
  const samples = [{ rtt: 100, ok: true }, { rtt: 300, ok: true }, { rtt: null, ok: false }, { rtt: 200, ok: true }, { rtt: 150, ok: true }];
  const sum = RL.summarize(samples, 5);
  check("可达率按成功轮计", sum.reachability === 80, sum.reachability + "%");
  check("抖动=max-min 只算成功轮", sum.jitter === 200, String(sum.jitter));
  check("中位数不受失败轮污染", sum.medianRtt === 175, String(sum.medianRtt));
  const tr = RL.toTrend([{ rtt: 100, ok: true }, { rtt: 400, ok: true }]);
  check("走势取倒数:低 RTT 反而更高", tr[0] > tr[1], tr.map(v => v.toFixed(2)).join(","));
  check("safeOrigin 拒绝非法 URL", RL.safeOrigin("not a url") === null && RL.safeOrigin("javascript:alert(1)") === null);
  check("safeOrigin 保留合法 https", RL.safeOrigin("https://aixoras.com/v1") === "https://aixoras.com");

  console.log("\n【坑 #1 浏览器探测必须串行(并行会让 RTT 失真)】");
  let inflight = 0, peak = 0, calls = [];
  const serial = load({
    fetch: (url, init) => {
      inflight++; peak = Math.max(peak, inflight);
      calls.push({ url, init });
      return new Promise(res => setTimeout(() => { inflight--; res({}); }, 12)).then(() => ({ rtt: 5, ok: true }));
    },
  }).ctx.window.RLSpeedProbe;
  await serial.runProbe("https://aixoras.com", 5, 4000, () => {});
  check("并发峰值 = 1(严格串行)", peak === 1, "peak=" + peak);
  check("确实发了 5 轮", calls.length === 5, String(calls.length));

  console.log("\n【坑 #2 防缓存三件套 + no-cors 语义】");
  const c0 = calls[0];
  check("method=HEAD", c0.init.method === "HEAD");
  check("mode=no-cors(承认拿不到响应体)", c0.init.mode === "no-cors");
  check("cache=no-store", c0.init.cache === "no-store");
  check("带时间戳 query 防缓存", /\?probe=\d{10,}/.test(c0.url), c0.url);
  check("带 AbortSignal(超时可中断)", !!c0.init.signal);

  console.log("\n【失败轮如实记不可达,不当 0ms】");
  const flaky = load({
    fetch: () => Promise.reject(new Error("network down")),
  }).ctx.window.RLSpeedProbe;
  const bad = await flaky.runProbe("https://gone.example", 3, 300, () => {});
  const bs = flaky.summarize(bad, 3);
  check("全失败时可达率 0%", bs.reachability === 0);
  check("全失败时中位数为 null(不是 0)", bs.medianRtt === null, String(bs.medianRtt));

  console.log("\n【弹窗与口径诚实性(源码断言)】");
  check("云端区标注为档案而非实时", /我们探针的最近一次流式实测\(档案\)/.test(src));
  check("有专门的口径声明块", /口径说明/.test(src) && /探针历史.*而非本次实时|探针档案.*非本次实时/.test(src));
  check("浏览器区标注本次实时", /本次实时测量|此刻从你的设备真实发出/.test(src));
  check("写明 HEAD 往返测不到首字,真首字走自带 Key 实测", /HEAD 往返因跨域限制.*测不到首字/.test(src) && /自带 Key 实测/.test(src));
  check("runId 作废机制存在", /runId\s*!==\s*id/.test(src));
  check("同站复用避免重复打站", /browserCache\[st\.origin\]/.test(src));
  check("全不可达时给红色告警", /全部.*轮浏览器探测均失败/.test(src));
  // 档案里只有短请求口径,因此不得出现"短/长"切换控件(切了没数据的开关比没有更糟)
  check("不做长上下文假开关(无切换控件)", !/sp-mode|setMode|data-mode=/.test(src) && !/长上下文<\/button>/.test(src));

  console.log("\n【事件流:点按钮不得触发行跳转(曾在榜单跳页)】");
  check("监听器用捕获阶段(第 3 参 true)", /addEventListener\("click",\s*function[\s\S]{0,400?\},\s*true\)/.test(src) || /\.addEventListener\("click",\s*function\s*\([^)]*\)\s*\{[\s\S]*?\}\s*,\s*true\s*\)/.test(src));
  check("命中按钮即 stopPropagation", /closest\("\.sp-btn"\)[\s\S]{0,220}stopPropagation/.test(src));
  // 契约级模拟:捕获阶段拦到的事件必须同时 preventDefault + stopPropagation
  (function () {
    let opts = null, ev = { preventDefault() { this.pd = true }, stopPropagation() { this.sp = true }, target: { closest: sel => sel === ".sp-btn" ? { getAttribute: () => '{"name":"x","origin":null}' } : null } };
    const fakeDoc = {
      addEventListener(t, fn, o) { if (t === "click") opts = { fn, capture: o === true }; },
      removeEventListener() {}, getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] }),
      body: { appendChild() {} }, readyState: "complete",
    };
    const d = makeDom();
    const ctx = { document: Object.assign(fakeDoc, { createElement: d.document.createElement }), window: {}, console: { log() {}, warn() {}, error() {} }, Math, JSON, Date, String, Number, Array, Object, RegExp, Error, Promise, setTimeout, clearTimeout, AbortController: global.AbortController, URL, performance: { now: () => Date.now() } };
    vm.runInContext(src, vm.createContext(ctx));
    check("click 监听已注册且为捕获", !!opts && opts.capture === true, "capture=" + (opts && opts.capture));
    if (opts) { opts.fn(ev); check("点击按钮时 preventDefault+stopPropagation 均生效", !!ev.pd && !!ev.sp, `pd=${ev.pd} sp=${ev.sp}`); }
  })();
  // 反向契约:复用 .sp-btn 类名但没有 data-probe 的按钮(如"测试详情")绝不能被吞掉
  (function () {
    let opts = null;
    const ev2 = { preventDefault() { this.pd = true; }, stopPropagation() { this.sp = true; },
      target: { closest: sel => sel === ".sp-btn" ? { getAttribute: () => null, hasAttribute: () => false } : null } };
    const fakeDoc = {
      addEventListener(t, fn, o) { if (t === "click") opts = { fn, capture: o === true }; },
      removeEventListener() {}, getElementById: () => null,
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} }),
      body: { appendChild() {} }, readyState: "complete",
    };
    const ctx = { document: fakeDoc, window: {}, console: { log() {}, warn() {}, error() {} },
      setTimeout: () => 0, clearTimeout() {}, fetch: () => Promise.resolve({ ok: false }), encodeURIComponent, JSON, Math, Date, String, Number, Array, Object, RegExp, Error };
    vm.runInContext(src, vm.createContext(ctx));
    if (opts) opts.fn(ev2);
    check("无 data-probe 的 .sp-btn 不被吞(测试详情按钮曾因此点了没反应)", !ev2.pd && !ev2.sp, `pd=${ev2.pd} sp=${ev2.sp}`);
  })();
  // 宿主页面确实给行绑了跳转 —— 这正是必须捕获拦截的原因
  const rkSrc = fs.readFileSync(DIR + "ranking.html", "utf8");
  check("前提成立:榜单行本身绑了跳详情", /tr\.addEventListener\("click"/.test(rkSrc));
  const rk = fs.readFileSync(DIR + "ranking.html", "utf8");
  const dt = fs.readFileSync(DIR + "detail.html", "utf8");
  check("ranking 引了 css+js", /speedprobe\.css/.test(rk) && /speedprobe\.js/.test(rk));
  check("detail 引了 css+js", /speedprobe\.css/.test(dt) && /speedprobe\.js/.test(dt));
  check("按钮仅在 probe.origin 存在时渲染", /!s\.probe\|\|!s\.probe\.origin\)return""/.test(rk));
  // 移动端榜单显示卡片而非表格行,按钮必须两处都有,否则手机上"一眼看不到"
  check("桌面表格与移动卡片都挂测速按钮", (rk.match(/probeBtn\(s\)/g) || []).length >= 2,
    "出现 " + (rk.match(/probeBtn\(s\)/g) || []).length + " 处");
  check("示例站不带测速(源码含真实域名的站才出)", /rs\.probe\.origin/.test(dt));
  check("data-probe 做了属性转义", /replace\(\/"\/g,"&quot;"\)/.test(rk) && /replace\(\/"\/g,"&quot;"\)/.test(dt));
  const j = JSON.parse(fs.readFileSync(DIR + "data/sites.json", "utf8"));
  check("实测站有 probe.origin 且 endpoint 合规", j.realSites.every(r => /^https:\/\//.test(r.probe.origin) && /\/v1\/chat\/completions$/.test(r.probe.endpoint)));
  check("占位站不下发 probe", !j.realSites.some(r => r.probe && /invalid\.relaylens\.invalid/.test(r.probe.origin || "")));

  /* ---- 弹窗三态(2026-10-03 流式真伪口径修正):专项结论 stream/buffered/mixed + 老批次回退 ---- */
  const sp = fs.readFileSync(DIR + "assets/speedprobe.js", "utf8");
  check("弹窗徽章用专项结论(streamVerdict)而非裸 bufferedRate", /streamVerdict;[\s\S]{0,120}v === "stream"[\s\S]{0,80}真流式/.test(sp) && /v === "mixed"[\s\S]{0,120}混合/.test(sp));
  check("弹窗徽章有 mixed(混合)档且展示伪流占比", /混合 · 伪流 /.test(sp));
  check("弹窗逐轮明细三态:缓冲/逐块/短答案不可判", /短答案·真伪由专项判/.test(sp) && /缓冲一次下发/.test(sp) && /逐块到达/.test(sp));
  check("弹窗展示专项取样说明(3 次/真伪次数)", /流式真伪专项/.test(sp) && /次长输出取样/.test(sp));
  check("老批次(无 streamVerdict)回退短循环口径且标注", /老批次:无专项/.test(sp));
  /* ---- 自带 Key 实测(2026-10-03) ---- */
  check("自带 key:输入框为 password 类型且 autocomplete 关闭", /type="password" id="spKey"/.test(sp) && /autocomplete="off"/.test(sp));
  check("自带 key:key 不落任何存储(无 localStorage/sessionStorage)", !/localStorage|sessionStorage/.test(sp));
  check("自带 key:3 次换措辞长输出(与云端探针同口径)", (sp.match(/写(一段|一篇)大约/g) || []).length >= 3 && /KEY_PROMPTS/.test(sp));
  check("自带 key:判定阈值与探针一致(chunks≥10&span≥800 / chunks≤5&span<200 / <80字不可判)",
    /chunks >= 10 && span >= 800/.test(sp) && /chunks <= 5 && span < 200/.test(sp) && /chars < 80/.test(sp));
  check("自带 key:聚合有 mixed 档(混合行为如实报,不硬归真/假)", /st > 0 && bf > 0 \? "mixed"/.test(sp));
  check("自带 key:CORS 失败如实报'跨域/拦截',不谎称站点不可用", /站点未开放浏览器跨域 CORS/.test(sp));
  check("自带 key:费用提示明示 3 次约 300 字输出由用户账户扣费", /3 次约 300 字输出的对话请求/.test(sp));
  check("自带 key:key 测试受同一 runId 作废机制保护(关弹窗后迟到响应不渲染)",
    /function runK\(i\) \{[\s\S]{0,120}runId !== id/.test(sp) && /runK\(0\)\.then[\s\S]{0,80}runId !== id/.test(sp));
  // 聚合函数行为级验证(真实调用,非正则)
  const RL2 = load().RL;
  check("keyAggregate:全流式→stream", RL2.keyAggregate([{ ok: true, verdict: "stream" }, { ok: true, verdict: "stream" }, { ok: true, verdict: "stream" }]).verdict === "stream");
  check("keyAggregate:交叉→mixed", RL2.keyAggregate([{ ok: true, verdict: "stream" }, { ok: true, verdict: "buffered" }, { ok: true, verdict: "stream" }]).verdict === "mixed");
  check("keyAggregate:全缓冲→buffered", RL2.keyAggregate([{ ok: true, verdict: "buffered" }, { ok: true, verdict: "buffered" }]).verdict === "buffered");
  check("keyAggregate:失败轮不参与判定", RL2.keyAggregate([{ ok: false, error: "x" }, { ok: true, verdict: "stream" }]).judged === 1);
  // 数据侧:线上 JSON 里的专项字段完整
  const mixedSite = j.realSites.find(r => r.probe && r.probe.archived && r.probe.archived.streamVerdict === "mixed");
  const streamSite = j.realSites.find(r => r.probe && r.probe.archived && r.probe.archived.streamVerdict === "stream");
  check("数据里有 stream 结论站点", !!streamSite, streamSite ? streamSite.name : "无");
    check("stream∈(0,100) 的站数据完整(新格式带 bufferedPct,旧格式批次容忍)", j.realSites.filter(r => typeof r.stream === "number" && r.stream > 0 && r.stream < 100).every(r => (r.probe && r.probe.archived && (typeof (r.probe.archived.streamCheck && r.probe.archived.streamCheck.bufferedPct) === "number" || typeof r.probe.archived.bufferedRate === "number"))));
  check("专项 trials 明细随 archived 下发", !j.realSites.some(r => r.probe && r.probe.archived && r.probe.archived.streamVerdict && !r.probe.archived.streamCheck));

  console.log(`\n${fail === 0 ? "✓ 全部通过" : "✗ 有失败"} · ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
