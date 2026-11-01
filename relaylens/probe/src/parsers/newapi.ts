/**
 * new-api 系中转站解析器 —— 定价来自 {origin}/api/pricing(带 key,返回全站分组倍率表)
 * new-api 计费口径(one-api 约定):
 *   输入价(USD/M)= model_ratio × group_ratio × $2   (ratio 1 = $0.002/1K tokens)
 *   输出价 = 输入价 × completion_ratio;缓存读 = 输入价 × cache_ratio
 * 分组口径(2026-10-03 修正,旧版取"最低组"导致到手价普遍虚低):
 *   主口径 = 默认组(普通注册用户在的组);无"default"字样组时取中位倍率组并标 median;
 *   全部组价存 groups[] 下发,前端并列展示"特价组"(含组名,门槛可见,如「仅限VIP」)。
 * ⚠ 锚点假设(ratio1=$2/M)只对遵守官方约定的站成立;自定义倍率表(如全站 model_ratio=37.5)
 *   由 billing 实扣校准(实扣/应扣因子),未校准的站前端一律标「页面价·估算」。
 */
import type { PriceResult, SiteConfig } from "../../../shared/types.js";

const TIMEOUT_MS = 30_000;
/** 采集前缀放宽(覆盖 2026-10-03 换代的 17 个主力模型及其点/横变体),多余项由 sync 的 matchCanon 裁掉 */
const WATCHED_PREFIXES = [
  "claude-sonnet", "claude-opus", "claude-fable",
  "gpt-5.6", "gpt-6", "gpt-5.5",
  "gemini-3", "grok-4", "deepseek-v4", "kimi", "glm",
];

interface NAPricingModel {
  model_name: string;
  quota_type: number;        // 0 = 按token计费
  model_ratio: number;       // 倍率(tiered_expr 模型里只是占位,不可用于计价!)
  model_price: number;       // 按次价格(quota_type≠0 时生效)
  completion_ratio: number;  // 输出/输入 倍率
  cache_ratio?: number;      // 缓存读/输入 倍率
  enable_groups: string[];
  billing_mode?: string;     // "tiered_expr" = 表达式分档计费(new-api 扩展)
  billing_expr?: string;     // 如 (len<=272000 ? tier("base", p*5 + c*30 + cr*0.5 + cc*6.25) : ...)
}

/**
 * tiered_expr 解析:真实价藏在表达式系数里,单位 = 美元/百万 token。
 * 实锤(2026-10-03,aicost 40 笔账单反推):账单 quota = ($系数×token/1M × 组倍率) × 500000,
 * 且 cr(缓存读)/cc(缓存写)按 cache_tokens 拆分计价 —— 三笔分毫对平。
 * model_ratio 在表达式模型里是占位值(常见 37.5),拿它×2 计价会错 15~40 倍。
 */
export function parseTieredExpr(expr: string): { input: number; output: number; cacheRead: number | null; cacheWrite: number | null } | null {
  if (!expr) return null;
  /* 取第一个 tier 体:条件档按「短上下文 base → 长上下文 higher」排列,第一个就是基础档。
   * 档名各站不同(base/standard/0_272k/≤272K),不能写死,只能按位置取第一个。 */
  let body: string | null = null;
  const first = /tier\(\s*["'][^"']*["']\s*,([^)]*)\)/.exec(expr);
  if (first) body = first[1];
  else if (!/tier\(/.test(expr)) body = expr;   // 无 tier() 包裹,整条即表达式
  if (!body) return null;
  const coef = (v: string) => { const k = new RegExp("\\b" + v + "\\s*\\*\\s*([\\d.]+)").exec(body as string); return k ? Number(k[1]) : null; };
  const p = coef("p"), c = coef("c");
  if (p == null || c == null || !isFinite(p) || !isFinite(c) || p <= 0 || c <= 0) return null;
  const cr = coef("cr"), cc = coef("cc");
  return { input: p, output: c, cacheRead: cr != null && isFinite(cr) ? cr : null, cacheWrite: cc != null && isFinite(cc) ? cc : null };
}

interface NAPricingResponse {
  success?: boolean;
  data?: NAPricingModel[];
  group_ratio?: Record<string, number>;
}

