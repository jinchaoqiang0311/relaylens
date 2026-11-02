/**
 * apply-reconcile-audit.cjs —— 把 store/audit/<site>-reconcile-*.json 的对账结论回填到
 * data/sites.json 的 details.<site>.audit,再由 slice-details.cjs 投影到详情切片。
 *
 * 背景:reconcile-logs.cjs / reconcile-aicost-logs.cjs 只落审计归档,不回写 sites.json,
 *      导致首页/详情页「实测详情」面板拿不到最新对账(matchPct/verified/lastAt 停在旧批次)。
 * 口径(诚实原则):只回填归档里真实存在的字段 —— matchRatePct→matchPct、audited→verified、
 *      ranAt→lastAt;inject/stream/consistency 等实测字段原样保留,归档没有的一律不动。
 * 运行:node scripts/apply-reconcile-audit.cjs(无参数,扫全部归档;原子写+收缩熔断)
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..", "..");
const AUDIT_DIR = path.join(ROOT, "relaylens", "probe", "store", "audit");
const SITES_FILE = path.join(ROOT, "relaylens-home", "data", "sites.json");

const d = JSON.parse(fs.readFileSync(SITES_FILE, "utf8"));
d.details = d.details || {};

if (!fs.existsSync(AUDIT_DIR)) { console.log("无审计归档目录,退出"); process.exit(0); }

/* 按站收集最新归档(取 ranAt 最大) */
const latest = {};
for (const f of fs.readdirSync(AUDIT_DIR)) {
  const m = f.match(/^(.+)-reconcile-(\d{4}-\d{2}-\d{2})\.json$/);
  if (!m) continue;
  let a;
  try { a = JSON.parse(fs.readFileSync(path.join(AUDIT_DIR, f), "utf8")); } catch (e) { console.log("  跳过损坏归档:" + f); continue; }
  const site = String(a.site || m[1]);
  const ranAt = String(a.ranAt || m[2]);
  if (!latest[site] || ranAt > latest[site].ranAt) latest[site] = { ranAt, file: f, a };
}

let n = 0;
for (const [site, { ranAt, file, a }] of Object.entries(latest)) {
  const det = d.details[site];
  if (!det) { console.log("  跳过( sites.json 无该站 details ):" + site); continue; }
  const audit = det.audit || {};
  const before = JSON.stringify(audit);
  /* 只覆盖归档真实拥有的字段;inject/stream/consistency 属 token 实测,保留原值 */
  if (typeof a.matchRatePct === "number") audit.matchPct = Math.round(a.matchRatePct * 100) / 100;
  if (typeof a.audited === "number") audit.verified = a.audited;
  audit.lastAt = ranAt.slice(0, 10);
  det.audit = audit;
  if (before !== JSON.stringify(audit)) {
    console.log("  " + site.padEnd(10) + " ← " + file + "(匹配率 " + audit.matchPct + "% · " + audit.verified + " 笔 · " + audit.lastAt + ")");
    n++;
  } else {
    console.log("  " + site.padEnd(10) + " 已是最新,不改动");
  }
}

if (n > 0) {
  const j = JSON.stringify(d, null, 1), tmp = SITES_FILE + ".tmp";
  fs.writeFileSync(tmp, j);
  const old = fs.statSync(SITES_FILE).size;
  if (j.length < old * 0.7) { fs.renameSync(tmp, SITES_FILE + ".rejected-" + Date.now()); throw new Error("收缩熔断:sites.json"); }
  fs.renameSync(tmp, SITES_FILE);
  console.log("sites.json 已更新(" + Math.round(j.length / 1024) + " KB)");
} else {
  console.log("sites.json 无需改动");
}
