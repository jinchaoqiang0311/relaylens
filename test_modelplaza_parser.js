/**
 * test_modelplaza_parser.js — model-plaza 解析器口径回归(2026-10-17 新增)
 * 覆盖两种载荷形态与关键口径:
 *   A 组内嵌(uuapi/hahacode):展示价=最终价(不再乘组倍率),锚价=official_pricing,主口径组 default→中位
 *   B 扁平价表(fluxionai):行级直摆价格字段,组价=基础价×组倍率,多渠道去重
 *   按次计价/非 token 计价跳过;0 有效模型必抛错(宁缺毋错);端点 404 回退第二个路径
 * 全部用 fixture + stub fetch,不打网络。
 */
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const ROOT = __dirname + "";
const PROBE = path.join(ROOT, "relaylens/probe");

const script = `
import { parseModelPlaza } from "./src/parsers/modelplaza.ts";

const site = { name: "t", base_url: "https://t.example", enabled: true, tags: [] };
let bad = 0;
const check = (n, c, d) => { if (!c) { bad++; console.log("MISMATCH", n, d || ""); } };

/** stub fetch:fixture 值为 false 表示该路径 404,否则 200 + 该 JSON */
function stub(map) {
  globalThis.fetch = async (url) => {
    const p = String(url).replace("https://t.example", "");
    const hit = map[p];
    if (hit === undefined || hit === false) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => hit };
  };
}

/* ---- A 型:组内嵌,跨倍率组同价(展示价即最终价) ---- */
stub({
  "/api/v1/model-plaza": { code: 0, data: { groups: [
    { id: 1, name: "VIP", rate_multiplier: 0.2, models: [
      { name: "m1", pricing: { billing_mode: "token", input_price: 0.000002, output_price: 0.000012, cache_read_price: 0.0000002 }, official_pricing: { input_price: 0.0000002, output_price: 0.0000012, cache_read_price: 0.00000002 } },
      { name: "m2", pricing: { billing_mode: "token", input_price: 0.00001, output_price: 0.00005, per_request_price: 0.5 } },
      { name: "m3", pricing: { billing_mode: "times", input_price: 0.00001, output_price: 0.00005 } },
    ] },
    { id: 2, name: "default", rate_multiplier: 1, models: [
      { name: "m1", pricing: { billing_mode: "token", input_price: 0.000002, output_price: 0.000012, cache_read_price: 0.0000002 }, official_pricing: { input_price: 0.0000002, output_price: 0.0000012, cache_read_price: 0.00000002 } },
    ] },
  ] } },
});
{
  const r = await parseModelPlaza(site);
  check("A: currency USD", r.currency === "USD");
  check("A: m2/m3 被跳过(按次/非token)", r.models.length === 1 && r.models[0].model === "m1", JSON.stringify(r.models.map(m => m.model)));
  check("A: 展示价即最终价(不乘 0.2 倍率)", r.models[0].input === 2 && r.models[0].output === 12, JSON.stringify(r.models[0]));
  check("A: 主口径=default 组", r.models[0].group === "default" && r.models[0].groupKind === "default");
  check("A: 锚价=official_pricing", r.models[0].base.input === 0.2 && r.models[0].base.output === 1.2);
  check("A: 全分组下发(倍率=隐含加价 展示价÷锚价=10)", r.models[0].groups.length === 2 && r.models[0].groups.some(g => g.group === "VIP" && g.ratio === 10) && r.models[0].grpRatio === 10);
  check("A: cacheRead 换算", r.models[0].cacheRead === 0.2);
  check("A: 三因子可验算(锚价×隐含倍率=展示价)", Math.abs(r.models[0].base.input * r.models[0].grpRatio - r.models[0].input) <= 0.011, r.models[0].base.input + "x" + r.models[0].grpRatio + " vs " + r.models[0].input);
}

/* ---- A 型无 default 组 → 中位倍率组 ---- */
stub({
  "/api/v1/model-plaza": { code: 0, data: { groups: [
    { id: 1, name: "g-cheap", rate_multiplier: 0.1, models: [{ name: "m1", pricing: { billing_mode: "token", input_price: 0.000002, output_price: 0.000012 } }] },
    { id: 2, name: "g-mid", rate_multiplier: 1, models: [{ name: "m1", pricing: { billing_mode: "token", input_price: 0.000002, output_price: 0.000012 } }] },
    { id: 3, name: "g-high", rate_multiplier: 3, models: [{ name: "m1", pricing: { billing_mode: "token", input_price: 0.000002, output_price: 0.000012 } }] },
  ] } },
});
{
  const r = await parseModelPlaza(site);
  check("A: 无 default 取中位组", r.models[0].group === "g-mid" && r.models[0].groupKind === "median" && r.models[0].grpRatio === 1);
}

/* ---- B 型:扁平行级直摆 + group_ids ---- */
stub({
  "/api/v1/model-plaza": false,
  "/api/v1/model-plaza/public": { code: 0, data: {
    groups: [
      { id: 39, name: "g-a", rate_multiplier: 0.4 },
      { id: 40, name: "g-b", rate_multiplier: 1 },
      { id: 41, name: "g-c", rate_multiplier: 2.5, models: [] },
    ],
    pricing: [
      { name: "claude-x", billing_mode: "token", input_price: 0.00001, output_price: 0.00005, cache_read_price: 0.000001, group_ids: [39, 40, 41], channel_id: 0 },
      { name: "claude-x", billing_mode: "token", input_price: 0.00001, output_price: 0.00005, group_ids: [39], channel_id: 7 },
      { name: "img-1", billing_mode: "token", input_price: 0.00001, output_price: 0.00005, per_request_price: 0.1, group_ids: [39] },
      { name: "no-group", billing_mode: "token", input_price: 0.00001, output_price: 0.00005, group_ids: [] },
    ],
  } },
});
{
  const r = await parseModelPlaza(site);
  check("B: 多渠道去重 + 按次/无分组跳过", r.models.length === 1 && r.models[0].model === "claude-x", JSON.stringify(r.models.map(m => m.model)));
  check("B: 主口径=中位倍率组 g-b(1)", r.models[0].group === "g-b" && r.models[0].grpRatio === 1 && r.models[0].input === 10 && r.models[0].output === 50);
  check("B: base=行级基础价", r.models[0].base.input === 10 && r.models[0].base.cacheRead === 1);
  check("B: 分组价=基础×倍率", JSON.stringify(r.models[0].groups.find(g => g.group === "g-c")) === JSON.stringify({ group: "g-c", ratio: 2.5, input: 25, output: 125, cacheRead: 2.5 }));
  check("B: 第一个端点 404 回退第二个", true);
  check("B: parseErrors 记录了跳过原因", r.parseErrors.some(e => /按次计价/.test(e)) && r.parseErrors.some(e => /无可用分组/.test(e)), r.parseErrors.join("|"));
  check("B: 三因子可验算(基础价×组倍率=额度价)", Math.abs(r.models[0].base.input * r.models[0].grpRatio - r.models[0].input) <= 0.011, r.models[0].base.input + "x" + r.models[0].grpRatio + " vs " + r.models[0].input);
}

/* ---- 空载荷必抛错 ---- */
stub({ "/api/v1/model-plaza": { code: 0, data: { groups: [{ id: 1, name: "g", rate_multiplier: 1, models: [] }] } } });
{
  let threw = false;
  try { await parseModelPlaza(site); } catch { threw = true; }
  check("空载荷抛错(宁缺毋错)", threw);
}

console.log(bad === 0 ? "MODELPLAZA_OK" : "MODELPLAZA_FAIL " + bad);
process.exit(bad === 0 ? 0 : 1);
`;

