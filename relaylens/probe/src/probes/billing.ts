/**
 * 探针 C:付费对账 —— 核心资产(P2)
 * 流程:读用量 → N 轮真实付费请求(含 4 轮固定长前缀验缓存) → 再读用量
 *      → 实际扣费 = 用量差;理论应扣 = 按站点公示价 × 实测 token
 *      → 偏差率 + 该 key 实际命中的分组倍率(反推)
 * 用量口径:/v1/dashboard/billing/usage 的 total_usage(美分,OpenAI 兼容,new-api 支持)
 * 注意:total_usage 为账号累计值,若同期有其他并发使用会污染差值 —— 对账期间勿手动调用该 key。
 */
import { createHash } from "node:crypto";
import type { PriceResult, ProbeConfig, SiteConfig } from "../../../shared/types.js";
import { getDb, nextBatchId } from "../store.js";

const TIMEOUT_MS = 90_000;
const UA = "RelayLens-Probe/0.1 (+https://relaylens.example/about)";

export interface RoundResult {
  seq: number; model: string; kind: "short" | "cache";
  promptTokens: number; cachedTokens: number; completionTokens: number;
  /** 本地独立估算的 prompt token 数(CJK≈1字/token,其他≈4字符/token),用于识破 usage 虚标 */
  promptTokensEstimate: number;
  ttftMs: number | null; responseModel: string | null; httpStatus: number; ok: boolean; error?: string;
}

/** 粗略 token 估算:数量级正确即可,用于比对自报值是否离谱(>3 倍即异常) */
export function estimateTokens(text: string): number {
  let cjk = 0, other = 0;
  // CJK 汉字/假名/懖文 + 中文标点: 约 1 字 ≈ 1 token;其他非空白 约 4 字符 ≈ 1 token
  const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯　-〿＀-￯]/;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else if (!/\s/.test(ch)) other++;
  }
  return Math.max(1, Math.round(cjk + other / 4));
}

export interface BillingResult {
  task: "billing";
  site: string;
  batchId: string;
  startedAt: string;
  finishedAt: string;
  usageBeforeCents: number | null;
  usageAfterCents: number | null;
  actualCostCents: number | null;
  rounds: RoundResult[];
  expectedCostCents: number | null;
  deviationPct: number | null;
  /** 反推:实际扣费相当于公示最低组价格的多少倍(≈该 key 命中的分组倍率/最低组倍率) */
  impliedGroupRatio: number | null;
  /** 自报 prompt_tokens ÷ 本地估算 —— 显著 >1 说明站点注入前缀或虚标,用户为未发送的 token 付费 */
  usageInflationRatio: number | null;
  errors: string[];
}

async function fetchJson(url: string, apiKey: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "User-Agent": UA, ...(init.headers ?? {}) },
    });
    let body: any = null;
    try { body = await res.json(); } catch { /* 非 JSON */ }
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

/** 读取账号累计用量(美分);不可用返回 null */
async function readUsageCents(base: string, apiKey: string): Promise<number | null> {
  try {
    const { status, body } = await fetchJson(`${base}/dashboard/billing/usage`, apiKey);
    if (status === 200 && typeof body?.total_usage === "number") return body.total_usage;
  } catch { /* ignore */ }
  return null;
}

/** 取该站最近一次价格快照(公示价,USD/M) */
function publishedPrices(site: string): Map<string, { input: number; output: number; cacheRead: number | null; group: string }> {
  const row = getDb().prepare(
    `SELECT summary FROM batches WHERE site=? AND task='price' ORDER BY started_at DESC LIMIT 1`
  ).get(site) as { summary: string | null } | undefined;
  const map = new Map<string, { input: number; output: number; cacheRead: number | null; group: string }>();
  if (!row?.summary) return map;
  try {
    const s = JSON.parse(row.summary) as PriceResult;
    for (const m of s.models) map.set(m.model, { input: m.input, output: m.output, cacheRead: m.cacheRead, group: m.group });
  } catch { /* 快照损坏 */ }
  return map;
}

/** 该 key 可用的模型列表 */
async function availableModels(base: string, apiKey: string): Promise<string[]> {
  const { body } = await fetchJson(`${base}/models`, apiKey);
  return Array.isArray(body?.data) ? body.data.map((m: any) => m.id).filter(Boolean) : [];
}

const SHORT_PROMPT = "用一句话解释什么是 REST API,不超过 30 字。";
/** 固定长前缀(约 1200 tokens),用于缓存命中验证 */
const LONG_PREFIX = "以下是需要仔细阅读的参考资料,请勿回答,只需确认收到:\n" +
  "第一章 系统架构概述。分布式系统的核心挑战在于一致性、可用性与分区容错之间的权衡。" +
  "CAP 定理指出,一个分布式系统最多同时满足其中两项。在实际工程中,我们通常选择 AP 或 CP 架构," +
  "并根据业务特性设计降级策略。数据分片是扩展系统吞吐的基础手段,常见策略包括哈希分片、范围分片与列表分片。" +
  "哈希分片实现简单且分布均匀,但难以支持范围查询;范围分片保留顺序信息,却容易产生热点。".repeat(12) + "\n\n";

