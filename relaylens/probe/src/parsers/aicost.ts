/**
 * aicost 解析器
 * /api/pricing 需鉴权:必须带 New-API-User: <用户id> + Authorization: Bearer <令牌>。
 * 采集策略(双通道,自动优先):
 *   1) 自动:在 sites.env 配置 AICOST_ACCESS_TOKEN + AICOST_USER_ID 后,解析器直接
 *      fetch /api/pricing(免浏览器,可进定时任务);实测 id=6289 + 令牌可返回 102 模型。
 *   2) 回退:未配置令牌时,读取 store/manual-imports/aicost-pricing-*.json(用户在已登录
 *      浏览器 Console 执行导出脚本落盘),capturedAt 取文件 mtime。
 * source 标注 api(token,id=...) 或 manual-import(...),parser 对应 aicost-api / aicost-manual。
 */
import fs from "node:fs";
import path from "node:path";
import type { PriceResult, SiteConfig } from "../../../shared/types.js";
import { STORE_DIR } from "../store.js";
import { parseTieredExpr } from "./newapi.js";

const IMPORT_DIR = path.join(STORE_DIR, "manual-imports");
/** 只采集关注的模型前缀 */
const WATCHED_PREFIXES = [
  "claude-opus", "claude-sonnet", "claude-fable", "gpt-5.5", "gpt-5.6", "gpt-6",
  "gemini-3.1", "deepseek-v4", "glm-5", "grok-4",
];

interface NAPricingModel {
  model_name: string;
  quota_type: number;
  model_ratio: number;
  model_price: number;
  completion_ratio: number;
  cache_ratio?: number;
  enable_groups: string[];
  billing_mode?: string;
  billing_expr?: string;
}

interface NAPricingResponse {
  success?: boolean;
  data?: NAPricingModel[];
  group_ratio?: Record<string, number>;
}

