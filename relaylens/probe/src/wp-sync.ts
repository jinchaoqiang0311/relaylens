/**
 * wp-sync.ts —— RelayLens → WordPress(aipaihangbang-relay 插件)单向回灌适配器。
 *
 * 定位:本文件是探针系统的**外挂适配器**,不被 cli.ts / scheduler.ts / 任何探针引用,
 * 探针运行不依赖 WordPress,删除本文件不影响 RelayLens 独立运行。
 *
 * 数据流:
 *   relaylens-home/data/sites.json (realSites) + config/sites.yaml (补 base_url)
 *     ── Worker Token ──▶ WP REST: /wp-json/aipaihangbang/v1/relaylens/push
 *
 * 用法:
 *   npx tsx src/wp-sync.ts --pull-map      # 拉取 WP 站点清单并生成 name → wp_id 映射建议
 *   npx tsx src/wp-sync.ts --dry-run       # 只组装 payload,不推送
 *   npx tsx src/wp-sync.ts                 # 正式推送
 *
 * Token 通过环境变量注入(默认 RELAYLENS_WP_TOKEN),不要写进配置文件。
 */
import fs from "fs";
import path from "path";
import YAML from "yaml";

const PUSH_SCHEMA = "relaylens-push/1.0.0";
const DEFAULT_TOKEN_ENV = "RELAYLENS_WP_TOKEN";

interface CliArgs {
  input: string;
  config: string;
  pullMap: boolean;
  dryRun: boolean;
}

interface WpSyncConfig {
  /** WP REST 基址,到 /aipaihangbang/v1 为止,不带末尾斜杠 */
  wp_api_base: string;
  /** 读取 Worker Token 的环境变量名 */
  token_env?: string;
  /** 探针站点名(sites.yaml 的 name) → WP relay_station 文章 ID */
  map?: Record<string, number>;
  /** sites.yaml 相对路径(用于给快照补 domain,让 WP 端可按域名自动匹配) */
  sites_yaml?: string;
}

interface WpMapSite {
  wp_id: number;
  name: string;
  official_url: string;
  status: string;
}

interface PushResponse {
  received: number;
  updated: Array<{ name: string; wp_id: number }>;
  unmatched: Array<{ name: string; domain: string; reason: string }>;
  pending_total: number;
  generated_at: string;
}

type RealSite = Record<string, unknown> & { name: string };

function parseArgs(argv: string[]): CliArgs {
  const here = import.meta.dirname; // .../relaylens/probe/src (ESM,Node 20.11+)
  const args: CliArgs = {
    input: path.resolve(here, "../../../relaylens-home/data/sites.json"),
    config: path.resolve(here, "../config/wp-sync.yaml"),
    pullMap: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pull-map") args.pullMap = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--input") args.input = path.resolve(argv[++i]);
    else if (a === "--config") args.config = path.resolve(argv[++i]);
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "wp-sync — RelayLens → WordPress 回灌适配器\n" +
          "  --pull-map        拉取 WP 站点清单,生成 name → wp_id 映射建议\n" +
          "  --dry-run         只组装并打印 payload,不推送\n" +
          "  --input <file>    sites.json 路径(默认 ../../../relaylens-home/data/sites.json)\n" +
          "  --config <file>   wp-sync.yaml 路径(默认 config/wp-sync.yaml)\n",
      );
      process.exit(0);
    }
  }
  return args;
}

