/**
 * sync.ts —— 数据管道:探针 dist/真实数据 → 前端可消费的 data/*.json
 * 合并策略:
 *   实测站(aixoras/aicost):真实数据全字段(未测=null 不臆造) + score.ts 六桶场景分
 *   演示站:沿用前端 SITES 既有示例值(标注 demo:true,前端显示「示例」角标)
 * 产物:web-data/sites.json —— 一个文件同时供 ranking/detail 页消费,附带 meta(updated/version/license)
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { getDb, siteHealth } from "./store.js";
import { priceTableHash } from "./probes/billing.js";
import { assembleMetrics } from "./assemble.js";
import { latestInjection } from "./probes/tokenprobe.js";
import { computeSceneScore, allScenes, weightsVersion, pricingDisplay, cny, money } from "./score.js";
import { matchCanon } from "./parsers/models.js";

const PROBE_ROOT = path.resolve(import.meta.dirname, "..");
/** 站点发布目录(与 probe 平级) */
const WEB_DIR = path.resolve(PROBE_ROOT, "../../relaylens-home");
const DATA_DIR = path.join(WEB_DIR, "data");

/** CPS 推广位配置(config/promo.yaml) */
export interface PromoConfig { enabled: boolean; url: string; coupon: string; couponDesc: string; rate?: number; until?: string; note?: string }
function loadPromo(): Record<string, PromoConfig> {
  const file = path.join(PROBE_ROOT, "config/promo.yaml");
  if (!fs.existsSync(file)) return {};
  try {
    const y = YAML.parse(fs.readFileSync(file, "utf8")) as { promo?: Record<string, Partial<PromoConfig>> };
    const out: Record<string, PromoConfig> = {};
    for (const [k, v] of Object.entries(y.promo ?? {})) {
      out[k] = {
        enabled: !!v.enabled, url: v.url || "", coupon: v.coupon || "", couponDesc: v.couponDesc || "",
        rate: Number(v.rate) > 0 ? Number(v.rate) : 0, until: v.until || "", note: v.note || "",
      };
    }
    return out;
  } catch { return {}; }
}

/**
 * 推荐位排序:实测合格是硬门槛,之后按 综合分 → 佣金率 → 活动截止日。
 * 只输出有序名单与展示字段,rate/until 留在服务端 —— 排序规则公开,费率保密。
 */
export function buildRecommendations(sites: FrontendSite[], promo: Record<string, PromoConfig>): Array<{ name: string; url: string; coupon: string; couponDesc: string }> {
  const today = new Date().toISOString().slice(0, 10);
  // 从完整 promo 表取数(前端视图已剥掉 rate/until,不能拿它排序)
  const eligible = sites.filter(s => {
    const p = promo[s.name];
    return !!p?.enabled && !!p.url && s.status !== "r" && s.fp !== "fail" && !(p.until && p.until < today);
  });
  eligible.sort((a, b) => {
    const pa = promo[a.name], pb = promo[b.name];
    return (b.score.all ?? 0) - (a.score.all ?? 0) ||
      (pb?.rate ?? 0) - (pa?.rate ?? 0) ||
      String(pa?.until || "9999").localeCompare(String(pb?.until || "9999"));
  });
  return eligible.slice(0, 3).map(s => ({ name: s.name, url: promo[s.name].url, coupon: promo[s.name].coupon, couponDesc: promo[s.name].couponDesc }));
}

export interface FrontendSite {
  name: string; real: true; dataLayer: "p2";
  /** billing = 做过账单级逐笔对账(前端可标「实测」);passive = 只有免成本监测(只能标「监测中」) */
  level: "billing" | "passive";
  status: "g" | "y" | "r";
  score: Record<string, number | null>;   // 六桶场景分 + 覆盖率/置信度
  coverage: Record<string, number>;
  confidence: Record<string, number>;
  lowConfidence: Record<string, boolean>;
  dev: number | null; avail: number | null; ttft: number | null;
  /** 首字延迟原始毫秒数:48ms 这种值用秒显示会变成"0 秒",页面必须拿毫秒自己排版 */
  ttftMs?: number | null;
  /** 推理档模型 TTFT(task=perf_reasoning,不入 PF):分模型锚点校准的数据面,
   *  展示用途——推理首 token 含思考调度,与普通档混在一个锚点里会互相污染(method.html 待办) */
  ttftReasoningMs?: number | null;
  ttftReasoningModel?: string | null;
  /** 双窗口分桶(2026-10-10.1):忙/闲桶各自中位数;ttftPartialBucket 非空=只有该桶有样本 */
  ttftWorkMs?: number | null;
  ttftOffMs?: number | null;
  ttftPartialBucket?: "work" | "off" | null;
  cache: number | null; inject: number | null; timeout: number | null; stream: number | null;
  fp: "pass" | "suspect" | "fail" | "pending";
  price: string | null;
  /** 报价数值(人民币 / 百万 tokens),前端排序用它 —— parseFloat("¥4.97") 会得到 NaN */
  priceV?: number | null;
  /** 这条报价的源货币与是否做过汇率折算(智谱是 CNY 原值,不能被再乘一次汇率) */
  priceSrc?: { src: string; fxApplied: boolean } | null;
  /** 标价原值(按源货币计)+ 币种:配合充值比例算到手价 */
  priceBase?: number | null;
  models?: string[];
  priceCalib?: "measured" | "page" | null;
  priceCalibFactor?: number | null;
  priceBaseCur?: string | null;
  /** 这个报价来自哪个分组:我们取最低倍率分组(最优价口径),不标就会被拿去跟默认分组比 */
  priceGroup?: string | null;
  /** 该报价对应的模型名(主价字符串里不再塞模型名) */
  priceModel?: string | null;
  /** 到手价 ¥/百万 tokens = 标价(美元数字) × 充值比例(¥ / 1 美元额度)。
   *  充值比例未声明时是 null —— 绝不假设 1:1,那会把"其实很贵"的站算成"便宜 7 倍"。 */
  effPrice?: number | null;
  effRatio?: number | null;
  audit: { matchPct: number | null; verified: number; consistency: string | null; lastAt: string };
  /** CPS 推广位(未启用时前端显示「合作洽谈中」) */
  promo?: PromoConfig | null;
  /** 声明-检测-验证:站方声明的主攻方向;null=未声明 */
  directions: string[] | null;
  /** 声明分组(含每组模型定价 vs 官方锚);null=未声明。tier=special → 特价侦察榜 */
  groups: DeclaredGroupOut[] | null;
  /** 实测所依据的分组与倍率 —— 一个 key 只绑一个分组,分数只代表该分组 */
  measuredGroup?: { group: string | null; ratio: number | null; models: string[] } | null;
  /** 注入的缓存/fresh 拆分(选型顾问算真实成本必需;null=该站未做 tokens 实验) */
  injectSplit?: { fresh_share: number; cached_share: number } | null;
  /** 商业信息(支付/比例/起充/发票/退款):来源为站方入驻声明或人工核实;未取得为 null,不臆造 */
  commerce?: CommerceInfo | null;
  /** 测速直达:浏览器探测用的 origin + 我们探针的最近一次流式实测(档案,非实时) */
  probe?: ProbePayload | null;
  /** 行内富信息:近 72 小时(6h/格)可用率走势、流式探针详情、指纹详情、健康检查次数 */
  slaSeries?: Array<{ h: string; pct: number | null; n: number }>;
  perf?: { p95: number | null; successRate: number | null; timeoutRate: number | null; bufferedRate: number | null; streamVerdict: string | null; streamCheck: any | null; iters: number | null; model: string | null; at: string | null };
  fpDetail?: { similarity: number | null; verdict: string | null; baseline: string | null; runs: number | null; at?: string | null; note?: string | null };
  checks?: number;
}

export interface CommerceInfo {
  pay: string | null;      // 支付方式:支付宝/微信/USDT/对公/卡密
  ratio: string | null;    // 充值比例:如 ¥1 = 1 美元额度
  ratioNum: number | null; // 同上一字段的数值(¥ per 1 美元额度),到手价算式要用
  minTopUp: string | null; // 起充金额:如 ¥10
  invoice: string | null;  // 发票政策:可开票类型/时效,或「不支持」
  refund: string | null;   // 退款政策:未消费余额可退/不可退/按比例
  src: string;             // 信息来源:declared=站方入驻声明 / manual=运营方人工核实
  at: string | null;       // 核实时点(YYYY-MM-DD),前端文案必须带日期
}