const tmp = path.join(PROBE, "tmp-modelplaza-check.mts");
fs.writeFileSync(tmp, script);
const r = spawnSync("npx", ["tsx", "tmp-modelplaza-check.mts"], { cwd: PROBE, encoding: "utf8", timeout: 120000, shell: true });
fs.unlinkSync(tmp);

let pass = 0, fail = 0;
const check = (n, c, d) => { (c ? pass++ : fail++); console.log(`${c ? "✓" : "✗"} ${n}${d ? " · " + d : ""}`); };

check("modelplaza 解析器行为级(A/B 形态+口径)", r.status === 0 && /MODELPLAZA_OK/.test(r.stdout || ""), (r.stdout || "").trim().split("\n").slice(-3).join(" / ") + (r.stderr ? " | stderr: " + r.stderr.trim().split("\n").slice(-2).join(" / ") : ""));

/* 源码契约:三种语义证据必须写在注释里(防后人误改) */
const src = fs.readFileSync(path.join(PROBE, "src/parsers/modelplaza.ts"), "utf8");
check("A 型不再乘组倍率(注释留证据)", /展示价 = 该组最终价/.test(src));
check("B 型组价=基础价×组倍率", /组价 = 基础价 × 组倍率/.test(src));
check("形态识别按非空内嵌 models(防 fluxionai 误判)", /groups\.some\(g => Array\.isArray\(g\.models\)/.test(src));
check("注册表已含 modelplaza", /modelplaza: parseModelPlaza/.test(fs.readFileSync(path.join(PROBE, "src/parsers/index.ts"), "utf8")));
check("三站已切 modelplaza 解析器", (() => {
  const y = fs.readFileSync(path.join(PROBE, "config/sites.yaml"), "utf8");
  return ["RL_UUAPI_IO_API_KEY", "RL_HAHACODE_COM_API_KEY", "RL_FLUXIONAI_SPACE_API_KEY"].every(k =>
    new RegExp(`parser: "modelplaza"\\s*\\n\\s*key_env: "${k}"`).test(y));
})());

console.log(`\n${fail === 0 ? "全部通过" : "有失败项"} (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
