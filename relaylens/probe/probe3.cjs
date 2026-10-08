process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const fs = require("fs");
// 直接读 env 文件
const env = fs.readFileSync("config/secrets/sites.env", "utf8");
const K = n => (env.match(new RegExp("^" + n + "=(.+)$", "m")) || [])[1];

const targets = [
  { n: "toonflow", o: "https://api.toonflow.net", k: K("RL_API_TOONFLOW_NET_API_KEY"), paths: ["/api/pricing", "/v1/models", "/api/status", "/api/about"] },
  { n: "api75", o: "https://www.75api.com", k: K("RL_75API_COM_API_KEY"), paths: ["/api/pricing"] },
  { n: "ricktoken", o: "https://ricktoken.top", k: K("RL_RICKTOKEN_TOP_API_KEY"), paths: ["/api/pricing", "/v1/models", "/api/status"] },
];

function classify(txt) {
  try {
    const j = JSON.parse(txt);
    if (j && Array.isArray(j.data) && j.group_ratio) return { kind: "newapi-pricing", models: j.data.length, groups: Object.keys(j.group_ratio).length, tiered: j.data.filter(x => x.billing_mode === "tiered_expr").length };
    if (j && Array.isArray(j.data) && j.data[0] && j.data[0].id) return { kind: "models-list", models: j.data.length };
    if (j && j.success === false) return { kind: "api-error", msg: String(j.message || "").slice(0, 60) };
    return { kind: "json-other", keys: Object.keys(j || {}).slice(0, 8).join(",") };
  } catch (e) {
    return { kind: /^\s*<!doctype|<html/i.test(txt) ? "html" : "text", len: txt.length };
  }
}

(async () => {
  for (const t of targets) {
    for (const p of t.paths) {
      for (const auth of [true, false]) {
        try {
          const r = await fetch(t.o + p, {
            headers: Object.assign({ "User-Agent": "Mozilla/5.0 RelayLens-Probe/0.1" }, auth && t.k ? { Authorization: "Bearer " + t.k } : {}),
            signal: AbortSignal.timeout(60000),
            redirect: "follow",
          });
          const txt = await r.text();
          const c = classify(txt);
          console.log(t.n.padEnd(9), p.padEnd(13), auth ? "带key" : "匿名  ", "HTTP", r.status, JSON.stringify(c));
          if (c.kind === "newapi-pricing") { fs.writeFileSync("store/manual-imports/" + t.n + "-pricing-live.json", txt); console.log("   ★已存 store/manual-imports/" + t.n + "-pricing-live.json"); }
          if (c.kind === "newapi-pricing" || (c.kind === "models-list" && p !== "/api/pricing")) break;
        } catch (e) {
          console.log(t.n.padEnd(9), p.padEnd(13), auth ? "带key" : "匿名  ", "ERR", e.name, String(e.message).slice(0, 50));
        }
      }
    }
  }
})();
