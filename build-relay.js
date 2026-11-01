/**
 * build-relay.js —— WordPress /relay/ 子目录部署构建器
 * 用法: node build-relay.js
 * 输入: relaylens-home/(源) + site.config.json(域名/备案/统计配置)
 * 输出: dist-relay/(可直接上传的静态包)
 *   ① 每页注入 <link rel="canonical">(指向 base/文件名,SEO 规范)
 *   ② 顶部导航追加「返回主站」链接(与主站互链,权重回流)
 *   ③ 页脚注入 ICP 备案号 + 公安备案(合规必须)
 *   ④ </body> 前注入统计代码(百度统计/GA/Umami 等)
 *   ⑤ 生成 sitemap.xml + robots-snippet.txt(供合并进主站 robots.txt)
 *   ⑥ 生成 DEPLOY.md(WordPress 集成说明)
 */
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const SRC = path.join(ROOT, "relaylens-home");
const OUT = path.join(ROOT, "dist-relay");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "site.config.json"), "utf8"));
const base0 = () => cfg.base.replace(/\/+$/, "");

// 评论/账号服务地址(可选):未配置时页面保持「服务尚未上线」诚实占位。
// 部署 api-worker 后在 site.config.json 填 apiBase(worker 的 https URL),重建即全站启用。
const apiBase = cfg.apiBase ? String(cfg.apiBase).trim() : "";
if (apiBase && !/^https?:\/\/[^\s<>"']+$/.test(apiBase)) {
  throw new Error("site.config.json 的 apiBase 必须是 http(s) 绝对 URL。");
}

// 模型比价看板(2026-10-28 起 price/compare 两页下线,比价功能由独立看板 relay_scraper serve 承担)。
// 挂载契约:看板统一挂在 **/price/** —— 本地 preview-server.js 与生产 nginx 都把 /price/ 反代到 8899,
// 因此源码里比价入口直接写 href="/price/"(与其它导航项同窗口、无中间跳转),构建期不做任何替换。
// site.config.json 的 priceDashboard 仅作文档备注(看板实际地址),构建不消费;
// 若将来换挂载路径,全局搜 "/price/" 同步改源码。
// site.config.json 的 priceDashboard 备注仍保留,供部署 nginx 时对照。

// 内部只读资产:运营看板与其数据不进对外包(即便 noindex,URL 可猜、内容含未公开结论)
// 需要内部看板时,单独把 relaylens-home/ops.html + data/ops.json 传到后台目录或加 HTTP Basic Auth。
const INTERNAL = ["ops.html", "data/ops.json"];
// 404:进包(供 nginx error_page 指向),但 noindex、不进 sitemap、不注入 canonical/og
// (2026-10-28 晚:price/compare 两页已彻底删除——重定向壳也不要了,老链接落 404 页;
//  站内有nginx的话建议在 DEPLOY 里对这两个路径配 301 → /price/,保住老外链权重)
const NOINDEX_PAGES = ["404.html", "auth.html"];

const pages = fs.readdirSync(SRC).filter(f => f.endsWith(".html") && !INTERNAL.includes(f));
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let changed = [];
for (const file of pages) {
  let html = fs.readFileSync(path.join(SRC, file), "utf8");
  const url = cfg.base.replace(/\/+$/, "") + "/" + (file === cfg.defaultPage ? "" : file);

  // ①'' 统一顶部导航(构建期集中注入,避免各页手写导航不一致 —— 曾出现 price/pitfalls/404 项偏少、切页按钮移位)。
  // 每次都从源文件重注,幂等;**含首页**(此前豁免 index 导致首页用自带 .nav、几何与注入的 .nav-links 不同,切页即移位)。
  // 要改全站导航只改这里即可;样式统一由 assets/theme-relayindex.css 的 .nav-links 提供。
  //
  // ⚠ NAV = 全站唯一的跨页入链来源:不在清单里的页面,除非正文有别处链到,否则构建后就是孤立页
  //   (爬不到、用户也进不去)。test_nav_integrity.js 对构建产物做全站入链分析,少一项就红 —— 改这里前先看它。
  //   2026-10-23 曾漏掉 选型顾问/避坑指南,两页直接 0 入链,已加回。
  //
  // 2026-10-28 导航加无障碍语义:aria-label 标主导航、当前页补 aria-current="page"
  //   (原先只有 class="active" 的颜色区分,读屏用户听不出自己在哪一页);
  //   源码各页的 <nav> 已同步成同一串(本地预览指的就是源码目录,否则源码与产物两套导航)。
  //
  // 2026-10-28 「模型比价」「比价矩阵」合并为一项「模型比价」,指向独立看板的规范挂载路径 /price/
  //   (本地 preview-server 与生产 nginx 均反代到 8899,同源同窗口,无中间跳转)。
  //   "/price/" 不对应站内文件 → h===file 永不成立 → 自然无 active,无需特判。
  {
    const NAV = [["index.html","选站比价"],["ranking.html","全站榜单"],["/price/","模型比价"],["selector.html","选型顾问"],["blacklist.html","避雷黑名单"],["pitfalls.html","避坑指南"],["method.html","方法论"],["tools.html","自测工具箱"]];
    const nav = '<nav class="nav-links" aria-label="主导航">' + NAV.map(([h,l]) => '<a href="'+h+'"'+(h===file?' class="active" aria-current="page"':'')+'>'+l+'</a>').join("") + '</nav>';
    html = html.replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/, nav);
  }

  // ① canonical(幂等:先清旧的再注入;404 是 noindex 页,不需要 canonical)
  html = html.replace(/\s*<link rel="canonical"[^>]*>/g, "");
  if (!NOINDEX_PAGES.includes(file)) {
    html = html.replace("</title>", `</title>\n<link rel="canonical" href="${url}">`);
  }

  // ①' Open Graph / Twitter 卡片(幂等;标题与描述从页面自身提取,不另维护一份)
  html = html.replace(/\s*<meta property="og:[^>]*>/g, "").replace(/\s*<meta name="twitter:[^>]*>/g, "");
  if (!NOINDEX_PAGES.includes(file)) {
    const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || "RelayLens";
    const desc = (html.match(/<meta name="description" content="([^"]*)">/) || [])[1] || "AI 中转站账单级实测";
    const og = `
<meta property="og:type" content="website">
<meta property="og:site_name" content="RelayLens">
<meta property="og:title" content="${title.replace(/"/g, "&quot;")}">
<meta property="og:description" content="${desc.replace(/"/g, "&quot;")}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${base0()}/assets/og-default.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">`;
    html = html.replace("</head>", og + "\n</head>");
  }

  // ② 返回主站链接(幂等)
  html = html.replace(/<a href="[^"]*" class="back-main"[^>]*>[\s\S]*?<\/a>/g, "");
  if (cfg.mainSite && !/YOUR-DOMAIN/.test(cfg.mainSite)) {
    html = html.replace("</nav>", `  <a href="${cfg.mainSite}" class="back-main">${cfg.mainSiteName || "返回主站"}</a>\n    </nav>`);
  }

  // ③ 备案信息(幂等)
  html = html.replace(/<div class="icp-line">[\s\S]*?<\/div>/g, "");
  if (cfg.icp || cfg.policeIcp) {
    const parts = [];
    if (cfg.icp) parts.push(`<a href="${cfg.icpLink}" target="_blank" rel="nofollow noopener">${cfg.icp}</a>`);
    if (cfg.policeIcp) parts.push(cfg.policeIcp);
    html = html.replace("</footer>", `  <div class="icp-line" style="text-align:center;padding-top:12px;font-size:12px;color:#5d6f92">${parts.join(" · ")}</div>\n</footer>`);
  }

  // ④ 统计代码
  html = html.replace(/<!-- analytics -->[\s\S]*?<!-- \/analytics -->/g, "");
  if (cfg.analyticsHtml && cfg.analyticsHtml.trim()) {
    html = html.replace("</body>", `<!-- analytics -->\n${cfg.analyticsHtml}\n<!-- /analytics -->\n</body>`);
  }

  // ④'' 评论/账号服务地址注入:直接替换源码里的 var RL_API_BASE="" 占位
  // (auth.js 资产与 api.html 内联各一份,资产那份在下方资源拷贝后统一补丁),与脚本顺序无关。
  if (apiBase) {
    html = html.replace(/var RL_API_BASE\s*=\s*""\s*;/, `var RL_API_BASE=${JSON.stringify(apiBase)};`);
  }

  // ④' WordPress 表单桥接(可选,幂等;未配置 wpBridge.formEndpoint 时完全不注入)
  // 作用:入驻/认领页的 schema JSON 表单从「邮件降级」切换为 POST 到 WP REST,
  // 进入 WP 后台申请/认领审核流。页面源码无需任何改动。
  html = html.replace(/\n?<!-- wp-bridge -->[\s\S]*?<!-- \/wp-bridge -->\n?/g, "");
  if (cfg.wpBridge && cfg.wpBridge.formEndpoint) {
    const ep = String(cfg.wpBridge.formEndpoint).trim();
    // 构建期白名单:只允许相对路径或 http(s) 绝对 URL,杜绝 </script> 注入。
    if (!/^(\/|https?:\/\/)[^\s<>"']+$/.test(ep)) {
      throw new Error("site.config.json 的 wpBridge.formEndpoint 必须是相对路径(/开头)或 http(s) 绝对 URL。");
    }
    html = html.replace(
      "</body>",
      `<!-- wp-bridge -->\n<script>window.RELAYLENS_FORM_ENDPOINT=${JSON.stringify(ep)};</script>\n<!-- /wp-bridge -->\n</body>`,
    );
  }

  fs.writeFileSync(path.join(OUT, file), html);
  changed.push(file);
}

// ⑤ 数据与图标资源目录(排除内部看板数据;assets 为图标/OG 图,全公开)
if (fs.existsSync(path.join(SRC, "data"))) {
  fs.cpSync(path.join(SRC, "data"), path.join(OUT, "data"), {
    recursive: true, filter: src => !INTERNAL.includes("data/" + path.basename(src)),
  });
}
if (fs.existsSync(path.join(SRC, "assets"))) {
  /* 手动递归拷贝:fs.cpSync 对本机 assets/fonts 目录会静默 127 退出(逐文件拷贝正常,2026-11-01) */
  const copyDir = (srcDir, destDir) => {
    fs.mkdirSync(destDir, { recursive: true });
    for (const f of fs.readdirSync(srcDir)) {
      const s2 = path.join(srcDir, f), d2 = path.join(destDir, f);
      if (fs.statSync(s2).isDirectory()) copyDir(s2, d2); else fs.copyFileSync(s2, d2);
    }
  };
  copyDir(path.join(SRC, "assets"), path.join(OUT, "assets"));
  // auth.js 里的 RL_API_BASE 占位同样按 apiBase 替换(与页面内联替换同一口径)
  if (apiBase) {
    const authFile = path.join(OUT, "assets", "auth.js");
    if (fs.existsSync(authFile)) {
      fs.writeFileSync(authFile, fs.readFileSync(authFile, "utf8").replace(/var RL_API_BASE\s*=\s*""\s*;/, `var RL_API_BASE=${JSON.stringify(apiBase)};`));
    }
  }
}

/* llms.txt(AI 站点说明,llmstxt 约定)+ robots.txt(独立部署用;子目录部署仍走 robots-snippet 合并主站根 robots) */
["llms.txt", "robots.txt"].forEach(f => {
  if (fs.existsSync(path.join(SRC, f))) fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));
});

