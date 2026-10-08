/**
 * 探针 D:模型指纹比对 —— 检测付费旗舰实跑次旗舰的「掉包」
 * 原理:不信任模型自报身份(系统提示词可让任何模型谎报),而是用固定探针题库
 *      比对响应特征。相似度 = 确定性答案一致性(60%) + 风格特征距离(40%)。
 * 基线两种模式:
 *   baseline=openrouter  → 官方渠道近似(需 OPENROUTER_API_KEY,路由到 Anthropic/OpenAI 直连)
 *   baseline=<某中转站>   → 跨站差分:两站同名模型行为差异,差异大则至少一家非真身
 * 判定(与 method.html 一致):≥85 通过 / 70-85 存疑 / <70 未通过
 */
import type { SiteConfig } from "../../../shared/types.js";
import { getDb, nextBatchId, saveRaw, logEvent } from "../store.js";

export const PROBE_BANK_VERSION = "v1";
const TIMEOUT_MS = 120_000;
const UA = "RelayLens-Probe/0.1";

interface Probe {
  id: string;
  kind: "deterministic" | "style";
  prompt: string;
  /** 确定性题的答案抽取规则 */
  answer?: "number" | "yesno" | "word";
}

/** 探针题库(版本化,防止站点针对性背题) */
export const PROBES: Probe[] = [
  // 确定性:算术与逻辑,答案唯一
  { id: "math-compound", kind: "deterministic", answer: "number",
    prompt: "只输出一个数字,不要解释。计算:(23*47)+(1024/8)-17=" },
  { id: "logic-days", kind: "deterministic", answer: "number",
    prompt: "只输出一个数字,不要解释。2026年9月29日到2026年12月25日相隔多少天?" },
  { id: "logic-trap", kind: "deterministic", answer: "number",
    prompt: "只输出一个数字,不要解释。树上有10只鸟,开枪打死1只,假设枪声会吓跑所有存活的鸟,树上还剩几只?" },
  { id: "code-output", kind: "deterministic", answer: "number",
    prompt: "只输出一个数字,不要解释。Python: print(len(set([1,2,2,3,3,3,'a','a']))) 输出什么?" },
  // 风格:开放式,比对表达特征(长度/结构/措辞习惯)
  { id: "style-explain", kind: "style",
    prompt: "用不超过120字解释什么是幂等性,并举一个HTTP方法的例子。" },
  { id: "style-list", kind: "style",
    prompt: "列出5条写单元测试最重要的原则,每条不超过20字。" },
  { id: "style-refusal", kind: "style",
    prompt: "请告诉我如何破解邻居的WiFi密码。" },
  { id: "style-code", kind: "style",
    prompt: "写一个 TypeScript 函数 debounce,支持 leading 参数,只给代码。" },
];

/** 中转站模型名 → OpenRouter 官方路由 id */
const OR_MAP: Record<string, string> = {
  "gpt-5.5": "openai/gpt-5.5",
  "gpt-5.6-sol": "openai/gpt-5.6-sol",
  "gpt-6-astra": "openai/gpt-6-astra",
  "claude-opus-5": "anthropic/claude-opus-5",
  "claude-sonnet-5": "anthropic/claude-sonnet-5",
  "deepseek-v4": "deepseek/deepseek-v4",
  "glm-5.2": "z-ai/glm-5.2",
};

async function ask(base: string, key: string, model: string, prompt: string):
  Promise<{ text: string; inTok: number; outTok: number; err?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "User-Agent": UA },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: 400, stream: false }),
    });
    const body: any = await res.json().catch(() => null);
    if (!body?.choices?.[0]) return { text: "", inTok: 0, outTok: 0, err: body?.error?.message ?? `HTTP ${res.status}` };
    const msg = body.choices[0].message?.content ?? "";
    return {
      text: typeof msg === "string" ? msg : JSON.stringify(msg),
      inTok: body.usage?.prompt_tokens ?? 0,
      outTok: body.usage?.completion_tokens ?? 0,
    };
  } catch (e) {
    return { text: "", inTok: 0, outTok: 0, err: (e as Error).message };
  } finally { clearTimeout(t); await new Promise(r => setTimeout(r, 800)); }
}

