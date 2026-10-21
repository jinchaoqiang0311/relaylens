/**
 * score.ts —— 场景评分引擎(唯一入口)
 * 权重唯一事实源:shared/weights.json(与 method.html 同步,修改必须升版本+changelog)
 * 核心规则:
 *   ① 指标缺失 → 剩余权重重归一化(不因未测而零分惩罚)
 *   ② 覆盖率 = 已测权重占比;<0.6 → 评分 null(数据不足);0.6~0.8 → 低置信标
 *   ③ 置信度 = 样本达标比 × 覆盖率 × 基线折扣(跨站差分 0.8)
 *   ④ EP 用场景参考负载算真实成本,注入开销在此被定价(不与价格列双重计分)
 */
import fs from "node:fs";
import path from "node:path";
import { getDb, siteHealth } from "./store.js";

export interface Weights {
  version: string;
  metrics: Record<string, { name: string }>;
  scenes: Record<string, Record<string, number> & { label?: string; separate?: boolean; note?: string }>;
  workloads: Record<string, { in_tok: number; out_tok: number; cache_hit: number }>;
  injection_pricing: { cached_share: number; fresh_share: number };
  /** 展示层计价口径:站内金额一律人民币,换算只发生在产出前端 payload 时,不参与评分 */
  pricing_display?: { currency: string; symbol: string; usd_cny: number; as_of: string; quota_per_usd: number; scope?: string; note?: string };
  confidence: { min_health_checks: number; min_reconcile_entries: number; min_ttft_samples: number; min_fingerprint_runs: number; cross_relay_confidence: number; coverage_floor: number };
}

const W: Weights = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../shared/weights.json"), "utf8"));

export interface SiteMetrics {
  site: string;
  BH: { match: number | null; consistency: number | null; entries: number };
  MA: { similarity: number | null; baseline: string | null };
  ST: { avail: number | null; timeoutPct: number | null; checks: number; spanMinutes: number };
  PF: {
    ttftMs: number | null; samples: number;
    /** 双窗口分桶(2026-10-10.1 口径):忙/闲桶各自中位数与单桶缺样本标注 */
    workMs?: number | null; offMs?: number | null; partialBucket?: "work" | "off" | null;
  };
  /** SR 流式真实性:伪流式率(%),null=未测 */
  SR: { bufferedRate: number | null; samples: number };
  /** 每模型:站点价(USD/M)与官方锚定价,及注入开销 */
  EP: { models: Array<{ model: string; inP: number; outP: number; cacheP: number | null; offIn: number; offOut: number; offCache: number | null; inject: number }> };
  /** 注入的缓存/fresh 拆分(该站 tokens 批次实测);null=未实测,退回 weights.json 全局兜底比例 */
  injectSplit?: { fresh_share: number; cached_share: number } | null;
}

export interface SceneScore {
  scene: string; site: string;
  score: number | null;        // null = 数据不足
  coverage: number;            // 0-1
  confidence: number;          // 0-1
  lowConfidence: boolean;
  components: Record<string, { value: number | null; weightUsed: number }>;
}

// ---------- 指标计算 ----------

function bhScore(m: SiteMetrics["BH"]): number | null {
  const parts: Array<[number, number]> = []; // [value, weight]
  if (m.match !== null && m.entries >= W.confidence.min_reconcile_entries) parts.push([m.match, 0.7]);
  if (m.consistency !== null) parts.push([m.consistency, 0.3]);
  if (!parts.length) return null;
  const tw = parts.reduce((s, p) => s + p[1], 0);
  return parts.reduce((s, p) => s + p[0] * p[1], 0) / tw;
}

function stScore(m: SiteMetrics["ST"]): number | null {
  // 次数与时间跨度双门槛:防止短时猛采刷样本数
  if (m.avail === null) return null;
  if (m.checks < W.confidence.min_health_checks) return null;
  if ((m.spanMinutes ?? 0) < (W.confidence.min_health_span_minutes ?? 45)) return null;
  const penalty = m.timeoutPct ?? 0;
  return Math.max(0, m.avail - 0.3 * penalty);
}

function pfScore(m: SiteMetrics["PF"]): number | null {
  if (m.ttftMs === null || m.samples < W.confidence.min_ttft_samples) return null;
  const s = m.ttftMs / 1000;
  return Math.round(Math.max(0, Math.min(100, 100 - ((s - 1) / 7) * 100)));
}

/** SR 流式真实性:100 - 伪流式率;仅当场景配了 SR 权重时才需要值,其他场景由调用方置 null */
function srScore(m: SiteMetrics["SR"], weight: number): number | null {
  if (!weight) return null;                     // 场景不含 SR → 恒 null,重归一化自动忽略
  if (m.bufferedRate === null || m.samples < 3) return null;
  return Math.max(0, 100 - m.bufferedRate);
}