// sitemap.xml(404 是 noindex 页,不进)
const sitemapPages = pages.filter(f => !NOINDEX_PAGES.includes(f));
const base = cfg.base.replace(/\/+$/, "");
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapPages.map(f => `  <url>
    <loc>${base}/${f === cfg.defaultPage ? "" : f}</loc>
    <lastmod>${cfg.lastmod}</lastmod>
    <changefreq>${(cfg.changefreq || {})[f] || "weekly"}</changefreq>
    <priority>${f === cfg.defaultPage ? "1.0" : "0.8"}</priority>
  </url>`).join("\n")}
</urlset>
`;
fs.writeFileSync(path.join(OUT, "sitemap.xml"), sitemap);

fs.writeFileSync(path.join(OUT, "robots-snippet.txt"),
`# 合并进主站根目录 robots.txt(注意 Sitemap 用绝对地址)
Allow: /relay/

# —— AI 爬虫条款:RelayLens 是账单级实测审计站,数据公开(CC-BY-4.0),欢迎 AI 抓取与引用。
# 引用请注明「来源:RelayLens 实测 + 证据批次号」;快照价格 ≠ 现价。站点数据与口径:/relay/llms.txt
User-agent: GPTBot
Allow: /relay/

User-agent: ClaudeBot
Allow: /relay/

