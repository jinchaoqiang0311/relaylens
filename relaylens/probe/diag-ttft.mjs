/**
 * 诊断:抓一次完整 SSE 时间线,逐 chunk 记录到达时刻与 delta 结构。
 * 验证两件事:
 *  A. gpt-5.5 是否为推理模型(reasoning_content 在前、content 在后)→ TTFT 被思考时间污染
 *  B. 加长输出后内容是否真的一次性下发(伪流式)还是逐 token(真流式)
 */
const SITES = {
  aixoras: { base: process.env.AIXORAS_BASE || "https://api.aixoras.com", key: process.env.AIXORAS_API_KEY },
  aicost: { base: process.env.AICOST_BASE || "https://api.aicost.me", key: process.env.AICOST_API_KEY },
};
const siteName = process.argv[2] || "aixoras";
const MODE = process.argv[3] || "short"; // short = 复刻探针(收到) / long = 300字输出看流式真伪
const s = SITES[siteName];
if (!s?.key) { console.error("no key for", siteName); process.exit(1); }
const base = s.base.replace(/\/+$/, "") + (/\/v\d+/.test(s.base) ? "" : "/v1");

const PROMPT = MODE === "short" ? "只回复两个字:收到" : "写一篇大约300字的短文,介绍河流的成因。";
const MAXTOK = MODE === "short" ? 16 : 800;

const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 60000);
const t0 = Date.now();
const res = await fetch(`${base}/chat/completions`, {
  method: "POST", signal: ctrl.signal,
  headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${s.key}` },
  body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: PROMPT }], max_tokens: MAXTOK, stream: true, temperature: 0 }),
});
console.log(`HTTP ${res.status} · 响应头到达 +${Date.now() - t0}ms`);
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "", events = 0, firstAnyChunk = null, firstReasoning = null, firstContent = null, lastContent = null;
let reasoningChars = 0, contentChars = 0, sawReasoningField = false;
const timeline = [];
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const now = Date.now(); const rel = now - t0;
  if (firstAnyChunk === null) firstAnyChunk = rel;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") { timeline.push(`${rel}ms [DONE]`); continue; }
    events++;
    try {
      const j = JSON.parse(payload);
      const d = j?.choices?.[0]?.delta || {};
      if (typeof d.reasoning_content === "string" && d.reasoning_content) {
        sawReasoningField = true;
        if (firstReasoning === null) { firstReasoning = rel; timeline.push(`${rel}ms 首个 reasoning_content 块 (${d.reasoning_content.length}字)`); }
        reasoningChars += d.reasoning_content.length;
      }
      if (typeof d.content === "string" && d.content) {
        if (firstContent === null) { firstContent = rel; timeline.push(`${rel}ms 首个 content 块 ("${d.content.slice(0, 12)}")`); }
        lastContent = rel; contentChars += d.content.length;
      }
    } catch { }
  }
}
const end = Date.now() - t0;
timeline.push(`${end}ms 流结束`);
console.log(timeline.join("\n"));
console.log("---");
console.log(JSON.stringify({
  mode: MODE, events,
  首个任意网络chunk: firstAnyChunk,
  首个reasoning块: firstReasoning, reasoning总字数: reasoningChars || null, 有reasoning字段: sawReasoningField,
  首个content块: firstContent, 末个content块: lastContent, content总字数: contentChars,
  探针口径TTFT_仅content: firstContent,
  若含思考的TTFT: firstReasoning ?? firstContent,
  content生成跨度ms: firstContent != null && lastContent != null ? lastContent - firstContent : null,
}, null, 1));
