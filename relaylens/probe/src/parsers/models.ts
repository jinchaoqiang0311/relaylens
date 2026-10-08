/**
 * 全站模型登记表(2026-10-03 换代):榜单/比价选择栏的模型集合以此为唯一权威。
 * 命名现实:各站与 OpenRouter 对同一模型写法不一(点号 vs 连字符、-preview/:batch 后缀、vendor/ 前缀),
 * 因此匹配一律走 canonName() 归一化 + 精确等值:
 *   - 归一化:去厂商前缀、去 ":batch" 类后缀、点号→连字符、去尾缀 -preview/-customtools/-latest
 *   - 精确匹配:deepseek-v4-1-flash-hc、glm-5.3-flash、gpt-5.6-sol-pro 这类派生名不会被误并入
 * 未登记的模型一律不进榜单/比价(宁缺毋滥,也不让旧代模型 gpt-5.5/claude-opus-5/glm-5.2 幽灵复发)。
 */
export interface CanonModel { canon: string; disp: string; fam: string }

export const CANON: CanonModel[] = [
  { canon: "gpt-5-6-sol",   disp: "GPT-5.6 Sol",         fam: "OpenAI" },
  { canon: "gpt-5-6-terra", disp: "GPT-5.6 Terra",       fam: "OpenAI" },
  { canon: "gpt-6-astra",   disp: "GPT-6 Astra",         fam: "OpenAI" },
  { canon: "gpt-6-sol",     disp: "GPT-6 Sol",           fam: "OpenAI" },
  { canon: "gpt-6-1-sol",   disp: "GPT-6.1 Sol",         fam: "OpenAI" },
  { canon: "claude-sonnet-5-5", disp: "Claude Sonnet 5.5", fam: "Anthropic" },
  { canon: "claude-opus-5-5",   disp: "Claude Opus 5.5",    fam: "Anthropic" },
  { canon: "claude-fable-5-1",  disp: "Claude Fable 5.1",   fam: "Anthropic" },
  { canon: "claude-sonnet-5",   disp: "Claude Sonnet 5",    fam: "Anthropic" },
  { canon: "gemini-3-1-pro",    disp: "Gemini 3.1 Pro",     fam: "Google" },
  { canon: "gemini-3-7-flash",  disp: "Gemini 3.7 Flash",   fam: "Google" },
  { canon: "gemini-3-5-flash",  disp: "Gemini 3.5 Flash",   fam: "Google" },
  { canon: "grok-4-7",          disp: "Grok 4.7",           fam: "xAI" },
  { canon: "deepseek-v4-pro",       disp: "DeepSeek V4 Pro",       fam: "DeepSeek" },
  { canon: "deepseek-v4-1-flash",   disp: "DeepSeek V4.1 Flash",   fam: "DeepSeek" },
  { canon: "kimi-k3",           disp: "Kimi K3",            fam: "Moonshot" },
  { canon: "glm-5-3",           disp: "GLM-5.3",            fam: "Zhipu" },
];

/** 归一化匹配键:vendor/、:batch、点号、-preview/-customtools/-latest 全部收敛(后缀可叠加,循环剥离) */
export function canonName(raw: string): string {
  let n = String(raw || "").toLowerCase();
  n = n.replace(/^[a-z0-9._-]+\//, "");     // openai/… 、~anthropic/…
  n = n.replace(/:.*$/, "");                // :batch 等冒号后缀
  n = n.replace(/\./g, "-");                // 点号版本 → 连字符
  n = n.replace(/(?:-(?:preview|customtools|latest|image))+$/g, "");
  return n;
}

/** 命中登记表 → canonical 条目;否则 null(不进比价/榜单) */
export function matchCanon(raw: string): CanonModel | null {
  const n = canonName(raw);
  return CANON.find(c => c.canon === n) ?? null;
}
