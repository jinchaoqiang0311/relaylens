/**
 * 逐笔对账引擎(P2 核心)—— 用站点自己披露的计费参数重算每一笔应扣,与实扣比对
 * 数据源:站点消费日志(需登录,由浏览器 Console 导出到 store/manual-imports/)
 * new-api 计费口径(实测验证 98/98 精确匹配):
 *   标准倍率:quota = (fresh×mr + cacheTok×mr×cache_ratio + out×mr×completion_ratio) × group_ratio
 *   阶梯计费:quota = (fresh×A + out×B + cacheTok×C) × group_ratio / 2   (A/B/C 取自 expr_b64)
 *   其中 fresh = prompt_tokens - cache_tokens
 */
import fs from "node:fs";
import path from "node:path";
import { STORE_DIR, getDb, nextBatchId, saveRaw, logEvent } from "./store.js";
import type { Batch } from "../../shared/types.js";

const IMPORT_DIR = path.join(STORE_DIR, "manual-imports");

export interface LogEntry {
  created_at: number; model_name: string; prompt_tokens: number; completion_tokens: number;
  quota: number; group?: string; type?: number; other?: string;
}
export interface ReconcileRow {
  model: string; at: string; inTok: number; cacheTok: number; outTok: number;
  actualQuota: number; expectedQuota: number; diffPct: number; mode: string; groupRatio: number;
}
export interface ReconcileResult {
  site: string; batchId: string; ranAt: string; source: string;
  total: number; matched: number; mismatched: number; unverifiable: number;
  maxAbsDiffPct: number; totalActualQuota: number; totalExpectedQuota: number;
  rows: ReconcileRow[]; notes: string[];
}

function parseTierCoeffs(expr: string, tier: string): { p: number; c: number; cr: number } | null {
  const m = new RegExp(`tier\\("${tier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}",\\s*(.+?)\\)`).exec(expr);
  if (!m) return null;
  const body = m[1];
  const grab = (v: string) => { const r = new RegExp(`\\b${v}\\s*\\*\\s*([\\d.]+)`).exec(body); return r ? parseFloat(r[1]) : 0; };
  return { p: grab("p"), c: grab("c"), cr: grab("cr") };
}

function b64decode(s: string): string {
  return Buffer.from(s, "base64").toString("utf8");
}

