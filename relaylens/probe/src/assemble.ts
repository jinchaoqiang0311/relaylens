/**
 * assemble.ts —— 从探针数据库装配 SiteMetrics(score.ts 的数据供给)
 * 数据源:价格快照 / 对账批次 / 指纹批次 / 健康检查 / billing 轮次 TTFT
 * 注入开销:暂为实测参数(4398)传入,待 P3 持久化后改从 DB 读
 */
import { getDb, siteHealth } from "./store.js";
import { meteringConsistency, loadEntries } from "./reconcile.js";
import { latestInjection, latestInjectionDetail } from "./probes/tokenprobe.js";
import { timeBucket } from "./probes/perf.js";
import type { SiteMetrics } from "./score.js";
import fs from "node:fs";
import path from "node:path";

const PROBE_ROOT = path.resolve(import.meta.dirname, "..");

interface PriceSnap { models: Array<{ model: string; input: number; output: number; cacheRead: number | null; group: string }> }

function latestPriceSnap(site: string): PriceSnap | null {
  const row = getDb().prepare(`SELECT summary FROM batches WHERE site=? AND task='price' ORDER BY started_at DESC LIMIT 1`).get(site) as { summary: string } | undefined;
  if (!row?.summary) return null;
  try { return JSON.parse(row.summary) as PriceSnap; } catch { return null; }
}

