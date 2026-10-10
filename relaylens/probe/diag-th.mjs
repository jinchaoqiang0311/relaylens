// 阈值扫描:aicost 在哪个 max_tokens 上从真流式切到伪流式
const base = "https://www.aicost.me/v1";
const key = process.env.AICOST_API_KEY;
async function once(maxTokens) {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 90000);
  const t0 = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST", signal: ctrl.signal,
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "写一段大约200字的短文,介绍河流的成因,直接开始正文。" }], max_tokens: maxTokens, stream: true, temperature: 0 }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", chunks = 0, chars = 0, firstC = null, lastC = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const now = Date.now();
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const p = line.slice(5).trim();
      if (p === "[DONE]") continue;
      try {
        const d = (JSON.parse(p))?.choices?.[0]?.delta?.content;
        if (typeof d === "string" && d) { chunks++; chars += d.length; if (firstC === null) firstC = now - t0; lastC = now - t0; }
      } catch {}
    }
  }
  const span = firstC !== null && lastC !== null ? lastC - firstC : null;
  console.log(`max_tokens=${String(maxTokens).padEnd(5)} chunks=${String(chunks).padEnd(4)} chars=${String(chars).padEnd(4)} firstContent=${String(firstC).padStart(6)}ms span=${String(span).padStart(6)}ms ${span === 0 || chunks <= 2 ? "BUFFERED" : "STREAM"}`);
}
for (const mt of [600, 700, 750, 800, 1000, 1600]) await once(mt);
