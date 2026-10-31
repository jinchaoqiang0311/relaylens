/* Time-bucketed PF test: bucket fn, scoring policy, versioning, frontend wiring.
   口径沿革:2026-10-10.1 双窗口分桶 + 取两桶较差值(悲观值);
            2026-10-22.1 用户拍板改「两桶中位数的均值」,本测试随之改判(勿再断言悲观值)。 */
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
/* 2026-10-22.1 用户拍板:PF = 两桶中位数的均值(悲观较差值会让分数被最坏时段单独主导);
   均值与 partialBucket 兜底逻辑同在,这里一起守住。 */
ok(/\(workMs \+ offMs\) \/ 2/.test(asm.replace(/\s+/g, " ")), "PF = mean of two bucket medians");
ok(!asm.includes("Math.max(workMs"), "pessimistic worse-bucket policy retired");
ok(asm.includes("partialBucket"), "partial bucket flagged when one side missing");
ok(asm.includes("-7 days"), "7-day window");

const sched = fs.readFileSync(__dirname + "/relaylens/probe/src/scheduler.ts", "utf8");
ok(sched.includes("perf_work") && sched.includes("perf_off"), "scheduler reads dual-window config");
ok(sched.includes("runPerfRound"), "perf round wired into scheduler");
const yaml = fs.readFileSync(__dirname + "/relaylens/probe/config/sites.yaml", "utf8");
ok(yaml.includes("perf_work") && yaml.includes("perf_off"), "cron windows in sites.yaml");

const w = JSON.parse(fs.readFileSync(__dirname + "/relaylens/shared/weights.json", "utf8"));
/* 版本只要求「有戳且 changelog 头部与之一致」,不锁具体号 —— 否则每次升版都要改测试;
   真正要守的是:均值口径这条变更必须在 changelog 里有据可查,且晚于 2026-10-10.1。 */
ok(/^\d{4}-\d{2}-\d{2}/.test(w.version || ""), "version stamped");
ok((w.changelog[0] || {}).version === w.version, "changelog head matches current version");
const meanEntry = (w.changelog || []).find(c => (c.change || "").includes("均值") && (c.change || "").includes("PF"));
ok(!!meanEntry, "changelog records mean-of-two-buckets policy");
ok(!!meanEntry && String(meanEntry.version) > "2026-10-10.1", "mean policy supersedes 2026-10-10.1");
ok(w.metrics.PF.normalize.includes("均值") && w.metrics.PF.normalize.includes("9–18 点=忙"), "PF.normalize matches implementation");
ok(w.scenes.all.PF === 5 && w.scenes.office.PF === 20, "scene weights unchanged");

const ranking = fs.readFileSync(__dirname + "/relaylens-home/ranking.html", "utf8");
ok(ranking.includes("function ttftDual"), "dual-value display function exists");
ok(ranking.includes("ttftWorkMs") && ranking.includes("ttftOffMs"), "applyRealData enriches bucket fields");
ok(ranking.includes("ttftPartialBucket"), "partial bucket honestly labeled");
ok(ranking.includes("10:30 / 每日 22:30"), "policy banner updated");
const method = fs.readFileSync(__dirname + "/relaylens-home/method.html", "utf8");
/* 方法论页必须公示当前口径:均值(而非已废止的悲观值),并写明是用户拍板 + 生效日期 */
ok(/两桶中位数的均值/.test(method) && /2026-10-22/.test(method), "method.html discloses mean policy");
ok(!/PF = 两桶较差值/.test(method), "method.html no longer claims pessimistic policy");

const scripts = [...ranking.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");
try { new Function(scripts); ok(true, "ranking inline script syntax ok"); }
catch (e) { ok(false, "ranking inline script syntax error: " + e.message); }

console.log("pf_timebucket: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);