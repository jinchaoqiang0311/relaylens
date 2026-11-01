/**
 * slice-details.cjs —— 把 data/sites.json 按站切成 details/<站名>.json
 * 目的:详情页只拉单站切片(几 KB),不再全量拖 326KB sites.json(优先级 #2)。
 * 切片结构 = detail.html 已消费的 payload 投影:{ site, meta, realSites:[本站], details:{本站}, evidence:[本站(如有)] }
 * 上游真源仍是 sites.json(本脚本只做投影,不产生第二真源);预览与 dist 均从 relaylens-home/data/details/ 取。
 * 运行:node scripts/slice-details.cjs(在 build-relay.js 与手动刷新后各跑一次;原子写+收缩熔断)
 */
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "..", "..", "relaylens-home", "data", "sites.json");
const OUT_DIR = path.join(__dirname, "..", "..", "..", "relaylens-home", "data", "details");

const d = JSON.parse(fs.readFileSync(SRC, "utf8"));
fs.mkdirSync(OUT_DIR, { recursive: true });

/* evidence 兼容对象/数组两种历史形态 */
const evidArr = [].concat(d.evidence || []).filter(e => e && e.site);
const safe = s => s.replace(/[^a-zA-Z0-9-_\u4e00-\u9fa5]/g, "_");
let n = 0, total = 0;
for (const name of Object.keys(d.details || {})) {
  const real = (d.realSites || []).find(s => s.name === name) || null;
  const ev = evidArr.find(e => e.site === name) || null;
  const slice = {
    slice: "details/" + safe(name) + ".json",
    site: name,
    meta: d.meta || {},
    realSites: real ? [real] : [],
    details: { [name]: d.details[name] },
    evidence: ev ? [ev] : [],
  };
  const f = path.join(OUT_DIR, safe(name) + ".json");
  (function atomic(file, data, guard) {
    const j = JSON.stringify(data, null, 1), tmp = file + ".tmp";
    fs.writeFileSync(tmp, j);
    if (fs.existsSync(file)) {
      const old = fs.statSync(file).size;
      if (old > 1024 && j.length < old * (1 - guard)) {
        fs.renameSync(tmp, file + ".rejected-" + Date.now());
        throw new Error("收缩熔断:" + file);
      }
    }
    fs.renameSync(tmp, file);
  })(f, slice, 0.3);
  total += JSON.stringify(slice).length;
  n++;
  console.log("  " + name.padEnd(12) + " → details/" + safe(name) + ".json(" + Math.round(JSON.stringify(slice).length / 1024) + " KB)");
}
console.log("切片完成:" + n + " 站,合计 " + Math.round(total / 1024) + " KB(全量 sites.json " + Math.round(fs.statSync(SRC).size / 1024) + " KB)");
