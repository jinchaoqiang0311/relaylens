/**
 * check-dashboard-contract.cjs —— 看板挂载与口径契约校验(2026-11-02 统一调度收口)
 * 依据: docs/dashboard-contract.md(两仓库共用的唯一契约项)
 * 用法:
 *   node scripts/check-dashboard-contract.cjs                        # CI: 只校验主站侧(relaylens)
 *   node scripts/check-dashboard-contract.cjs --dashboard <看板仓库路径>  # 本地: 连看板侧(renlay-ranking)一起校验
 * 防漂移核心: 倍率口径(组价=基础价×声明倍率 rate_multiplier)两侧必须同源,
 *   防止再出现「探针 modelplaza 没读全局倍率表,与看板对不上」一类问题(UUAPI 事件 2026-11-02)。
 */
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };
const read = p => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };

console.log("【契约文档 docs/dashboard-contract.md】");
const doc = read(path.join(ROOT, "docs", "dashboard-contract.md"));
ok(doc.length > 0, "契约文档存在");
ok(/healthz/.test(doc), "契约含 /healthz 探活路由");
ok(/\/api\/compare/.test(doc) && /\/api\/stations/.test(doc) && /\/api\/summary/.test(doc),
   "契约含 compare / stations / summary 数据接口");
ok(/\/price\//.test(doc), "契约含 /price/ 统一挂载点");
ok(/RL_DASH_TOKEN/.test(doc), "契约含可选令牌门约定");

console.log("【主站侧 relaylens】");
const common = read(path.join(ROOT, "relaylens-home", "assets", "rl-common.js"));
ok(/dashProbe/.test(common) && /\/price\//.test(common), "rl-common.js 探活/取数走 /price/ 反代(契约挂载)");
ok(/data\/dashboard-snapshot\.json/.test(common), "dashApi 有静态快照兜底(看板线上化)");
ok(!common.includes('"/data/dashboard-snapshot'), "快照 fetch 用相对路径(防 base=/relay 下打到主站根)");
ok(/fillPhStats|dashApi/.test(common), "看板数据经 dashApi 驱动页面(数据驱动,不写死)");

const home = read(path.join(ROOT, "relaylens-home", "index.html"));
ok(/href="\/price\/"/.test(home), "首页挂载点 href=/price/ 与契约一致");

const build = read(path.join(ROOT, "build-relay.js"));
ok(/api\/compare/.test(build) && /api\/stations/.test(build) && /api\/summary/.test(build),
   "构建期快照抓取契约三接口(compare/stations/summary)");

console.log("【倍率口径(防漂移核心)】");
const mp = read(path.join(ROOT, "relaylens", "probe", "src", "parsers", "modelplaza.ts"));
ok(/rate_multiplier/.test(mp), "探针 modelplaza 读取声明倍率 rate_multiplier(组价=基础价×倍率)");
ok(/倍率/.test(mp), "modelplaza 保留倍率口径说明(可追溯)");

const dashIdx = process.argv.indexOf("--dashboard");
if (dashIdx > -1 && process.argv[dashIdx + 1]) {
  const dashDir = process.argv[dashIdx + 1];
  console.log("【看板侧 renlay-ranking】(" + dashDir + ")");
  const py = read(path.join(dashDir, "relay_scraper.py"));
  ok(py.length > 0, "relay_scraper.py 存在");
  ok(/healthz/.test(py), "看板实现 /healthz 探活(契约要求)");
  ok(/rate_multiplier/.test(py), "看板解析同样读 rate_multiplier(两侧口径同源)");
  ok(/model_plaza|parse_model_plaza/.test(py), "看板含 plaza 解析入口");
  ok(/add_parser\("scrape"/.test(py), "看板提供 scrape 抓取命令(统一调度的联动目标)");
}

console.log(`\nhonesty contract: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
