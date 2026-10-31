/**
 * 探针:长上下文完整性(标记码法 / canary)。
 *
 * 目的:验证长上下文是否被**截断或压缩**。中转站最常见的两种隐形造假:
 *   ① 尾部截断 —— 只把前 N 个 token 转给上游,后面的直接丢;
 *   ② 摘要/滑窗压缩 —— 中间段被砍掉或改写。
 * 两种都不会报错,也不会体现在 usage 上(有的站甚至照收全额 input token)。
 *
 * 方法:在长文本的固定**相对位置**埋若干唯一标记码,只让模型回吐编号。
 *   命中率 100%           → complete
 *   末尾连续缺失           → tail_truncated(典型截断)
 *   中间规律性缺失         → compressed(摘要/滑窗)
 *   一个都没回 / 报错/不照做 → inconclusive(不判负也不判通过 —— 宁可说未测)
 *
 * 铁律:这是**确定性证据**,不进评分(weights.json 不动)。要进分必须走
 *      「沙盘模拟 → 用户拍板 → 升版本 → changelog」。
 * 成本:每档几千到几万 input token 的真实消耗 —— 只能显式触发,不进免费 cron。
 */
import type { ContextCase, ContextResult, ContextVerdict, SiteConfig } from "../../../shared/types.js";
import { getDb, nextBatchId, saveRaw, recordBatch, logEvent } from "../store.js";
import { cjkText } from "./tokenprobe.js";

const TIMEOUT_MS = 180_000;   // 长上下文首 token 慢,给足 3 分钟
const UA = "RelayLens-Probe/0.1";

/** 标记码出现位置的相对比例:首尾各留一点边,其余均匀分布 —— 换长度档不用改代码 */
const POSITIONS = [0.005, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 0.995];

export function canaryPrefix(batchId: string): string { return `RL-CANARY-${batchId}`; }
export function canaryId(batchId: string, seq: number): string { return `${canaryPrefix(batchId)}-${String(seq).padStart(2, "0")}`; }

export interface CanaryDoc { text: string; ids: string[] }

/** 生成埋好标记码的长文本。从后往前插,避免插入后位置漂移。 */
export function buildCanaryDoc(chars: number, batchId: string): CanaryDoc {
  const ids = POSITIONS.map((_, i) => canaryId(batchId, i + 1));
  const body = cjkText(Math.max(chars, 500), 13);
  const at = POSITIONS.map(p => Math.max(0, Math.min(body.length, Math.floor(body.length * p))));
  let out = "";
  let cursor = 0;
  for (let i = 0; i < ids.length; i++) {
    const pos = Math.max(at[i], cursor);
    out += body.slice(cursor, pos) + `【${ids[i]}】`;
    cursor = pos;
  }
  out += body.slice(cursor);
  return { text: out, ids };
}