/** 商业信息只来自站方声明或人工核实(sites.yaml 的 commerce 块);没有任何探测路径能产出它。
 *  source 缺省为 declared(入驻 promote 写入的都是站方自填),人工回填必须显式标 manual,否则前端会把「我们猜的」说成「站方讲的」。 */
function commerceInfo(cfg: any): CommerceInfo | null {
  const c = cfg && cfg.commerce;
  if (!c || typeof c !== "object") return null;
  const s = (v: any) => (typeof v === "string" && v.trim()) ? v.trim() : null;
  const rn = Number(c.ratio_cny_per_usd);
  const out: CommerceInfo = {
    pay: s(Array.isArray(c.pay_methods) ? c.pay_methods.join(" / ") : c.pay_methods),
    ratio: s(c.recharge_ratio),
    ratioNum: isFinite(rn) && rn > 0 ? rn : null,
    minTopUp: s(c.min_top_up), invoice: s(c.invoice), refund: s(c.refund),
    src: s(c.source) === "manual" ? "manual" : "declared",
    at: s(c.verified),
  };
  return (out.pay || out.ratio || out.minTopUp || out.invoice || out.refund) ? out : null;
}

export interface ProbeRound {
  seq: number; ok: boolean; ttftMs: number | null; totalMs: number | null;
  inTok: number | null; outTok: number | null; buffered: boolean | null;
  httpStatus: number | null; error: string | null; failureType: string | null;
}
export interface ProbePayload {
  origin: string | null;
  endpoint: string | null;
  /** 档案口径:最近一次 perf 批次;浏览器探测是实时的,这部分不是 */
  archived: null | {
    batchId: string; probedAt: string; model: string | null;
    medianTtftMs: number | null; p95TtftMs: number | null;
    successRate: number | null; timeoutRate: number | null;
    bufferedRate: number | null; streamVerdict: string | null; streamCheck: any | null; iters: number | null; rounds: ProbeRound[];
  };
}

function probePayload(site: string, baseUrl: string | undefined): ProbePayload | null {
  let origin: string | null = null, endpoint: string | null = null;
  try {
    const u = new URL(String(baseUrl || ""));
    origin = u.origin;
    let base = u.href.replace(/\/+$/, "");
    if (!/\/v\d+(\/|$)/.test(base)) base += "/v1";
    endpoint = base + "/chat/completions";
  } catch { return null; }
  if (/invalid\.relaylens\.invalid$/.test(origin)) return null;   // 占位站不给测
  const d = getDb();
  const row = d.prepare(`SELECT id, started_at, summary, raw_path FROM batches WHERE site=? AND task='perf'
                         ORDER BY started_at DESC LIMIT 1`).get(site) as
    { id: string; started_at: string; summary: string | null; raw_path: string } | undefined;
  if (!row?.summary) return { origin, endpoint, archived: null };
  let rounds: ProbeRound[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(PROBE_ROOT, row.raw_path.replace(/\\/g, "/")), "utf8"));
    rounds = (raw.result?.samples ?? []).map((s: any) => ({
      seq: s.seq, ok: !!s.ok, ttftMs: s.ttftMs ?? null, totalMs: s.totalMs ?? null,
      inTok: s.inTok ?? null, outTok: s.outTok ?? null, buffered: s.buffered ?? null,
      httpStatus: s.httpStatus ?? null, error: s.error ?? null, failureType: s.failureType ?? null,
    }));
  } catch { /* 归档读不到时只留汇总 */ }
  const sm = JSON.parse(row.summary) as any;
  return {
    origin, endpoint,
    archived: {
      batchId: row.id, probedAt: row.started_at, model: sm.model ?? null,
      medianTtftMs: sm.medianTtftMs ?? null, p95TtftMs: sm.p95TtftMs ?? null,
      successRate: sm.successRate ?? null, timeoutRate: sm.timeoutRate ?? null,
      bufferedRate: streamDisplayRate(sm), streamVerdict: sm.streamVerdict ?? null, streamCheck: sm.streamCheck ?? null, iters: sm.iters ?? null, rounds,
    },
  };
}

export interface GroupModel { model: string; inP: number | null; offIn: number | null; ratioPct: number | null }
export interface DeclaredGroupOut { name: string; tier: string; models: GroupModel[] }

function loadSiteConfigs(): Map<string, any> {
  const file = path.join(PROBE_ROOT, "config/sites.yaml");
  const m = new Map<string, any>();
  if (!fs.existsSync(file)) return m;
  try {
    const cfg = YAML.parse(fs.readFileSync(file, "utf8")) as { sites?: any[] };
    for (const s of cfg.sites ?? []) if (s?.name) m.set(s.name, s);
  } catch { /* 配置损坏时按无声明处理 */ }
  return m;
}

