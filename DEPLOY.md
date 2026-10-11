# RelayLens → WordPress 子目录部署说明

## 0. 构建
```bash
# 1) 探针同步最新实测数据
cd relaylens/probe && npx tsx cli.ts sync
# 2) 改 site.config.json:base / mainSite / icp / analyticsHtml
# 3) 构建静态包
node build-relay.js
```

> 本页已自动排除内部资产:`ops.html` 与 `data/ops.json`(运营看板,含未公开的待复核结论)不进对外包。
> 需要内部看板时,单独上传到你的后台目录并加 HTTP Basic Auth;它的 `noindex` 只是兜底,不能当访问控制用。
> `data/audit.json` 是**故意公开**的审计链摘要(方法论页第 ⑥ 节读它),不要误删。

## 0.5 构建产物:图标与 404
`assets/` 已随包生成(favicon.svg / PNG 各尺寸 / og-default.png 分享图)。
404 页为 `404.html`(noindex,不进 sitemap)。子目录部署下建议在站点配置里把 /relay/ 内的 404 指向它:
```nginx
# nginx(宝塔:网站设置 → 配置文件,加在 server 块内)
location /relay/ { error_page 404 /relay/404.html; }
```
不改也能跑:WordPress 会兜底显示主站 404,只是少了回流量入口。

## 1. 上传
把 `dist-relay/` 内**除 DEPLOY.md / robots-snippet.txt 外**的所有文件,上传到 WordPress 站点根目录下的 `relay/`:
```
/www/wwwroot/你的站点/relay/        # 宝塔/lnmp 典型路径
  index.html  ranking.html  ...  data/sites.json  sitemap.xml
```
> 必须是**站点根目录**(与 index.php、wp-content 同级),不是 wp-content 里。

## 2. WordPress 固定链接冲突检查
WP 默认 .htaccess 已含 `RewriteCond %{REQUEST_FILENAME} !-f`,真实文件会直接返回、不进 index.php,**通常无需改动**。
若访问 /relay/ 出现 404(Nginx 或改写过规则),在 rewrite 规则前加一条排除:
```apache
RewriteCond %{REQUEST_URI} !^/relay/
```
Nginx 用户确认有 `location /relay/ { try_files $uri $uri/ =404; }` 或默认的静态处理即可。

## 2.5 (可选)入驻/认领表单回传 WordPress
前置:已安装并启用「AI 派排行榜 · 中转站业务」插件(含 relaylens-bridge 桥接层,版本 4.2.68+)。
在 `site.config.json` 增加(同域部署直接用相对地址):
```json
"wpBridge": {
  "formEndpoint": "/wp-json/aipaihangbang/v1/relaylens/form"
}
```
重新 `node build-relay.js` 后,入驻页/认领页提交会进入 WP 后台审核流;
端点不可用时页面自动降级为复制 JSON + 邮件申请。匿名提交有 60 秒/每日 20 次的 IP 限流。
跨域部署时把地址写成绝对 URL,并在 WP 选项 `aipaihangbang_relay_relaylens_allow_origin` 配置来源域名。
探针实测数据(评分/指纹/对账)的回传是另一条链路,见 `relaylens/probe/config/wp-sync.yaml`。

## 3. 挂到主站导航
后台 → 外观 → 菜单 → 「自定义链接」→ URL 填 `https://你的域名/relay/` → 加入菜单。
(反向互链已在构建时自动注入:relay 每页顶部有「返回主站」。)

## 4. robots.txt(可选)
把 `robots-snippet.txt` 内容合并进主站根目录 robots.txt。

## 5. 数据更新流程(日常)
```bash
cd relaylens/probe && npx tsx cli.ts sync   # 重新生成 data/sites.json
node build-relay.js                          # 重新构建
# 只需上传变更文件:relay/data/sites.json(以及有改动的 html)
```
页面运行时 fetch `data/sites.json`,**覆盖该 JSON 即完成数据更新,无需改 HTML**。

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
