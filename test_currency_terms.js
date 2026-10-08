/**
 * test_currency_terms.js —— 全站口径统一断言(2026-10-02 那轮改动的守门人)
 *   ①决策页不许再出现 "TTFT"(统一说「首字延迟」);方法页/API 文档作为技术口径可保留,但必须先给大白话。
 *   ②单位诚实规则(2026-10-02.2 纠偏后):标价必须保持站方公示的额度单位($X/M),
 *     人民币价必须能追溯到充值比例(出现"到手"或"比例"字样);绝不允许出现按 1$=¥7.1 乘出来的假 ¥ 主价。
 *   ③数据层必须带 fx,且 payload 里不能再有 USD/M 单位。
 */
const fs = require("fs");
const DIR = "C:/Users/Administrator/.qwenworkcn/workspace/mugbtmedrrtj5xkw/relaylens-home/";
const DECISION = ["index.html", "ranking.html", "compare.html", "detail.html", "selector.html",
  "tools.html", "reports.html", "blacklist.html", "onboarding.html", "claim.html", "404.html", "ops.html"];
const TECH = ["method.html", "api.html"];
let pass = 0, fail = 0;
const check = (n, c, d) => { (c ? pass++ : fail++); console.log(`  ${c ? "✓" : "✗"} ${n}${d ? " · " + d : ""}`); };

console.log("\n【决策页:术语与货币绝迹检查】");
for (const f of DECISION) {
  const s0 = fs.readFileSync(DIR + f, "utf8");
  // 注释里允许出现历史字面量(如 "$0.90/M 已折算" 的说明),断言只看对外可见文案
  const s = s0.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/<!--[\s\S]*?-->/g, "");
  // 允许的唯一一处:先给大白话再括注技术口径「首字延迟(技术口径 TTFT)」;其余一律算漏改
  const GLOSS = "首字延迟(技术口径 TTFT)";
  const stripped = s.split(GLOSS).join("");
  const t = (stripped.match(/TTFT/g) || []).length;
  const dollars = [...s.matchAll(/(.{0,24})\$(\d[\d.,]*)/g)].filter(m => !/USD = |1 USD/.test(m[1]));
  check(`${f} 无 TTFT(已统一为首字延迟)`, t === 0, t ? stripped.match(/.{0,28}TTFT.{0,14}/)[0] : "");
  // 标价允许是站方额度价($X/M),但必须出现"额度"字样说明单位;人民币价必须伴随"到手/比例"
  if (/\$\d/.test(s)) check(`${f} 出现美元数时已注明额度单位`, /额度/.test(s), (dollars[0] || [""])[0].trim().slice(0, 40));
  check(`${f} 无 1$=¥7.1 乘出来的假主价`, !/标价按 1 USD = ¥7\.1 折算/.test(s) && !/¥6\.39|¥12\.43|¥4\.97/.test(s));
}
check("ranking 保留了唯一一处技术口径括注", (fs.readFileSync(DIR + "ranking.html", "utf8").match(/首字延迟\(技术口径 TTFT\)/g) || []).length === 1);

console.log("\n【决策页:正向文案确实改了】");
check("ranking 列头与筛选项说「首字延迟」", /首字延迟 ≤ 2s/.test(fs.readFileSync(DIR + "ranking.html", "utf8")));
check("compare 场景说明说「首字延迟」", /晚高峰首字延迟/.test(fs.readFileSync(DIR + "compare.html", "utf8")));
check("selector 维度名说「首字延迟」", /speed:"首字延迟"/.test(fs.readFileSync(DIR + "selector.html", "utf8")));
check("detail 指标条说「首字延迟」", /首字延迟·晚高峰/.test(fs.readFileSync(DIR + "detail.html", "utf8")));
check("index 的 quota 换算输出额度价,比例已知才补 ¥",
  /function q2cny/.test(fs.readFileSync(DIR + "index.html", "utf8")) &&
  /额度/.test(fs.readFileSync(DIR + "index.html", "utf8")) && !/q2usd/.test(fs.readFileSync(DIR + "index.html", "utf8")));

console.log("\n【技术页:保留 TTFT 但必须先给大白话】");
const meth = fs.readFileSync(DIR + "method.html", "utf8");
check("method 首现处给中文口径", /晚高峰首字延迟\(TTFT\)/.test(meth));
check("method 的美元数都带额度单位说明", /额度/.test(meth) && !/标价按 1 USD = ¥7\.1 折算/.test(meth));
check("method 公示汇率口径与生效日", /1 美元 = ¥7\.1/.test(meth) && /pricing_display/.test(meth) && /2026-10-02/.test(meth));
const api = fs.readFileSync(DIR + "api.html", "utf8");
check("api 文档字段名保留 ttft 但说明为中文", /ttft/.test(api) && /晚高峰首字延迟/.test(api));

console.log("\n【数据层:payload 已折算且自带口径】");
const D = JSON.parse(fs.readFileSync(DIR + "data/sites.json", "utf8"));
check("meta.fx 存在并写明 7.1 与日期", !!D.meta.fx && D.meta.fx.usdCny === 7.1 && D.meta.fx.asOf === "2026-10-02");
check("标价保持站方额度单位(美元站为 $X/M,声明比例的站给 ¥ 到手价)",
  D.realSites.every(r => !r.price || /^[¥$][\d.]+\/M$/.test(r.price)) &&
  D.realSites.filter(r => r.effPrice != null).every(r => r.price === "¥" + r.effPrice + "/M") &&
  D.realSites.filter(r => r.effPrice == null && r.priceBaseCur === "USD").every(r => r.price.charAt(0) === "$"),
  D.realSites.map(r => r.name + ":" + r.price).join(" "));
check("报价带出模型与分组(可回溯到站方页面)", D.realSites.every(r => !r.price || (!!r.priceModel && !!r.priceGroup)));
check("到手价只能来自已声明的充值比例", D.realSites.every(r => r.effPrice == null || (r.commerce && r.commerce.ratioNum > 0)));
check("priceV = 站方额度价(排序同单位)", D.realSites.every(r => r.priceV == null || r.priceV === r.priceBase),
  D.realSites.map(r => r.priceV).filter(v => v != null).join(","));
check("compare.unit 说明标价是站方额度价", /额度价/.test(D.compare.unit) && /不给人民币价/.test(D.compare.fx));
check("compare 价格数值已折算(无亚分美元级假价残留;实扣校准后的真低单价以 0.001 为底线)", D.compare.tabs.every(t => t.rows.every(r => r.inP == null || r.inP >= 0.001)));
check("评分未受换算影响(两站综合分仍为整数)", D.realSites.every(r => r.score.all === null || Number.isInteger(r.score.all)),
  D.realSites.map(r => r.name + ":" + r.score.all).join(" "));

console.log(`\n${fail === 0 ? "✓ 全部通过" : "✗ 有失败"} · ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
