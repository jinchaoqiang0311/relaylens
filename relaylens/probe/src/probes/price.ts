/**
 * 探针 B:价格采集 —— 分发到 per-site 解析器
 * 解析器注册表见 src/parsers/index.ts;未配置时走 pending 占位。
 */
import type { PriceResult, SiteConfig } from "../../../shared/types.js";
import { getParser, parsePending } from "../parsers/index.js";

export async function runPrice(site: SiteConfig): Promise<PriceResult> {
  const parser = getParser(site.parser);
  if (!parser) return parsePending(site);
  try {
    return await parser(site);
  } catch (e) {
    // 解析器崩溃 → 记录错误但返回结构化失败(不入 raw 的 result 为 null)
    return {
      task: "price",
      site: site.name,
      capturedAt: new Date().toISOString(),
      currency: "CNY",
      models: [],
      ratio: null,
      parser: site.parser ?? "unknown",
      parseErrors: [`parser crashed: ${(e as Error).message}`],
    };
  }
}
