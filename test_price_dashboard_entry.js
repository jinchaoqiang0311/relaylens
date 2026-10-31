/* 比价入口迁移守卫(2026-10-28,当晚二改:废除占位符与预览垫片)。
   背景:price.html(模型比价)与 compare.html(比价矩阵)已彻底删除,比价功能由独立看板承担,
   统一挂在规范路径 /price/(本地 preview-server.js、生产 nginx 均反代到 127.0.0.1:8899)。
   曾用 __PRICE_DASHBOARD__ 占位符 + 预览垫片目录,但点击要经过一次中间跳转,地址栏会闪出怪路径,
   故二改为源码直写 /price/。本套件保证:
   ① 旧页面/垫片/占位符都不存在;
   ② 全站比价入口统一 href="/price/",同窗口直达无跳转;
   ③ NAV 与构建逻辑同步。 */
const fs = require("fs");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL " + m); } };
const DIR = __dirname + "/relaylens-home/";

/* —— 旧页面与中间跳转机制必须已消失 —— */
ok(!fs.existsSync(DIR + "price.html"), "price.html 已删除");
ok(!fs.existsSync(DIR + "compare.html"), "compare.html 已删除");
ok(!fs.existsSync(DIR + "assets/compare-matrix.js"), "compare-matrix.js 已删(唯一使用方 compare.html 已下线)");
ok(!fs.existsSync(DIR + "__PRICE_DASHBOARD__"), "预览垫片目录已删(点击直达 /price/,不再闪中间页)");
ok(!fs.readFileSync(__dirname + "/build-relay.js", "utf8").includes("__PRICE_DASHBOARD__"),
  "构建脚本无占位符残留(填充机制已废除)");

/* —— 配置:看板地址备注仍在(供部署 nginx 对照,构建不消费) —— */
const cfg = JSON.parse(fs.readFileSync(__dirname + "/site.config.json", "utf8"));
ok(typeof cfg.priceDashboard === "string" && /^https?:\/\//.test(cfg.priceDashboard),
  "site.config.json 保留 priceDashboard 备注(看板实际地址)");
ok(!/compare\.html/.test(JSON.stringify(cfg.changefreq || {})), "changefreq 里没有已下线的 compare.html");

/* —— 全站入口:统一 href="/price/",同窗口直达 —— */
const pages = fs.readdirSync(DIR).filter(f => f.endsWith(".html"));
let stale = 0, withPrice = 0;
for (const f of pages) {
  const h = fs.readFileSync(DIR + f, "utf8");
  if (/href="(?:price|compare)\.html/.test(h)) { stale++; console.log("FAIL " + f + " 仍有旧页链接"); }
  if (/__PRICE_DASHBOARD__/.test(h)) { stale++; console.log("FAIL " + f + " 仍有占位符"); }
  if (/href="\/price\//.test(h)) withPrice++;
}
ok(stale === 0, "无旧页链接/占位符残留(异常 " + stale + " 处)");
ok(withPrice >= pages.length - 2, "几乎每页都有 /price/ 入口(仅 404/auth 可豁免,实际 " + withPrice + "/" + pages.length + ")");
/* 坑位页深链 */
const pf = fs.readFileSync(DIR + "pitfalls.html", "utf8");
ok(pf.includes('href="/price/#cmp:gpt-5.6-sol"'), "pitfalls 深链直达看板 /price/#cmp:gpt-5.6-sol");

/* —— 构建侧 —— */
const build = fs.readFileSync(__dirname + "/build-relay.js", "utf8");
ok(/\["\/price\/","模型比价"\]/.test(build), "NAV 里有 /price/ 比价项");
ok(!/target="_blank"/.test((build.match(/const nav = '<nav[^;]+;/) || [""])[0]),
  "导航注入不再带新窗口(同源挂载,与其它导航项行为一致)");

console.log("price_dashboard_entry: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