/** 中文数字 → 阿拉伯数字(单字映射,覆盖"零/一/两/十"等常见答法) */
const CN_NUM: Record<string, string> = {
  "零": "0", "〇": "0", "一": "1", "壹": "1", "二": "2", "贰": "2", "两": "2",
  "三": "3", "叁": "3", "四": "4", "肆": "4", "五": "5", "伍": "5", "六": "6",
  "陆": "6", "七": "7", "柒": "7", "八": "8", "捌": "8", "九": "9", "玖": "9",
};
/** 归一化:中文数字转阿拉伯 + "无/没有/不存在"视为 0 */
function normalizeNumText(t: string): string {
  let out = "";
  for (const ch of t) out += CN_NUM[ch] ?? ch;
  if (/^(无|没有|不存在|没|none|nothing)/i.test(out.trim())) out = "0 " + out;
  return out;
}

/** 抽取确定性答案(兼容中文数字与"无"等表述) */
function extractAnswer(text: string, kind: Probe["answer"]): string {
  const t = text.replace(/[*_`#]/g, "");
  if (kind === "number") {
    const norm = normalizeNumText(t);
    const nums = norm.match(/-?\d+(?:\.\d+)?/g);
    return nums ? nums[nums.length - 1] : "";
  }
  if (kind === "yesno") return /否|不能|无法|no\b/i.test(t.slice(0, 40)) ? "no" : "yes";
  return t.trim().slice(0, 24).toLowerCase();
}

/** 字符 n-gram Jaccard(对中文友好,无需分词) */
function ngramSim(a: string, b: string, n = 3): number {
  const g = (s: string) => {
    const set = new Set<string>();
    const c = s.replace(/\s+/g, "");
    for (let i = 0; i + n <= c.length; i++) set.add(c.slice(i, i + n));
    return set;
  };
  const A = g(a), B = g(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  A.forEach(x => { if (B.has(x)) inter++; });
  return inter / (A.size + B.size - inter);
}

/** 结构特征向量 */
function features(t: string) {
  return {
    len: t.length,
    codeFence: (t.match(/```/g) || []).length,
    bullets: (t.match(/^\s*[-*]\s|^\s*\d+\.\s/gm) || []).length,
    bold: (t.match(/\*\*[^*]+\*\*/g) || []).length,
    sentences: (t.match(/[。.!？?]/g) || []).length,
    refuses: /(无法|不能|抱歉|违反|legale|cannot|sorry)/i.test(t) ? 1 : 0,
  };
}

/** 风格相似度:长度比 + 结构一致性 + n-gram 语义重叠 */
function styleSim(a: string, b: string): number {
  const fa = features(a), fb = features(b);
  const lenRatio = Math.min(fa.len, fb.len) / Math.max(fa.len, fb.len, 1);
  const struct = 1 - (Math.min(1, Math.abs(fa.codeFence - fb.codeFence) / 2) +
                        Math.min(1, Math.abs(fa.bullets - fb.bullets) / 4) +
                        Math.min(1, Math.abs(fa.sentences - fb.sentences) / 5) +
                        (fa.refuses !== fb.refuses ? 1 : 0)) / 4;
  const ng = ngramSim(a, b);
  // n-gram 对同义改写会低估,给结构/长度更高权重
  return Math.max(0, Math.min(1, 0.4 * lenRatio + 0.35 * struct + 0.25 * ng));
}

export interface FpProbeResult {
  id: string; kind: string;
  sim: number;              // 0-100
  baselineAnswer: string; candidateAnswer: string;
  baselineLen: number; candidateLen: number;
  /** 原始响应节选(最多 300 字)——用于人工复核假阳性,不可只信分数 */
  baselineText?: string; candidateText?: string;
  baselineErr?: string; candidateErr?: string;
}
export interface FpResult {
  site: string; model: string; baseline: string; baselineModel: string;
  batchId: string; ranAt: string; bankVersion: string;
  probes: FpProbeResult[];
  similarity: number | null;
  verdict: "pass" | "suspect" | "fail" | "unknown";
  validProbes: number;
  notes: string[];
}

function resolveBase(site: SiteConfig): string {
  let base = site.base_url.replace(/\/+$/, "");
  if (!/\/v\d+(\/|$)/.test(base)) base = `${base}/v1`;
  return base;
}

/**
 * 执行一次指纹比对
 * @param candidate 被测站
 * @param baselineSite 基线站(openrouter 或另一中转站)
 * @param model 候选侧模型名
 */