/** 声明分组 → 定价输出(站点快照价 ⋈ OpenRouter 官方锚,同 EP 的 join) */
function groupsOut(site: string, groups: any[] | undefined): DeclaredGroupOut[] | null {
  if (!Array.isArray(groups) || !groups.length) return null;
  const d = getDb();
  const bare = (x: string) => x.replace(/^[a-z-]+\//, "");
  const snapOf = (site2: string): Map<string, any> => {
    const r = d.prepare(`SELECT summary FROM batches WHERE site=? AND task='price' ORDER BY started_at DESC LIMIT 1`).get(site2) as { summary: string | null } | undefined;
    const m = new Map<string, any>();
    if (r?.summary) try { for (const mm of (JSON.parse(r.summary).models ?? [])) m.set(bare(mm.model), mm); } catch { /* 损坏跳过 */ }
    return m;
  };
  const siteSnap = snapOf(site);
  const offSnap = snapOf("openrouter");
  const out: DeclaredGroupOut[] = [];
  for (const g of groups) {
    if (!g?.name) continue;
    const models: GroupModel[] = (g.models ?? []).map((model: string) => {
      const s = siteSnap.get(model);
      const o = offSnap.get(model);
      const inP = s ? s.input : null;
      const offIn = o ? o.input : null;
      return { model, inP, offIn, ratioPct: inP && offIn ? Math.round(inP / offIn * 100) : null };
    });
    out.push({ name: g.name, tier: g.tier === "special" ? "special" : "primary", models });
  }
  return out;
}

/** 站点最近一次**价格快照**(含源货币)。currency 是权威字段:智谱定价页 CNY,new-api 系与 OpenRouter 为 USD。 */
function priceSnapshot(site: string): { models: any[]; currency: string | null; at: string | null } {
  const row = getDb().prepare(`SELECT started_at, summary FROM batches WHERE site=? AND task='price' ORDER BY started_at DESC LIMIT 1`)
    .get(site) as { started_at: string; summary: string | null } | undefined;
  if (!row?.summary) return { models: [], currency: null, at: null };
  try {
    const j = JSON.parse(row.summary) as any;
    return { models: Array.isArray(j.models) ? j.models : [], currency: j.currency ?? null, at: row.started_at };
  } catch { return { models: [], currency: null, at: null }; }
}

/** 最近一次健康检查的原始探针值:探活 RTT 与 /models 可见模型数(参照系行只有这两项性能数据是真的) */
function healthLatest(site: string): { latencyMs: number | null; httpStatus: number | null; modelCount: number | null; at: string | null } {
  const row = getDb().prepare(`SELECT started_at, summary FROM batches WHERE site=? AND task='health' ORDER BY started_at DESC LIMIT 1`)
    .get(site) as { started_at: string; summary: string | null } | undefined;
  if (!row?.summary) return { latencyMs: null, httpStatus: null, modelCount: null, at: null };
  try {
    const j = JSON.parse(row.summary) as any;
    const mc = j.modelsCheck ?? j.check ?? {};
    return {
      latencyMs: typeof mc.latencyMs === "number" ? mc.latencyMs : null,
      httpStatus: typeof mc.httpStatus === "number" ? mc.httpStatus : null,
      modelCount: typeof mc.modelCount === "number" ? mc.modelCount : null,
      at: row.started_at,
    };
  } catch { return { latencyMs: null, httpStatus: null, modelCount: null, at: null }; }
}

function latestSummary(site: string, like: string): any | null {
  const row = getDb().prepare(`SELECT started_at, summary FROM batches WHERE site=? AND summary LIKE ? ORDER BY started_at DESC LIMIT 1`).get(site, like) as { started_at: string; summary: string } | undefined;
  if (!row?.summary) return null;
  try { return { ...JSON.parse(row.summary), _at: row.started_at }; } catch { return null; }
}

/** 流式真伪的对外展示值:长输出专项(3 次)结论优先——真流式=0 / 伪流式=100 / 混合=伪流式占比;
 *  老批次退回短循环 bufferedRate,再没有=未测。
 *  为什么不能直接用 bufferedRate:短 prompt 答案只有 2 字,真流式站也会单 chunk 交付,直接展示会把 aixoras 这类真流式站误标成伪流式 100%。 */
function streamDisplayRate(perfSummary: any): number | null {
  const v = perfSummary?.streamVerdict;
  if (v === "stream") return 0;
  if (v === "buffered") return 100;
  if (v === "mixed") return perfSummary?.streamCheck?.bufferedPct ?? null;
  return perfSummary?.bufferedRate ?? null;
}

function buildRealSite(site: string, opts: { inject?: number | null }): FrontendSite | null {
  const m = assembleMetrics(site, { inject: opts.inject ?? undefined });
  // 场景分
  const score: Record<string, number | null> = {};
  const coverage: Record<string, number> = {};
  const confidence: Record<string, number> = {};
  const lowConfidence: Record<string, boolean> = {};
  for (const scene of allScenes()) {
    const r = computeSceneScore(m, scene);
    score[scene] = r.score; coverage[scene] = r.coverage; confidence[scene] = r.confidence; lowConfidence[scene] = r.lowConfidence;
  }
  // 指标
  const h = siteHealth(site);
  const rec = latestSummary(site, "%reconcile%");
  const fp = latestSummary(site, "%fingerprint%");
  const perf = latestSummary(site, "%\"perf\"%");
  // 代表价格:取价格快照中最便宜的锚定模型。折算按**该快照自己的 currency** 走,不假设全是美元
  let price: string | null = null;
  let priceV: number | null = null;
  let priceSrc: { src: string; fxApplied: boolean } | null = null;
  let priceBase: number | null = null;
  let priceBaseCur: string | null = null;
  let priceGroup: string | null = null;
  let priceModel: string | null = null;
  let priceCalib: "measured" | "page" | null = null;
  let priceCalibFactor: number | null = null;
  if (m.EP.models.length) {
    /** 主价 = 站方公示的原始额度价(new-api 系页面显示的就是 $X/M)。
     *  以前在这里乘 1 美元=¥7.1 造出 ¥ 主价,而站方是按充值比例卖额度的(常见 ¥1=1$),
     *  结果我们报的数在站方页面上根本找不到。汇率只适用于真用美元付款的官方直连。 */
    const snap = priceSnapshot(site);
    const cheapest = m.EP.models.slice().sort((a, b) => a.inP - b.inP)[0];
    const srcRow = snap.models.find((x: any) => x.model === cheapest.model) as any;
    const cur = snap.currency ?? "USD";
    priceBase = cheapest.inP; priceBaseCur = cur;
    priceGroup = srcRow?.group ?? null;
    /* 三因子口径(2026-10-03,用户钉死):到手价 = 官方价格 × 倍率 × 充值比例,价格严格按此展示。
     * 实扣校准不再乘进价格,只作验证标签:factor≈1 → 标价与实扣一致;偏离 → 标价不实信号。 */
    const cal = calibOf(site);
    priceCalib = cal ? "measured" : "page";
    priceCalibFactor = cal ? cal.factor : null;
    priceV = priceBase;                                    // 排序统一用额度价数字(跨站同单位可比)
    priceSrc = { src: cur, fxApplied: false };
    price = (cur === "CNY" ? "¥" : "$") + priceBase + "/M";
    priceModel = cheapest.model;
  }
  const status: "g" | "y" | "r" =
    (h.lastCheckAt && latestSummary(site, "%") === null) ? "r" :
    h.avail7d === null ? "r" : h.avail7d >= 95 ? "g" : h.avail7d >= 80 ? "y" : "r";
  /** 推理档 TTFT(独立 task,与主 PF 样本物理隔离):锚点校准素材 + 页面透明展示 */
  const perfR = getDb().prepare(`SELECT summary FROM batches WHERE site=? AND task='perf_reasoning' ORDER BY started_at DESC LIMIT 1`)
    .get(site) as { summary: string } | undefined;
  let ttftReasoningMs: number | null = null, ttftReasoningModel: string | null = null;
  if (perfR?.summary) {
    try {
      const pr = JSON.parse(perfR.summary) as { medianTtftMs?: number | null; model?: string | null };
      ttftReasoningMs = pr.medianTtftMs ?? null;
      ttftReasoningModel = pr.model ?? null;
    } catch { /* 损坏批次按未测处理 */ }
  }
  return {
    name: site, real: true, dataLayer: "p2", status,
    /** billing = 做过账单级逐笔对账(可称"实测");passive = 只有免成本的健康与价格监测(只能称"监测中") */
    level: (latestSummary(site, "%reconcile%") ? "billing" : "passive") as "billing" | "passive",
    score, coverage, confidence, lowConfidence,
    dev: m.BH.match,
    avail: h.avail7d, ttft: m.PF.ttftMs !== null ? Math.round(m.PF.ttftMs / 100) / 10 : null,
    ttftMs: m.PF.ttftMs,
    ttftWorkMs: m.PF.workMs ?? null, ttftOffMs: m.PF.offMs ?? null,
    ttftPartialBucket: m.PF.partialBucket ?? null,
    ttftReasoningMs, ttftReasoningModel,
    cache: null,                                     // 缓存命中率来自对账日志另算,暂 null
    inject: opts.inject ?? null,
    injectSplit: m.injectSplit ?? null,
    timeout: m.ST.timeoutPct, stream: m.SR.bufferedRate,
    fp: fp ? (fp.verdict === "pass" ? "pass" : fp.verdict === "suspect" ? "suspect" : "fail") : "pending",
    price, priceV, priceSrc, priceBase, priceBaseCur, priceGroup, priceModel, priceCalib, priceCalibFactor,
    /** 该站在监测到的价表覆盖哪些模型家族(榜单「模型」筛选栏的数据源;空=价表未采到任何登记模型) */
    models: (() => {
      const FAMTOK: Record<string, string> = { Anthropic: "claude", OpenAI: "gpt", Google: "gemini", DeepSeek: "deepseek", Zhipu: "glm", xAI: "grok", Moonshot: "kimi" };
      const set = new Set<string>();
      for (const mm of m.EP.models) { const c = matchCanon(mm.model); if (c && FAMTOK[c.fam]) set.add(FAMTOK[c.fam]); }
      return [...set];
    })(),
    audit: {
      matchPct: rec ? rec.matched !== undefined && (rec.matched + rec.mismatched) > 0 ? Math.round(rec.matched / (rec.matched + rec.mismatched) * 1000) / 10 : null : null,
      verified: rec ? (rec.matched ?? 0) + (rec.mismatched ?? 0) : 0,
      consistency: null,
      lastAt: rec ? rec._at.slice(0, 10) : "",
    },
  };
}

/**
 * 首页信任横幅与账单证据面板的事实源。
 * 原则:只统计**已经发生且可回溯到原始证据**的量;数字不好看是次要的,
 * 首页写一个编出来的「已实测 47 家 / 核验账单 ¥128,600」才是致命的 ——
 * 一个卖点是「计费诚实」的站,自己的门面数字必须是假的话,被拆穿一次就全盘崩塌。
 */
export interface TrustStats {
  sitesRegistered: number;      // 在册(已解析器配置)站点数
  sitesPaidMeasured: number;    // 其中做过账单级逐笔对账的(真数,不是入参长度)
  sitesMonitored: number;       // 已入册但只有免费监测(健康/价格)的站
  priceLineItems: number;       // 最新价格快照的报价条目合计(含同名跨站)
  distinctModels: number;       // 去重后的模型名
  reconcileVerified: number;    // 逐笔核验过的真实请求笔数
  reconcileMismatched: number;  // 其中超差笔数
  reconcileAmountUsd: number;   // 这些笔次实扣金额合计(美元)
  reconcileAmountCny: number | null;   // 同上一字段,人民币口径 —— 页面只能用它
  maxSingleRequestTokens: number;
  batchesToday: number;
  healthChecksTotal: number;
  since: string;                // 实测起始日
}

/**
 * 请求总 token 量 = prompt + completion。
 * 注意 cacheTok 是 prompt_tokens 的**子集**(reconcile 里 fresh = prompt - cache),
 * 加成 in+cache+out 会把缓存算两遍 —— 曾因此把单笔最大量报成 786K(实际 404K)。
 */
const tokOf = (x: { inTok?: number; outTok?: number }) => (x.inTok ?? 0) + (x.outTok ?? 0);

function computeStats(realSites: string[]): TrustStats {
  const d = getDb();
  const cfgFile = path.join(PROBE_ROOT, "config/sites.yaml");
  let registered = realSites.length;
  try {
    const y = YAML.parse(fs.readFileSync(cfgFile, "utf8")) as { sites?: Array<{ enabled?: boolean }> };
    registered = (y.sites ?? []).filter(s => s.enabled !== false).length;
  } catch { /* 配置读不到则退化为实测站数,不编数 */ }

  // 报价条目:各站最新一次价格快照
  let lineItems = 0;
  const names = new Set<string>();
  for (const r of d.prepare(`SELECT site, summary FROM batches b WHERE task='price'
      AND started_at = (SELECT MAX(started_at) FROM batches b2 WHERE b2.site=b.site AND b2.task='price')`).all() as Array<{ site: string; summary: string | null }>) {
    if (!r.summary) continue;
    try {
      const ms = (JSON.parse(r.summary) as { models?: Array<{ model: string }> }).models ?? [];
      lineItems += ms.length;
      for (const m of ms) names.add(m.model);
    } catch { /* 损坏快照不计数 */ }
  }

  // 逐笔核验:读原始归档(不用 batches.summary —— 摘要里没存金额,读原始才是事实源)
  let verified = 0, mismatched = 0, amountQuota = 0, maxTok = 0;
  const seen = new Set<string>();
  for (const r of d.prepare(`SELECT site, id, raw_path, started_at, summary FROM batches
                             WHERE summary LIKE '%reconcile%' ORDER BY started_at DESC`).all() as
    Array<{ site: string; id: string; raw_path: string; started_at: string; summary: string | null }>) {
    if (seen.has(r.site)) continue;      // 只取每站最近一次(同批次的笔次不重复累加)
    seen.add(r.site);
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(PROBE_ROOT, r.raw_path.replace(/\\/g, "/")), "utf8")) as
        { result?: { matched?: number; mismatched?: number; totalActualQuota?: number; rows?: Array<{ inTok?: number; cacheTok?: number; outTok?: number }> } };
      const res = raw.result ?? {};
      verified += res.matched ?? 0;
      mismatched += res.mismatched ?? 0;
      amountQuota += res.totalActualQuota ?? 0;
      for (const row of res.rows ?? []) {
        const t = tokOf(row);
        if (t > maxTok) maxTok = t;
      }
    } catch { /* 归档缺失跳过该站,不猜 */ }
  }

  const first = d.prepare(`SELECT MIN(started_at) a FROM batches`).get() as { a: string | null };
  const checks = (d.prepare(`SELECT COUNT(*) c FROM batches WHERE task='health'`).get() as { c: number }).c;
  const today = (d.prepare(`SELECT COUNT(*) c FROM batches WHERE started_at >= date('now')`).get() as { c: number }).c;

  /**
   * 「已付费实测」必须数得出来的真数:只有做过账单级逐笔对账(reconcile 批次)的站才算。
   * 扩站当天就把入参长度直接当这个数,会让首页写「12 家已付费实测」而实际只有 2 家 —— 那是回到编数字的老路。
   */
  const billingSites = realSites.filter(s =>
    (d.prepare(`SELECT COUNT(*) AS c FROM batches WHERE site=? AND summary LIKE '%reconcile%'`).get(s) as { c: number }).c > 0);
  return {
    sitesRegistered: registered, sitesPaidMeasured: billingSites.length, sitesMonitored: realSites.length - billingSites.length,
    priceLineItems: lineItems, distinctModels: names.size,
    reconcileVerified: verified, reconcileMismatched: mismatched,
    reconcileAmountUsd: Math.round(amountQuota / 500000 * 10000) / 10000,
    /** 同一笔金额的人民币口径(站内所有对外展示金额一律用它,不得把上面的 Usd 字段直接上页面) */
    reconcileAmountCny: money(amountQuota / 500000, "USD").cny,
    maxSingleRequestTokens: maxTok,
    batchesToday: today, healthChecksTotal: checks,
    since: first.a ? first.a.slice(0, 10) : "",
  };
}

