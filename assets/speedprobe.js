/* RelayLens 测速直达 · 零依赖 vanilla 实现
 *
 * 与规格的两处刻意差异(因为我们是静态站,必须说清而不是假装):
 * ① 云端视角 = 我们探针**最近一次 perf 批次的档案实测**(带日期与批次号),不是本次实时。
 * 静态站没有服务端探针,若伪造一个"正在云端探测"的动画就是撒谎。规格第 1 章第 7 条
 * 要求的正是"明确区分哪些是真实测量、哪些是档案数据",这里照办。
 * ② 不做「短请求/长上下文」切换 —— 那需要能实时发起长上下文探测的后端;档案里只有短请求
 * 口径,给一个切不动或切了没数据的开关比没有更糟。
 *
 * 浏览器视角是 100% 真实测量:HEAD + no-cors 串行 5 轮,逐轮回填指示灯。
 */
(function (global) {
 "use strict";

 var ROUNDS = 5, TIMEOUT_MS = 4000;

 /* ---------- 浏览器视角探测(规格第 3 章,逻辑照搬) ---------- */
 function safeOrigin(u) {
 try { var x = new URL(String(u)); return x.protocol === "https:" || x.protocol === "http:" ? x.origin : null; }
 catch (e) { return null; }
 }
 function probeOnce(origin, timeoutMs) {
 var ctrl = new AbortController();
 var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
 var t0 = performance.now();
 // no-cors:拿不到响应体,但请求真实发出;resolve 即证明 DNS/TLS/路由全通 = 可达
 // cache:no-store + 时间戳 query 双重防缓存,否则后几轮会命中缓存得到个位数假 RTT
 return fetch(origin + "/?probe=" + Date.now(), {
 method: "HEAD", mode: "no-cors", signal: ctrl.signal, cache: "no-store",
 }).then(function () {
 return { rtt: Math.round(performance.now() - t0), ok: true };
 }, function () {
 return { rtt: null, ok: false };
 }).then(function (s) { clearTimeout(timer); return s; });
 }
 function median(a) {
 if (!a.length) return null;
 var s = a.slice().sort(function (x, y) { return x - y }), m = Math.floor(s.length / 2);
 return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
 }
 /**
 * 必须串行(for + then 链),严禁 Promise.all:
 * 并行会因浏览器同域连接复用/排队让 RTT 失真,且失去逐轮点亮的动效节奏。
 */
 function runProbe(origin, rounds, timeoutMs, onSample) {
 var samples = [], i = 0;
 function step() {
 if (i >= rounds) return Promise.resolve(samples);
 return probeOnce(origin, timeoutMs).then(function (s) {
 samples.push(s); onSample(s, i); i++; return step();
 });
 }
 return step();
 }
 function summarize(samples, rounds) {
 var ok = samples.filter(function (s) { return s.ok && s.rtt !== null }).map(function (s) { return s.rtt });
 return {
 samples: samples,
 medianRtt: median(ok),
 jitter: ok.length >= 2 ? Math.max.apply(null, ok) - Math.min.apply(null, ok) : null,
 reachability: Math.round(ok.length / rounds * 100),
 };
 }
 /* RTT 越低越好 → 取倒数再归一,走势线"越高越快" */
 function toTrend(samples) {
 var v = samples.map(function (s) { return s.ok && s.rtt !== null ? 1000 / Math.max(s.rtt, 1) : 0 });
 var max = Math.max.apply(null, v.concat([1e-6]));
 return v.map(function (x) { return x / max });
 }

 /* ---------- SVG Sparkline(零依赖) ---------- */
 function sparkline(data, color, w, h) {
 w = w || 110; h = h || 22;
 if (!data || data.length < 2) return "";
 var max = Math.max.apply(null, data), min = Math.min.apply(null, data), span = (max - min) || 1;
 var step = w / (data.length - 1);
 var pts = data.map(function (v, i) { return [i * step, h - 2 - ((v - min) / span) * (h - 5)] });
 var line = pts.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1) }).join(" ");
 var last = pts[pts.length - 1], gid = "sg" + Math.random().toString(36).slice(2, 8);
 return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" role="img" aria-label="往返延迟趋势" style="overflow:visible">' +
 '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1">' +
 '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.32"/><stop offset="100%" stop-color="' + color + '" stop-opacity="0"/>' +
 '</linearGradient></defs>' +
 '<path d="' + line + ' L' + w + ',' + h + ' L0,' + h + ' Z" fill="url(#' + gid + ')"/>' +
 '<path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>' +
 '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="2" fill="' + color + '"/></svg>';
 }

 /* ---------- 弹窗 ---------- */
 var runId = 0, browserCache = {}; // key=origin → 本轮浏览器探测结果(切站点复用无意义,只防同站重开重复测)
 function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") }

 /* 流式真伪三态(与探针 2026-10-03 修正后的口径一致):
 * 长输出专项(3 次换措辞取样)结论优先——stream/buffered/mixed;
 * 没有专项的老批次退回短循环 bufferedRate;都没有 = 无档案。
 * 不能只看 bufferedRate:短 prompt 答案只有 2 个字,真流式站也会单 chunk 交付。 */
 function streamBadge(arch) {
 if (!arch) return '<span class="sp-badge mute">无档案</span>';
 var v = arch.streamVerdict;
 if (v === "stream") return '<span class="sp-badge pass">真流式</span>';
 if (v === "buffered") return '<span class="sp-badge alert">伪流式</span>';
 if (v === "mixed") return '<span class="sp-badge amber">混合 · 伪流 ' + (arch.bufferedRate != null ? arch.bufferedRate + "%" : "?") + '</span>';
 if (arch.bufferedRate != null) // 老批次:无专项,短循环口径(注明不可靠)
 return '<span class="sp-badge ' + (arch.bufferedRate === 0 ? "pass" : "alert") + '">' + (arch.bufferedRate === 0 ? "真流" : "假流 " + arch.bufferedRate + "%") + '</span>';
 return '<span class="sp-badge mute">无档案</span>';
 }
 function streamCheckNote(sc) {
 if (sc.verdict === "stream") return sc.trials + " 次长输出取样全部真流式(逐 token 下发)";
 if (sc.verdict === "buffered") return sc.trials + " 次长输出取样全部伪流式(整段缓冲后一次性下发)";
 if (sc.verdict === "mixed") return sc.trials + " 次长输出取样中 " + sc.streamed + " 次真流式 / " + sc.bufferedTrials + " 次伪流式——不同请求行为不一致,疑似多渠道路由";
 return sc.trials + " 次取样均不可判(" + (sc.lastError || "样本不足") + ")";
 }
 /* 逐轮的流式标注三态:短答案(2 字)单 chunk 是真流式常态,判不了真伪,不能标"逐块到达" */
 function roundStreamLabel(b) {
 if (b === true) return "缓冲一次下发";
 if (b === false) return "逐块到达";
 return "短答案·真伪由专项判";
 }

 /* ---------- 自带 Key 实测(2026-10-03):用户 key 从浏览器直连站点,测真 TTFT + 流式真伪 ----------
 * 口径与云端探针完全一致:3 次长输出、每次换措辞、同阈值(见 KEY_VERDICT)。
 * 原因:单措辞会被"混合行为"站点骗过(aicost 对「写一篇…300字…」100% 缓冲、对「写一段…」100% 真流)。
 * key 安全:仅存于本页内存与输入框,不落任何浏览器存储、不上报本站、弹窗关闭即丢弃。 */
 var KEY_PROMPTS = [
 "写一段大约200字的短文,介绍河流的成因,直接开始正文。",
 "写一篇大约300字的短文,介绍河流的成因。",
 "写一段大约400字的文字,介绍季风的形成,直接开始正文。",
 ];
 var KEY_MAX_TOKENS = 600, KEY_TIMEOUT_MS = 90_000;
 function KEY_VERDICT(chunks, span, chars) {
 if (chars < 80) return "unknown";
 if (chunks >= 10 && span >= 800) return "stream";
 if (chunks <= 5 && span < 200) return "buffered";
 return "unknown";
 }
 function keyTrial(endpoint, key, model, prompt, onFirstChunk) {
 return new Promise(function (resolve) {
 var ctrl = new AbortController();
 var timer = setTimeout(function () { ctrl.abort(); }, KEY_TIMEOUT_MS);
 var t0 = performance.now();
 fetch(endpoint, {
 method: "POST", signal: ctrl.signal,
 headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
 body: JSON.stringify({ model: model, messages: [{ role: "user", content: prompt }], max_tokens: KEY_MAX_TOKENS, stream: true, temperature: 0 }),
 }).then(function (res) {
 if (!res.ok || !res.body) {
 clearTimeout(timer);
 res.text().then(function (tx) {
 resolve({ ok: false, error: "HTTP " + res.status + " " + String(tx).slice(0, 80) });
 }, function () { resolve({ ok: false, error: "HTTP " + res.status }) });
 return;
 }
 var reader = res.body.getReader(), dec = new TextDecoder();
 var buf = "", chunks = 0, chars = 0, firstC = null, lastC = null, done = false;
 function finish() {
 if (done) return; done = true; clearTimeout(timer);
 var span = firstC !== null && lastC !== null ? Math.round(lastC - firstC) : null;
 resolve({
 ok: true, chunks: chunks, chars: chars, spanMs: span,
 ttftMs: firstC !== null ? Math.round(firstC) : null,
 verdict: KEY_VERDICT(chunks, span === null ? -1 : span, chars),
 });
 }
 function pump() {
 reader.read().then(function (r) {
 if (r.done) { finish(); return }
 var now = performance.now();
 buf += dec.decode(r.value, { stream: true });
 var i;
 while ((i = buf.indexOf("\n")) >= 0) {
 var line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
 if (line.indexOf("data:") !== 0) continue;
 var payload = line.slice(5).trim();
 if (payload === "[DONE]") continue;
 try {
 var delta = JSON.parse(payload).choices[0].delta.content;
 if (typeof delta === "string" && delta) {
 chunks++; chars += delta.length;
 if (firstC === null) { firstC = now - t0; if (onFirstChunk) onFirstChunk(Math.round(firstC)); }
 lastC = now - t0;
 }
 } catch (e) { }
 }
 pump();
 }, function () { finish() });
 }
 pump();
 }, function (err) {
 clearTimeout(timer);
 // 浏览器 fetch 对 CORS 拒绝/网络失败都抛 TypeError,分不出两者,如实说
 resolve({ ok: false, error: "请求未能发出或被拦截(站点未开放浏览器跨域 CORS,或网络不通)" });
 });
 });
 }
 function keyAggregate(trials) {
 var st = 0, bf = 0;
 trials.forEach(function (t) { if (t.ok) { if (t.verdict === "stream") st++; else if (t.verdict === "buffered") bf++ } });
 var known = st + bf;
 return {
 verdict: known === 0 ? "unknown" : st > 0 && bf > 0 ? "mixed" : st > 0 ? "stream" : "buffered",
 streamed: st, buffered: bf, judged: known,
 };
 }

 function tpl(st) {
 var arch = st.archived;
 return '<div class="sp-mask" id="spMask" role="dialog" aria-modal="true" aria-label="测速直达">' +
 '<div class="sp-dlg"><div class="sp-head">' +
 '<button class="sp-x" type="button" id="spX" aria-label="关闭">×</button>' +
 '<div class="sp-eyebrow">SPEED PROBE / 双视角实测</div>' +
 '<div class="sp-title">' + esc(st.name) + ' · 链路测速</div>' +
 '<div class="sp-sub">目标 ' + esc(st.origin || "—") + (st.endpoint ? ' · ' + esc(st.endpoint) : '') + '</div>' +
 '</div>' +

 /* 云端(档案)指标带 */
 '<div class="sp-sec">云端视角 · 我们探针的最近一次流式实测(档案)</div>' +
 '<div class="sp-band c2">' +
 '<div class="sp-cell"><div class="sp-k">首字延迟中位数</div>' +
 '<div class="sp-v ' + (arch && arch.medianTtftMs != null ? "" : "mute") + '" id="spTtft">' +
 (arch && arch.medianTtftMs != null ? arch.medianTtftMs + "ms" : "无档案") + '</div>' +
 (arch ? '<div class="sp-note">P95 ' + (arch.p95TtftMs != null ? arch.p95TtftMs + "ms" : "—") + ' · 成功率 ' + (arch.successRate != null ? arch.successRate + "%" : "—") + '</div>' : '') +
 '</div>' +
 '<div class="sp-cell"><div class="sp-k">流式完整性判定</div><div style="margin-top:5px">' +
 streamBadge(arch) +
 '</div>' + (arch ? '<div class="sp-note">' + esc(arch.probedAt.slice(0, 16).replace("T", " ")) + ' UTC · ' + esc(arch.batchId) + '</div>' : '') + '</div>' +
 '</div>' +
 (arch && arch.streamCheck && arch.streamCheck.trials ? '<div class="sp-note" style="margin-top:6px">流式真伪专项:' + esc(streamCheckNote(arch.streamCheck)) + '</div>' : '') +
 (arch && arch.rounds && arch.rounds.length
 ? '<ol class="sp-rounds" style="margin-top:8px">' + arch.rounds.map(function (r) {
 return '<li><span class="sp-dot ' + (r.ok ? "ok" : "fail") + '"></span><span class="lbl">云端第 ' + r.seq + ' 轮' +
 (r.failureType ? "(" + esc(r.failureType) + ")" : "") + '</span>' +
 (r.ok ? '<span class="val">首字 ' + (r.ttftMs != null ? r.ttftMs : "—") + 'ms · in ' + (r.inTok != null ? r.inTok : "—") +
 ' tok · ' + roundStreamLabel(r.buffered) + '</span>'
 : '<span class="val alert">' + esc(r.error || "失败") + '</span>') + '</li>';
 }).join("") + '</ol>'
 : '') +
 '<div class="sp-alert-box">上方云端数据是<b>我们探针的历史档案</b>(非本次实时),探测时间与批次号已标注;它反映的是我们节点当时的表现。</div>' +

 /* 浏览器实时探测 */
 '<div class="sp-sec">浏览器视角 · ' + ROUNDS + ' 次 HEAD 往返(本次实时测量)</div>' +
 '<ol class="sp-rounds" id="spList">' + Array.apply(null, { length: ROUNDS }).map(function (_, i) {
 return '<li data-i="' + i + '"><span class="sp-dot wait"></span><span class="lbl">第 ' + (i + 1) + ' 轮往返探测</span></li>';
 }).join("") + '</ol>' +
 '<div class="sp-band c3" id="spBand">' +
 '<div class="sp-cell"><div class="sp-k">RTT 中位数</div><div class="sp-v mute" id="spMedian">探测中</div></div>' +
 '<div class="sp-cell"><div class="sp-k">抖动</div><div class="sp-v mute" id="spJitter">—</div></div>' +
 '<div class="sp-cell"><div class="sp-k">可达率</div><div class="sp-v mute" id="spReach">—</div></div>' +
 '</div>' +
 '<div id="spExtra"></div>' +

 /* 自带 Key 实测:浏览器直连站点,真 TTFT + 流式真伪(与云端探针同口径) */
 '<div class="sp-sec">自带 Key 实测 · 你的 key 从本浏览器直连站点(可选)</div>' +
 '<div class="sp-keyrow">' +
 '<input type="password" id="spKey" placeholder="粘贴该站 API Key(sk-…)" autocomplete="off" spellcheck="false" aria-label="API Key">' +
 '<input type="text" id="spModel" value="' + esc(arch && arch.model ? arch.model : "") + '" placeholder="模型名(如 gpt-5.5)" aria-label="模型名">' +
 '<button class="sp-run" id="spRunKey" type="button">实测流式真伪</button>' +
 '</div>' +
 '<ol class="sp-rounds" id="spKeyList" style="display:none"></ol>' +
 '<div id="spKeyOut"></div>' +
 '<p class="sp-note">实测将向该站发起 <b>3 次约 300 字输出的对话请求</b>(合计约 1K tokens 输出),费用按你账户的计价扣除。' +
 'key 仅存于本页内存:不写入浏览器存储、不发送到本站以外的任何地方,关闭弹窗即丢弃。' +
 '若该站未开放浏览器跨域(CORS),请求会被拦截而失败——这说明它不允许网页端直连,不代表站点不可用。' +
 '判定口径与云端探针一致:3 次换措辞长输出,防"混合行为"漏判。</p>' +

 /* 口径声明 */
 '<p class="sp-decl"><b>口径说明:</b>浏览器视角的 RTT / 抖动 / 可达率是<b>此刻从你的设备真实发出</b>的测量;' +
 'HEAD 往返因跨域限制(opaque response)测不到首字——要测<b>真首字与流式真伪</b>请用「自带 Key 实测」,' +
 '它用你的 key 向该站真实发起流式对话,与云端探针同口径(3 次换措辞长输出)。' +
 '云端档案是<b>探针历史</b>而非本次实时,两者时间点不同,请勿混读。所有档案数字均可在开源仓库按批次号复现。</p>' +
 '</div></div>';
 }

 function open(st) {
 var host = document.getElementById("spHost");
 if (!host) { host = document.createElement("div"); host.id = "spHost"; document.body.appendChild(host); }
 host.innerHTML = tpl(st);
 var mask = document.getElementById("spMask"), id = ++runId;
 function close() { runId++; if (mask && mask.parentNode) mask.parentNode.removeChild(mask); document.removeEventListener("keydown", onKey); }
 function onKey(e) { if (e.key === "Escape") close(); }
 document.getElementById("spX").addEventListener("click", close);
 mask.addEventListener("click", function (e) { if (e.target === mask) close(); });
 document.addEventListener("keydown", onKey);

 if (!st.origin) {
 document.getElementById("spExtra").innerHTML = '<div class="sp-alert-box red">档案中的域名无法解析为合法 URL,无法发起真实探测。</div>';
 return;
 }
 var list = document.getElementById("spList");
 function paint(samples) {
 var lis = list.querySelectorAll("li");
 for (var i = 0; i < lis.length; i++) {
 var dot = lis[i].querySelector(".sp-dot"), s = samples[i];
 dot.className = "sp-dot " + (s ? (s.ok ? "ok" : "fail") : (samples.length === i ? "run" : "wait"));
 var old = lis[i].querySelector(".val");
 if (old) old.parentNode.removeChild(old);
 if (s) {
 var el = document.createElement("span");
 el.className = "val" + (s.ok ? "" : " alert");
 el.textContent = s.ok ? s.rtt + "ms" : "超时/不可达";
 lis[i].appendChild(el);
 }
 }
 }
 // 同 origin 刚测过则复用:反复开关弹窗不该重复打站,也省一半请求
 var cached = browserCache[st.origin];
 if (cached) { paint(cached.samples); fill(cached); return; }

 var acc = [];
 runProbe(st.origin, ROUNDS, TIMEOUT_MS, function (s) {
 if (runId !== id) return; // 作废机制:旧轮次迟到响应不得覆盖新结果
 acc.push(s); paint(acc);
 }).then(function () {
 if (runId !== id) return;
 var r = summarize(acc, ROUNDS);
 browserCache[st.origin] = r;
 fill(r);
 }, function () {
 if (runId !== id) return;
 var r = summarize(acc, ROUNDS);
 fill(r);
 });

 /* ---------- 自带 Key 实测(可选):与上面 HEAD 往返相互独立,互不阻塞 ---------- */
 var runBtn = document.getElementById("spRunKey");
 if (runBtn) runBtn.addEventListener("click", function () {
 if (runId !== id) return;
 var keyEl = document.getElementById("spKey"), modelEl = document.getElementById("spModel");
 var key = keyEl ? keyEl.value.trim() : "", model = modelEl ? modelEl.value.trim() : "";
 var outEl = document.getElementById("spKeyOut"), listEl = document.getElementById("spKeyList");
 if (!outEl) return;
 if (!key) { outEl.innerHTML = '<div class="sp-alert-box red">请先粘贴该站的 API Key。</div>'; return; }
 if (!model) { outEl.innerHTML = '<div class="sp-alert-box red">请填模型名(可参照上方云端档案使用的模型)。</div>'; return; }
 runBtn.disabled = true; runBtn.textContent = "实测中…";
 outEl.innerHTML = ""; listEl.style.display = "";
 listEl.innerHTML = KEY_PROMPTS.map(function (_, i) {
 return '<li id="spKeyR' + i + '"><span class="sp-dot wait"></span><span class="lbl">长输出取样 ' + (i + 1) + '/3</span></li>';
 }).join("");
 var trials = [];
 function runK(i) {
 if (runId !== id) return Promise.resolve();
 var li = document.getElementById("spKeyR" + i);
 if (li) { var d = li.querySelector(".sp-dot"); if (d) d.className = "sp-dot run"; }
 return keyTrial(st.endpoint, key, model, KEY_PROMPTS[i]).then(function (t) {
 if (runId !== id) return;
 trials.push(t);
 var li2 = document.getElementById("spKeyR" + i);
 if (li2) {
 var dot2 = li2.querySelector(".sp-dot");
 if (dot2) dot2.className = "sp-dot " + (t.ok ? "ok" : "fail");
 var v = document.createElement("span");
 v.className = "val" + (t.ok && t.verdict === "buffered" ? " alert" : "");
 v.textContent = t.ok
 ? "首字 " + (t.ttftMs != null ? t.ttftMs : "—") + "ms · " + t.chars + "字/" + t.chunks + "块 · 跨度 " + (t.spanMs != null ? t.spanMs : "—") + "ms · " + (t.verdict === "stream" ? "逐 token 流式" : t.verdict === "buffered" ? "整段缓冲!" : "不可判")
 : (t.error || "失败");
 li2.appendChild(v);
 }
 if (i + 1 < KEY_PROMPTS.length) return new Promise(function (r) { setTimeout(r, 800) }).then(function () { return runK(i + 1) });
 });
 }
 runK(0).then(function () {
 if (runId !== id) return;
 runBtn.disabled = false; runBtn.textContent = "重测一次";
 if (!trials.length) { outEl.innerHTML = '<div class="sp-alert-box red">未能完成任何一次取样。</div>'; return; }
 var agg = keyAggregate(trials);
 var badge = agg.verdict === "stream" ? '<span class="sp-badge pass">真流式</span>'
 : agg.verdict === "buffered" ? '<span class="sp-badge alert">伪流式</span>'
 : agg.verdict === "mixed" ? '<span class="sp-badge amber">混合 · 伪流 ' + Math.round(agg.buffered / agg.judged * 100) + '%</span>'
 : '<span class="sp-badge mute">不可判</span>';
 var ttfts = trials.filter(function (t) { return t.ok && t.ttftMs != null }).map(function (t) { return t.ttftMs });
 var med = median(ttfts);
 var detail = agg.verdict === "stream" ? "3 次取样全部逐 token 下发,首字后内容持续到达。"
 : agg.verdict === "buffered" ? "3 次取样均为整段缓冲:首字要等全文生成完才来,流式名存实亡。"
 : agg.verdict === "mixed" ? "不同请求行为不一致(" + agg.streamed + " 次流式 / " + agg.buffered + " 次缓冲),疑似多渠道路由——你的实际体验取决于命中哪条。"
 : "输出长度或结构不足以判定(可换个更大的模型重试)。";
 outEl.innerHTML = '<div class="sp-band c3" style="margin-top:8px">' +
 '<div class="sp-cell"><div class="sp-k">你的实测结论</div><div style="margin-top:5px">' + badge + '</div></div>' +
 '<div class="sp-cell"><div class="sp-k">首字延迟中位</div><div class="sp-v ' + (med != null ? "" : "mute") + '">' + (med != null ? med + "ms" : "—") + '</div></div>' +
 '<div class="sp-cell"><div class="sp-k">有效取样</div><div class="sp-v">' + agg.judged + '/3</div></div>' +
 '</div><div class="sp-note" style="margin-top:6px">' + esc(detail) + '</div>';
 /* key 不落任何存储:结束后从输入框外的所有引用中自然丢弃(闭包随弹窗销毁) */
 });
 });
 }

 function fill(r) {
 var g = function (id) { return document.getElementById(id) };
 var med = g("spMedian"), jit = g("spJitter"), reach = g("spReach");
 if (!med) return;
 med.textContent = r.medianRtt !== null ? r.medianRtt + "ms" : "—";
 med.className = "sp-v" + (r.medianRtt === null ? " mute" : r.medianRtt < 300 ? "" : r.medianRtt < 900 ? " amber" : " alert");
 jit.textContent = r.jitter !== null ? "±" + r.jitter + "ms" : "—";
 reach.textContent = r.reachability + "%";
 reach.className = "sp-v" + (r.reachability === 100 ? " pass" : r.reachability === 0 ? " alert" : " amber");
 var extra = g("spExtra");
 if (!extra) return;
 var html = "";
 if (r.samples.length >= 2) {
 html += '<div class="sp-trend"><span class="sp-k">本次 RTT 走势(越高越快)</span>' +
 sparkline(toTrend(r.samples), r.reachability > 0 ? "#0d9488" : "#b42318") + '</div>';
 }
 if (r.reachability === 0) {
 html += '<div class="sp-alert-box red">全部 ' + ROUNDS + ' 轮浏览器探测均失败:该域名从当前访客网络不可达(可能已下线、被墙或 DNS 不通)。上方云端档案数据仍为该站历史表现。</div>';
 }
 extra.innerHTML = html;
 }

 function attach(root) {
 // 必须用捕获阶段 + stopPropagation:榜单整行 <tr> 绑了跳详情的 click,
 // 若在冒泡阶段(document)才处理,行的跳转已经先执行过了 → 点按钮变成跳页。
 (root || document).addEventListener("click", function (e) {
 var btn = e.target && e.target.closest ? e.target.closest(".sp-btn") : null;
 if (!btn) return;
 /* 必须先确认这是测速按钮再吞事件:早期版本先 preventDefault/stopPropagation 再看 data-probe,
 结果把同样复用 .sp-btn 类名的「测试详情」按钮点击吃掉了(点了没反应)。 */
 var data = btn.getAttribute("data-probe");
 if (!data) return;
 e.preventDefault();
 e.stopPropagation();
 try { open(JSON.parse(data)); } catch (err) { }
 }, true);
 }
 if (typeof document !== "undefined" && document.addEventListener) {
 if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { attach(); });
 else attach();
 }

 global.RLSpeedProbe = {
 runProbe: runProbe, summarize: summarize, toTrend: toTrend, median: median,
 safeOrigin: safeOrigin, sparkline: sparkline, open: open, attach: attach,
 keyTrial: keyTrial, keyAggregate: keyAggregate, KEY_PROMPTS: KEY_PROMPTS,
 ROUNDS: ROUNDS, _resetCache: function () { browserCache = {}; },
 };
})(typeof window !== "undefined" ? window : globalThis);