/** 执行单轮请求 */
async function runRound(base: string, apiKey: string, model: string, kind: "short" | "cache", seq: number): Promise<RoundResult> {
  const t0 = Date.now();
  const prompt = kind === "cache" ? LONG_PREFIX + "请用一句话概括上述资料主题,不超过 20 字。" : SHORT_PROMPT;
  try {
    const { status, body } = await fetchJson(`${base}/chat/completions`, apiKey, {
      method: "POST",
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 40,
        stream: false,
      }),
    });
    const ttftMs = Date.now() - t0;
    const usage = body?.usage ?? {};
    const promptTokens: number = usage.prompt_tokens ?? 0;
    const completionTokens: number = usage.completion_tokens ?? 0;
    const cachedTokens: number = usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0;
    const err = body?.error;
    const ok = status === 200 && !err && promptTokens > 0;
    return {
      seq, model, kind, promptTokens, cachedTokens, completionTokens,
      promptTokensEstimate: estimateTokens(prompt),
      ttftMs, responseModel: body?.model ?? null, httpStatus: status, ok,
      error: err ? `${err.code ?? err.type ?? "error"}: ${String(err.message ?? "").slice(0, 120)}` : undefined,
    };
  } catch (e) {
    return { seq, model, kind, promptTokens: 0, cachedTokens: 0, completionTokens: 0, promptTokensEstimate: estimateTokens(prompt), ttftMs: Date.now() - t0, responseModel: null, httpStatus: 0, ok: false, error: (e as Error).message };
  }
}

/** 轮次计划:5 旗舰 + 3 主力 + 2 低价(旗舰含缓存轮);模型取该站实际可用者 */
function planRounds(models: string[], priceMap: Map<string, any>, cfg: ProbeConfig): Array<{ model: string; kind: "short" | "cache" }> {
  const pick = (prefixes: string[]) => prefixes
    .map(p => models.find(m => m.startsWith(p) && priceMap.has(m)))
    .filter(Boolean) as string[];
  const flagship = pick(cfg.models.flagship);
  const standard = pick(cfg.models.standard);
  const budget = pick(cfg.models.budget);
  const plan: Array<{ model: string; kind: "short" | "cache" }> = [];
  flagship.slice(0, 2).forEach(m => plan.push({ model: m, kind: "short" }));
  flagship.slice(0, 1).forEach(m => plan.push({ model: m, kind: "cache" }));
  standard.slice(0, 2).forEach(m => plan.push({ model: m, kind: "short" }));
  standard.slice(0, 1).forEach(m => plan.push({ model: m, kind: "cache" }));
  budget.slice(0, 2).forEach(m => plan.push({ model: m, kind: "short" }));
  budget.slice(0, 1).forEach(m => plan.push({ model: m, kind: "cache" }));
  return plan;
}

/** 理论应扣(美分):按公示 USD/M 价 × 实测 token,缓存命中部分按缓存价 */
function expectedCents(rounds: RoundResult[], priceMap: Map<string, { input: number; output: number; cacheRead: number | null }>): number | null {
  let sum = 0, covered = 0;
  for (const r of rounds) {
    const p = priceMap.get(r.model);
    if (!p) continue;
    covered++;
    const fresh = Math.max(0, r.promptTokens - r.cachedTokens);
    const cachePrice = p.cacheRead ?? p.input;
    sum += (fresh / 1e6) * p.input + (r.cachedTokens / 1e6) * cachePrice + (r.completionTokens / 1e6) * p.output;
  }
  return covered === 0 ? null : sum * 100; // USD → cents
}

