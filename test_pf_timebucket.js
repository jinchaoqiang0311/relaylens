/* Time-bucketed PF (2026-10-10.1) test: bucket fn, pessimistic scoring, versioning, frontend wiring. */
const { execSync } = require("child_process");
const fs = require("fs");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.log("FAIL " + m); } }

const probe = `import { timeBucket } from "./src/probes/perf.js";
const cases = [
  ["2026-10-10T02:30:00.000Z","work"],
  ["2026-10-10T14:30:00.000Z","off"],
  ["2026-10-10T00:59:00.000Z","off"],
  ["2026-10-10T01:00:00.000Z","work"],
  ["2026-10-10T09:59:00.000Z","work"],
  ["2026-10-10T10:00:00.000Z","off"],
];
let bad = 0;
for (const [iso, want] of cases) { const got = timeBucket(iso); if (got !== want) { console.log("MISMATCH " + iso + " want=" + want + " got=" + got); bad++; } }
console.log(bad ? "BAD:" + bad : "OK"); process.exit(bad ? 1 : 0);`;
fs.writeFileSync(__dirname + "/relaylens/probe/.tmp-bucket-test.ts", probe);
try {
  const out = execSync("npx tsx .tmp-bucket-test.ts", { cwd: __dirname + "/relaylens/probe", encoding: "utf8", stdio: "pipe" });
  ok(out.includes("OK"), "timeBucket all correct");
} catch (e) {
  ok(false, "timeBucket failed: " + (e.stdout || e.message));
} finally {
  try { fs.unlinkSync(__dirname + "/relaylens/probe/.tmp-bucket-test.ts"); } catch {}
}

const asm = fs.readFileSync(__dirname + "/relaylens/probe/src/assemble.ts", "utf8");
ok(asm.includes("timeBucket("), "assemble buckets by time");
ok(asm.includes("Math.max(workMs, offMs)"), "PF = worse of two buckets (pessimistic)");
ok(asm.includes("partialBucket"), "partial bucket flagged when one side missing");
ok(asm.includes("-7 days"), "7-day window");

const sched = fs.readFileSync(__dirname + "/relaylens/probe/src/scheduler.ts", "utf8");
ok(sched.includes("perf_work") && sched.includes("perf_off"), "scheduler reads dual-window config");
ok(sched.includes("runPerfRound"), "perf round wired into scheduler");
const yaml = fs.readFileSync(__dirname + "/relaylens/probe/config/sites.yaml", "utf8");
ok(yaml.includes("perf_work") && yaml.includes("perf_off"), "cron windows in sites.yaml");

const w = JSON.parse(fs.readFileSync(__dirname + "/relaylens/shared/weights.json", "utf8"));
ok(w.version === "2026-10-10.1", "version bumped to 2026-10-10.1");
ok((w.changelog[0] || {}).version === "2026-10-10.1" && (w.changelog[0].change || "").includes("悲观值"), "changelog records new policy");
ok(w.metrics.PF.normalize.includes("较差桶") && w.metrics.PF.normalize.includes("9–18 点=忙"), "PF.normalize matches implementation");
ok(w.scenes.all.PF === 5 && w.scenes.office.PF === 20, "scene weights unchanged");

const ranking = fs.readFileSync(__dirname + "/relaylens-home/ranking.html", "utf8");
ok(ranking.includes("function ttftDual"), "dual-value display function exists");
ok(ranking.includes("ttftWorkMs") && ranking.includes("ttftOffMs"), "applyRealData enriches bucket fields");
ok(ranking.includes("ttftPartialBucket"), "partial bucket honestly labeled");
ok(ranking.includes("10:30 / 每日 22:30"), "policy banner updated");
const method = fs.readFileSync(__dirname + "/relaylens-home/method.html", "utf8");
ok(method.includes("悲观值,2026-10-10.1"), "method.html discloses new policy");

const scripts = [...ranking.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");
try { new Function(scripts); ok(true, "ranking inline script syntax ok"); }
catch (e) { ok(false, "ranking inline script syntax error: " + e.message); }

console.log("pf_timebucket: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);