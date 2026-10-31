/**
 * 探针 E:专用短延迟测量(PF 数据源)
 * 为什么需要它:此前 PF 借用 billing 轮次的耗时,而 billing 含 4000 字长前缀请求,
 * 中位数 21s 被当成 TTFT → PF 恒为 0 分,是测量缺陷不是站点问题。
 *
 * 方法:SSE 流式请求 + 固定极短 prompt,测「首个内容 token 到达时间」= 真 TTFT。
 *      同一模型重复 N 次取中位数(P50),顺带产出超时率(此前未持久化的 D3 指标)。
 * 公平性:跨站比较必须用同一 --model(两站共有的模型,默认 gpt-5.5)。
 */
import type { SiteConfig } from "../../../shared/types.js";
import { getDb, nextBatchId, saveRaw, logEvent } from "../store.js";
import { modelCategory } from "../parsers/models.js";

const UA = "RelayLens-Probe/0.1";
const PERF_PROMPT = "只回复两个字:收到";
const PERF_MAX_TOKENS = 16;
const DEFAULT_TIMEOUT_MS = 30_000;
/** 伪流式判定最小输出量:答案短于 30 token 时首末 chunk 天然贴近,判不了真伪 */
const BUFFER_MIN_TOKENS = 30;
/** 流式真伪专项:一次长输出请求。短 prompt 答案只有 2 个字,单 chunk 交付是常态,
 *  「首末 chunk 间隔 <50ms」会把真流式站误判成伪流式(aixoras 实测 231 事件逐块到达仍被判 100% 伪流式)。
 *  只有让模型输出足够长(约 200 字),看内容是逐 token 下发还是攒齐一次性吐,才能分辨。 */
const STREAM_CHECK_MAX_TOKENS = 600;
const STREAM_CHECK_TIMEOUT_MS = 90_000;

/** 取该站 key 可见的模型 id 清单(延迟探针与指纹比对都要先知道对方有什么模型) */
export async function listModels(site: SiteConfig): Promise<string[]> {
  const key = site.key_env ? process.env[site.key_env] : undefined;
  if (!key) return [];
  let base = site.base_url.replace(/\/+$/, "");
  if (!/\/v\d+(\/|$)/.test(base)) base = `${base}/v1`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    const resp = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return [];
    const j = (await resp.json()) as { data?: Array<{ id?: string }> };
    return (j.data ?? []).map(x => x.id).filter((x): x is string => !!x);
  } catch { return []; }
}
/**
 * 从站点可见模型里挑一个跑延迟探针的:优先便宜快的档(deepseek → flash/轻量 → 国产中档 → gpt/claude),都没有取第一个。
 * 先剔除非对话模型(图像/视频/语音/向量),否则会挑中 gpt-image-2 这种,测出来的"首字延迟"没有意义。
 */
export async function pickModel(site: SiteConfig): Promise<string | null> {
  const ids = await listModels(site);
  if (!ids.length) return null;
  const NOT_CHAT = /(image|video|t2v|i2v|dall|embed|whisper|tts|audio|speech|moderation|rerank|ocr|flux|sora|kling|jimeng)/i;
  const pool = ids.filter(id => !NOT_CHAT.test(id));
  const list = pool.length ? pool : ids;
  for (const re of [/deepseek/i, /flash|lite|mini|haiku|turbo/i, /glm|kimi|minimax/i, /gpt|claude|sonnet/i]) {
    const hit = list.find(id => re.test(id)); if (hit) return hit;
  }
  return list[0];
}

/** 挑一个**推理档**模型(与主采样模型不同站内另有推理系时才返回):
 *  分模型锚点校准的数据入口——普通/推理两类 TTFT 天然不同量级,混在一个锚点里互相污染。
 *  找不到时返回 null(该站没有推理档,主模型样本即代表)。 */
