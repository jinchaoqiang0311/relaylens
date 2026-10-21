/**
 * parsers/index.ts —— per-site 解析器注册表
 * 新站接入:在 parsers/ 下写一个解析器 → 在此注册 → sites.yaml 配 parser 字段。
 */
import type { PriceResult, SiteConfig } from "../../../shared/types.js";
import { parseOpenRouter } from "./openrouter.js";
import { parseDeepSeek } from "./deepseek.js";
import { parseZhipu } from "./zhipu.js";
import { parseNewAPI } from "./newapi.js";
import { parseAicost } from "./aicost.js";
import { parseModelPlaza } from "./modelplaza.js";
import { parseUptoken } from "./uptoken.js";
import { parseHeyRoute } from "./heyroute.js";

export type PriceParser = (site: SiteConfig) => Promise<PriceResult>;

const REGISTRY: Record<string, PriceParser> = {
  openrouter: parseOpenRouter,
  deepseek: parseDeepSeek,
  zhipu: parseZhipu,
  newapi: parseNewAPI,
  aicost: parseAicost,
  modelplaza: parseModelPlaza,
  uptoken: parseUptoken,
  heyroute: parseHeyRoute,
};

export function getParser(name: string | undefined): PriceParser | null {
  if (!name) return null;
  return REGISTRY[name] ?? null;
}

/** 占位解析器:未配置/未注册时返回空集(标记 pending) */
export async function parsePending(site: SiteConfig): Promise<PriceResult> {
  return {
    task: "price",
    site: site.name,
    capturedAt: new Date().toISOString(),
    currency: "CNY",
    models: [],
    ratio: null,
    parser: "pending",
    parseErrors: [],
  };
}