/**
 * 账单证据面板的真实样本:从最近一次逐笔对账里挑 4 笔有代表性的请求。
 * 挑法:最大 token / 典型 / 最短 / 缓存占比最高 —— 让读者看到不同量级都对得上,
 * 而不是只挑对自己好看的那笔。
 */
export function evidenceSample(sites: string[]): { site: string; batchId: string; ranAt: string; rows: unknown[]; matched: number; total: number } | null {
  const d = getDb();
  const batches = d.prepare(`SELECT site, id, raw_path, started_at FROM batches
                             WHERE summary LIKE '%reconcile%' ORDER BY started_at DESC`).all() as
    Array<{ site: string; id: string; raw_path: string; started_at: string }>;
  // 取「可验证笔数最多」那一站的最近批次:证据厚度优先于新旧
  let best: { r: typeof batches[number]; res: any } | null = null;
  for (const r of batches) {
    if (!sites.includes(r.site)) continue;
    let res: any;
    try { res = JSON.parse(fs.readFileSync(path.join(PROBE_ROOT, r.raw_path.replace(/\\/g, "/")), "utf8")).result; }
    catch { continue; }
    if (!res?.rows?.length) continue;
    if (!best || (res.matched ?? 0) > (best.res.matched ?? 0)) best = { r, res };
  }
  if (best) {
    const { r, res } = best;
    const all: any[] = res.rows;
    const pick: any[] = [];
    const take = (cand: any | undefined) => { if (cand && !pick.includes(cand)) pick.push(cand); };
    const share = (x: any) => (x.cacheTok ?? 0) / Math.max(1, x.inTok ?? 1);   // 缓存占 prompt 的比例
    take(all.slice().sort((a, b) => tokOf(b) - tokOf(a))[0]);                   // 最大单笔
    take(all.slice().sort((a, b) => share(b) - share(a))[0]);                   // 缓存占比最高
    take(all.slice().sort((a, b) => tokOf(a) - tokOf(b))[0]);                   // 最短单笔
    take(all[Math.floor(all.length / 2)]);                                       // 典型(中位序)
    return {
      site: r.site, batchId: r.id, ranAt: r.started_at, rows: pick,
      matched: res.matched ?? 0, total: res.total ?? pick.length,
    };
  }
  return null;
}

/**
 * 比价页真实数据:站点快照 ⋈ OpenRouter 官方锚(与 EP 同一套 join)。
 * 只收「有官方锚」的模型 —— 没有锚就无从谈贵贱,宁缺毋滥。
 * 每行同时带该站的计费实测(对账匹配率/最大偏差/实测批次缓存占比),
 * 让比价页的「扣费偏差」「实测命中」两列是真数,而不是演示值。
 */
export interface CompareRow {
  site: string; group: string | null;
  inP: number; outP: number; cacheP: number | null;
  /** 主口径是怎么来的:default=默认组 / median=无默认组取中位 / null=旧快照未标 */
  groupKind?: "default" | "median" | "key" | null;
  /** 三因子透明化:官方价格(基础价,不含组倍率,$/M)+ 倍率(组倍率)+ 充值比例 → 到手价 = 官方价 × 倍率 × 充值比例 */
  baseIn?: number | null; baseOut?: number | null; baseCr?: number | null; grpRatio?: number | null;
  /** 低于主口径的特价组(门槛透明展示用);inP/effIn 同为该组「官方价×该组倍率(×充值比例)」 */
  special?: { group: string; ratio: number; inP: number; outP: number; effIn?: number | null } | null;
  /** 同模型全部在售渠道价(站方定价页口径,页面价=官方价×该组倍率;head=本行主渠道,calibHead=该行是否实测校准过) */
  channels?: Array<{ group: string; grpRatio: number; inP: number; outP: number; cacheP: number | null; head: boolean }> | null;
  /** 实扣验证:measured=已用真金白银账单核对 / page=仅页面价未实测;calibStatus 表实测是否与标价公式相符 */
  calib?: "measured" | "page" | null;
  calibStatus?: "match" | "mismatch" | null;   // measured 时:实扣≈标价公式 / 实扣≠标价(站方做手脚信号)
  calibDiffPct?: number | null;                // (实扣 − 按公式应扣) ÷ 应扣 × 100,正=多收 负=少收
  cacheBill: "honest" | "unknown";
  matchPct: number | null; dev: number | null;   // dev = 该站最近对账的最大偏差%
  cacheShare: number | null;                     // 实测批次 cacheTok/prompt 中位(探针口径)
  inject: number | null;
  /** 该价的源货币与是否折算(如 "USD→CNY" / "CNY"),让"这个 ¥ 是怎么来的"可追溯 */
  src?: string | null;
  /** 站方声明的充值比例(¥ / 1 美元额度);null = 未声明,不得按 1:1 默认 */
  ratio?: number | null;
  /** 到手价 ¥/百万 tokens:仅当比例已声明且标价按美元额度记账时产出 */
  effIn?: number | null; effOut?: number | null; effCr?: number | null;
}
export interface CompareTab {
  key: string; name: string; family: string;
  /** 官方锚计价单位(OpenRouter 为 USD) */
  officialCur?: string;
  official: { in: number; out: number; cr: number | null };
  rows: CompareRow[];
}


