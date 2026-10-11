#!/usr/bin/env node
/* RelayLens API admin CLI: moderate reviews/submissions/claims queues. */
const BASE = process.env.RL_API_BASE;
const TOKEN = process.env.RL_ADMIN_TOKEN;
if (!BASE || !TOKEN) { console.error("missing RL_API_BASE or RL_ADMIN_TOKEN env"); process.exit(1); }

const cmd = process.argv[2], type = process.argv[3], id = process.argv[4], verdict = process.argv[5], reason = process.argv[6];

async function main() {
  if (cmd === "queue") {
    const st = id || "pending";
    const r = await fetch(BASE + "/admin/queue?type=" + type + "&status=" + st, { headers: { "X-Admin-Token": TOKEN } });
    const j = await r.json();
    if (!r.ok) { console.error(j); process.exit(1); }
    console.log("[" + type + "/" + j.status + "] " + j.count + " items:");
    for (const it of j.items) {
      if (type === "reviews") console.log("  " + it.id + " stars=" + it.stars + " [" + it.site + "] " + String(it.text).slice(0, 60));
      else if (type === "submissions") console.log("  " + it.id + " " + it.created_at + " " + String(it.payload).slice(0, 80));
      else console.log("  " + it.id + " [" + it.site + "] " + it.domain);
    }
    return;
  }
  if (cmd === "decide") {
    if (!type || !id || ["approve", "reject"].indexOf(verdict) < 0) {
      console.error("usage: decide <reviews|submissions|claims> <id> <approve|reject> [reason]");
      process.exit(1);
    }
    const r = await fetch(BASE + "/admin/" + type + "/" + id + "/decision", {
      method: "POST",
      headers: { "X-Admin-Token": TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ approve: verdict === "approve", reason: reason || null }),
    });
    const j = await r.json();
    console.log(r.ok ? "OK " + j.id + " -> " + j.status : JSON.stringify(j));
    if (!r.ok) process.exit(1);
    return;
  }
  console.error("usage: admin.cjs queue <reviews|submissions|claims> [status] | decide <type> <id> <approve|reject> [reason]");
  process.exit(1);
}
main().catch(e => { console.error(e.message); process.exit(1); });