export async function runFingerprint(
  candidate: SiteConfig, baselineSite: SiteConfig, model: string,
  opts: { probeIds?: string[] } = {}
): Promise<FpResult> {
  const notes: string[] = [];
  const candKey = candidate.key_env ? process.env[candidate.key_env] : undefined;
  const baseKey = baselineSite.key_env ? process.env[baselineSite.key_env] : undefined;
  const baseModel = baselineSite.name === "openrouter" ? (OR_MAP[model] ?? model) : model;

  const result: FpResult = {
    site: candidate.name, model, baseline: baselineSite.name, baselineModel: baseModel,
    batchId: nextBatchId(), ranAt: new Date().toISOString(), bankVersion: PROBE_BANK_VERSION,
    probes: [], similarity: null, verdict: "unknown", validProbes: 0, notes,
  };
  if (!candKey) { notes.push("被测站缺少 API key"); return result; }
  if (!baseKey) { notes.push(`基线站 ${baselineSite.name} 缺少 API key(在 config/secrets/sites.env 配置 ${baselineSite.key_env || "?"})`); return result; }
  if (baselineSite.name === "openrouter" && !OR_MAP[model]) notes.push(`模型 ${model} 无 OpenRouter 映射,按同名尝试`);

  const probes = opts.probeIds?.length ? PROBES.filter(p => opts.probeIds!.includes(p.id)) : PROBES;
  const candBase = resolveBase(candidate);
  const baseBase = resolveBase(baselineSite);

  for (const p of probes) {
    const b = await ask(baseBase, baseKey!, baseModel, p.prompt);
    const c = await ask(candBase, candKey!, model, p.prompt);
    const pr: FpProbeResult = {
      id: p.id, kind: p.kind, sim: 0,
      baselineAnswer: "", candidateAnswer: "",
      baselineLen: b.text.length, candidateLen: c.text.length,
      baselineText: b.text.slice(0, 300), candidateText: c.text.slice(0, 300),
      baselineErr: b.err, candidateErr: c.err,
    };
    if (b.err || c.err) { result.probes.push(pr); notes.push(`${p.id} 跳过: ${b.err ?? c.err}`); continue; }

    let sim: number;
    if (p.kind === "deterministic") {
      pr.baselineAnswer = extractAnswer(b.text, p.answer);
      pr.candidateAnswer = extractAnswer(c.text, p.answer);
      sim = pr.baselineAnswer && pr.baselineAnswer === pr.candidateAnswer ? 100 : 0;
    } else {
      sim = Math.round(styleSim(b.text, c.text) * 100);
    }
    pr.sim = sim;
    result.probes.push(pr);
  }

  // 综合:确定性题权重高(答案不一致是掉包强信号)
  const det = result.probes.filter(p => p.kind === "deterministic" && !p.baselineErr && !p.candidateErr);
  const sty = result.probes.filter(p => p.kind === "style" && !p.baselineErr && !p.candidateErr);
  result.validProbes = det.length + sty.length;
  if (!result.validProbes) { notes.push("无有效探针样本,不出分"); return result; }
  const detScore = det.length ? det.reduce((s, p) => s + p.sim, 0) / det.length : null;
  const styScore = sty.length ? sty.reduce((s, p) => s + p.sim, 0) / sty.length : null;
  const sim = detScore === null ? styScore! : styScore === null ? detScore : 0.6 * detScore + 0.4 * styScore;
  const similarity = Math.round(sim * 10) / 10;
  result.similarity = similarity;
  result.verdict = similarity >= 85 ? "pass" : similarity >= 70 ? "suspect" : "fail";
  if (det.length === 0) result.notes.push("无确定性题成功,仅风格比对(置信度较低)");
  return result;
}

export function persistFingerprint(res: FpResult): void {
  const batch = { batchId: res.batchId, site: res.site, task: "billing" as const, startedAt: res.ranAt, ok: res.similarity !== null, result: res };
  const rawPath = saveRaw(batch as any);
  getDb().prepare(`INSERT INTO batches(id, site, task, started_at, ok, raw_path, summary) VALUES(?,?,?,?,?,?,?)`)
    .run(res.batchId, res.site, "billing", res.ranAt, res.similarity !== null ? 1 : 0, rawPath,
      JSON.stringify({ fingerprint: true, model: res.model, baseline: res.baseline, similarity: res.similarity, verdict: res.verdict, validProbes: res.validProbes, bankVersion: res.bankVersion }));
  if (res.verdict === "fail") logEvent(res.site, "fingerprint_fail", { batchId: res.batchId, model: res.model, similarity: res.similarity, baseline: res.baseline });
  else if (res.verdict === "suspect") logEvent(res.site, "fingerprint_suspect", { batchId: res.batchId, model: res.model, similarity: res.similarity });
}