/** 每站计费实测摘要(读原始归档,不读 summary) */
function billingProfile(site: string): { matchPct: number | null; maxDev: number | null; cacheShare: number | null } {
  const d = getDb();
  const row = d.prepare(`SELECT raw_path FROM batches WHERE site=? AND summary LIKE '%reconcile%'
                         ORDER BY started_at DESC LIMIT 1`).get(site) as { raw_path: string } | undefined;
  if (!row?.raw_path) return { matchPct: null, maxDev: null, cacheShare: null };
  try {
    const res = JSON.parse(fs.readFileSync(path.join(PROBE_ROOT, row.raw_path.replace(/\\/g, "/")), "utf8")).result;
    const verifiable = (res.matched ?? 0) + (res.mismatched ?? 0);
    const shares = (res.rows ?? []).map((r: any) => r.inTok > 0 ? (r.cacheTok ?? 0) / r.inTok : null)
      .filter((x: number | null) => x !== null && x > 0 && x <= 1).sort((a: number, b: number) => a - b);
    return {
      matchPct: verifiable > 0 ? Math.round((res.matched / verifiable) * 1000) / 10 : null,
      maxDev: res.maxAbsDiffPct ?? null,
      cacheShare: shares.length ? Math.round(shares[Math.floor(shares.length / 2)] * 1000) / 10 : null,
    };
  } catch { return { matchPct: null, maxDev: null, cacheShare: null }; }
}

/** 实扣校准:billing 批次的 实扣÷应扣 因子(锚点假设破缺的站靠它纠偏)。
 *  仅当 billing 发生在**当前价格快照之后**才有效(因子是相对快照算的,快照一换就作废);
 *  未校准的站展示页面价并标「估算」。 */
const _calibCache = new Map<string, { factor: number; at: string; models: string[] | null } | null>();
export function calibOf(site: string): { factor: number; at: string; models: string[] | null } | null {
  if (_calibCache.has(site)) return _calibCache.get(site)!;
  const d = getDb();
  let out: { factor: number; at: string; models: string[] | null } | null = null;
  const b = d.prepare(`SELECT started_at, summary FROM batches WHERE site=? AND task='billing' AND summary LIKE '%expectedCostCents%' ORDER BY started_at DESC LIMIT 1`).get(site) as { started_at: string; summary: string } | undefined;
  const p = d.prepare(`SELECT started_at FROM batches WHERE site=? AND task='price' ORDER BY started_at DESC LIMIT 1`).get(site) as { started_at: string } | undefined;
  if (b?.summary) {
    try {
      const s = JSON.parse(b.summary) as any;
      /* 有效性:新批次带 priceHash(价表内容指纹,价一字未改则验证仍成立);老批次回退「billing 晚于当前价格快照」的时间戳判据 */
      let valid: boolean;
      if (typeof s.priceHash === "string" && s.priceHash) {
        valid = p !== undefined && s.priceHash === priceTableHash(site);
      } else {
        valid = !!(p?.started_at && b.started_at >= p.started_at);
      }
      if (valid && typeof s.actualCostCents === "number" && s.actualCostCents > 0 && typeof s.expectedCostCents === "number" && s.expectedCostCents > 0) {
        const f = s.actualCostCents / s.expectedCostCents;
        if (isFinite(f) && f > 0.001 && f < 100) {
          /* 覆盖模型:新批次带 calibModels(逐轮实测过的模型);老批次无此字段 → null=按全局因子对待 */
          let models: string[] | null = null;
          if (s.calibModels && typeof s.calibModels === "object") {
            models = Object.keys(s.calibModels).map(k => matchCanon(k)?.canon ?? "​").filter(x => x !== "​");
          }
          out = { factor: Math.round(f * 1000) / 1000, at: b.started_at, models };
        }
      }
    } catch { /* */ }
  }
  _calibCache.set(site, out);
  return out;
}

