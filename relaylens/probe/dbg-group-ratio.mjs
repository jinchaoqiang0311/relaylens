
import fs from "node:fs";
const env = fs.readFileSync("config/secrets/sites.env", "utf8");
function key(name) { const m = env.match(new RegExp("^" + name + "=(.+)$", "m")); return m && m[1].trim(); }
const SITES = [
  { n: "aixoras", o: "https://api.aixoras.com", k: key("AIXORAS_API_KEY") },
  { n: "wolfai", o: "https://wolfai.top", k: key("RL_WOLFAI_TOP_API_KEY") },
  { n: "memecode", o: "https://memecode.de", k: key("RL_MEMECODE_DE_API_KEY") },
  { n: "thinkai", o: "https://thinkai.tv", k: key("RL_THINKAI_TV_API_KEY") },
  { n: "boxying", o: "https://boxying.com", k: key("RL_BOXYING_COM_API_KEY") },
];
const WATCH = ["gpt-5.5", "claude-sonnet-5", "claude-opus-5", "deepseek-v4.1-flash"];
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
for (const s of SITES) {
  try {
    const r = await fetch(s.o + "/api/pricing", { headers: { Authorization: "Bearer " + s.k, "User-Agent": "RelayLens-Probe/0.1" } });
    if (!r.ok) { console.log(s.n, "HTTP", r.status); continue; }
    const j = await r.json();
    const gr = j.group_ratio || {};
    console.log("==== " + s.n + " ==== 组倍率表:", JSON.stringify(gr));
    for (const m of (j.data || [])) {
      if (!WATCH.includes(m.model_name)) continue;
      const g = m.enable_groups || [];
      const priced = g.map(x => ({ g: x, r: gr[x], in: m.model_ratio * (gr[x] ?? 0) * 2 }));
      console.log("  " + m.model_name + " model_ratio=" + m.model_ratio + " 各组$价:", JSON.stringify(priced));
    }
  } catch (e) { console.log(s.n, "ERR", e.message); }
}