/** 从模型回复里抽出本批次标记码的序号(不认别的批次的编号) */
export function parseReturnedIds(reply: string, batchId: string): number[] {
  const prefix = canaryPrefix(batchId);
  const re = new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-(\\d{2})", "g");
  const out = new Set<number>();
  for (const m of reply.matchAll(re)) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

/**
 * 单档判读(纯函数,单测直接打这里)。
 * 判定门槛:一个编号都没回 → inconclusive(模型没照做 / 被拒 / 报错,不能当成站方截断的证据)。
 */
export function judgeContextCase(
  expected: string[], reply: string, batchId: string,
  meta: { targetChars: number; reportedPromptTokens: number | null; error?: string },
): ContextCase {
  const n = expected.length;
  const got = new Set(parseReturnedIds(reply, batchId).map(v => String(v).padStart(2, "0")));
  const want = expected.map(id => id.slice(-2));
  const missing = want.map((s, i) => ({ s, seq: i + 1 })).filter(x => !got.has(x.s)).map(x => x.seq);
  const hitPct = n ? Math.round(((n - missing.length) / n) * 1000) / 10 : 0;

  let verdict: ContextVerdict;
  if (meta.error || got.size === 0) {
    verdict = "inconclusive";
  } else if (missing.length === 0) {
    verdict = "complete";
  } else {
    // 末尾连续缺失(且只有末尾缺失)= 尾部截断;其余缺失一律按压缩处理
    const isTailSuffix = missing[missing.length - 1] === n &&
      missing.every((v, idx) => v === n - missing.length + 1 + idx);
    verdict = isTailSuffix ? "tail_truncated" : "compressed";
  }
  return {
    targetChars: meta.targetChars,
    reportedPromptTokens: meta.reportedPromptTokens,
    canaries: n,
    returned: got.size,
    hitPct,
    missing,
    verdict,
  };
}

/** 多档汇总:取最差结论;inconclusive 不覆盖任何已有结论 */
export function judgeContext(cases: ContextCase[]): { verdict: ContextVerdict; maxVerifiedChars: number | null } {
  const conclusive = cases.filter(c => c.verdict !== "inconclusive");
  const completes = cases.filter(c => c.verdict === "complete");
  const maxVerifiedChars = completes.length ? Math.max(...completes.map(c => c.targetChars)) : null;
  if (!conclusive.length) return { verdict: "inconclusive", maxVerifiedChars: null };
  const severity: ContextVerdict[] = ["tail_truncated", "compressed", "complete"];
  const verdict = severity.find(v => conclusive.some(c => c.verdict === v)) ?? "inconclusive";
  return { verdict, maxVerifiedChars };
}

/** 跑一档:请求 + 解析(错误如实记成 inconclusive,不当成截断证据) */
async function probeOne(
  base: string, apiKey: string, model: string, chars: number, batchId: string, ids: string[],
): Promise<ContextCase> {
  const doc = buildCanaryDoc(chars, batchId);
  const prompt = `资料里埋有若干形如 ${canaryPrefix(batchId)}-NN 的编号。`
    + `请只输出你看到的全部编号,一行一个,不要解释、不要总结、不要输出其他内容。\n\n资料:\n${doc.text}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "User-Agent": UA },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 300, temperature: 0, stream: false }),
    });
    const body: any = await res.json().catch(() => ({}));
    const reply: string = body?.choices?.[0]?.message?.content ?? "";
    const reported: number | null = typeof body?.usage?.prompt_tokens === "number" ? body.usage.prompt_tokens : null;
    const err = body?.error ? `HTTP ${res.status}: ${String(body.error.message ?? "").slice(0, 80)}` : (!res.ok ? `HTTP ${res.status}` : undefined);
    return judgeContextCase(ids, err ? "" : reply, batchId, { targetChars: chars, reportedPromptTokens: reported, error: err });
  } catch (e) {
    return judgeContextCase(ids, "", batchId, {
      targetChars: chars, reportedPromptTokens: null,
      error: /abort|timeout/i.test((e as Error).message) ? "TIMEOUT" : (e as Error).message.slice(0, 80),
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 跑一轮(多档)。真实扣费任务:必须显式调用,不进 schedule。
 * @param charsList 目标字符数档位,默认 8000 与 32000
 */
export async function runContextProbe(
  site: SiteConfig, model: string, charsList: number[] = [8000, 32000],
): Promise<ContextResult> {
  const apiKey = site.key_env ? process.env[site.key_env] : undefined;
  if (!apiKey) throw new Error("缺少 API key");
  let base = site.base_url.replace(/\/+$/, "");
  if (!/\/v\d+(\/|$)/.test(base)) base = `${base}/v1`;

  const batchId = nextBatchId();
  const { ids } = buildCanaryDoc(charsList[0], batchId);   // 标记码前缀只与批次有关,各档共用
  const cases: ContextCase[] = [];
  for (const chars of charsList) {
    cases.push(await probeOne(base, apiKey, model, chars, batchId, ids));
    await new Promise(r => setTimeout(r, 800));             // 别把站方限流当成截断
  }
  const { verdict, maxVerifiedChars } = judgeContext(cases);
  const result: ContextResult = {
    task: "context", site: site.name, checkedAt: new Date().toISOString(),
    model, samples: cases.filter(c => c.verdict !== "inconclusive").length,
    cases, verdict, maxVerifiedChars,
  };

  // 落库:raw 归档 + batches 索引(task='context',summary 带结论),audit hash 链自动覆盖
  const batch = {
    batchId, site: site.name, task: "context" as const,
    startedAt: result.checkedAt, ok: result.samples > 0, result,
  };
  const rawPath = saveRaw(batch);
  recordBatch(batch, rawPath, result as unknown as Record<string, unknown>);
  logEvent(site.name, "context", { verdict, maxVerifiedChars, model });
  return result;
}

export interface ContextVerdictOut { level: "ok" | "warn" | "info" | "none"; label: string }

/**
 * 结论措辞(后端统一生成,前端只上色)。任何分支都不出现分数或扣分语义:
 * 截断/压缩是**站点行为证据**,要不要因此不用这家由用户判断。
 */
export function judgeContextLabel(r: ContextResult | null): ContextVerdictOut {
  if (!r) return { level: "none", label: "未测(标记码探针需显式触发,会产生真实 token 消耗)" };
  const worst = r.cases.find(c => c.verdict === r.verdict && c.verdict !== "complete") ?? r.cases.find(c => c.verdict === "complete");
  const missTxt = worst && worst.missing.length ? ` · 缺失编号 ${worst.missing.map(n => String(n).padStart(2, "0")).join("/")}` : "";
  const at = worst ? `${worst.targetChars.toLocaleString("en-US")} 字符档` : "";
  switch (r.verdict) {
    case "complete":
      return { level: "ok", label: `长上下文完整 · ${(r.maxVerifiedChars ?? 0).toLocaleString("en-US")} 字符档标记码全命中` };
    case "tail_truncated":
      return { level: "warn", label: `尾部截断 · ${at}末尾编号未回传${missTxt} —— 说明只把前段转给了上游` };
    case "compressed":
      return { level: "warn", label: `疑似压缩/改写 · ${at}中间编号缺失${missTxt}` };
    default:
      return { level: "info", label: "未取得结论(模型未按格式回吐编号或请求失败,不据此判断截断)" };
  }
}

/** 最近一次长上下文实测(没有就返回 null —— 未测就是未测) */
export function latestContext(site: string): ContextResult | null {
  const row = getDb().prepare(`SELECT summary FROM batches WHERE site=? AND task='context' ORDER BY started_at DESC LIMIT 1`)
    .get(site) as { summary: string | null } | undefined;
  if (!row?.summary) return null;
  try {
    const s = JSON.parse(row.summary) as ContextResult;
    return s && s.verdict ? s : null;
  } catch { return null; }
}
