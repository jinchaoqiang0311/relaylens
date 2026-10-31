/**
 * 全量价格表抓取 —— 用于人工核对 / 出表 / 补采
 *  - memecode / aixoras: /api/pricing 公开 JSON,实时抓取(全量,不过滤前缀)
 *  - aicost: 定价接口需登录 session,复制最新手动导出(aicost-pricing-*.json)
 * 产出: store/manual-imports/{site}-pricing-live.json (全量原始) + raw 归档
 * 用法: node scripts/fetch-full-prices.cjs [site...]
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const IMPORT_DIR = path.join(ROOT, "store", "manual-imports");
const RAW_DIR = path.join(ROOT, "store", "raw");

const SITES = {
  memecode: { base: "https://memecode.de", fetch: true },
  aixoras: { base: "https://aixoras.com", fetch: true },
  aicost: { base: null, fetch: false },
};

function msTs() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function fetchLive(site, base) {
  const url = `${base}/api/pricing`;
  console.log(`→ 抓取 ${site}: ${url}`);
  const res = await fetch(url, { headers: { "User-Agent": "RelayLens-Probe/0.1" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const models = body.data || [];
  console.log(`  ${site}: ${models.length} 个模型, ${(body.group_ratio ? Object.keys(body.group_ratio).length : 0)} 个分组倍率`);
  return body;
}

function copyManual(site) {
  const files = fs.readdirSync(IMPORT_DIR)
    .filter((f) => f.startsWith(`${site}-pricing`) && f.endsWith(".json") && !f.includes("live"))
    .map((f) => ({ f, mtime: fs.statSync(path.join(IMPORT_DIR, f)).mtime }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) throw new Error(`未找到 ${site} 的手动导出文件`);
  const src = path.join(IMPORT_DIR, files[0].f);
  const body = JSON.parse(fs.readFileSync(src, "utf8"));
  console.log(`→ ${site}: 复制手动导出 ${files[0].f} (${body.data?.length || 0} 个模型)`);
  return body;
}

function save(site, body) {
  const ts = msTs();
  const livePath = path.join(IMPORT_DIR, `${site}-pricing-live.json`);
  fs.writeFileSync(livePath, JSON.stringify(body, null, 2));
  // 同时进 raw 归档(按批次号风格命名,可回溯)
  const rawPath = path.join(RAW_DIR, `price-${site}-${ts}.json`);
  fs.mkdirSync(path.dirname(rawPath), { recursive: true });
  fs.writeFileSync(rawPath, JSON.stringify({ task: "price", site, capturedAt: new Date().toISOString(), currency: "USD", raw: body }, null, 2));
  console.log(`  已保存: ${livePath}  + 归档 ${rawPath}`);
}

async function main() {
  const args = process.argv.slice(2);
  const targets = args.length ? args : Object.keys(SITES);
  for (const site of targets) {
    if (!SITES[site]) { console.error(`未知站点: ${site}`); continue; }
    try {
      const body = SITES[site].fetch ? await fetchLive(site, SITES[site].base) : copyManual(site);
      save(site, body);
    } catch (e) {
      console.error(`✗ ${site} 失败: ${e.message}`);
    }
  }
}
main();
