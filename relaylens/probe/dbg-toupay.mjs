import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
const db = new DatabaseSync("store/relaylens.sqlite");
const sites = db.prepare(`SELECT DISTINCT site FROM batches WHERE task='billing'`).all().map(r => r.site);
const yaml = fs.readFileSync("config/sites.yaml", "utf8");

function yamlBlock(site) {
  const marker = 'name: "' + site + '"';
  const i = yaml.indexOf(marker);
  if (i < 0) return "";
  const next = yaml.indexOf("\n  - id:", i);
  return yaml.slice(i, next < 0 ? undefined : next);
}

for (const s of sites) {
  if (/official|openrouter|placeholder|deepseek|zhipu/.test(s)) continue;
  const b = db.prepare(`SELECT started_at, summary FROM batches WHERE site=? AND task='billing' AND summary LIKE '%expectedCostCents%' ORDER BY started_at DESC LIMIT 1`).get(s);
  const p = db.prepare(`SELECT started_at FROM batches WHERE site=? AND task='price' ORDER BY started_at DESC LIMIT 1`).get(s);
  let st = "从未跑成对账", act = "—";
  if (b) {
    const j = JSON.parse(b.summary);
    const err = (j.errors || []).join(" ").slice(0, 60);
    const unfunded = /额度不足|余额不足|停用/.test(err);
    const spent = typeof j.actualCostCents === "number" && j.actualCostCents > 0;
    st = spent
      ? (p && b.started_at >= p.started_at ? "校准有效" : "校准过期(快照已换)")
      : (unfunded ? "无余额(报额度/余额不足)" : "未跑成:" + err);
    act = j.actualCostCents != null ? j.actualCostCents.toFixed(2) + "分 @ " + b.started_at.slice(5, 10) : "—";
  }
  const blk = yamlBlock(s);
  const min = /min_top_up:\s*"?([^"\n]+)"?/.exec(blk);
  const pay = /pay_methods:\s*\[([^\]]*)\]/.exec(blk);
  const url = /base_url:\s*"?([^"\n]+)"?/.exec(blk);
  const ratio = /recharge_ratio:\s*"?([^"\n]+)"?/.exec(blk);
  console.log([
    s.padEnd(11),
    st.padEnd(22),
    ("上次实扣 " + act).padEnd(24),
    ("起充 " + (min ? min[1].trim() : "?")).padEnd(10),
    ("比例 " + (ratio ? ratio[1].trim() : "?")).padEnd(16),
    (pay ? pay[1].replace(/"/g, "") : ""),
    url ? url[1].trim() : "",
  ].join(" | "));
}
