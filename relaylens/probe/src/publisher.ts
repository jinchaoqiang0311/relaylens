/**
 * publisher.ts —— dist 产物生成
 * 产物结构与 web/ 九页数据结构、api.html 端点响应体字段级对齐。
 */
import fs from "node:fs";
import path from "node:path";
import { DIST_DIR, getDb, siteHealth } from "./store.js";
import type { DistRankingSite, DistStats, DistPrices } from "../../shared/types.js";

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function meta() {
  const now = new Date();
  const countRow = getDb().prepare("SELECT COUNT(*) AS c FROM batches").get() as { c: number };
  const version = `v${now.toISOString().slice(0, 10).replace(/-/g, ".")}-${String(countRow.c).padStart(3, "0")}`;
  return { updated: now.toISOString(), version, license: "CC-BY-4.0" as const };
}

/** dist/stats.json —— 首页信任标语 */
export function buildStats(sites: string[]): DistStats {
  const d = getDb();
  const since24h = new Date(Date.now() - 86400_000).toISOString();
  const checks24h = (d.prepare(`SELECT COUNT(*) c FROM batches WHERE task='health' AND started_at >= ?`).get(since24h) as { c: number }).c;
  const outages = (d.prepare(`SELECT COUNT(*) c FROM events WHERE type='outage' AND ts >= ?`).get(since24h) as { c: number }).c;
  const batchesTotal = (d.prepare(`SELECT COUNT(*) c FROM batches`).get() as { c: number }).c;
  return { ...meta(), sitesMonitored: sites.length, healthChecks24h: checks24h, batchesTotal, outages };
}

/** dist/ranking.json —— 榜单基础数据(P1 层) */
export function buildRanking(sites: string[]): { updated: string; version: string; license: string; sites: DistRankingSite[] } {
  const list: DistRankingSite[] = sites.map(name => {
    const h = siteHealth(name);
    const batches = (() => {
      const r = getDb().prepare(`SELECT COUNT(*) c FROM batches WHERE site=? AND task='billing'`).get(name) as { c: number };
      return r.c;
    })();
    const lastStatus = h.lastCheckAt
      ? (getDb().prepare(`SELECT summary FROM batches WHERE site=? AND task='health' ORDER BY started_at DESC LIMIT 1`).get(name) as { summary: string | null }).summary
      : null;
      let st = "r";
    try {
      const parsed = lastStatus ? (JSON.parse(lastStatus) as { overall?: { status?: string } }) : null;
      st = parsed?.overall?.status === "up" ? "g" : parsed?.overall?.status === "degraded" ? "y" : "r";
    } catch { /* 保持 r */ }
    const status = st as DistRankingSite["status"];
    return {
      name,
      status,
      avail7d: h.avail7d,
      lastCheckAt: h.lastCheckAt ?? "",
      batches,
      score: batches >= 12 ? null /* P2 评分接入后填充 */ : null,
      dataLayer: "p1" as const,
    };
  });
  return { ...meta(), sites: list };
}

/** dist/prices.json —— 比价页数据(取每站最近一次成功 price 批次) */
export function buildPrices(sites: string[]): DistPrices {
  const d = getDb();
  const list: DistPrices["sites"] = [];
  for (const name of sites) {
    const row = d.prepare(
      `SELECT started_at, summary FROM batches WHERE site=? AND task='price' ORDER BY started_at DESC LIMIT 1`
    ).get(name) as { started_at: string; summary: string | null } | undefined;
    if (!row?.summary) continue;
    try {
      const s = JSON.parse(row.summary) as DistPrices["sites"][number];
      list.push({ ...s, capturedAt: row.started_at });
    } catch { /* 跳过损坏记录 */ }
  }
  return { ...meta(), sites: list };
}

export function rebuild(siteNames: string[]) {
  writeJson(path.join(DIST_DIR, "stats.json"), buildStats(siteNames));
  writeJson(path.join(DIST_DIR, "ranking.json"), buildRanking(siteNames));
  writeJson(path.join(DIST_DIR, "prices.json"), buildPrices(siteNames));
  // TODO P2:site/{name}.json(曲线/对账/时间线)
}