/** 场景参考负载下的有效价格分:多模型取中位数 */
function epScore(ep: SiteMetrics["EP"], scene: string, split?: { fresh_share: number; cached_share: number } | null): number | null {
  const wl = W.workloads[scene] ?? W.workloads.all;
  const inj = split ?? W.injection_pricing;   // 站点实测拆分优先,全局比例仅兜底
  const scores: number[] = [];
  for (const m of ep.models) {
    const cacheP = m.cacheP ?? m.inP;          // 无缓存价 = 不认缓存(按全价)
    const offCache = m.offCache ?? m.offIn;
    // 站点成本(每千次请求,USD)
    const freshTok = wl.in_tok * (1 - wl.cache_hit) + m.inject * inj.fresh_share;
    const cachedTok = wl.in_tok * wl.cache_hit + m.inject * inj.cached_share;
    const siteCost = (freshTok * m.inP + cachedTok * cacheP + wl.out_tok * m.outP) / 1e6;
    // 官方锚定(同负载,无注入)
    const offFresh = wl.in_tok * (1 - wl.cache_hit);
    const offCost = (offFresh * m.offIn + wl.in_tok * wl.cache_hit * offCache + wl.out_tok * m.offOut) / 1e6;
    if (offCost <= 0) continue;
    const ratio = siteCost / offCost;
    const sc = 20 + 80 * Math.max(0, Math.min(1, -Math.log(ratio) / Math.log(20)));
    scores.push(sc);
  }
  if (!scores.length) return null;
  scores.sort((a, b) => a - b);
  return Math.round(scores[Math.floor(scores.length / 2)] * 10) / 10;
}

function maScore(m: SiteMetrics["MA"], confidenceOut: { cap: number }): number | null {
  if (m.similarity === null) return null;
  if (m.baseline === "openrouter") return m.similarity;
  confidenceOut.cap = Math.min(confidenceOut.cap, W.confidence.cross_relay_confidence);
  return m.similarity;
}

// ---------- 场景评分 ----------

export function computeSceneScore(m: SiteMetrics, scene: string): SceneScore {
  const sceneW = W.scenes[scene];
  if (!sceneW || (sceneW as any).separate) throw new Error(`场景 ${scene} 无权重定义或为独立指数`);
  const confCap = { cap: 1 };
  const raw: Record<string, number | null> = {
    BH: bhScore(m.BH), MA: maScore(m.MA, confCap), ST: stScore(m.ST),
    PF: pfScore(m.PF), EP: epScore(m.EP, scene, m.injectSplit),
    SR: srScore(m.SR, sceneW.SR ?? 0),
  };
  const total = Object.keys(raw).reduce((s, k) => s + (sceneW[k] ?? 0), 0);
  const avail = Object.keys(raw).reduce((s, k) => s + (raw[k] !== null ? (sceneW[k] ?? 0) : 0), 0);
  const coverage = total > 0 ? avail / total : 0;

  const out: SceneScore = {
    scene, site: m.site, score: null, coverage: Math.round(coverage * 100) / 100,
    confidence: 0, lowConfidence: false, components: {},
  };
  for (const k of Object.keys(raw)) out.components[k] = { value: raw[k], weightUsed: sceneW[k] ?? 0 };

  if (coverage < W.confidence.coverage_floor) return out; // 数据不足 → null

  // 样本达标比
  let sat = 0, cnt = 0;
  const pushSat = (ok: boolean) => { cnt++; if (ok) sat++; };
  pushSat(m.BH.match !== null && m.BH.entries >= W.confidence.min_reconcile_entries);
  pushSat(m.ST.checks >= W.confidence.min_health_checks && (m.ST.spanMinutes ?? 0) >= (W.confidence.min_health_span_minutes ?? 45));
  pushSat(m.PF.samples >= W.confidence.min_ttft_samples);
  pushSat(m.MA.similarity !== null);
  const sampleRatio = cnt ? sat / cnt : 0;

  out.score = Math.round(avail > 0 ? Object.keys(raw).reduce((s, k) => s + (raw[k] ?? 0) * (sceneW[k] ?? 0), 0) / avail : 0);
  out.confidence = Math.round(sampleRatio * coverage * confCap.cap * 100) / 100;
  out.lowConfidence = out.confidence < 0.8;
  return out;
}