export async function pickReasoningModel(site: SiteConfig, exclude: string): Promise<string | null> {
  const ids = await listModels(site);
  const NOT_CHAT = /(image|video|t2v|i2v|dall|embed|whisper|tts|audio|speech|moderation|rerank|ocr|flux|sora|kling|jimeng)/i;
  const hit = ids
    .filter(id => !NOT_CHAT.test(id))
    .filter(id => modelCategory(id) === "reasoning")
    .filter(id => id !== exclude);
  return hit[0] ?? null;
}

/** 时段桶(按本地时区小时):9:00–17:59 = work(忙),其余 = off(闲)。
 *  双窗口采样(工作日 10:30 = work 桶;每天 22:30 = off 桶)落哪个桶由此判定;
 *  PF 悲观值口径(2026-10-10.1)依赖此函数,与 assemble 的分桶统计必须一致。 */
export function timeBucket(iso: string): "work" | "off" {
  const h = new Date(iso).getHours();
  return h >= 9 && h < 18 ? "work" : "off";
}

export interface PerfSample {
  seq: number; ok: boolean;
  ttftMs: number | null; totalMs: number | null;
  inTok: number | null; outTok: number | null;
  throughputTps: number | null;
  /** true = 首末 chunk 几乎同时到达(缓冲后一次性下发),对流式客户端等价于非流式 */
  buffered?: boolean;
  httpStatus: number | null; error?: string; failureType?: string;
}
export interface PerfResult {
  task: "perf"; site: string; model: string; batchId: string; startedAt: string; finishedAt: string;
  /** 模型延迟类别:normal=主采样(入 PF);reasoning=推理档加测(task=perf_reasoning,**不入 PF**,
   *  供分模型锚点校准——推理首 token 含思考调度,与普通模型混测互污染)。 */
  category?: "normal" | "reasoning";
  samples: PerfSample[];
  medianTtftMs: number | null;
  successRate: number | null; timeoutRate: number | null;
  medianThroughput: number | null;
  /** 伪流式样本占比%(仅统计输出≥30 token 的可判样本;无资格样本时为 null) */
  bufferedRate: number | null;
  /** 流式真伪专项(一次长输出请求)的结论,是 bufferedRate 之外更可靠的判定 */
  streamCheck: StreamCheckResult | null;
  iters: number; timeoutMs: number; notes: string[];
}

export interface StreamCheckTrial {
  prompt: string;
  chunks: number | null;
  spanMs: number | null;
  chars: number | null;
  verdict: "stream" | "buffered" | "unknown";
  error: string | null;
}
export interface StreamCheckResult {
  prompt: string;
  trials: number;
  streamed: number;
  bufferedTrials: number;
  /** 伪流式请求占比%(3 次中缓冲的次数),verdict=mixed 时对外展示 */
  bufferedPct: number | null;
  verdict: "stream" | "buffered" | "mixed" | "unknown";
  lastError: string | null;
}

function classify(e: unknown): string {
  const m = (e as Error).message ?? "";
  if (/abort|timeout|timed out/i.test(m)) return "timeout";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) return "dns_error";
  if (/ECONNREFUSED|ECONNRESET|fetch failed|network/i.test(m)) return "conn_error";
  return "error";
}

