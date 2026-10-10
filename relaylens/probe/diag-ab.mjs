// A/B:探针 UA+探针 prompt vs 裸 UA+诊断 prompt,同一时刻对 aicost 各跑一次
const base = "https://www.aicost.me/v1";
const key = process.env.AICOST_API_KEY;
async function once(label, ua, prompt, maxTokens) {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 90000);
  const t0 = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST", signal: ctrl.signal,
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${key}`, ...(ua ? { "User-Agent": ua } : {}) },
    body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, stream: true, temperature: 0 }),
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
  console.log(label, JSON.stringify({ chunks, chars, firstContent: firstC, span: firstC !== null && lastC !== null ? lastC - firstC : null }));
}
await once("A 探针UA+探针prompt(600) ", "RelayLens-Probe/0.1", "写一段大约200字的短文,介绍河流的成因,直接开始正文。", 600);
await once("B 裸UA+诊断prompt(800) ", null, "写一篇大约300字的短文,介绍河流的成因。", 800);
await once("C 探针UA+诊断prompt(800) ", "RelayLens-Probe/0.1", "写一篇大约300字的短文,介绍河流的成因。", 800);
await once("D 裸UA+探针prompt(600) ", null, "写一段大约200字的短文,介绍河流的成因,直接开始正文。", 600);