/** openrouter "openai/gpt-5.5" → "gpt-5.5" */
const bareName = (m: string) => m.replace(/^[a-z-]+\//, "");

export function assembleMetrics(site: string, opts: { inject?: number } = {}): SiteMetrics {
  const d = getDb();
  // 注入开销:优先显式覆盖(测试/沙盘),否则读最近一次 tokens 批次;未测按 0 计并在 ops 看板提示
  const inject = opts.inject !== undefined ? opts.inject : (latestInjection(site) ?? 0);

  // BH:最近一次逐笔对账 + 计量一致性(同内容请求对 quota 偏差,30% 分量)
  const rec = d.prepare(`SELECT summary, raw_path FROM batches WHERE site=? AND summary LIKE '%reconcile%' ORDER BY started_at DESC LIMIT 1`).get(site) as { summary: string; raw_path: string } | undefined;
  let BH: SiteMetrics["BH"] = { match: null, consistency: null, entries: 0 };
  if (rec) {
    try {
      const s = JSON.parse(rec.summary) as { total: number; matched: number; mismatched: number };
      const verifiable = s.matched + s.mismatched;
      BH = { match: verifiable > 0 ? Math.round(s.matched / verifiable * 1000) / 10 : null, consistency: null, entries: s.total };
      // 一致性:直接从该批次的日志源算
      const logFile = rec.raw_path ? (rec.raw_path.startsWith("store/") ? path.join(PROBE_ROOT, rec.raw_path) : rec.raw_path) : null;
      if (logFile && fs.existsSync(logFile)) {
        try {
          const batch = JSON.parse(fs.readFileSync(logFile, "utf8"));
          const entriesSrc = (batch.result as any)?.source;
          if (entriesSrc && fs.existsSync(entriesSrc)) {
            const mc = meteringConsistency(loadEntries(entriesSrc));
            BH.consistency = mc.score;
          }
        } catch { /* */ }
      }
    } catch { /* 损坏跳过 */ }
  }

  // MA:最近一次指纹
  const fp = d.prepare(`SELECT summary FROM batches WHERE site=? AND summary LIKE '%fingerprint%' ORDER BY started_at DESC LIMIT 1`).get(site) as { summary: string } | undefined;
  let MA: SiteMetrics["MA"] = { similarity: null, baseline: null };
  if (fp) {
    try { const s = JSON.parse(fp.summary) as { similarity: number | null; baseline?: string }; MA = { similarity: s.similarity ?? null, baseline: s.baseline ?? null }; } catch { /* */ }
  }

  // ST:健康检查(跨度防猛采);超时率改由 perf 探针持久化提供
  const h = siteHealth(site);
  const span = d.prepare(`
    SELECT MIN(started_at) a, MAX(started_at) b FROM batches
    WHERE site=? AND task='health' AND started_at >= datetime('now','-7 days')`).get(site) as { a: string | null; b: string | null };
  const spanMinutes = (span.a && span.b)
    ? Math.round((new Date(span.b).getTime() - new Date(span.a).getTime()) / 60000)
    : 0;
  // 最近一次 perf 的超时率 + 伪流式率(SR)
  const perfRow = d.prepare(`SELECT summary FROM batches WHERE site=? AND task='perf' ORDER BY started_at DESC LIMIT 1`).get(site) as { summary: string } | undefined;
  let timeoutPct: number | null = null;
  let SR: SiteMetrics["SR"] = { bufferedRate: null, samples: 0 };
  if (perfRow?.summary) {
    try {
      const p = JSON.parse(perfRow.summary) as { timeoutRate: number | null; bufferedRate: number | null; streamVerdict?: "stream" | "buffered" | "mixed" | "unknown" | null; streamCheck?: { bufferedPct?: number | null } | null; iters?: number };
      timeoutPct = p.timeoutRate ?? null;
      // 流式真伪:优先取长输出专项(3 次)的结论;没有专项的老批次退回短循环 bufferedRate
      const verdictRate = p.streamVerdict === "stream" ? 0
        : p.streamVerdict === "buffered" ? 100
          : p.streamVerdict === "mixed" ? (p.streamCheck?.bufferedPct ?? null)
            : null;
      const rate = verdictRate !== null ? verdictRate : (p.bufferedRate ?? null);
      SR = { bufferedRate: rate, samples: rate !== null ? 1 : 0 };
    } catch { /* */ }
  }
  const ST: SiteMetrics["ST"] = { avail: h.avail7d, timeoutPct, checks: h.checks, spanMinutes };

  // PF:近 7 天 perf 轮按忙/闲桶(本地 9–18 点=work)分别取中位数,PF = 较差桶(悲观值口径,2026-10-10.1)。
  // 之前取"最近一批"中位数 —— 同一站闲时 2.5s / 高峰 12s,采样时点决定分数,波动完全由运气主导。
  // 悲观值 = 最坏常用时段的承诺;单桶缺样本时用另一桶并标 partialBucket(前端如实标注,不假装完整)。
  const perfRounds = d.prepare(`
    SELECT r.ttft_ms, b.started_at FROM rounds r JOIN batches b ON b.id=r.batch_id
    WHERE b.site=? AND b.task='perf' AND r.ttft_ms>0 AND r.ttft_ms<30000
      AND b.started_at >= datetime('now','-7 days')`).all(site, site) as Array<{ ttft_ms: number; started_at: string }>;
  const buckets: Record<"work" | "off", number[]> = { work: [], off: [] };
  for (const r of perfRounds) buckets[timeBucket(r.started_at)].push(r.ttft_ms);
  const bucketMedian = (xs: number[]): number | null =>
    xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null;
  const workMs = bucketMedian(buckets.work);
  const offMs = bucketMedian(buckets.off);
  let pfMs: number | null = null;
  let partialBucket: "work" | "off" | null = null;
  if (workMs !== null && offMs !== null) pfMs = Math.max(workMs, offMs);
  else if (workMs !== null) { pfMs = workMs; partialBucket = "work"; }
  else if (offMs !== null) { pfMs = offMs; partialBucket = "off"; }
  const PF: SiteMetrics["PF"] = {
    ttftMs: pfMs, samples: buckets.work.length + buckets.off.length,
    workMs, offMs, partialBucket,
  };

  // EP:站点价 × 官方锚(openrouter 快照),按裸模型名 join
  const siteSnap = latestPriceSnap(site);
  const offSnap = latestPriceSnap("openrouter");
  const offMap = new Map<string, { i: number; o: number; c: number | null }>();
  if (offSnap) for (const m of offSnap.models) offMap.set(bareName(m.model), { i: m.input, o: m.output, c: m.cacheRead });
  const models: SiteMetrics["EP"]["models"] = [];
  if (siteSnap) {
    for (const m of siteSnap.models) {
      const off = offMap.get(m.model);
      if (!off) continue; // 官方无锚的模型不计 EP
      models.push({ model: m.model, inP: m.input, outP: m.output, cacheP: m.cacheRead, offIn: off.i, offOut: off.o, offCache: off.c, inject });
    }
  }
  const EP: SiteMetrics["EP"] = { models };
  // 注入的缓存/fresh 拆分:来自该站 tokens 批次实测(EP 计价用;无实测则 null,score 退回全局兜底比例)
  const det = latestInjectionDetail(site);
  const injectSplit = det && det.inject > 0
    ? { fresh_share: Math.min(1, det.freshIntercept / det.inject), cached_share: Math.max(0, 1 - Math.min(1, det.freshIntercept / det.inject)) }
    : null;
  return { site, BH, MA, ST, PF, SR, EP, injectSplit };
}
