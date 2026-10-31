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
ok(NAV.length === 8, "导航 8 项(2026-10-28 起「模型比价」「比价矩阵」合并为一项外链看板,原 price/compare 两页变重定向壳;改项数前先确认没有页面被孤立)");
ok(NAV.length === new Set(NAV.map(x => x[0])).size, "NAV 无重复项");

/* —— 逐项校验:站内项目标文件必须存在,否则注入的是死链;比价挂载路径 /price/ 跳过 —— */
for (const [href, label] of NAV) {
  if (href === "/price/") {
    ok(true, "NAV 项 模型比价 = 看板挂载路径 /price/(preview-server 与生产 nginx 反代到 8899)");
    continue;
  }
  ok(fs.existsSync(SRC + "/" + href), "NAV 项 " + href + "(" + label + ")对应源文件存在");
}

/* —— 复刻构建期注入(含当前页 active/aria-current),得到与构建产物一致的导航 —— */
const navFor = (file) => '<nav class="nav-links" aria-label="主导航">' + NAV.map(([h, l]) => '<a href="' + h + '"' + (h === file ? ' class="active" aria-current="page"' : '') + '>' + l + '</a>').join("") + '</nav>';

/* 构建脚本的排除项:内部看板不进对外包 */
const INTERNAL = ["ops.html"];
const pages = fs.readdirSync(SRC).filter(f => f.endsWith(".html") && !INTERNAL.includes(f));
ok(pages.length >= 14, "进包页面数合理(" + pages.length + ",2026-10-28 起 price/compare 已删,比价走外链看板)");

const injected = {};
for (const file of pages) {
  const html = fs.readFileSync(SRC + "/" + file, "utf8");
  injected[file] = html.replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/, navFor(file));
}

/* —— 有意孤立的页面:noindex 页 + 靠 JS 跳转的详情页 ——
   404/auth 是 noindex 兜底页,本就不该被链;detail.html 由 location.href 带参数跳转
   (ranking/compare 的行点击),静态入链统计看不到它,故单独豁免。
   price/compare 两页已于 2026-10-28 彻底删除(比价走外链看板,老链接落 404)。 */
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
   把它们钉死在这里:哪天某页的 nav 被误删,这项会红,而不是悄悄变成"注入空操作"。
   (price/compare 已删除,不再在此列。) */
const NO_NAV_OK = new Set(["404.html", "auth.html"]);
let noNav = pages.filter(f => !/<nav\b/.test(fs.readFileSync(SRC + "/" + f, "utf8")));
ok(noNav.length === NO_NAV_OK.size && noNav.every(f => NO_NAV_OK.has(f)),
   "无顶部导航的页面 = 既定集合(" + (noNav.join(", ") || "无") + ")");

for (const f of pages) {
  if (NO_NAV_OK.has(f)) continue;
  const nav = injected[f].match(/<nav class="nav-links" aria-label="主导航">[\s\S]*?<\/nav>/);
  ok(!!nav, f + " 的 <nav> 被成功替换");
  if (!nav) continue;
  const hrefs = [...nav[0].matchAll(/href="([^"]+)"/g)].map(m => m[1]);
  ok(hrefs.length === NAV.length, f + " 导航项数 = " + NAV.length + "(实际 " + hrefs.length + ")");
  ok(nav[0].includes('aria-label="主导航"'), f + " 导航带 aria-label(读屏可识别为主导航)");
  if (navHrefs.has(f)) {
    ok(nav[0].includes('<a href="' + f + '" class="active" aria-current="page">'), f + " 当前页高亮 + aria-current(注入逻辑按 file 名打 active)");
  }
}

/* —— 源码各页的 <nav> 必须与注入串同形:本地预览指向源码目录(relaylens-home/),
   源码里手写旧导航(曾 5~11 项不等)会让人看到"有的页层级跟别的不一样"。
   断言源码串 == 注入串,保证源码与产物是同一套导航。
   注:构建在此之后还会往 </nav> 前追加「返回主站」(与主站互链),那是构建行为,源码不该有。 —— */
for (const f of pages) {
  if (NO_NAV_OK.has(f)) continue;
  const src = fs.readFileSync(SRC + "/" + f, "utf8");
  const nav = src.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/);
  ok(!!nav, f + " 源码含 <nav>");
  if (!nav) continue;
  ok(nav[0] === navFor(f), f + " 源码导航与构建注入串逐字一致(源码=产物,本地预览不跑偏)");
}

/* —— 二级导航不得被误伤:method.html 的目录 <nav class="toc"> 要活下来 —— */
const method = injected["method.html"];
ok(method.includes('<nav class="toc">'), "method.html 页内目录 nav.toc 未被注入覆盖(只替第一个 nav)");
ok(method.indexOf('class="nav-links"') < method.indexOf('class="toc"'), "顶部导航在前、目录在后");

console.log("nav_integrity: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
