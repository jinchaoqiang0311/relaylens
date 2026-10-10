/**
 * store.ts —— 三层数据湖:raw 归档(不可变文件)→ sqlite 指标 → dist 产物
 * 写入顺序铁律:先 raw 后 metrics(任何指标可回溯到原始证据)
 * SQLite 用 Node 25 内置 node:sqlite(实验性 API,v0.1 阶段够用;
 * 若未来迁移 better-sqlite3/Postgres,数据契约不变)。
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { Batch, EventRow } from "../../shared/types.js";

const PROBE_ROOT = path.resolve(import.meta.dirname, "..");
export const STORE_DIR = path.join(PROBE_ROOT, "store");
export const RAW_DIR = path.join(STORE_DIR, "raw");
export const DIST_DIR = path.join(STORE_DIR, "dist");
const DB_PATH = path.join(STORE_DIR, "relaylens.sqlite");

// ---------- 初始化 ----------
let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(STORE_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  migrate(db);
  return db;
}

function migrate(d: DatabaseSync) {
  // 站点表
  d.exec(`CREATE TABLE IF NOT EXISTS sites(
    name TEXT PRIMARY KEY,
    base_url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unknown',
    first_seen TEXT NOT NULL,
    last_check_at TEXT
  )`);
  // 批次表
  d.exec(`CREATE TABLE IF NOT EXISTS batches(
    id TEXT PRIMARY KEY,
    site TEXT NOT NULL,
    task TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ok INTEGER NOT NULL,
    raw_path TEXT NOT NULL,
    summary TEXT
  )`);
  // 轮次表(P2 付费对账用,先建好)
  d.exec(`CREATE TABLE IF NOT EXISTS rounds(
    batch_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    model TEXT,
    in_tok INTEGER, cached_tok INTEGER, out_tok INTEGER,
    should_cost REAL, actual_cost REAL, ttft_ms INTEGER,
    PRIMARY KEY(batch_id, seq)
  )`);
  // 事件表(黑名单时间线 + 告警的统一事件源)
  d.exec(`CREATE TABLE IF NOT EXISTS events(
    ts TEXT NOT NULL,
    site TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT
  )`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_events_site_ts ON events(site, ts)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_batches_site ON batches(site, started_at)`);
  // 批次号原子预留表(调度器与手动命令并发取号时防 TOCTOU 撞号)
  d.exec(`CREATE TABLE IF NOT EXISTS id_reserve(id TEXT PRIMARY KEY)`);
}

// ---------- batchId ----------
export function nextBatchId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const d = getDb();
  const row = d.prepare(`SELECT COUNT(*) AS c FROM batches WHERE id LIKE ?`).get(`RL-RC-${date}-%`) as { c: number };
  // 原子预留:INSERT 主键冲突即失败,再试下一个号 —— 避免并发进程"先查后插"撞号
  // 号宽必须 ≥3 且不封顶:2026-10-01 单日到 999 号后,写死的 3 位校验让后续取号全部失败,调度器静默停摆近 4 小时
  const tryReserve = (id: string): boolean => {
    if (!/^RL-RC-\d{8}-\d{3,8}$/.test(id)) return false;
    if (fs.existsSync(RAW_DIR) && fs.readdirSync(RAW_DIR).some(dir => fs.existsSync(path.join(RAW_DIR, dir, `${id}.json`)))) return false;
    try { d.prepare(`INSERT INTO id_reserve(id) VALUES(?)`).run(id); return true; } catch { return false; }
  };
  const cnt = (like: string): number =>
    (d.prepare(`SELECT COUNT(*) AS c FROM batches WHERE id LIKE ?`).get(like) as { c: number }).c +
    (d.prepare(`SELECT COUNT(*) AS c FROM id_reserve WHERE id LIKE ?`).get(like) as { c: number }).c;
  const start = Math.max(row.c, cnt(`RL-RC-${date}-%`)) + 1;
  for (let k = 0; k < 800; k++) {
    const id = `RL-RC-${date}-${String(start + k).padStart(3, "0")}`;
    if (tryReserve(id)) return id;
  }
  throw new Error("无法分配批次号(预留表异常)");
}

// ---------- raw 归档(只追加) ----------
export function saveRaw<T>(batch: Batch<T>): string {
  const siteDir = path.join(RAW_DIR, sanitize(batch.site));
  fs.mkdirSync(siteDir, { recursive: true });
  const file = path.join(siteDir, `${batch.batchId}.json`);
  if (fs.existsSync(file)) throw new Error(`raw archive exists: ${file}`); // 不可变
  fs.writeFileSync(file, JSON.stringify(batch, null, 2), "utf8");
  return path.relative(PROBE_ROOT, file);
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9-_\u4e00-\u9fa5]/g, "_");
}

// ---------- 指标入库 ----------
export function recordBatch<T>(batch: Batch<T>, rawPath: string, summary?: Record<string, unknown>) {
  const d = getDb();
  d.prepare(`INSERT INTO batches(id, site, task, started_at, ok, raw_path, summary) VALUES(?,?,?,?,?,?,?)`)
    .run(batch.batchId, batch.site, batch.task, batch.startedAt, batch.ok ? 1 : 0, rawPath, summary ? JSON.stringify(summary) : null);
  d.prepare(`INSERT INTO sites(name, base_url, status, first_seen, last_check_at) VALUES(?,?,?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET last_check_at=excluded.last_check_at`)
    .run(batch.site, "", "unknown", batch.startedAt, batch.startedAt);
}

export function logEvent(site: string, type: string, payload: Record<string, unknown>) {
  getDb().prepare(`INSERT INTO events(ts, site, type, payload) VALUES(?,?,?,?)`)
    .run(new Date().toISOString(), site, type, JSON.stringify(payload));
}

// ---------- 查询 ----------
export interface SiteHealth {
  site: string;
  checks: number;
  okChecks: number;
  avail7d: number | null;   // %
  lastOkAt: string | null;
  lastCheckAt: string | null;
}

/** 7 天滚动可用率(健康检查口径:以 overall.status 为准,而非任务是否执行成功) */
export function siteHealth(site: string): SiteHealth {
  const d = getDb();
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const rows = d.prepare(`
    SELECT b.started_at AS at, b.summary AS summary
    FROM batches b WHERE b.site = ? AND b.task = 'health' AND b.started_at >= ?
    ORDER BY b.started_at DESC`).all(site, since) as Array<{ at: string; summary: string | null }>;
  if (rows.length === 0) return { site, checks: 0, okChecks: 0, avail7d: null, lastOkAt: null, lastCheckAt: null };
  let okCount = 0, lastOkAt: string | null = null;
  for (const r of rows) {
    let healthy = false;
    try {
      const s = JSON.parse(r.summary ?? "{}") as { overall?: { status?: string } };
      healthy = s.overall?.status === "up";
      // degraded 计为"部分可用":可用率给半权重场景由调用方决定,这里以 up 计满
      if (healthy && !lastOkAt) lastOkAt = r.at;
    } catch { /* summary 损坏按不健康计 */ }
    if (healthy) okCount++;
  }
  return {
    site,
    checks: rows.length,
    okChecks: okCount,
    avail7d: Math.round((okCount / rows.length) * 1000) / 10,
    lastOkAt,
    lastCheckAt: rows[0].at,
  };
}

export function batchCount(site: string): number {
  const r = getDb().prepare(`SELECT COUNT(*) AS c FROM batches WHERE site = ?`).get(site) as { c: number };
  return r.c;
}

export function recentEvents(site: string, limit = 20): EventRow[] {
  return getDb().prepare(`SELECT ts, site, type, payload FROM events WHERE site = ? ORDER BY ts DESC LIMIT ?`)
    .all(site, limit) as EventRow[];
}