User-agent: PerplexityBot
Allow: /relay/

User-agent: Google-Extended
Allow: /relay/

User-agent: CCBot
Allow: /relay/

User-agent: Applebot-Extended
Allow: /relay/

Sitemap: ${base}/sitemap.xml
`);

// ⑥ DEPLOY.md
fs.writeFileSync(path.join(OUT, "DEPLOY.md"), `# RelayLens → WordPress 子目录部署说明

## 0. 构建
\`\`\`bash
# 1) 探针同步最新实测数据
cd relaylens/probe && npx tsx cli.ts sync
# 2) 改 site.config.json:base / mainSite / icp / analyticsHtml
# 3) 构建静态包
node build-relay.js
\`\`\`

> 本页已自动排除内部资产:\`ops.html\` 与 \`data/ops.json\`(运营看板,含未公开的待复核结论)不进对外包。
> 需要内部看板时,单独上传到你的后台目录并加 HTTP Basic Auth;它的 \`noindex\` 只是兜底,不能当访问控制用。
> \`data/audit.json\` 是**故意公开**的审计链摘要(方法论页第 ⑥ 节读它),不要误删。

## 0.5 构建产物:图标与 404
\`assets/\` 已随包生成(favicon.svg / PNG 各尺寸 / og-default.png 分享图)。
404 页为 \`404.html\`(noindex,不进 sitemap)。子目录部署下建议在站点配置里把 /relay/ 内的 404 指向它:
\`\`\`nginx
# nginx(宝塔:网站设置 → 配置文件,加在 server 块内)
location /relay/ { error_page 404 /relay/404.html; }
\`\`\`
不改也能跑:WordPress 会兜底显示主站 404,只是少了回流量入口。

## 1. 上传
把 \`dist-relay/\` 内**除 DEPLOY.md / robots-snippet.txt 外**的所有文件,上传到 WordPress 站点根目录下的 \`relay/\`:
\`\`\`
/www/wwwroot/你的站点/relay/        # 宝塔/lnmp 典型路径
  index.html  ranking.html  ...  data/sites.json  sitemap.xml
\`\`\`
> 必须是**站点根目录**(与 index.php、wp-content 同级),不是 wp-content 里。

## 2. WordPress 固定链接冲突检查
WP 默认 .htaccess 已含 \`RewriteCond %{REQUEST_FILENAME} !-f\`,真实文件会直接返回、不进 index.php,**通常无需改动**。
若访问 /relay/ 出现 404(Nginx 或改写过规则),在 rewrite 规则前加一条排除:
\`\`\`apache
RewriteCond %{REQUEST_URI} !^/relay/
\`\`\`
Nginx 用户确认有 \`location /relay/ { try_files $uri $uri/ =404; }\` 或默认的静态处理即可。

## 2.5 (可选)入驻/认领表单回传 WordPress
前置:已安装并启用「AI 派排行榜 · 中转站业务」插件(含 relaylens-bridge 桥接层,版本 4.2.68+)。
在 \`site.config.json\` 增加(同域部署直接用相对地址):
\`\`\`json
"wpBridge": {
  "formEndpoint": "/wp-json/aipaihangbang/v1/relaylens/form"
}
\`\`\`
重新 \`node build-relay.js\` 后,入驻页/认领页提交会进入 WP 后台审核流;
端点不可用时页面自动降级为复制 JSON + 邮件申请。匿名提交有 60 秒/每日 20 次的 IP 限流。
跨域部署时把地址写成绝对 URL,并在 WP 选项 \`aipaihangbang_relay_relaylens_allow_origin\` 配置来源域名。
探针实测数据(评分/指纹/对账)的回传是另一条链路,见 \`relaylens/probe/config/wp-sync.yaml\`。

## 3. 挂到主站导航
后台 → 外观 → 菜单 → 「自定义链接」→ URL 填 \`https://你的域名/relay/\` → 加入菜单。
(反向互链已在构建时自动注入:relay 每页顶部有「返回主站」。)

## 4. robots.txt(可选)
把 \`robots-snippet.txt\` 内容合并进主站根目录 robots.txt。

## 5. 数据更新流程(日常)
\`\`\`bash
cd relaylens/probe && npx tsx cli.ts sync   # 重新生成 data/sites.json
node build-relay.js                          # 重新构建
# 只需上传变更文件:relay/data/sites.json(以及有改动的 html)
\`\`\`
页面运行时 fetch \`data/sites.json\`,**覆盖该 JSON 即完成数据更新,无需改 HTML**。

## 6. 检查清单
- [ ] site.config.json 的 base/mainSite 已改成真实域名(占位符含 YOUR-DOMAIN)
- [ ] icp 备案号已填(中国境内站点必须,页脚会显示并链接 beian.miit.gov.cn)
- [ ] analyticsHtml 已填(百度统计/GA 等脚本)
- [ ] 访问 https://域名/relay/ 正常,且导航「返回主站」可点
- [ ] 浏览器 Console 无 fetch 报错(data/sites.json 可访问)
- [ ] sitemap.xml 可访问
- [ ] CPS:promo.yaml 填链接 → sync → 详情页出现优惠码与「含推广链接」标识

## 7. 注意
- **不要把 site.config.json / promo.yaml 上传到公开目录**(含商业配置);它们只在本机构建时使用。
- CPS 链接若不想进 Git,保持 promo.yaml 在 .gitignore 或用环境变量注入。
- 静态包内所有引用均为相对路径,换子目录名(如 /relayLens/)只需同步改 base 并重构建。
`);

console.log(`✅ 构建完成 → dist-relay/`);
console.log(`   页面 ${pages.length} 个进包(${NOINDEX_PAGES.length} 个 noindex 不注入 canonical/OG)${cfg.mainSite && !/YOUR-DOMAIN/.test(cfg.mainSite) ? " + 返回主站" : ""}${cfg.icp ? " + ICP" : ""}${cfg.analyticsHtml ? " + 统计" : ""}`);
console.log(`   sitemap.xml / robots-snippet.txt / DEPLOY.md 已生成`);
if (/YOUR-DOMAIN/.test(cfg.base)) console.log(`   ⚠ site.config.json 仍是占位域名,部署前请修改 base/mainSite/icp`);