function loadConfig(file: string): WpSyncConfig {
  if (!fs.existsSync(file)) {
    throw new Error(`找不到配置文件: ${file}\n可复制 config/wp-sync.yaml 示例并填入 wp_api_base。`);
  }
  const cfg = YAML.parse(fs.readFileSync(file, "utf8")) as WpSyncConfig | null;
  if (!cfg || !cfg.wp_api_base) {
    throw new Error(`配置缺少 wp_api_base: ${file}`);
  }
  cfg.wp_api_base = cfg.wp_api_base.replace(/\/+$/, "");
  cfg.map = cfg.map ?? {};
  return cfg;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** 从 sites.yaml 取 name → base_url,供 WP 端按域名自动匹配。 */
function loadDomains(cfg: WpSyncConfig, configFile: string): Map<string, string> {
  const out = new Map<string, string>();
  const file = cfg.sites_yaml
    ? path.resolve(path.dirname(configFile), cfg.sites_yaml)
    : path.resolve(path.dirname(configFile), "sites.yaml");
  if (!fs.existsSync(file)) return out;

  const y = YAML.parse(fs.readFileSync(file, "utf8")) as { sites?: Array<{ name?: string; base_url?: string }> } | null;
  for (const s of y?.sites ?? []) {
    if (s?.name && s.base_url) out.set(s.name, s.base_url);
  }
  return out;
}

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 20000): Promise<{ status: number; body: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* 非 JSON 响应保留原文 */
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

async function pullMap(cfg: WpSyncConfig, args: CliArgs): Promise<void> {
  const url = `${cfg.wp_api_base}/relaylens/station-map`;
  process.stdout.write(`拉取站点清单: GET ${url}\n`);
  const { status, body } = await fetchJson(url);
  if (status !== 200) {
    throw new Error(`station-map 请求失败 HTTP ${status}: ${JSON.stringify(body)}`);
  }
  const sites = (body as { sites?: WpMapSite[] }).sites ?? [];
  const domains = loadDomains(cfg, args.config);

  // 建议映射:优先按 sites.yaml base_url 的 host 匹配,其次同名匹配。
  const suggested: Record<string, number> = {};
  const byHost = new Map<string, number>();
  for (const s of sites) {
    const h = hostOf(s.official_url);
    if (h) byHost.set(h, s.wp_id);
  }
  for (const [name, baseUrl] of domains) {
    const byUrl = byHost.get(hostOf(baseUrl));
    if (byUrl) suggested[name] = byUrl;
  }
  for (const s of sites) {
    const key = s.name.trim().toLowerCase();
    for (const name of domains.keys()) {
      if (!(name in suggested) && name.trim().toLowerCase() === key) {
        suggested[name] = s.wp_id;
      }
    }
  }

  const outFile = path.resolve(path.dirname(args.config), "wp-station-map.json");
  fs.writeFileSync(
    outFile,
    JSON.stringify({ generated_at: new Date().toISOString(), suggested, wp_sites: sites }, null, 2),
    "utf8",
  );

  process.stdout.write(`\nWP 站点 ${sites.length} 个,探针配置站点 ${domains.size} 个,自动建议映射 ${Object.keys(suggested).length} 条:\n`);
  process.stdout.write(YAML.stringify({ map: suggested }, { lineWidth: 0 }));
  process.stdout.write(`\n完整清单已写入: ${outFile}\n`);
  process.stdout.write(`请把确认后的 map 段粘贴进 ${path.basename(args.config)},再执行不带 --pull-map 的推送。\n`);
}

function buildPayload(args: CliArgs, cfg: WpSyncConfig): { payload: unknown; totalReal: number } {
  const data = readJson<{ realSites?: RealSite[] }>(args.input);
  const realSites = (data.realSites ?? []).filter((s) => s.real !== false);
  const domains = loadDomains(cfg, args.config);
  const map = cfg.map ?? {};

  const sites = realSites.map((s) => {
    const name = String(s.name ?? "").trim();
    const out: Record<string, unknown> = { ...s, name };
    const wpId = map[name];
    if (typeof wpId === "number") out.wp_id = wpId;
    const baseUrl = domains.get(name);
    if (baseUrl && !out.domain) out.domain = baseUrl;
    return out;
  });

  return {
    payload: {
      schema: PUSH_SCHEMA,
      generated_at: new Date().toISOString(),
      sites,
    },
    totalReal: realSites.length,
  };
}

async function push(cfg: WpSyncConfig, args: CliArgs): Promise<void> {
  const tokenEnv = cfg.token_env || DEFAULT_TOKEN_ENV;
  const token = process.env[tokenEnv] || "";
  const { payload, totalReal } = buildPayload(args, cfg);
  const body = JSON.stringify(payload);
  const sites = (payload as { sites: unknown[] }).sites;

  process.stdout.write(`组装完成:真实站点 ${totalReal} 个,payload ${(body.length / 1024).toFixed(1)} KB\n`);

  if (args.dryRun) {
    process.stdout.write("[dry-run] 未推送。前 3 个站点:\n");
    process.stdout.write(JSON.stringify(sites.slice(0, 3), null, 2) + "\n");
    return;
  }

  if (!token) {
    throw new Error(`缺少 Worker Token:请设置环境变量 ${tokenEnv}(WP 后台测评设置中生成)。`);
  }

  const url = `${cfg.wp_api_base}/relaylens/push`;
  process.stdout.write(`推送中: POST ${url}\n`);
  const { status, body: resBody } = await fetchJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Aipaihangbang-Worker-Token": token,
    },
    body,
  });

  if (status !== 200) {
    throw new Error(`推送失败 HTTP ${status}: ${JSON.stringify(resBody)}`);
  }

  const res = resBody as PushResponse;
  process.stdout.write(`\n✓ 已接收 ${res.received},写入 ${res.updated.length} 个站点:\n`);
  for (const u of res.updated) process.stdout.write(`  ✓ ${u.name} → wp_id=${u.wp_id}\n`);
  if (res.unmatched.length) {
    process.stdout.write(`\n⚠ 未匹配 ${res.unmatched.length} 个(WP 端记入待绑定,不会自动建站):\n`);
    for (const u of res.unmatched) process.stdout.write(`  - ${u.name} ${u.domain ? `(${u.domain})` : ""}\n`);
    process.stdout.write(`提示:先执行 --pull-map 获取映射建议,把 map 填入配置后重推。\n`);
  }
  process.stdout.write(`\nWP 待绑定队列累计 ${res.pending_total} 条。\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(args.config);
  if (args.pullMap) {
    await pullMap(cfg, args);
  } else {
    await push(cfg, args);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`wp-sync 错误: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
