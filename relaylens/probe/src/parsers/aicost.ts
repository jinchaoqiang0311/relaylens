/**
 * aicost 解析器 —— 手动导出模式
 * aicost 的 /api/pricing 需登录 session,无法自动采集;
 * 数据来源:用户在已登录浏览器 Console 执行导出脚本(见 README),JSON 落盘到
 *   store/manual-imports/aicost-pricing-*.json
 * 本解析器读取最新的导出文件,capturedAt 取文件 mtime,source 标注 manual-import。
 * 自动化路径(P3):浏览器定时任务或社区节点登录态采集。
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

  const imp = latestImport();
  if (!imp) {
    return {
      task: "price", site: site.name, capturedAt: new Date().toISOString(),
      currency: "USD", models: [], ratio: null, parser: "aicost-manual",
      parseErrors: ["no manual import found — 在已登录浏览器 Console 执行导出脚本后重跑"],
    };
  }

  const body = JSON.parse(fs.readFileSync(imp.file, "utf8")) as NAPricingResponse;
  const data = body.data ?? [];
  const groupRatio = body.group_ratio ?? {};
  const capturedAt = imp.mtime.toISOString();

  if (data.length === 0) throw new Error("pricing data empty");

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
      source: (tiered ? "manual-import(tiered_expr)" : "manual-import") + `(${path.basename(imp.file)})`,
    });
  }

  return {
    task: "price", site: site.name, capturedAt,
    currency: "USD", models, ratio: null, parser: "aicost-manual",
    parseErrors,
  };
}