function round8(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

export async function parseNewAPI(site: SiteConfig): Promise<PriceResult> {
  const capturedAt = new Date().toISOString();
  const parseErrors: string[] = [];
  const origin = site.base_url.replace(/\/+$/, "").replace(/\/v1$/, "");
  const apiKey = site.key_env ? process.env[site.key_env] : undefined;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let models: Array<PriceResult["models"][number]> = [];

  /* /api/pricing 的鉴权因站而异:有的收 sk- key,有的只认管理面令牌(new-api 后台"系统访问令牌")。
     优先管理面令牌(<SITE>_ACCESS_TOKEN + <SITE>_USER_ID,与 aicost.ts 同约定),回退 sk- key。 */
  const at = process.env[site.name.toUpperCase() + "_ACCESS_TOKEN"];
  const uid = process.env[site.name.toUpperCase() + "_USER_ID"];
  const authHeaders = (at && uid)
    ? { Authorization: `Bearer ${at}`, "New-API-User": String(uid) }
    : (apiKey ? { Authorization: `Bearer ${apiKey}` } : {});

  try {
    const res = await fetch(`${origin}/api/pricing`, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "RelayLens-Probe/0.1",
        ...authHeaders,
      },
    });
    if (!res.ok) {
      throw new Error(`/api/pricing HTTP ${res.status}${res.status === 401 ? " (定价需登录,价格暂不可采)" : ""}`);
    }
    const body = (await res.json()) as NAPricingResponse;
    const data = body.data ?? [];
    const groupRatio = body.group_ratio ?? {};

    if (data.length === 0) throw new Error("pricing data empty");

    for (const m of data) {
      if (!WATCHED_PREFIXES.some(p => m.model_name.startsWith(p))) continue;
      if (m.quota_type !== 0) { parseErrors.push(`per-call pricing skipped: ${m.model_name}`); continue; }
      if (m.billing_mode !== "tiered_expr" && (!Number.isFinite(m.model_ratio) || m.model_ratio <= 0)) continue;  // 表达式模型不看占位 ratio

      // 全部分组价格(groups[])
      /* tiered_expr 站:价 = 表达式系数($/M) × 组倍率;非表达式站:价 = model_ratio × 组倍率 × $2 */
      const tiered = m.billing_mode === "tiered_expr" ? parseTieredExpr(m.billing_expr || "") : null;
      if (m.billing_mode === "tiered_expr" && !tiered) { parseErrors.push(`tiered_expr 无法解析,宁缺毋错: ${m.model_name}`); continue; }
      const cacheRatio = tiered ? tiered.cacheRead
        : (m.cache_ratio !== undefined && m.cache_ratio > 0 ? m.cache_ratio : null);
      const priceOf = (ratio: number) => (tiered
        ? {
            input: round8(tiered.input * ratio),
            output: round8(tiered.output * ratio),
            cacheRead: tiered.cacheRead != null ? round8(tiered.cacheRead * ratio) : null,
          }
        : {
            input: round8(m.model_ratio * ratio * 2),
            output: round8(m.model_ratio * ratio * 2 * (m.completion_ratio || 1)),
            cacheRead: cacheRatio != null && !tiered ? round8(m.model_ratio * ratio * 2 * (cacheRatio as number)) : null,
          }
      );
      const gs = (m.enable_groups ?? []).filter(g => groupRatio[g] !== undefined);
      if (gs.length === 0) { parseErrors.push(`no group ratio: ${m.model_name}`); continue; }
      const allGroups = gs.map(g => ({ group: g, ratio: groupRatio[g], ...priceOf(groupRatio[g]) }));
      // 主口径:默认组优先(普通注册用户体验价);无默认组取中位倍率并标 median
      const DEFAULT_RE = /^(default|默认|普通用户|normal)$/i;
      const def = allGroups.find(x => DEFAULT_RE.test(x.group));
      let head = def;
      let groupKind: "default" | "median" | "cheapest" = def ? "default" : "median";
      if (!def) {
        const sorted = [...allGroups].sort((a, b) => a.ratio - b.ratio);
        head = sorted[Math.floor(sorted.length / 2)];   // 中位倍率组
      }
      const { input, output, cacheRead } = priceOf(head.ratio);
      const base = priceOf(1);   // 官方价格(基础价,不含任何组倍率):到手价 = base × 倍率 × 充值比例

      models.push({
        model: m.model_name,
        input, output, cacheRead,
        grpRatio: head.ratio, base,
        cacheWrite: tiered ? (tiered.cacheWrite != null ? round8(tiered.cacheWrite * head.ratio) : null) : null,
        group: head.group,
        groupKind,
        groups: allGroups,
        source: tiered ? "newapi-pricing-api(tiered_expr)" : "newapi-pricing-api",
      });
    }
  } finally {
    clearTimeout(t);
  }

  return {
    task: "price",
    site: site.name,
    capturedAt,
    currency: "USD",
    models,
    ratio: null, // 充值比例待 P2 实测
    parser: "newapi",
    parseErrors,
  };
}
