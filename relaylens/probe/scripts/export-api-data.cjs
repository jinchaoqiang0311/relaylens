"use strict";
/* Export Pro API data: local SQLite -> D1 import SQL (wrangler d1 execute --file).
   Usage: node probe/scripts/export-api-data.cjs > api-worker/export.sql
   Scope: last 365 days only; read-only. */
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const REPO = path.join(__dirname, "..", "..");
const DB = path.join(REPO, "probe", "store", "relaylens.sqlite");
const db = new DatabaseSync(DB, { readOnly: true });

const q = (sql) => db.prepare(sql).all();
const lit = (v) => v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'";

const lines = ["-- RelayLens API export @ " + new Date().toISOString(), "BEGIN TRANSACTION;"];

const batches = q("SELECT id, site, task, started_at, ok, summary FROM batches WHERE started_at >= datetime('now','-365 days') ORDER BY started_at");
for (const b of batches) {
  lines.push("INSERT OR REPLACE INTO batches(id,site,task,started_at,ok,summary) VALUES(" +
    [lit(b.id), lit(b.site), lit(b.task), lit(b.started_at), b.ok ? 1 : 0, lit(b.summary)].join(",") + ");");
}

const rounds = q("SELECT r.batch_id, r.seq, r.model, r.in_tok, r.cached_tok, r.out_tok, r.should_cost, r.actual_cost, r.ttft_ms FROM rounds r JOIN batches b ON b.id = r.batch_id WHERE b.started_at >= datetime('now','-365 days') AND b.task IN ('reconcile','perf','billing','perf_reasoning')");
for (const r of rounds) {
  lines.push("INSERT OR REPLACE INTO rounds(batch_id,seq,model,in_tok,cached_tok,out_tok,should_cost,actual_cost,ttft_ms) VALUES(" +
    [lit(r.batch_id), r.seq, lit(r.model), r.in_tok, r.cached_tok, r.out_tok, r.should_cost, r.actual_cost, r.ttft_ms].join(",") + ");");
}

const w = JSON.parse(fs.readFileSync(path.join(REPO, "shared", "weights.json"), "utf8"));
const sites = JSON.parse(fs.readFileSync(path.join(REPO, "..", "relaylens-home", "data", "sites.json"), "utf8"));
const meta = JSON.stringify({
  version: w.version,
  updated: (sites.meta && sites.meta.updated) || new Date().toISOString(),
  weightsVersion: w.version,
});
lines.push("INSERT OR REPLACE INTO meta(k,v) VALUES('data'," + lit(meta) + ");");

lines.push("COMMIT;");
lines.push("-- batches: " + batches.length + " rows, rounds: " + rounds.length + " rows");
process.stdout.write(lines.join("\n") + "\n");