# RelayLens 主站交接文档

> 面向接手本项目的人。读完即可本地起站、构建、部署、避坑。
> 配套看板仓库 `renlay-ranking` 的交接见其根目录 `项目交接文档.md`（已在 GitHub）。

---

## 0. 2026-11-01 更新摘要(主工作区已迁移,先读这节)

- **主工作区**:`D:\软件项目\中转站测评网站relaylens`(GitHub `jinchaoqiang0311/relaylens`,git 推送走 SSH 443 通道,已在仓库级 insteadOf 配置)。桌面 `Desktop\relaylens` 为**只读历史**,其探针库 3500 批次 + 198 条审计链已全量并入本区(哈希链逐条验证),两库 git 谱系分叉,勿再从桌面同步。
- **数据管道加固(演进#1)**:全部 JSON 落盘走 `atomicWriteJson`(临时文件+rename)+ 收缩熔断(audit 0.2/ops 0.5——新内容缩水超阈值拒绝覆盖、另存 *.rejected-*);空库 rebuild 截断线上数据的事故类已结构性消除。
- **按站切片(演进#2)**:详情页只拉 `data/details/<站>.json`(4~15KB);上游真源仍是 sites.json,改数据后跑 `node relaylens/probe/scripts/slice-details.cjs` 重投影(构建器不改切片)。
- **公共 JS(演进#3)**:`assets/rl-common.js` 全站唯一 `esc` 与支付图标实现 + 看板探活降级标记;九页已删本地副本。**新页面勿再定义本地 esc**。
- **部署脚本(演进#4)**:`node deploy/deploy.mjs --dry-run|--to=local:<目录>|--to=ssh:<user>@<host>:<路径>`(预检含占位域名/必需文件/内部资产泄漏拦截)。
- **看板接缝加固**:renlay-ranking 的 serve 有单实例锁(启动前试连端口)+ `/healthz` + 可选令牌门(`RL_DASH_TOKEN`;preview-server/nginx 同名注入 X-RL-Token);守护重启 `serve-guarded.ps1`;挂载契约 `docs/dashboard-contract.md`(两仓库同文)。
- **双站扣费实测结论(2026-10-31)**:aicost 文本计费逐笔精确(1854 笔),图片按次"公示降价、扣费未跟随"+11% 待核,号池注入 4224 tok 实锤;aixoras 计费精确(3617 笔 97.62%),号池注入 3968 tok 实锤。明细:`relaylens/probe/store/audit/*-reconcile-*.json`。
- **探针新工具**(probe/scripts/):`reconcile-logs.cjs <站>`(管理面日志逐笔对账)、`update-rounds.cjs <站> [N]`(逐轮回填,最新 20 笔)、`slice-details.cjs`;管理面令牌在 `config/secrets/sites.env`(gitignored,令牌存活期短,失效找站方重取)。
- **剩余已知项**:aicost 详情报价表仍指向比价页(其价格页需登录、按次计费);claude 缓存写口径待核;#5 调度迁服务器为长期项。

---

## 1. 一句话定位

**AI 中转站评测站**：实测审计（榜单/黑名单/方法论/避坑）+ 全站导航 + 选型工具，比价功能外迁到独立的 Python 看板（见第 6 节）。本站定位「纯审计口径」，看板定位「自采标价数据面」，**两套数据口径不同，展示时不要混用**。

- 主仓库：`c:\Users\Administrator\Desktop\relaylens`（本站，`git` 版本管理）
- 看板仓库：`C:\Users\Administrator\CodeBuddy\20261017201226`（renlay-ranking，`git@github.com:jinchaoqiang0311/renlay-ranking.git`）

---

## 2. 当前本地服务状态（2026-10-30 实测）

| 端口 | 服务 | 进程 | 说明 |
|---|---|---|---|
| 5173 | preview-server（node 零依赖） | `node preview-server.js` | 静态站 + 反代看板 `/price/` |
| 8899 | relay_scraper 看板 serve（python） | `python relay_scraper.py serve --port 8899` | 比价看板，长驻=代码快照 |

- 两服务当前都在线（HTTP 200）。
- 看板导航当前项靠 `RELAY_SELF_URL=/price/` 留在同源，避免跨端口。

---

## 3. 本地如何起（顺序很重要）

```powershell
# 1) 先起看板（带环境变量，导航/链接同源）
cd C:\Users\Administrator\CodeBuddy\20261017201226
$env:RELAY_HOME_URL='http://127.0.0.1:5173/index.html'
$env:RELAY_SELF_URL='/price/'
Start-Process python -ArgumentList 'relay_scraper.py','serve','--port','8899' -WindowStyle Hidden

# 2) 再起预览（反代 8899 挂 /price/）
cd c:\Users\Administrator\Desktop\relaylens
Start-Process node -ArgumentList 'preview-server.js' -WindowStyle Hidden

# 浏览器打开
#   首页:     http://127.0.0.1:5173/
#   比价看板: http://127.0.0.1:5173/price/
```

> 启动顺序：先 8899 后 5173。改看板 `relay_scraper.py` 的 `DASHBOARD_HTML` 后**必须重启 8899 进程**（长驻=代码快照）。

---

## 4. 构建与产物

```powershell
cd c:\Users\Administrator\Desktop\relaylens
node build-relay.js          # 产物 → dist-relay/（gitignore，不入库）
```

- `dist-relay/` 即线上部署包（14 页：index/ranking/blacklist/method/pitfalls/detail/reports/selector/tools/api/claim/onboarding/404 等）。
- 发布流程：本地 `build-relay.js` → 上传 `dist-relay/` 到线上静态目录 + nginx 配 `/price/` 反代 8899。

---

## 5. ⚠️ 未提交改动（换账号前必须先处理！）

主站仓库当前有**一大批未提交改动**（含近期多次主题/导航/榜单改动）。`git status` 摘要：

- 构建：`build-relay.js`、`relaylens-home/assets/theme-relayindex.css`
- 全站页面（均 modified）：`index.html / ranking.html / blacklist.html / method.html / pitfalls.html / detail.html / reports.html / selector.html / tools.html / api.html / claim.html / onboarding.html / 404.html`
- 已删：`price.html`、`compare.html`、`relaylens-home/assets/compare-matrix.js`（比价外迁）
- 探针（TS，modified）：`relaylens/probe/*`、`shared/types.ts`
- 数据（modified）：`relaylens-home/data/{audit,ops,sites}.json`
- 其它：`.gitignore`

**看板仓库 `relay_scraper.py` 已提交（干净）**，仅多一个未跟踪的 `项目交接文档.md`。

> 风险：换账号若清工作区，这些未提交改动会丢。**建议在换账号前用项目约定的提交身份提交**（见第 9 节）。

---

## 6. 关键口径与产品决策（勿回退）

| 决策 | 内容 |
|---|---|
| 比价外迁 | 2026-10-28 起 price/compare 下线为重定向壳（已删），比价走看板 `/price/`；全站入口直写 `href="/price/"` |
| 站点数真相 | 看板启用站 **12 家**（DB `stations.enabled=1`），本站实测 **9 站**，重叠 8 家；曾误报「42 站」是把 `stations.json` 清单条数当启用数 |
| 数据全开放 | 2026-10-22 起所有数据无查看限制，Pro 订阅不启用，变现仅靠合作推荐位 |
| 顶栏几何锁 v3 | `header > .wrap/.nav/.shell/.topbar-inner` 统一 `max-width:1560px 居中 + 60px + gap22`（!important）+ `html{scrollbar-gutter:stable}`；看板 `rl-wrap` 同步居中、48→60px、绿系 |
| 旧路径 301 | preview-server 把 `/price.html`、`/compare.html`、`/compare` → `/price/`；静态 HTML 加 `Cache-Control: no-cache` 防旧页缓存 |
| heyroute CNY | 直接用价格页 ¥ CNY 公示单价，不乘充值比例（`ratio_applies_to_price:false`） |
| 千问官方锚 | 国产官方锚以 qianwenai.com 为准（含转售价），命中 `officialCur=CNY`；glm/kimi 该站无覆盖仍用 OpenRouter |
| billing 自动化 | 2026-10-15 用户授权 billing 真实扣费进常驻调度（见 memory） |
| 自托管方向 | 阿里云部署规划中（静态站 + api-worker 已建，待用户提供服务器信息） |

---

## 7. 已知坑（接手必读）

1. **双进程抢绑 8899**：`pythonw.exe` 隐藏的旧 serve 会和新 serve 同时绑 8899（SO_REUSEADDR 允许双绑），连接随机落旧页面 → 表现「改了代码不生效」。排查先 `Get-CimInstance Win32_Process | Where CommandLine -match relay_scraper`（别只筛 `python.exe`，会漏 `pythonw`）。
2. **勿杀 watch 进程**：用户另有 `watch --interval 43200` 采集进程（pythonw）**不能杀**，否则停止数据更新。
3. **netstat 漏报**：此环境 `netstat`/`Get-NetTCPConnection` 常漏报监听端口，判活以 HTTP 请求为准。
4. **agent-browser eval 引号**：传参含引号必挂，把 JS 写进 `.js` 文件再用 `eval (Get-Content -Raw -Encoding UTF8 文件)`。
5. **看板表头修复教训**：gth 模板 `class="'+...+'>'` 少收尾引号会让属性值不闭合、两级表头全毁；改动后必须浏览器实测两行表头（11+6 格、`theadTop=60`）。`.tablescroll{overflow-x:auto}` 会把 sticky 表头囚禁，已收进 `@media(max-width:1100px)`。

---

## 8. 接手必做（优先级）

- **P0**：把主站当前未提交改动提交（见第 5 节）；线上 `aipaihangbang.cn/relay` 仍是 2026-10-23 旧包，**需重新上传 `dist-relay/`**。
- **P0**：生产 nginx 配 `/price/` 反代 `127.0.0.1:8899` + 旧路径 301（`/price.html`、`/compare.html`、`/compare` → `/price/`）。把 site.config.json 的 `priceDashboard` 设成 `https://域名/price/` 即全站同域。
- **P1**：看板侧「最低价分组→默认组」口径（见看板 `项目交接文档.md` 第 7 节 P0）；评分三因子前端可视化。
- **P2**：阿里云自托管落地；公网暴露看板前加鉴权（看板当前无鉴权）。

---

## 9. 提交身份（本机无全局 git config）

```powershell
git -c user.name=relaylens -c user.email=relaylens@local commit -m "..."
```
（仓库约定：禁止改全局 config，提交用一次性 `-c` 身份。）

---

## 10. 关键文件索引

| 文件 | 作用 |
|---|---|
| `preview-server.js` | 本地预览服务器（零依赖），反代 `/price/`→8899，旧路径 301，HTML no-cache |
| `build-relay.js` | 构建脚本，产出 `dist-relay/` |
| `relaylens-home/` | 站点源（html/css/js/data） |
| `relaylens-home/assets/theme-relayindex.css` | 全站主题 + 顶栏几何锁 v3（最后加载，!important 压平各页） |
| `relaylens/probe/` | Node 探针（TS），实测数据落库 |
| `shared/types.ts` | 跨端类型 |
| `test_*.js`（仓库根） | 21 个守卫套件（发布基线：全部 exit 0） |
| `relaylens-home/data/*.json` | 审计/运营/站点数据 |

记忆目录（随项目路径持久化，跨账号可能不自动加载）：`C:\Users\Administrator\.codebuddy\projects\c-Users-Administrator-Desktop-relaylens\memory\`（含 billing 自动化、阿里云部署、风格改版、heyroute/千问口径、数据全开放、提交身份、看板外迁等）。

---

**一句话交接**：代码本地两份都在、看板已上 GitHub；主站有一大批未提交改动需先 commit，线上仍待重传 `dist-relay/` 与配 nginx。最优先两件事：① 提交主站改动；② 上传 `dist-relay/` 并配 `/price/` 反代。