/** 读取指定站点最新的日志导出文件 */
export function latestLogImport(site: string): { file: string; mtime: Date } | null {
  if (!fs.existsSync(IMPORT_DIR)) return null;
  const files = fs.readdirSync(IMPORT_DIR)
    .filter(f => f.startsWith(`${site}-logs`) && f.endsWith(".json"))
    .map(f => ({ file: path.join(IMPORT_DIR, f), mtime: fs.statSync(path.join(IMPORT_DIR, f)).mtime }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return files[0] ?? null;
}

export function loadEntries(file: string): LogEntry[] {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const data = raw?.data?.items ?? raw?.data ?? raw;
  return Array.isArray(data) ? data.filter((x: LogEntry) => x.type === 2 && x.quota) : [];
}

export function reconcile(site: string, opts: { file?: string; thresholdPct?: number } = {}): ReconcileResult {
  const src = opts.file ?? latestLogImport(site)?.file;
  const notes: string[] = [];
  const result: ReconcileResult = {
    site, batchId: nextBatchId(), ranAt: new Date().toISOString(), source: src ?? "none",
    total: 0, matched: 0, mismatched: 0, unverifiable: 0, maxAbsDiffPct: 0,
    totalActualQuota: 0, totalExpectedQuota: 0, rows: [], notes,
  };
  if (!src) { notes.push(`无日志导入文件 —— 在已登录浏览器 Console 导出后放入 ${IMPORT_DIR}/${site}-logs-*.json`); return result; }

  const entries = loadEntries(src);
  result.total = entries.length;
  const thr = opts.thresholdPct ?? 1;

  for (const it of entries) {
    let o: any = {};
    try { o = JSON.parse(it.other || "{}"); } catch { /* ignore */ }
    const gr = o.group_ratio;
    const cacheTok = o.cache_tokens || 0;
    const fresh = Math.max(0, (it.prompt_tokens || 0) - cacheTok);
    if (typeof gr !== "number") { result.unverifiable++; continue; }

    let expected: number | null = null;
    let mode = "standard";
    if (o.billing_mode === "tiered_expr" && o.expr_b64) {
      mode = `tiered:${o.matched_tier || "standard"}`;
      const co = parseTierCoeffs(b64decode(o.expr_b64), o.matched_tier || "standard");
      if (co) expected = (fresh * co.p + it.completion_tokens * co.c + cacheTok * co.cr) * gr / 2;
    } else {
      const { model_ratio: mr, cache_ratio: cr, completion_ratio: comp } = o;
      if (typeof mr === "number" && mr > 0 && typeof cr === "number" && typeof comp === "number") {
        expected = (fresh * mr + cacheTok * mr * cr + it.completion_tokens * mr * comp) * gr;
      }
    }
    if (expected === null || !Number.isFinite(expected)) { result.unverifiable++; continue; }

    const diffPct = it.quota > 0 ? Math.round(((expected - it.quota) / it.quota) * 10000) / 100 : 0;
    const withinTol = Math.abs(expected - it.quota) <= Math.max(2, it.quota * (thr / 100));
    if (withinTol) result.matched++; else result.mismatched++;
    result.maxAbsDiffPct = Math.max(result.maxAbsDiffPct, Math.abs(diffPct));
    result.totalActualQuota += it.quota;
    result.totalExpectedQuota += expected;
    result.rows.push({
      model: it.model_name, at: new Date(it.created_at * 1000).toISOString(),
      inTok: it.prompt_tokens, cacheTok, outTok: it.completion_tokens,
      actualQuota: it.quota, expectedQuota: Math.round(expected * 100) / 100, diffPct, mode, groupRatio: gr,
    });
  }
  return result;
}

/** 落库(作为 billing 类批次,raw 存完整结果) */
export function persistReconcile(res: ReconcileResult): void {
  const batch: Batch = {
    batchId: res.batchId, site: res.site, task: "billing", startedAt: res.ranAt,
    ok: res.mismatched === 0, result: res,
  };
  const rawPath = saveRaw(batch);
  getDb().prepare(`INSERT INTO batches(id, site, task, started_at, ok, raw_path, summary) VALUES(?,?,?,?,?,?,?)`)
    .run(res.batchId, res.site, "billing", res.ranAt, res.mismatched === 0 ? 1 : 0, rawPath,
      JSON.stringify({ reconcile: true, total: res.total, matched: res.matched, mismatched: res.mismatched, unverifiable: res.unverifiable, maxAbsDiffPct: res.maxAbsDiffPct, source: res.source }));
  if (res.mismatched > 0) {
    logEvent(res.site, "billing_mismatch", { batchId: res.batchId, mismatched: res.mismatched, total: res.total });
  }
}

/** 计量一致性(BH 的 30% 分量):同内容请求对(同模型+同token计数)的 quota 偏差中位数 */
export function meteringConsistency(entries: LogEntry[]): { score: number | null; pairs: number; medianDevPct: number | null; note: string } {
  // 按 (model, prompt_tokens, completion_tokens, cache_tokens) 分组,组内两两比 quota
  const groups = new Map<string, number[]>();
  for (const it of entries) {
    let cacheTok = 0;
    try { cacheTok = JSON.parse(it.other || "{}").cache_tokens || 0; } catch { /* */ }
    const key = `${it.model_name}|${it.prompt_tokens}|${it.completion_tokens}|${cacheTok}`;
    const arr = groups.get(key) ?? [];
    arr.push(it.quota);
    groups.set(key, arr);
  }
  const devs: number[] = [];
  for (const qs of groups.values()) {
    if (qs.length < 2) continue;
    for (let a = 0; a < qs.length; a++) for (let b = a + 1; b < qs.length; b++) {
      const mx = Math.max(qs[a], qs[b]);
      if (mx > 0) devs.push(Math.abs(qs[a] - qs[b]) / mx * 100);
    }
  }
  if (!devs.length) return { score: null, pairs: 0, medianDevPct: null, note: "无同内容重复请求对" };
  devs.sort((a, b) => a - b);
  const med = devs[Math.floor(devs.length / 2)];
  return { score: Math.max(0, 100 - med), pairs: devs.length, medianDevPct: Math.round(med * 10) / 10, note: "" };
}
