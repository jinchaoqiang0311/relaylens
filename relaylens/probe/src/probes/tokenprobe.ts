/**
 * token 计量对照实验 —— 判定站点上报的 prompt_tokens 是否随真实输入线性变化
 * 方法:发送已知字符数的唯一中文文本(避免跨轮缓存),记录上报 prompt_tokens;
 *      再重复同一文本两轮,观察 cache_tokens 是否如实增长。
 * 判读:fresh tokens 与字符数成比例 → 计量可信;近似恒定 → 存在注入脚手架或计量失真。
 */
import type { SiteConfig } from "../../../shared/types.js";
import { getDb, nextBatchId, saveRaw, recordBatch, logEvent } from "../store.js";

const TIMEOUT_MS = 90_000;
const UA = "RelayLens-Probe/0.1";

/** 生成唯一中文填充文本(数字打散避免缓存与压缩) */
function cjkText(chars: number, salt: number): string {
  const pool = "系统架构分布式一致性可用性分区容错工程实践数据分片哈希范围列表热点降级策略容量吞吐延迟抖动监控告警链路追踪熔断限流灰度发布回滚配置服务治理注册发现";
  let s = "";
  let i = salt;
  while (s.length < chars) {
    s += pool[i % pool.length];
    i = (i * 1103515245 + 12345) & 0x7fffffff;
    if (s.length % 37 === 0) s += String(i % 97) + "，";
  }
  return s.slice(0, chars);
}

export interface TokenProbeRow {
  label: string; chars: number; repeat: number;
  reportedPrompt: number; reportedCached: number; reportedCompletion: number;
  fresh: number; tokensPerChar: number | null; httpStatus: number; error?: string;
}

export interface InjectionEstimate {
  inject: number | null;        // 每请求固定注入合计(保守口径:非零缓存脚手架 + fresh 截距)
  freshIntercept: number | null;// fresh = a×chars + b 的 b(与内容无关的固定 fresh 部分)
  cachedScaffold: number | null;// 恒定以「缓存命中」计价的部分(取非零中位数,保守)
  cachedMin: number | null; cachedMax: number | null;  // 唯一行 cached 的极差(渠道混合证据)
  unstable: boolean;            // 部分请求 0 缓存、部分有脚手架 → 疑似多上游路由
  slope: number | null;         // 每字符 token 系数(干净中文 ≈ 1)
  uniqueSamples: number;        // 参与拟合的唯一文本样本数
  note: string;
}

/**
 * 从对照实验行推导注入开销。
 * 模型:fresh = slope×chars + intercept(唯一文本,排除重复行)。
 *      cachedScaffold 取**非零** cached 的中位数 —— 同站部分请求 cached=0、部分 3840
 *      属于渠道混合(多上游路由),取中位数会把号池路径的注入平均掉、严重低估,
 *      所以保守取非零口径并打 unstable 标。inject = intercept + cachedScaffold。
 * 判定门槛:≥3 个有效唯一样本才出数;<50 视为噪声报 0(干净渠道)。
 */
export function deriveInjection(rows: TokenProbeRow[]): InjectionEstimate {
  const uniq = rows.filter(r => r.repeat === 0 && !r.error && r.reportedPrompt > 0 && r.chars > 0);
  if (uniq.length < 3) {
    return { inject: null, freshIntercept: null, cachedScaffold: null, cachedMin: null, cachedMax: null,
      unstable: false, slope: null, uniqueSamples: uniq.length, note: `唯一文本有效样本 ${uniq.length}/3,不足以拟合` };
  }
  // 最小二乘:fresh = slope×chars + intercept
  const n = uniq.length;
  const sx = uniq.reduce((s, r) => s + r.chars, 0);
  const sy = uniq.reduce((s, r) => s + r.fresh, 0);
  const sxx = uniq.reduce((s, r) => s + r.chars * r.chars, 0);
  const sxy = uniq.reduce((s, r) => s + r.chars * r.fresh, 0);
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  // 缓存脚手架:非零 cached 中位数(0 是"这条路径没脚手架",不能把号池路径平均没)
  const cacheds = uniq.map(r => r.reportedCached);
  const nonZero = cacheds.filter(c => c > 0).sort((a, b) => a - b);
  const cachedScaffold = nonZero.length ? nonZero[Math.floor(nonZero.length / 2)] : 0;
  const cachedMin = cacheds.length ? Math.min(...cacheds) : null;
  const cachedMax = cacheds.length ? Math.max(...cacheds) : null;
  const unstable = (nonZero.length > 0 && cacheds.some(c => c === 0)) ||
                   (nonZero.length > 1 && (cachedMax! - cachedMin! > 1500));
  const raw = Math.max(0, intercept) + cachedScaffold;
  const inject = raw < 50 ? 0 : Math.round(raw);
  const verdict = inject === 0
    ? `未检出注入(fresh 截距 ${intercept.toFixed(0)} + 缓存脚手架 ${cachedScaffold} ≈ ${raw.toFixed(0)},低于噪声门槛)`
    : `检出固定注入 ≈ ${inject} tok/请求(fresh 截距 ${Math.round(Math.max(0, intercept))} + 缓存脚手架 ${cachedScaffold},slope=${slope.toFixed(2)} tok/字符)` +
      (unstable ? `;⚠ 渠道混合:唯一请求 cached 在 ${cachedMin}–${cachedMax} 间跳(部分路径无脚手架,部分 ${cachedScaffold}+),此值为保守口径` : "");
  return {
    inject, freshIntercept: Math.round(intercept * 10) / 10, cachedScaffold,
    cachedMin, cachedMax, unstable,
    slope: Math.round(slope * 100) / 100, uniqueSamples: n, note: verdict,
  };
}