function round8(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

function latestImport(): { file: string; mtime: Date } | null {
  if (!fs.existsSync(IMPORT_DIR)) return null;
  const files = fs.readdirSync(IMPORT_DIR)
    .filter(f => f.startsWith("aicost-pricing") && f.endsWith(".json"))
    .map(f => ({ file: path.join(IMPORT_DIR, f), mtime: fs.statSync(path.join(IMPORT_DIR, f)).mtime }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return files[0] ?? null;
}

export async function parseAicost(site: SiteConfig): Promise<PriceResult> {
  const parseErrors: string[] = [];
  const models: Array<PriceResult["models"][number]> = [];

  // 1) 优先:令牌自动拉取(Bearer token + New-API-User: id,免浏览器)
  //    来源:用户在 sites.env 配置 AICOST_ACCESS_TOKEN + AICOST_USER_ID
  const baseUrl = (site.base_url || "https://www.aicost.me").replace(/\/$/, "");
  const token = process.env.AICOST_ACCESS_TOKEN;
  const userId = process.env.AICOST_USER_ID;
  let body: NAPricingResponse | null = null;
  let capturedAt = new Date().toISOString();
  let sourceNote = "";
  let parser = "aicost-manual";

  if (token && userId) {
    try {
      const r = await fetch(baseUrl + "/api/pricing", {
        headers: {
          "New-API-User": String(userId),
          "Authorization": "Bearer " + token,
          "Cache-Control": "no-store",
        },
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) {
        const j = await r.json() as NAPricingResponse;
        if (j && j.success && Array.isArray(j.data) && j.data.length) {
          body = j; sourceNote = `api(token,id=${userId})`; parser = "aicost-api";
        } else { parseErrors.push("令牌拉取返回结构异常,回退手动导入"); }
      } else { parseErrors.push(`令牌拉取 HTTP ${r.status},回退手动导入`); }
    } catch (e) { parseErrors.push("令牌拉取异常:" + (e as Error).message + ",回退手动导入"); }
  }

  // 2) 回退:手动导入文件(store/manual-imports/aicost-pricing-*.json)
  if (!body) {
    const imp = latestImport();
    if (!imp) {
      return {
        task: "price", site: site.name, capturedAt,
        currency: "USD", models: [], ratio: null, parser: "aicost-manual",
        parseErrors: ["no manual import found — 配置 AICOST_ACCESS_TOKEN + AICOST_USER_ID 走自动拉取,或在已登录浏览器 Console 执行导出脚本后重跑"],
      };
    }
    body = JSON.parse(fs.readFileSync(imp.file, "utf8")) as NAPricingResponse;
    capturedAt = imp.mtime.toISOString();
    sourceNote = `manual-import(${path.basename(imp.file)})`;
  }

  const data = body.data ?? [];
  const groupRatio = body.group_ratio ?? {};
  if (data.length === 0) throw new Error("pricing data empty");

  const tag = parser === "aicost-api" ? "api" : "manual-import";

  for (const m of data) {
    if (!WATCHED_PREFIXES.some(p => m.model_name.startsWith(p))) continue;
    if (m.quota_type !== 0) continue; // 按次计费暂不采集
    const tiered = m.billing_mode === "tiered_expr" ? parseTieredExpr(m.billing_expr || "") : null;
    if (m.billing_mode === "tiered_expr" && !tiered) { parseErrors.push(`tiered_expr 无法解析,宁缺毋错: ${m.model_name}`); continue; }
    if (!tiered && (!Number.isFinite(m.model_ratio) || m.model_ratio <= 0)) continue;

    const gs = (m.enable_groups ?? []).filter(g => groupRatio[g] !== undefined);
    if (gs.length === 0) { parseErrors.push(`no group ratio: ${m.model_name}`); continue; }
    const cacheRatio = tiered ? tiered.cacheRead : (m.cache_ratio !== undefined && m.cache_ratio > 0 ? m.cache_ratio : null);
    const priceOf = (ratio: number) => (tiered
      ? {
          input: round8(tiered.input * ratio),
          output: round8(tiered.output * ratio),
          cacheRead: tiered.cacheRead != null ? round8(tiered.cacheRead * ratio) : null,
        }
      : {
          input: round8(m.model_ratio * ratio * 2),
          output: round8(m.model_ratio * ratio * 2 * (m.completion_ratio || 1)),
          cacheRead: cacheRatio != null ? round8(m.model_ratio * ratio * 2 * (cacheRatio as number)) : null,
        }
    );
    const allGroups = gs.map(g => ({ group: g, ratio: groupRatio[g], ...priceOf(groupRatio[g]) }));
    // 主口径:默认组优先,无默认组取中位倍率(与 newapi 解析器同口径,2026-10-03)
    const DEFAULT_RE = /^(default|默认|普通用户|normal)$/i;
    const def = allGroups.find(x => DEFAULT_RE.test(x.group));
    let head = def;
    let groupKind: "default" | "median" = def ? "default" : "median";
    if (!def) {
      const sorted = [...allGroups].sort((a, b) => a.ratio - b.ratio);
      head = sorted[Math.floor(sorted.length / 2)];
    }
    const { input, output, cacheRead } = priceOf(head.ratio);
    const base = priceOf(1);   // 官方价格(不含组倍率):到手价 = base × 倍率 × 充值比例

    models.push({
      model: m.model_name,
      input, output, cacheRead,
      grpRatio: head.ratio, base,
      cacheWrite: tiered ? (tiered.cacheWrite != null ? round8(tiered.cacheWrite * head.ratio) : null) : null,
      group: head.group,
      groupKind,
      groups: allGroups,
      source: (tiered ? tag + "(tiered_expr)" : tag) + `(${sourceNote})`,
    });
  }

  return {
    task: "price", site: site.name, capturedAt,
    currency: "USD", models, ratio: null, parser,
    parseErrors,
  };
}