// ---------- 三态判定(v1 PRD §2) ----------
// 原则:现有阈值一个字不动,只是把"给不给分"变成显式的层(L2 实测榜 / L1 观察榜)。
// L0(监测中)不在这判 —— 它是 level="passive"(没做过账单对账),由 sync.ts 的 level 字段表达。

/** L2 = 出分且置信达标;L1 = 有过对账但未达标(覆盖率不足或低置信),前端不给分只给信号卡 */
export function tierOf(r: SceneScore): "L2" | "L1" {
  return r.score !== null && r.confidence >= 0.8 ? "L2" : "L1";
}

export interface SampleProgress { key: string; label: string; n: number; need: number; ok: boolean }

/**
 * 观察榜信号卡的样本进度:各指标样本量 vs 官方阈值(weights.json)。
 * n 是真实累计样本数,need 是同评分引擎完全相同的门槛 —— 前端只渲染,不得自己发明门槛。
 */
export function sampleProgress(m: SiteMetrics): SampleProgress[] {
  const c = W.confidence;
  const minSpan = (c as { min_health_span_minutes?: number }).min_health_span_minutes ?? 45;
  return [
    { key: "BH", label: "扣费对账", n: m.BH.entries, need: c.min_reconcile_entries, ok: m.BH.match !== null && m.BH.entries >= c.min_reconcile_entries },
    { key: "ST", label: "稳定性", n: m.ST.checks, need: c.min_health_checks, ok: m.ST.checks >= c.min_health_checks && (m.ST.spanMinutes ?? 0) >= minSpan },
    { key: "PF", label: "首字延迟", n: m.PF.samples, need: c.min_ttft_samples, ok: m.PF.ttftMs !== null && m.PF.samples >= c.min_ttft_samples },
    { key: "MA", label: "模型指纹", n: m.MA.similarity !== null ? 1 : 0, need: 1, ok: m.MA.similarity !== null },
    { key: "SR", label: "流式真实性", n: m.SR.samples, need: 3, ok: m.SR.bufferedRate !== null && m.SR.samples >= 3 },
  ];
}

export function weightsVersion(): string { return W.version; }
/** 展示层汇率口径(pricing_display)。缺省兜底:配置缺失时退回 1 USD = 7.1 ¥ 并在页面标注日期未知 —— 宁可显式兜底也不让价格静默变成美元 */
export function pricingDisplay() {
  const p = W.pricing_display;
  const rate = p && Number(p.usd_cny) > 0 ? Number(p.usd_cny) : 7.1;
  return {
    currency: p?.currency || "CNY", symbol: p?.symbol || "¥", usdCny: rate,
    asOf: p?.as_of || "未标注", quotaPerUsd: Number(p?.quota_per_usd) > 0 ? Number(p!.quota_per_usd) : 500000,
    note: p?.note || "",
  };
}
/** USD 金额 → 人民币展示值(保留 2 位;小于 0.01 的极小额保留 5 位,避免容差被四舍五入成 0) */
export function cny(usd: number | null | undefined): number | null {
  if (usd === null || usd === undefined || !isFinite(usd)) return null;
  const v = usd * pricingDisplay().usdCny;
  return Math.round(v * (Math.abs(v) < 0.01 ? 1e5 : 100)) / (Math.abs(v) < 0.01 ? 1e5 : 100);
}

/** 金额折算结果:fxApplied 表示"这个 ¥ 数是乘过汇率的",前端要能据此说明口径 */
export interface MoneyOut { cny: number | null; fxApplied: boolean; src: string }

/**
 * **货币感知**折算。价格快照自带 currency 字段:智谱官方定价页是 CNY,new-api 系与 OpenRouter 是 USD。
 * 只对 USD 乘汇率 —— 拿 CNY 值再乘一次会把 ¥2/M 报成 ¥14.2/M,是数量级错误而不是小数点问题。
 * 源货币未知时同样不折算(原值透出 + src="未知"),宁可标注不确定,也不要悄悄乘错。
 */
export function money(v: number | null | undefined, currency: string | null | undefined): MoneyOut {
  const cur = String(currency || "").trim().toUpperCase();
  if (v === null || v === undefined || !isFinite(v)) return { cny: null, fxApplied: false, src: cur || "未知" };
  if (cur === "USD") return { cny: cny(v), fxApplied: true, src: cur };
  if (cur === "CNY" || cur === "RMB" || cur === "¥" || cur === "元") return { cny: Math.round(v * 100) / 100, fxApplied: false, src: "CNY" };
  return { cny: Math.round(v * 100) / 100, fxApplied: false, src: cur || "未知" };
}
export function allScenes(): string[] { return Object.keys(W.scenes).filter(s => !(W.scenes[s] as any).separate); }