/** 单次流式请求,返回真 TTFT(首个内容 chunk 到达时间) */
async function timedStreamOnce(base: string, key: string, model: string, timeoutMs: number): Promise<any> {
  const call = async (withStreamOptions: boolean) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const body: Record<string, unknown> = {
        model, messages: [{ role: "user", content: PERF_PROMPT }],
        max_tokens: PERF_MAX_TOKENS, stream: true, temperature: 0,
      };
      if (withStreamOptions) body.stream_options = { include_usage: true };
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${key}`, "User-Agent": UA },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        const txt = await res.text().catch(() => "");
        return { hardFail: true, httpStatus: res.status, error: `HTTP ${res.status} ${txt.slice(0, 100)}`, retryable: res.status === 400 && /stream_options/i.test(txt) };
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "", ttft: number | null = null, usage: any = null, contentChunks = 0, doneAt: number | null = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const now = Date.now();
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") { if (doneAt === null) doneAt = now; continue; }
          try {
            const j = JSON.parse(payload);
            const delta = j?.choices?.[0]?.delta?.content;
            if (delta) { if (ttft === null) ttft = now - t0; contentChunks++; }
            if (j.usage) usage = j.usage;
          } catch { /* 非完整 JSON 片段忽略 */ }
        }
      }
      const totalMs = (doneAt ?? Date.now()) - t0;
      if (ttft === null) return { hardFail: true, httpStatus: res.status, error: "无内容 chunk(可能不支持流式或返回错误体)", retryable: true };
      const outTok = usage?.completion_tokens ?? contentChunks;
      const genMs = totalMs - ttft;
      // 伪流式判定:仅当输出足够长(≥30 token)时,「首 chunk 与末 chunk 几乎同时」才说明站点缓冲后一次性下发。
      // 短答案(2~3 token)单 chunk 交付是真流式的正常表现,不可判 → null,真伪由 streamCheck 专项说了算。
      const buffered = outTok >= BUFFER_MIN_TOKENS ? genMs < 50 : null;
      return {
        hardFail: false, httpStatus: res.status, ttftMs: ttft, totalMs, buffered,
        inTok: usage?.prompt_tokens ?? null, outTok,
        throughputTps: buffered ? null : Math.round(outTok / (genMs / 1000) * 10) / 10,
      };
    } catch (e) {
      return { hardFail: true, httpStatus: null, error: (e as Error).message, retryable: false, exception: true };
    } finally { clearTimeout(timer); }
  };

  let r = await call(true);
  if (r.retryable) r = await call(false);   // 部分站不支持 stream_options → 降级重试
  return r;
}

/** 流式真伪专项的长输出 prompt(每次取样轮换):实测同一站对不同措辞行为可能不同——
 *  aicost 对「写一篇…300字…」100% 整段缓冲,对「写一段…,直接开始正文」100% 真流式,
 *  单一 prompt 会把「混合行为」错报成纯真/纯假,故 3 次取样各用不同措辞与长度。 */
const STREAM_CHECK_PROMPTS = [
  "写一段大约200字的短文,介绍河流的成因,直接开始正文。",
  "写一篇大约300字的短文,介绍河流的成因。",
  "写一段大约400字的文字,介绍季风的形成,直接开始正文。",
];
/** 流式真伪专项:每次取样统计内容块数量与首末内容块时间跨度。
 *  判定标准:内容 ≥80 字时——
 *    contentChunks ≥10 且跨度 ≥800ms → stream(真流式,逐 token 下发)
 *    contentChunks ≤5 且跨度 <200ms → buffered(伪流式,攒齐一次性吐)
 *    其余 → unknown(不硬判) */
const STREAM_CHECK_TRIALS = 3;
async function streamCheckOnce(base: string, key: string, model: string, prompt: string): Promise<StreamCheckTrial> {
  const out: StreamCheckTrial = { prompt, chunks: null, spanMs: null, chars: null, verdict: "unknown", error: null };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STREAM_CHECK_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${key}`, "User-Agent": UA },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: STREAM_CHECK_MAX_TOKENS, stream: true, temperature: 0 }),
    });
    if (!res.ok || !res.body) {
      out.error = `HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 100)}`;
      return out;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "", chunks = 0, chars = 0, firstC: number | null = null, lastC: number | null = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const now = Date.now();
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const delta = (JSON.parse(payload))?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            chunks++; chars += delta.length;
            if (firstC === null) firstC = now - t0;
            lastC = now - t0;
          }
        } catch { /* 片段忽略 */ }
      }
    }
    const span = firstC !== null && lastC !== null ? lastC - firstC : null;
    out.chunks = chunks; out.chars = chars; out.spanMs = span;
    if (chars < 80) {
      out.error = `输出仅 ${chars} 字,不足以判定流式真伪`;
    } else if (chunks >= 10 && (span ?? 0) >= 800) {
      out.verdict = "stream";
    } else if (chunks <= 5 && (span ?? Infinity) < 200) {
      out.verdict = "buffered";
    }
    return out;
  } catch (e) {
    out.error = (e as Error).message;
    return out;
  } finally { clearTimeout(timer); }
}

