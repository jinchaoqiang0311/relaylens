/* 全站导航完整性(孤立页守卫)。
   背景:2026-10-23 导航改为构建期集中注入后,NAV 常量成了全站唯一的跨页入链来源。
        当时 NAV 漏了 选型顾问/避坑指南,而这两页正文也没有任何别处链到 —— 构建产物里
        pitfalls.html / selector.html 直接 0 入链:用户点不进去,爬虫也爬不到。
   本套件把注入后的真实入链关系重建一遍,断言没有"非设计孤立页"。
   ⚠ 这里会复刻 build-relay.js 的注入正则;正则若被改动,下面的 drift 断言会先红,不会假绿。 */
const fs = require("fs");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.log("FAIL " + m); } }

const SRC = __dirname + "/relaylens-home";
const build = fs.readFileSync(__dirname + "/build-relay.js", "utf8");

/* —— 从构建脚本里取出 NAV 与注入正则(不复写业务数据,避免两份清单漂移)—— */
const navMatch = build.match(/const NAV = (\[\[[\s\S]*?\]\])/);
ok(!!navMatch, "build-relay.js 里能找到 NAV 常量(清单被改名/换写法了,先改本测试)");
let NAV = [];
if (navMatch) { try { NAV = eval(navMatch[1]); } catch (e) { ok(false, "NAV 解析失败: " + e.message); } }

const injLine = 'html = html.replace(/<nav\\b[^>]*>[\\s\\S]*?<\\/nav>/, nav);';
ok(build.includes(injLine), "注入正则未变(改了注入方式请同步本测试的重建逻辑)");

ok(Array.isArray(NAV) && NAV.length > 0, "NAV 非空");
ok(NAV.length === 9, "导航 9 项(全站榜单/比价矩阵/选型顾问/避坑指南 等都在,改项数前先确认没有页面被孤立)");
ok(NAV.length === new Set(NAV.map(x => x[0])).size, "NAV 无重复项");

/* —— 逐项校验:目标文件必须存在,否则注入的是死链 —— */
for (const [href, label] of NAV) {
  ok(fs.existsSync(SRC + "/" + href), "NAV 项 " + href + "(" + label + ")对应源文件存在");
}

/* —— 复刻构建期注入(含当前页 active),得到与构建产物一致的导航 —— */
const navFor = (file) => '<nav class="nav-links">' + NAV.map(([h, l]) => '<a href="' + h + '"' + (h === file ? ' class="active"' : '') + '>' + l + '</a>').join("") + '</nav>';

/* 构建脚本的排除项:内部看板不进对外包 */
const INTERNAL = ["ops.html"];
const pages = fs.readdirSync(SRC).filter(f => f.endsWith(".html") && !INTERNAL.includes(f));
ok(pages.length >= 16, "进包页面数合理(" + pages.length + ")");

const injected = {};
for (const file of pages) {
  const html = fs.readFileSync(SRC + "/" + file, "utf8");
  injected[file] = html.replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/, navFor(file));
}

/* —— 有意孤立的页面:noindex 页 + 靠 JS 跳转的详情页 ——
   404/auth 是 noindex 兜底页,本就不该被链;detail.html 由 location.href 带参数跳转
   (ranking/compare 的行点击),静态入链统计看不到它,故单独豁免。 */
const ORPHAN_OK = new Set(["404.html", "auth.html", "detail.html"]);

const inbound = {};
for (const f of pages) {
  const links = new Set(
    [...injected[f].matchAll(/href="([^"#?]+\.html)/g)].map(m => m[1])
  );
  for (const l of links) {
    if (l === f || !pages.includes(l)) continue;
    (inbound[l] = inbound[l] || []).push(f);
  }
}

/* —— 核心断言:除豁免外,每页至少有一个别处的入口 —— */
let orphans = [];
for (const f of pages) {
  if (ORPHAN_OK.has(f)) continue;
  if (!inbound[f] || inbound[f].length === 0) orphans.push(f);
}
ok(orphans.length === 0, "无孤立页(0 入链: " + (orphans.join(", ") || "无") + ") —— 把页面移出 NAV 前,先确认正文里有别的页链到它");
for (const f of pages) {
  if (ORPHAN_OK.has(f)) continue;
  ok((inbound[f] || []).length > 0, f + " 可从其它页到达");
}

/* —— 每页导航项数一致,且(若本页在 NAV 里)当前页带 active —— */
const navHrefs = new Set(NAV.map(x => x[0]));
/* 无顶部导航的页面是既定设计(404/auth 是 noindex 兜底页,不挂导航)。
   把它们钉死在这里:哪天某页的 nav 被误删,这项会红,而不是悄悄变成"注入空操作"。 */
const NO_NAV_OK = new Set(["404.html", "auth.html"]);
let noNav = pages.filter(f => !/<nav\b/.test(fs.readFileSync(SRC + "/" + f, "utf8")));
ok(noNav.length === NO_NAV_OK.size && noNav.every(f => NO_NAV_OK.has(f)),
   "无顶部导航的页面 = 既定集合(" + (noNav.join(", ") || "无") + ")");

for (const f of pages) {
  if (NO_NAV_OK.has(f)) continue;
  const nav = injected[f].match(/<nav class="nav-links">[\s\S]*?<\/nav>/);
  ok(!!nav, f + " 的 <nav> 被成功替换");
  if (!nav) continue;
  const hrefs = [...nav[0].matchAll(/href="([^"]+)"/g)].map(m => m[1]);
  ok(hrefs.length === NAV.length, f + " 导航项数 = " + NAV.length + "(实际 " + hrefs.length + ")");
  if (navHrefs.has(f)) {
    ok(nav[0].includes('<a href="' + f + '" class="active">'), f + " 当前页高亮(注入逻辑按 file 名打 active)");
  }
}

/* —— 二级导航不得被误伤:method.html 的目录 <nav class="toc"> 要活下来 —— */
const method = injected["method.html"];
ok(method.includes('<nav class="toc">'), "method.html 页内目录 nav.toc 未被注入覆盖(只替第一个 nav)");
ok(method.indexOf('class="nav-links"') < method.indexOf('class="toc"'), "顶部导航在前、目录在后");

console.log("nav_integrity: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