/** 落库:raw 归档 + batches 索引(task='tokens',summary 带推导结果供 sync/assemble 读取) */
export function persistTokens(site: string, model: string, rows: TokenProbeRow[]): InjectionEstimate {
  const est = deriveInjection(rows);
  const batch = {
    batchId: nextBatchId(), site, task: "tokens" as const,
    startedAt: new Date().toISOString(), ok: rows.some(r => !r.error),
    result: { model, rows, estimate: est },
  };
  const rawPath = saveRaw(batch);
  recordBatch(batch, rawPath, {
    tokens: true, model,
    inject: est.inject, freshIntercept: est.freshIntercept,
    cachedScaffold: est.cachedScaffold, cachedMin: est.cachedMin, cachedMax: est.cachedMax,
    unstable: est.unstable, slope: est.slope,
    uniqueSamples: est.uniqueSamples, note: est.note,
  });
  logEvent(site, "tokens", { inject: est.inject, model });
  return est;
}

/** 读最近一次 tokens 批次的推导结果(无批次返回 null —— 未测就是未测,不猜) */
export function latestInjection(site: string): number | null {
  const row = getDb().prepare(`SELECT summary FROM batches WHERE site=? AND task='tokens' ORDER BY started_at DESC LIMIT 1`)
    .get(site) as { summary: string | null } | undefined;
  if (!row?.summary) return null;
  try {
    const s = JSON.parse(row.summary) as { inject: number | null };
    return typeof s.inject === "number" ? s.inject : null;
  } catch { return null; }
}

/** 完整推导详情(含缓存/fresh 拆分与渠道混合标记,供 EP 计价与 ops 看板) */
export interface InjectionDetail {
  inject: number; freshIntercept: number; cachedScaffold: number;
  cachedMin: number | null; cachedMax: number | null; unstable: boolean;
}
export function latestInjectionDetail(site: string): InjectionDetail | null {
  const row = getDb().prepare(`SELECT summary FROM batches WHERE site=? AND task='tokens' ORDER BY started_at DESC LIMIT 1`)
    .get(site) as { summary: string | null } | undefined;
  if (!row?.summary) return null;
  try {
    const s = JSON.parse(row.summary) as Partial<InjectionDetail>;
    if (typeof s.inject !== "number" || typeof s.freshIntercept !== "number" || typeof s.cachedScaffold !== "number") return null;
    return {
      inject: s.inject, freshIntercept: s.freshIntercept, cachedScaffold: s.cachedScaffold,
      cachedMin: s.cachedMin ?? null, cachedMax: s.cachedMax ?? null, unstable: !!s.unstable,
    };
  } catch { return null; }
}

export async function runTokenProbe(site: SiteConfig, model: string): Promise<TokenProbeRow[]> {
  const apiKey = site.key_env ? process.env[site.key_env] : undefined;
  if (!apiKey) throw new Error("缺少 API key");
  let base = site.base_url.replace(/\/+$/, "");
  if (!/\/v\d+(\/|$)/.test(base)) base = `${base}/v1`;

  // 用例:递增长度(唯一文本) + 同文本重复(测缓存)
  const cases: Array<{ label: string; chars: number; repeat: number; text: string }> = [];
  [30, 200, 1000, 4000].forEach((n, i) => cases.push({ label: `唯一${n}字`, chars: n, repeat: 0, text: cjkText(n, i + 7) }));
  cases.push({ label: `重复A(1000字)`, chars: 1000, repeat: 1, text: cases[2].text });
  cases.push({ label: `重复B(1000字)`, chars: 1000, repeat: 2, text: cases[2].text });

  const rows: TokenProbeRow[] = [];
  for (const c of cases) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "User-Agent": UA },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: `请仅回复"收到"二字。资料：${c.text}` }],
          max_tokens: 8, stream: false,
        }),
      });
      const body: any = await res.json().catch(() => ({}));
      const u = body?.usage ?? {};
      const prompt = u.prompt_tokens ?? 0;
      const cached = u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0;
      rows.push({
        label: c.label, chars: c.chars, repeat: c.repeat,
        reportedPrompt: prompt, reportedCached: cached, reportedCompletion: u.completion_tokens ?? 0,
        fresh: Math.max(0, prompt - cached),
        tokensPerChar: prompt > 0 ? Math.round(prompt / c.chars * 100) / 100 : null,
        httpStatus: res.status,
        error: body?.error ? String(body.error.message ?? "").slice(0, 90) : undefined,
      });
    } catch (e) {
      rows.push({ label: c.label, chars: c.chars, repeat: c.repeat, reportedPrompt: 0, reportedCached: 0, reportedCompletion: 0, fresh: 0, tokensPerChar: null, httpStatus: 0, error: (e as Error).message });
    } finally {
      clearTimeout(t);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return rows;
}