/** 流式真伪专项:长输出请求跑 3 次,每次换 prompt。
 *  为什么换 prompt:aicost 实测对「写一篇…300字…」100% 整段缓冲、对「写一段…直接开始正文」100% 真流式,
 *  同一站对不同措辞行为不同,单一 prompt 会把「混合行为」错报成纯真或纯假。
 *  3 次全部一致才给 stream/buffered,交叉出现给 mixed。 */
async function streamCheck(base: string, key: string, model: string): Promise<StreamCheckResult> {
  const trials: StreamCheckTrial[] = [];
  for (let k = 0; k < STREAM_CHECK_TRIALS; k++) {
    const prompt = STREAM_CHECK_PROMPTS[k % STREAM_CHECK_PROMPTS.length];
    trials.push(await streamCheckOnce(base, key, model, prompt));
    if (k < STREAM_CHECK_TRIALS - 1) await new Promise(r => setTimeout(r, 1000));
  }
  const streamed = trials.filter(t => t.verdict === "stream").length;
  const bufferedN = trials.filter(t => t.verdict === "buffered").length;
  const known = streamed + bufferedN;
  const verdict: StreamCheckResult["verdict"] =
    known === 0 ? "unknown" : streamed > 0 && bufferedN > 0 ? "mixed" : streamed > 0 ? "stream" : "buffered";
  const lastErr = [...trials].reverse().find(t => t.error)?.error ?? null;
  return {
    prompt: "3 次取样·措辞各异(逐次 prompt 见 trials)", trials: trials.length, streamed, bufferedTrials: bufferedN,
    bufferedPct: known ? Math.round(bufferedN / known * 1000) / 10 : null,
    verdict, lastError: lastErr,
  };
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export async function runPerf(
  site: SiteConfig, model: string,
  opts: { iters?: number; timeoutMs?: number; category?: "normal" | "reasoning" } = {}
): Promise<PerfResult> {
  const iters = opts.iters ?? 8;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const category = opts.category ?? "normal";
  const notes: string[] = [];
  const key = site.key_env ? process.env[site.key_env] : undefined;
  let base = site.base_url.replace(/\/+$/, "");
  if (!/\/v\d+(\/|$)/.test(base)) base = `${base}/v1`;

  const result: PerfResult = {
    task: "perf", site: site.name, model, batchId: nextBatchId(),
    category,
    startedAt: new Date().toISOString(), finishedAt: "", samples: [],
    medianTtftMs: null, successRate: null, timeoutRate: null,
    medianThroughput: null, bufferedRate: null, streamCheck: null, iters, timeoutMs, notes,
  };
  if (!key) { notes.push("缺少 API key,无法测延迟"); result.finishedAt = new Date().toISOString(); return result; }
  /** 推理档只采 TTFT:流式真伪专项(3 次长输出)对推理模型又慢又贵,且 SR 有主模型批次覆盖 */
  if (category === "reasoning") notes.push("推理档加测:仅采 TTFT,不跑流式真伪专项;数据不入 PF,供分模型锚点校准");

  for (let i = 0; i < iters; i++) {
    const r = await timedStreamOnce(base, key, model, timeoutMs);
    if (r.hardFail) {
      const ftype = r.exception ? classify(r.error) : (r.httpStatus === null ? "conn_error" : "http_error");
      result.samples.push({ seq: i + 1, ok: false, ttftMs: null, totalMs: null, inTok: null, outTok: null, throughputTps: null, httpStatus: r.httpStatus, error: String(r.error).slice(0, 120), failureType: /abort|timeout/i.test(String(r.error)) ? "timeout" : ftype });
    } else {
      result.samples.push({ seq: i + 1, ok: true, ttftMs: r.ttftMs, totalMs: r.totalMs, inTok: r.inTok, outTok: r.outTok, throughputTps: r.throughputTps, buffered: !!r.buffered, httpStatus: r.httpStatus });
    }
    await new Promise(res => setTimeout(res, 1000));
  }

  const ok = result.samples.filter(s => s.ok);
  const ttfts = ok.map(s => s.ttftMs!).filter(Number.isFinite);
  const tps = ok.map(s => s.throughputTps!).filter(x => x && Number.isFinite(x));
  result.medianTtftMs = median(ttfts);
  result.medianThroughput = median(tps);
  // 伪流式率只统计「输出够长、可判真伪」的样本;短答案(2 字)一律不算
  const judgeable = ok.filter(s => s.buffered !== null && s.buffered !== undefined);
  const bufferedN = judgeable.filter(s => s.buffered).length;
  result.bufferedRate = judgeable.length ? Math.round(bufferedN / judgeable.length * 1000) / 10 : null;
  // 流式真伪专项:短循环判不了时由 3 次长输出请求给出结论(推理档加测跳过,见上)
  if (category === "reasoning") {
    result.finishedAt = new Date().toISOString();
    return result;
  }
  result.streamCheck = await streamCheck(base, key, model);
  const sc = result.streamCheck;
  if (sc.verdict === "stream") notes.push(`流式真伪专项(${sc.trials} 次):全部真流式`);
  else if (sc.verdict === "buffered") notes.push(`流式真伪专项(${sc.trials} 次):全部伪流式(整段缓冲后一次性下发)`);
  else if (sc.verdict === "mixed") notes.push(`流式真伪专项(${sc.trials} 次):混合——${sc.bufferedTrials} 次伪流式 / ${sc.streamed} 次真流式,疑似多渠道路由`);
  else notes.push(`流式真伪专项:${sc.trials} 次均不可判(${sc.lastError ?? "样本不足"})`);
  result.successRate = result.samples.length ? Math.round(ok.length / result.samples.length * 1000) / 10 : null;
  const timeouts = result.samples.filter(s => !s.ok && s.failureType === "timeout").length;
  result.timeoutRate = result.samples.length ? Math.round(timeouts / result.samples.length * 1000) / 10 : null;
  if (ok.length < 3) notes.push(`有效样本仅 ${ok.length} 个,中位数不稳定`);
  result.finishedAt = new Date().toISOString();
  return result;
}

export function persistPerf(res: PerfResult): void {
  /** 推理档批次用独立 task 名落库:所有 task='perf' 的既有查询(PF/超时率/流式真伪)天然免疫,
   *  推理档更慢的 TTFT 不会污染主评分;数据经 task='perf_reasoning' 单独取用(锚点校准素材)。 */
  const task = res.category === "reasoning" ? "perf_reasoning" : "perf";
  const batch = { batchId: res.batchId, site: res.site, task: task as any, startedAt: res.startedAt, ok: (res.successRate ?? 0) >= 50, result: res };
  const rawPath = saveRaw(batch as any);
  const d = getDb();
  d.prepare(`INSERT INTO batches(id, site, task, started_at, ok, raw_path, summary) VALUES(?,?,?,?,?,?,?)`)
    .run(res.batchId, res.site, task, res.startedAt, batch.ok ? 1 : 0, rawPath,
      JSON.stringify({ perf: true, category: res.category ?? "normal", model: res.model, medianTtftMs: res.medianTtftMs, successRate: res.successRate, timeoutRate: res.timeoutRate, medianThroughput: res.medianThroughput, bufferedRate: res.bufferedRate, streamVerdict: res.streamCheck?.verdict ?? null, streamCheck: res.streamCheck, iters: res.iters }));
  const ins = d.prepare(`INSERT OR REPLACE INTO rounds(batch_id, seq, model, in_tok, cached_tok, out_tok, should_cost, actual_cost, ttft_ms) VALUES(?,?,?,?,?,?,?,?,?)`);
  for (const s of res.samples) ins.run(res.batchId, s.seq, res.model, s.inTok, null, s.outTok, null, null, s.ttftMs);
  if ((res.timeoutRate ?? 0) > 20) logEvent(res.site, "high_timeout_rate", { batchId: res.batchId, timeoutRate: res.timeoutRate, model: res.model });
}