export function buildCompare(sites: string[], injectOf: (site: string) => number | null): CompareTab[] {
  const d = getDb();
  const snap = (site: string): Array<{ model: string; input: number; output: number; cacheRead: number | null; group: string | null; groupKind?: string | null; grpRatio?: number | null; base?: { input: number; output: number; cacheRead: number | null } | null; groups?: Array<{ group: string; ratio: number; input: number; output: number; cacheRead: number | null }> }> => {
    const r = d.prepare(`SELECT summary FROM batches WHERE site=? AND task='price' ORDER BY started_at DESC LIMIT 1`).get(site) as { summary: string | null } | undefined;
    if (!r?.summary) return [];
    try { return (JSON.parse(r.summary) as any).models ?? []; } catch { return []; }
  };
  const bare = (m: string) => m.replace(/^[a-z-]+\//, "");
  /* 官方锚按 17 模型登记表归一后建索引:OpenRouter 点号写法(claude-sonnet-5.5)与中转站连字符写法
   * (claude-sonnet-5-5)、thinkai 的 deepseek-v4-1-flash 等在此收敛到同一 canon */
  const offMap = new Map<string, any>();
  for (const m of snap("openrouter")) { const c = matchCanon(m.model); if (c && !offMap.has(c.canon)) offMap.set(c.canon, m); }

  /* 逐站预算:源货币、站方声明的充值比例、实扣校准因子(仅用于验证,不改价格) */
  const cfgCache = loadSiteConfigs();
  const curOf = (site: string) => priceSnapshot(site).currency ?? null;
  const ratioOf = (site: string): number | null => {
    const raw = Number((cfgCache.get(site) as any)?.commerce?.ratio_cny_per_usd);
    return isFinite(raw) && raw > 0 ? raw : null;
  };
  const r2 = (n: number) => Math.round(n * 100) / 100;

  const byModel = new Map<string, CompareTab>();
  for (const site of sites) {
    const prof = billingProfile(site);
    const rc = curOf(site);                       // 该站标价源货币(USD/CNY)
    const rn = ratioOf(site);                     // 站方声明充值比例(¥ / 1 美元额度)
    const cal = calibOf(site);                    // 实扣÷应扣 因子(有真金白银账单才有)
    const seen = new Set<string>();             // 同站同 canon 多写法(点/横、-preview)只留首个(快照已按价排序时即代表价)
    for (const m of snap(site)) {
      const entry = matchCanon(m.model);
      if (!entry) continue;                     // 不在 17 模型登记表 → 不进比价(裁掉旧代 gpt-5.5/claude-opus-5/glm-5.2 与派生名)
      /* 因子只作用于验证批次实测覆盖的模型:站方对不同模型可配不同倍率组,把 GPT 轮次的因子外推到 deepseek 行是错的 */
      const calForModel = cal && (cal.models === null || cal.models.includes(entry.canon)) ? cal : null;
      const off = offMap.get(entry.canon);
      if (!off) continue;                        // 无官方锚,不进比价
      if (seen.has(entry.canon)) continue;
      seen.add(entry.canon);
      const key = entry.canon;
      let tab = byModel.get(key);
      if (!tab) {
        tab = { key, name: entry.disp, family: entry.fam, official: { in: off.input, out: off.output, cr: off.cacheRead ?? null }, rows: [] };
        byModel.set(key, tab);
      }
      /** 到手价严格三因子:官方价格(base,$/M) × 倍率(组倍率) × 充值比例。
       *  base/grpRatio 来自解析器(表达式系数或 model_ratio×$2 的「不含组倍率」基础价)。
       *  ⚠ 校准因子绝不乘进价格——它只做「标价公式 vs 真金白银实扣」的验证。
       *  组归位(2026-10-03):new-api 一个 key 只绑一个组。有账单实测时,把主口径钉到
       *  「按公式价与实扣吻合」的那个组(groupKind=key)——这才是你 key 的真价,公式与账单同时自洽。 */
      const base = m.base?.input != null ? m.base : (m.grpRatio ? { input: Math.round((m.input / m.grpRatio) * 1e6) / 1e6, output: Math.round((m.output / m.grpRatio) * 1e6) / 1e6, cacheRead: m.base?.cacheRead ?? (m.grpRatio && m.cacheRead != null ? Math.round((m.cacheRead / m.grpRatio) * 1e6) / 1e6 : m.cacheRead ?? null) } : { input: m.input, output: m.output, cacheRead: m.cacheRead ?? null });
      let finalGroup: string | null = m.group ?? null;
      let grpRatio: number | null = m.grpRatio ?? null;
      let quotaIn = m.input, quotaOut = m.output, quotaCr = m.cacheRead ?? null;
      let gKind: CompareRow["groupKind"] = (m.groupKind as CompareRow["groupKind"]) ?? null;
      let factorEff: number | null = calForModel ? calForModel.factor : null;
      if (calForModel && Array.isArray(m.groups) && m.groups.length) {
        const actual = m.input * calForModel.factor;                       // 账单实扣折算的 $/M 单价
        const matchG = m.groups.find(g => actual > 0 && Math.abs(g.input - actual) / actual <= 0.05);
        if (matchG) {                                              // 命中实扣组:主口径换成该组的页面三因子价
          finalGroup = matchG.group; grpRatio = matchG.ratio;
          quotaIn = matchG.input; quotaOut = matchG.output; quotaCr = matchG.cacheRead ?? null;
          gKind = "key"; factorEff = actual > 0 ? Math.round(actual / matchG.input * 1000) / 1000 : null;
        }
      }

      let special: CompareRow["special"] = null;
      if (Array.isArray(m.groups) && m.groups.length) {
        const lower = m.groups.filter(g => g.group !== finalGroup && g.input < quotaIn - 1e-9);
        if (lower.length) {
          const min = lower.reduce((a, b) => (a.input <= b.input ? a : b));
          // 特价组到手 = 官方价 × 该组倍率 × 充值比例(与主口径同公式,只换倍率)
          special = { group: min.group, ratio: min.ratio, inP: r2(min.input), outP: r2(min.output), effIn: (rc === "USD" && rn != null) ? r2(min.input * rn) : null };
        }
      }
      /* 实扣验证:标价公式算出的应扣与真金白银一致吗(±5%) */
      let calibStatus: CompareRow["calibStatus"] = null, calibDiffPct: number | null = null;
      const calib: CompareRow["calib"] = calForModel ? "measured" : "page";
      if (factorEff != null) {
        calibDiffPct = Math.round((factorEff - 1) * 1000) / 10;
        calibStatus = factorEff >= 0.95 && factorEff <= 1.05 ? "match" : "mismatch";
      }
      /* 渠道全览:同模型该站所有声明组的页面价(主渠道行用校准后价格,与主行一致) */
      const channels = Array.isArray(m.groups) && m.groups.length
        ? m.groups.map(g => ({
            group: g.group, grpRatio: g.ratio,
            inP: g.group === finalGroup ? r2(quotaIn) : r2(g.input),
            outP: g.group === finalGroup ? r2(quotaOut) : r2(g.output),
            cacheP: g.group === finalGroup ? (quotaCr == null ? null : r2(quotaCr)) : (g.cacheRead == null ? null : r2(g.cacheRead)),
            head: g.group === finalGroup,
          })).sort((a, b) => (b.head ? 1 : 0) - (a.head ? 1 : 0) || a.inP - b.inP)
        : null;
      tab.rows.push({
        site, group: finalGroup, groupKind: gKind,
        inP: r2(quotaIn), outP: r2(quotaOut), cacheP: quotaCr == null ? null : r2(quotaCr), special, channels,
        baseIn: Math.round(base.input * 1e4) / 1e4, baseOut: Math.round(base.output * 1e4) / 1e4, baseCr: base.cacheRead == null ? null : Math.round(base.cacheRead * 1e4) / 1e4, grpRatio,
        calib, calibStatus, calibDiffPct,
        cacheBill: m.cacheRead != null && prof.matchPct === 100 ? "honest" : "unknown",
        matchPct: prof.matchPct, dev: prof.maxDev, cacheShare: prof.cacheShare,
        inject: injectOf(site),
      });
    }
  }
  // 双站可比的模型排前,同数按名称
  const tabs = [...byModel.values()].sort((a, b) => b.rows.length - a.rows.length || a.key.localeCompare(b.key));
  /**
   * 展示层换算:数据库与评分永远按源货币原样记账,下发前统一折算成人民币。
   * OpenRouter / new-api 系是 USD,智谱官方定价页是 CNY —— 对 CNY 再乘一次汇率会把 ¥2/M 报成 ¥14.2/M。
   */
  for (const t of tabs) {
    t.officialCur = curOf("openrouter") ?? "USD";   // 官方锚保持美元原价(真美元现金支付)
    for (const r of t.rows) {
      const rc = curOf(r.site), rn = ratioOf(r.site);
      /** 到手价 = 额度价(= 官方价 × 倍率) × 充值比例。比例只能由站方声明;未声明留 null,前端如实显示「无法折算」。 */
      if (rn !== null && rc === "USD") {
        r.ratio = rn;
        r.effIn = r2((r.inP as number) * rn); r.effOut = r2((r.outP as number) * rn);
        r.effCr = r.cacheP == null ? null : r2((r.cacheP as number) * rn);
      } else { r.ratio = null; }
      r.src = `${rc ?? "USD"}`;
    }
  }
  return tabs;
}

/** 下发给前端的推广视图:只含展示字段 —— rate/until 是商业敏感信息,只参与服务端排序 */
function pubPromo(p?: PromoConfig | null): PromoConfig | null {
  if (!p) return null;
  return { enabled: p.enabled, url: p.url, coupon: p.coupon, couponDesc: p.couponDesc };
}

/**
 * 实测所依据的分组。new-api 系的一个 token 只绑一个分组,
 * 所以「站点分」实为「该站某个分组的分」—— 不披露就是口径造假。
 * 取最近一次对账样本模型在价格快照里的多数派分组。
 */
function measuredGroup(site: string): { group: string | null; ratio: number | null; models: string[] } {
  const d = getDb();
  const r = d.prepare(`SELECT raw_path FROM batches WHERE site=? AND summary LIKE '%reconcile%' ORDER BY started_at DESC LIMIT 1`)
    .get(site) as { raw_path: string } | undefined;
  if (!r?.raw_path) return { group: null, ratio: null, models: [] };
  let rows: any[] = [];
  try { rows = (JSON.parse(fs.readFileSync(path.join(PROBE_ROOT, r.raw_path.replace(/\\/g, "/")), "utf8")).result.rows) ?? []; }
  catch { return { group: null, ratio: null, models: [] }; }
  const models = [...new Set(rows.map(x => x.model).filter(Boolean))] as string[];
  const p = d.prepare(`SELECT summary FROM batches WHERE site=? AND task='price' ORDER BY started_at DESC LIMIT 1`).get(site) as { summary: string | null } | undefined;
  const tally = new Map<string, number>();
  if (p?.summary) {
    const byModel = new Map(((JSON.parse(p.summary).models ?? []) as any[]).map(m => [m.model, m.group]));
    for (const m of models) {
      const g = byModel.get(m);
      if (g) tally.set(g, (tally.get(g) ?? 0) + 1);
    }
  }
  let group: string | null = null, best = 0;
  for (const [g, n] of tally) if (n > best) { best = n; group = g; }
  return { group, ratio: rows.length ? (rows[0].groupRatio ?? null) : null, models };
}

/**
 * 可用率走势:近 72 小时、每 6 小时一格(空桶记 null,前端断线画,不插值造假)。
 * 2026-10-02 起探活间隔是 5 小时 —— 沿用"逐小时 24 格"会让一整列曲线 90% 是断点,
 * 看着像站点在抖,其实是我们在睡觉。窗口与桶宽必须跟采样密度匹配。
 * rule="up" 用中转榜口径(仅 overall.status==="up");rule="alive" 用参照系可达口径(探针 overall.ok ——
 * 无 key 的官方端点返回 401 鉴权门也算"活着",按 up 口径会被算成 0% 可用率,那是假话)。
 * 两种口径各自保留:改全局规则会重算所有中转站的历史可用率,进而悄悄改动分数。
 */
const SLA_BUCKETS = 12, SLA_BUCKET_HOURS = 6;
function slaSeries(site: string, rule: "up" | "alive" = "up"): Array<{ h: string; pct: number | null; n: number }> {
  const d = getDb();
  const rows = d.prepare(`SELECT started_at, summary FROM batches WHERE site=? AND task='health'
                          AND started_at >= datetime('now','-${SLA_BUCKETS * SLA_BUCKET_HOURS} hour') ORDER BY started_at`).all(site) as
    Array<{ started_at: string; summary: string | null }>;
  const buckets = new Map<string, { up: number; n: number }>();
  /** 桶键:按 epoch 对齐到 6 小时整点(UTC 00/06/12/18)。**累加与出图必须用同一个函数** ——
   *  两边各写一遍 slice 时,起点没对齐就会得到"12 格全空"的假断线(踩过一次)。 */
  const bucketKey = (ms: number) =>
    new Date(Math.floor(ms / (SLA_BUCKET_HOURS * 3600_000)) * (SLA_BUCKET_HOURS * 3600_000)).toISOString().slice(0, 13) + ":00Z";
  /** 库里的 started_at 是 SQLite 的 UTC 文本("YYYY-MM-DD HH:MM:SS",无时区后缀)。
   *  直接 new Date() 会被按本地时区解析,整条曲线会平移 8 小时 —— 必须补 Z 再解析。 */
  const msOf = (s: string) => {
    const t = s.trim().replace(" ", "T");
    return Date.parse(/Z$|[+-]\d{2}:?\d{2}$/.test(t) ? t : t + "Z");
  };
  for (const r of rows) {
    const key = bucketKey(msOf(r.started_at));
    const o = (() => { try { return JSON.parse(r.summary ?? "{}").overall; } catch { return null; } })();
    const alive = rule === "alive" ? o?.ok === true : o?.status === "up";
    const b = buckets.get(key) ?? { up: 0, n: 0 };
    b.n++; if (alive) b.up++;
    buckets.set(key, b);
  }
  const out: Array<{ h: string; pct: number | null; n: number }> = [];
  const now = Date.now();
  for (let i = SLA_BUCKETS - 1; i >= 0; i--) {
    const key = bucketKey(now - i * SLA_BUCKET_HOURS * 3600_000);
    const b = buckets.get(key);
    out.push({ h: key.slice(5, 10) + " " + key.slice(11, 13) + ":00", pct: b && b.n ? Math.round(b.up / b.n * 1000) / 10 : null, n: b?.n ?? 0 });
  }
  return out;
}

/** 流式探针的逐轮明细与 P95(行内「延迟·口径」与链路质检用) */
function perfDetail(site: string): { p95: number | null; successRate: number | null; timeoutRate: number | null; bufferedRate: number | null; streamVerdict: string | null; streamCheck: any | null; iters: number | null; model: string | null; at: string | null } {
  const row = getDb().prepare(`SELECT started_at, summary FROM batches WHERE site=? AND task='perf' ORDER BY started_at DESC LIMIT 1`)
    .get(site) as { started_at: string; summary: string | null } | undefined;
  const empty = { p95: null, successRate: null, timeoutRate: null, bufferedRate: null, streamVerdict: null, streamCheck: null, iters: null, model: null, at: null };
  if (!row?.summary) return empty;
  try {
    const s = JSON.parse(row.summary) as any;
    return { p95: s.p95TtftMs ?? null, successRate: s.successRate ?? null, timeoutRate: s.timeoutRate ?? null, bufferedRate: s.bufferedRate ?? null, streamVerdict: s.streamVerdict ?? null, streamCheck: s.streamCheck ?? null, iters: s.iters ?? null, model: s.model ?? null, at: row.started_at };
  } catch { return empty; }
}

/** 指纹详情(相似度与判定,行内「模型真实性」用) */
/**
 * 指纹详情:取**最近一批有有效样本的**结果,而不是无条件取最新。
 * 原因:复检常因余额耗尽跑出 0 有效样本的一批,若直接覆盖,上一次真实测到的数就被抹掉(wolfai 82% 就这么没了)。
 * 但也不能假装没发生:更晚的空跑批次要如实标出来。
 */
function fpDetail(site: string): { similarity: number | null; verdict: string | null; baseline: string | null; runs: number | null; at: string | null; note: string | null } {
  const empty = { similarity: null, verdict: null, baseline: null, runs: null, at: null, note: null };
  const rows = getDb().prepare(`SELECT started_at, summary FROM batches WHERE site=? AND summary LIKE '%fingerprint%' ORDER BY started_at DESC LIMIT 8`)
    .all(site) as Array<{ started_at: string; summary: string | null }>;
  if (!rows.length) return empty;
  const parsed = rows.map(r => { try { return { at: r.started_at, s: JSON.parse(r.summary ?? "{}") as any }; } catch { return null; } })
    .filter((x): x is { at: string; s: any } => !!x);
  const good = parsed.find(x => typeof x.s.similarity === "number");
  if (!good) return empty;
  const newerEmpty = parsed.filter(x => x.at > good.at && typeof x.s.similarity !== "number").length;
  return {
    similarity: good.s.similarity ?? null, verdict: good.s.verdict ?? null, baseline: good.s.baseline ?? null,
    runs: good.s.runs ?? null, at: good.at,
    note: newerEmpty ? `其后 ${newerEmpty} 轮复检 0 有效样本(多为余额不足),此数为最近一次有效测量` : null,
  };
}

/**
 * 参照系站:官方直连 / 海外聚合平台。它们有真实的健康探测与公开报价,但**不是中转商** ——
 * 榜单衡量的是"中间商有没有少给你、多扣你",对官方没有语义,所以只作对照,不参与排名。
 * 每一列必须显式区分「不适用」(范畴不同,永远不会有值)与「未测」(我们还没做),不能都糊成"未测"。
 */
const REF_DISPLAY: Record<string, { display: string; category: "official" | "aggregator"; why: string }> = {
  "openrouter": { display: "OpenRouter", category: "aggregator", why: "聚合平台按上游官方价 + 固定服务费计费,不存在中转加价,「计费诚实」这一列对它没有语义" },
  "deepseek-official": { display: "DeepSeek 官方", category: "official", why: "官方直连按自家价格表扣费,是本站的比价基准而非被审对象" },
  "zhipu-bigmodel": { display: "智谱 GLM 官方", category: "official", why: "官方直连按自家价格表扣费,是本站的比价基准而非被审对象" },
};

export interface ReferenceSite {
  name: string; display: string; category: "official" | "aggregator"; domain: string | null;
  avail: number | null; checks: number | null; timeout: number | null;
  /** 参照系的 avail 永远是 "reachable"(免鉴权探活可达),与中转榜 avail(鉴权后真跑出内容)是两把尺子 */
  availKind: "reachable";
  authGateChecks: number | null;     // 近 7 日有多少次探活撞在 401/403 鉴权门上
  slaSeries: Array<{ h: string; pct: number | null; n: number }>;
  probeLatencyMs: number | null; probeHttpStatus: number | null; modelCount: number | null; probeNote: string;
  price: string | null; priceV: number | null; priceModel: string | null; priceSrc: string | null; priceAt: string | null;
  modelsPriced: number;
  na: Record<string, string>;               // 列 → 不适用原因
  unmeasured: Record<string, string>;       // 列 → 我们还没测的原因
}

/** 已登记的参照系站名(官方直连 / 聚合平台)。cli sync 用它决定哪些无 key 站点也要下发 */
export function referenceSiteNames(): string[] { return Object.keys(REF_DISPLAY); }

/**
 * 参照系可达率(近 7 日,探针 overall.ok 口径)。
 * **与中转榜的「可用率」是两把尺子,不可横向比较**:中转站要鉴权后真跑出内容才算 up;
 * 官方端点我们无 key,401 鉴权门证明 DNS/TLS/路由全通即算"可达"。前端必须换列名并写明口径。
 */
function refAvailability(site: string): { pct: number | null; n: number; authGate: number } {
  const rows = getDb().prepare(`SELECT summary FROM batches WHERE site=? AND task='health' AND started_at >= datetime('now','-7 day')`)
    .all(site) as Array<{ summary: string | null }>;
  let ok = 0, auth = 0;
  for (const r of rows) {
    try {
      const j = JSON.parse(r.summary ?? "{}");
      if (j.overall?.ok === true) ok++;
      if (j.modelsCheck?.httpStatus === 401 || j.modelsCheck?.httpStatus === 403) auth++;
    } catch { /* 单条 summary 损坏按不计入 */ }
  }
  return { pct: rows.length ? Math.round(ok / rows.length * 1000) / 10 : null, n: rows.length, authGate: auth };
}

function buildReferenceSite(site: string, cfg: any): ReferenceSite | null {
  const meta = REF_DISPLAY[site];
  if (!meta) return null;
  const h = siteHealth(site);
  const snap = priceSnapshot(site);
  if (h.checks === 0 && snap.models.length === 0) return null;   // 一点真实数据都没有,就不要上页面占位
  const hl = healthLatest(site);
  const m = assembleMetrics(site);
  const ra = refAvailability(site);

  // 最低报价:先把每条按**自己的源货币**折成 ¥ 再比较,否则 CNY 站会被美元站挤掉
  const priced = snap.models
    .map(x => ({ model: x.model, base: x.input, mo: money(x.input, snap.currency) }))
    .filter(x => x.mo.cny !== null && x.mo.cny > 0)
    .sort((a, b) => (a.mo.cny as number) - (b.mo.cny as number));
  const cheapest = priced[0] ?? null;

  let domain: string | null = null;
  try { domain = cfg?.base_url ? new URL(cfg.base_url).hostname : null; } catch { domain = null; }

  return {
    name: site, display: meta.display, category: meta.category, domain,
    avail: ra.pct, availKind: "reachable", checks: ra.n || null, authGateChecks: ra.authGate || null,
    timeout: m.ST.timeoutPct,
    slaSeries: slaSeries(site, "alive"),
    probeLatencyMs: hl.latencyMs, probeHttpStatus: hl.httpStatus, modelCount: hl.modelCount,
    probeNote: ra.authGate > 0
      ? `可达率口径:近 7 日 ${ra.n} 次免鉴权探活中 ${ra.authGate} 次返回 401/403 鉴权门 —— 我们按「DNS/TLS/路由全通」计为可达,不代表可直接调用,也不与中转榜的「可用率」横向比较`
      : `可达率口径:近 7 日 ${ra.n} 次免鉴权探活返回 2xx 计为可达`,
    price: cheapest ? (cheapest.mo.src === "CNY" ? "¥" : "$") + cheapest.base + "/M" : null,
    priceV: cheapest ? cheapest.base : null,
    priceModel: cheapest ? cheapest.model : null,
    priceSrc: cheapest ? cheapest.mo.src : null,
    priceAt: snap.at, modelsPriced: snap.models.length,
    na: {
      score: "不参与排名:榜单衡量的是中转站的扣费诚实度,官方与聚合平台不在这层",
      dev: meta.why,
      inject: "无号池转发,不存在「每请求塞固定脚手架 token」这种扣费方式",
      fp: "参照系本身就是模型指纹的基线来源,拿自己比自己无意义",
      stream: "官方逐 token 流式是行业基准,把它写成一列会让「真流式」失去参照意义",
    },
    unmeasured: {
      ttft: "未测:需要官方 key 跑付费流式探针(当前只做了免鉴权探活)",
      cache: "未测:缓存命中要靠真实付费批次",
      commerce: "未采集:官方多为按量后付/免费档,与中转站预充值口径不同",
    },
  };
}

export function syncData(sites: string[], opts: { inject?: Record<string, number>; reference?: string[] } = {}): string {
  const promo = loadPromo();
  /** 注入开销:显式覆盖(沙盘)→ 最近一次 tokens 批次实测 → null(未测,前端显示「未测」) */
  const inj = (s: string): number | null => opts.inject?.[s] ?? latestInjection(s);
  const cfgMap = loadSiteConfigs();
  const realSites: FrontendSite[] = [];
  for (const s of sites) {
    const r = buildRealSite(s, { inject: inj(s) });
    if (r) {
      r.promo = pubPromo(promo[s]);
      const cfg = cfgMap.get(s);
      r.directions = Array.isArray(cfg?.directions) ? cfg.directions : null;
      r.groups = groupsOut(s, cfg?.declared_groups);
      r.measuredGroup = measuredGroup(s);
      r.probe = probePayload(s, cfg?.base_url);
      r.slaSeries = slaSeries(s);
      r.perf = perfDetail(s);
      r.fpDetail = fpDetail(s);
      r.checks = siteHealth(s).checks;
      r.commerce = commerceInfo(cfg);
      /** 到手价只在「标价按美元额度记账 + 充值比例已声明」两个条件都满足时才算。
       *  缺一个就留 null,前端显示「充值比例未声明,无法折算」——  assumption 1:1 会让价格差 7 倍。 */
      const rn = r.commerce?.ratioNum ?? null;
      if (rn !== null && r.priceBase !== null && r.priceBase !== undefined) {
        r.effRatio = rn;
        r.effPrice = Math.round(r.priceBase * rn * 100) / 100;
        if (r.price !== null) r.price = "¥" + r.effPrice + "/M";   // 主价换成真花出去的人民币
      }
      realSites.push(r);
    }
  }
  /** 参照系:官方直连与聚合平台,有真实健康/报价但不进中转榜;没有任何一项数据是编的 */
  const referenceSites: ReferenceSite[] = [];
  for (const s of opts.reference ?? []) {
    const r = buildReferenceSite(s, cfgMap.get(s));
    if (r) referenceSites.push(r);
  }
  const fx = pricingDisplay();
  const out = {
    meta: {
      updated: new Date().toISOString(), weightsVersion: weightsVersion(),
      license: "CC-BY-4.0", source: "relaylens-probe",
      /** 计价口径:站内所有金额均为人民币,由 USD 按此汇率折算(评分不受影响) */
      fx: { currency: fx.currency, symbol: fx.symbol, usdCny: fx.usdCny, asOf: fx.asOf, quotaPerUsd: fx.quotaPerUsd },
      stats: { ...computeStats(sites), referenceCount: referenceSites.length },
    },
    evidence: evidenceSample(sites),
    compare: {
      unit: "站方公示价 /M tokens(new-api 系为美元额度价,智谱为人民币)",
      fx: "到手价 = 站方额度价 × 站方声明的充值比例;比例未声明的站不给人民币价。"
        + " 官方直连(OpenRouter)按美元现金支付,参考汇率 1 美元 = ¥" + fx.usdCny + "(" + fx.asOf + ")仅适用于它",
      officialAnchor: "openrouter",
      note: "仅收录有官方锚(OpenRouter)的模型;价格为各站最新价格快照,计费列为该站最近一次逐笔对账实测。",
      tabs: buildCompare(sites, inj),
    },
    realSites,
    /** 官方直连 / 聚合平台参照行(榜单底部独立分区,不参与中转排名) */
    referenceSites,
    /** 推荐位有序名单(无合格合作站则为空数组,前端显示诚实空态而非编造优惠) */
    recommendations: buildRecommendations(realSites, promo),
    // detail 页消费:每站的六桶分数+审计摘要(detail.html 的 DETAIL 结构兼容字段)
    details: Object.fromEntries(sites.map(s => {
      const m = assembleMetrics(s, { inject: inj(s) ?? undefined });
      const sc: Record<string, number | null> = {};
      const cov: Record<string, number> = {};
      const con: Record<string, number> = {};
      const low: Record<string, boolean> = {};
      for (const scene of allScenes()) {
        const r = computeSceneScore(m, scene);
        sc[scene] = r.score; cov[scene] = r.coverage; con[scene] = r.confidence; low[scene] = r.lowConfidence;
      }
      const fp = latestSummary(s, "%fingerprint%");
      const rec = latestSummary(s, "%reconcile%");
      const perf = latestSummary(s, '%\"perf\"%');
      const h = siteHealth(s);
      return [s, {
        score: sc, coverage: cov, confidence: con, lowConfidence: low,
        promo: pubPromo(promo[s]),
        commerce: commerceInfo(cfgMap.get(s)),
        audit: {
          matchPct: rec && (rec.matched + rec.mismatched) > 0 ? Math.round(rec.matched / (rec.matched + rec.mismatched) * 1000) / 10 : null,
          verified: rec ? rec.matched + rec.mismatched : 0,
          inject: inj(s),
          stream: perf ? streamDisplayRate(perf) : null,
          consistency: null,
          lastAt: rec ? rec._at.slice(0, 10) : "",
        },
        metrics: {
          avail7d: h.avail7d, checks: h.checks,
          ttft: m.PF.ttftMs, ttftSamples: m.PF.samples,
          timeoutRate: m.ST.timeoutPct, bufferedRate: m.SR.bufferedRate,
          fingerprint: fp ? { similarity: fp.similarity, baseline: fp.baseline, verdict: fp.verdict } : null,
          inject: inj(s),
          measuredGroup: measuredGroup(s),
        },
      }];
    })),
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, "sites.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
  return file;
}