export async function runBilling(site: SiteConfig, cfg: ProbeConfig, opts: { rounds?: number } = {}): Promise<BillingResult> {
  const batchId = nextBatchId();
  const startedAt = new Date().toISOString();
  const errors: string[] = [];
  const apiKey = site.key_env ? process.env[site.key_env] : undefined;
  let base = site.base_url.replace(/\/+$/, "");
  if (!/\/v\d+(\/|$)/.test(base)) base = `${base}/v1`;

  const empty: BillingResult = {
    task: "billing", site: site.name, batchId, startedAt, finishedAt: new Date().toISOString(),
    usageBeforeCents: null, usageAfterCents: null, actualCostCents: null, rounds: [],
    expectedCostCents: null, deviationPct: null, impliedGroupRatio: null, usageInflationRatio: null, errors,
  };
  if (!apiKey) { empty.errors.push("缺少 API key(检查 config/secrets/sites.env)"); return empty; }

  const priceMap = publishedPrices(site.name);
  if (priceMap.size === 0) { empty.errors.push("无价格快照,先跑 price 任务"); return empty; }

  const before = await readUsageCents(base, apiKey);
  if (before === null) errors.push("用量端点不可用,无法对账");

  const models = await availableModels(base, apiKey);
  if (models.length === 0) { empty.errors.push("模型列表为空(key 可能失效或额度耗尽)"); empty.finishedAt = new Date().toISOString(); return empty; }

  let plan = planRounds(models, priceMap, cfg);
  if (plan.length === 0) {
    // 兜底:用可用模型里价格表有的任意组合
    const usable = models.filter(m => priceMap.has(m));
    plan = usable.slice(0, 3).map(m => ({ model: m, kind: "short" as const }));
    errors.push("标准组合不可用,退化为任意模型组合");
  }
  if (opts.rounds && opts.rounds > 0) plan = plan.slice(0, opts.rounds);

  const rounds: RoundResult[] = [];
  for (let i = 0; i < plan.length; i++) {
    const r = await runRound(base, apiKey, plan[i].model, plan[i].kind, i + 1);
    rounds.push(r);
    if (!r.ok) errors.push(`round${i + 1} ${plan[i].model}: ${r.error ?? `HTTP ${r.httpStatus}`}`);
    // 轮间隔,避免并发用量污染与限流
    await new Promise(res => setTimeout(res, 1200));
  }

  const after = await readUsageCents(base, apiKey);
  const actual = (before !== null && after !== null) ? after - before : null;
  const expected = expectedCents(rounds.filter(r => r.ok), priceMap);
  const deviation = (actual !== null && expected !== null && expected > 0)
    ? Math.round(((actual - expected) / expected) * 10000) / 100 : null;
  const implied = (actual !== null && expected !== null && expected > 0)
    ? Math.round((actual / expected) * 1000) / 1000 : null;
  // usage 虚标检测:自报 prompt_tokens ÷ 本地估算(取成功轮次的中位数)
  const ratios = rounds.filter(r => r.ok && r.promptTokensEstimate > 0)
    .map(r => r.promptTokens / r.promptTokensEstimate).sort((a, b) => a - b);
  const inflation = ratios.length ? Math.round(ratios[Math.floor(ratios.length / 2)] * 100) / 100 : null;

  return {
    task: "billing", site: site.name, batchId, startedAt, finishedAt: new Date().toISOString(),
    usageBeforeCents: before, usageAfterCents: after, actualCostCents: actual,
    rounds, expectedCostCents: expected, deviationPct: deviation, impliedGroupRatio: implied,
    usageInflationRatio: inflation, errors,
  };
}

/** 落库:批次 + 逐轮 */
/** 价表内容指纹:校准因子是「相对哪一版价表」算出来的,凭指纹判断验证是否仍然有效。
 *  时间戳比较太脆——调度每天重采价,哪怕价表一字未改,也会把真金白银测出的验证角标打成过期。 */
export function priceTableHash(site: string): string | null {
  const row = getDb().prepare(`SELECT summary FROM batches WHERE site=? AND task='price' ORDER BY started_at DESC LIMIT 1`).get(site) as { summary: string | null } | undefined;
  if (!row?.summary) return null;
  try {
    const j = JSON.parse(row.summary);
    const models = (j.models ?? []).map((m: any) => [m.model, m.input, m.output, m.cacheRead ?? null, m.group ?? null, m.grpRatio ?? null, m.base?.input ?? null]).sort();
    return createHash("sha256").update(JSON.stringify(models)).digest("hex").slice(0, 16);
  } catch { return null; }
}

export function persistBilling(site: string, res: BillingResult, rawPath: string) {
  const d = getDb();
  /* 记录覆盖模型与各自应扣(厘):验证因子按模型生效——站可能给不同模型组配不同倍率,
   * 把 GPT 轮次测出的因子套到 deepseek 行上是错误外推(2026-10-03 aicost 6 行错标 mismatch 的教训) */
  const priceMap = publishedPrices(site);
  const per: Record<string, { expectLi: number; rounds: number }> = {};
  for (const r of res.rounds) {
    if (!r.ok) continue;
    const p = priceMap.get(r.model);
    if (!p) continue;
    const e = ((Math.max(0, r.promptTokens - r.cachedTokens) / 1e6) * p.input
      + (r.cachedTokens / 1e6) * (p.cacheRead ?? p.input)
      + (r.completionTokens / 1e6) * p.output) * 1000;
    per[r.model] = { expectLi: Math.round(((per[r.model]?.expectLi || 0) + e) * 100) / 100, rounds: (per[r.model]?.rounds || 0) + 1 };
  }
  d.prepare(`INSERT INTO batches(id, site, task, started_at, ok, raw_path, summary) VALUES(?,?,?,?,?,?,?)`)
    .run(res.batchId, site, "billing", res.startedAt, res.errors.length === 0 ? 1 : 0, rawPath,
      JSON.stringify({ actualCostCents: res.actualCostCents, expectedCostCents: res.expectedCostCents, deviationPct: res.deviationPct, impliedGroupRatio: res.impliedGroupRatio, usageInflationRatio: res.usageInflationRatio, rounds: res.rounds.length, errors: res.errors, priceHash: priceTableHash(site), calibModels: per }));
  const ins = d.prepare(`INSERT OR REPLACE INTO rounds(batch_id, seq, model, in_tok, cached_tok, out_tok, should_cost, actual_cost, ttft_ms) VALUES(?,?,?,?,?,?,?,?,?)`);
  for (const r of res.rounds) {
    ins.run(res.batchId, r.seq, r.model, r.promptTokens, r.cachedTokens, r.completionTokens, null, null, r.ttftMs);
  }
}
