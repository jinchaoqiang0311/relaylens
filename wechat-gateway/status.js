/**
 * 只读状态指令数据源:relaylens-home/data/sites.json(由 `npx tsx cli.ts sync` 产出)。
 * 这里绝不触发采集/扣费,秒回。
 */
const fs = require("node:fs");

function readSites(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function fmtUpdated(iso) {
  if (!iso) return "未知";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** status:全站汇总 */
function statusSummary(file) {
  const d = readSites(file);
  if (!d) return "⚠ 无法读取 sites.json(可能还没跑过 sync),请先在本机执行: npx tsx cli.ts sync";
  const m = d.meta || {};
  const st = m.stats || {};
  const fx = m.fx || {};
  const lines = [
    "📊 RelayLens 状态",
    `更新: ${fmtUpdated(m.updated)}  权重: ${m.weightsVersion || "?"}`,
    fx.usdCny ? `汇率: 1 USD = ${fx.usdCny} CNY (asOf ${fx.asOf || "?"})` : null,
    "",
    `在册站点 ${st.sitesRegistered ?? "?"} | 已实测付费 ${st.sitesPaidMeasured ?? "?"} | 监测中 ${st.sitesMonitored ?? "?"}`,
    `价格条目 ${st.priceLineItems ?? "?"} | 覆盖模型 ${st.distinctModels ?? "?"}`,
    `对账核验 ${st.reconcileVerified ?? 0} 笔 / 不符 ${st.reconcileMismatched ?? 0} 笔`,
    `健康检查累计 ${st.healthChecksTotal ?? "?"} 次 (自 ${st.since || "?"})`,
    "",
    "Top 站点(综合分,详见:「站点 关键词」):",
  ].filter((l) => l !== null);

  const sites = (d.realSites || [])
    .filter((s) => s && s.score && typeof s.score.all === "number")
    .sort((a, b) => b.score.all - a.score.all)
    .slice(0, 5);
  if (sites.length === 0) lines.push("(暂无有效评分)");
  sites.forEach((s, i) => {
    lines.push(
      `${i + 1}. ${s.name} ${s.score.all}分 可用${s.avail ?? "?"}%` +
        (s.ttftMs ? ` TTFT ${Math.round(s.ttftMs)}ms` : "")
    );
  });
  return lines.join("\n");
}

/** site <关键词>:单站详情 */
function siteDetail(file, kw) {
  if (!kw) return "用法: 站点 <名称关键词>,如「站点 aicost」";
  const d = readSites(file);
  if (!d) return "⚠ 无法读取 sites.json,请先执行: npx tsx cli.ts sync";
  const hit = (d.realSites || []).find(
    (s) => s.name && String(s.name).toLowerCase().includes(kw.toLowerCase())
  );
  if (!hit) return `未找到名称含「${kw}」的站点`;
  const score = hit.score && typeof hit.score.all === "number" ? hit.score.all : null;
  const coverage = hit.coverage && typeof hit.coverage.all === "number"
    ? `${Math.round(hit.coverage.all * 100)}%`
    : null;
  const priceSrc = hit.priceSrc && typeof hit.priceSrc === "object" ? hit.priceSrc.src : hit.priceSrc;
  const lines = [
    `🔎 ${hit.name}`,
    `状态: ${hit.status || "?"}  评级: ${hit.level || "?"}`,
    score !== null ? `综合分: ${score}${coverage ? ` (覆盖 ${coverage})` : ""}` : "综合分: 未出分(覆盖率不足或 passive)",
    `可用率: ${hit.avail ?? "?"}%  超时: ${hit.timeout ?? "?"}%`,
    hit.ttftMs ? `TTFT: ${Math.round(hit.ttftMs)}ms` : null,
    hit.price ? `主口径价: ${hit.price}${priceSrc ? ` (计价 ${priceSrc})` : ""}` : null,
    hit.priceCalib ? `实扣校准: ${hit.priceCalib}` : null,
    Array.isArray(hit.models) ? `模型: ${hit.models.length} 个` : null,
    hit.commerce && hit.commerce.ratio ? `充值比例: ${hit.commerce.ratio}` : null,
  ].filter((l) => l !== null);
  return lines.join("\n");
}

/** meta:汇率/口径等全局元信息 */
function metaSummary(file) {
  const d = readSites(file);
  if (!d || !d.meta) return "⚠ 无法读取 sites.json,请先执行: npx tsx cli.ts sync";
  const m = d.meta;
  const fx = m.fx || {};
  return [
    "🧭 口径元信息",
    `数据更新: ${fmtUpdated(m.updated)}`,
    `权重版本: ${m.weightsVersion || "?"}`,
    `汇率口径: ${fx.currency || "?"} ${fx.usdCny ?? "?"} (asOf ${fx.asOf || "?"})`,
    `额度口径: ${fx.quotaPerUsd ?? "?"} token/USD`,
    `批次可回溯: 页面任一数字可按批次号(RL-RC-*)查证`,
  ].join("\n");
}

module.exports = { statusSummary, siteDetail, metaSummary };
