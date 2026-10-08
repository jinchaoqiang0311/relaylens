# RelayLens — AI 中转站计费诚实度审计平台

> 给接手的开发助手（workbuddy）：本文件是项目宪法。先通读这里再动手，所有"为什么这样设计"都有理由，破之前请先读 docs/ 三份方法论文档。

## 项目是什么

静态站 + 探针系统。探针真实测量各 AI API 中转站（new-api 系为主）的定价、扣费诚实度、模型真实性、流式/延迟表现，产出 `data/sites.json` 供 15 个纯静态页面消费。**卖点是一个数字一个证据：页面任何数字可按批次号（RL-RC-YYYYMMDD-NNN）回溯到原始归档。**

## 目录结构

```
relaylens/
├── shared/            类型定义 + weights.json(评分唯一事实源,带 changelog)
├── probe/             探针系统(TypeScript + Node≥22 + node:sqlite,tsx 运行)
│   ├── cli.ts         入口:once/schedule/sync/rebuild/report + perf/fingerprint 子命令
│   ├── src/parsers/   定价解析:newapi/aicost/openrouter/deepseek/zhipu + models.ts(模型登记表)
│   ├── src/probes/    health/price/billing/perf/tokenprobe/fingerprint
│   ├── src/           sync.ts(产出 sites.json)/score.ts(评分)/assemble.ts/ops.ts(告警)/audit.ts(hash链)
│   ├── scripts/       gen-station-cny.cjs(通用出表)
│   ├── config/
│   │   ├── sites.yaml     站点注册表(base_url/key_env/commerce声明/调度cron)
│   │   └── secrets/sites.env  各站 sk key ⚠ 绝不入库/绝不进发布目录/绝不明文输出
│   └── store/         relaylens.sqlite + raw/归档 + manual-imports/(aicost定价与流水)
├── (上层) relaylens-home/   前端源码:15 个 HTML(榜单/比价/最低价/工具箱/避坑/方法论/申诉/收录/ops…)
│                             共享 assets/speedprobe.js(测速弹窗+自带key实测)
├── build-relay.js     构建:relaylens-home → dist-relay(注入canonical/OG/备案/统计/sitemap)
├── site.config.json   域名/备案/统计配置(base 指向最终域 aipaihangbang.cn/relay/)
└── test_*.js          13 个回归套件(纯 node 跑,无框架;DOM 用 vm+stub)
```

## 常用命令

```bash
cd relaylens/probe
npx tsx cli.ts once --task=health|price            # 免费任务全量
npx tsx cli.ts once --task=billing --site=X        # ⚠ 真实扣费(分/厘级),需用户明确授权
npx tsx cli.ts perf --site=all --force             # TTFT+流式专项
npx tsx cli.ts fingerprint --site=all              # 跨站差分指纹
npx tsx cli.ts sync                                # 重建 sites.json(改任何数据后必跑)
npx tsx cli.ts schedule                            # 常驻调度(见下方红线)
node build-relay.js                                # 构建 dist-relay
node test_compare_render.js                        # 逐个跑 13 套件,发布前必须全绿
```

## 铁律（每条都有事故背书，违反会毁掉信任资产）

### 定价口径
1. **到手价 = 官方价格 × 组倍率 × 充值比例**，三因子在页面 hover 摊开可验算；
2. **tiered_expr 模型真实价在 billing_expr 第一个 tier 体系数**（$/M），`model_ratio=37.5` 是占位——直接乘 $2 锚会虚高 15 倍；表达式解析失败宁缺毋错跳过；
3. **主口径 = 默认组**，无默认取中位组；**永远不许取最低组当主价**（那是 VIP/号池价）；特价组只作并列展示+组名透明；
4. **充值比例(¥/1美元额度)必须站方声明**，未声明不给人民币价；绝不用银行汇率猜；比例与倍率是同一价格的两种写法，风险判定只信可测量；
5. **实扣校准只出验证角标不改价格**：因子按模型生效(calibModels)、绑价表内容哈希(priceHash)；
6. 模型名匹配走 models.ts 的 canonName 归一化 + **精确等值**（防 -flash/-hc/-pro 派生名误并）；模型清单换代只改 CANON 登记表一处。

### 数据诚实
7. 三种空值语义严格区分：不适用(N/A灰)/未测(琥珀)/未声明(需站方)；空值排序沉底、不参与打分；
8. 未测指标**重归一化**而非记零分；覆盖率<0.6 不出分；passive 站只称"监测中"不给分数；
9. 评分权重只认 shared/weights.json；改权重必须：沙盘模拟影响→用户拍板→升版本→changelog；
10. 首页门面数字（实测家数/核验笔数）只统计可回溯证据，数字难看也不编。

### 运维红线
11. **调度器是长驻进程=代码快照**：改了 parsers/models/weights 后必须杀掉重启 `schedule`，再全量重采——否则旧代码会用旧名单覆盖新数据（2026-10-03 实际发生：17 模型锚点被打回 9 个）；
12. 单站重跑任务**必须基于全部在册站点重建 dist**，禁止只发布单站产物；
13. 发布走 QW Pages（工具 publish dist-relay，category=static，name=relaylens-relay）；**域名可能漂移**，每次发布后校验返回域名并告知用户（当前 weaph8e3.qwenwork.host，V21）；
14. secrets 三不：不进 git、不进发布目录、不在聊天回显（最多前 6 字符）；构建脚本 build-relay.js 有内容扫描，别绕过；
15. 发布前 13 套件全绿 + 新页面跑对应渲染测试；HTML 结构守卫（未闭合引号/td 配平/格数=列数）不许删——一个漏引号曾让全站表格错位。

## 已知边界（对用户的承诺，别越）

- 所有测量反映测量时点+我们节点/分组；「疑似掉包」是复核信号非终局定论，措辞不许升级；
- 掉包终局判定需官方基线（等用户给 OpenRouter 官方 key）；
- 缓存命中率只能来自消费日志对账（aicost/aixoras 有，其余站待导出）；
- aicost 定价接口需登录 session（用 store/manual-imports/ 的导出文件，README-export.md 有脚本）；toonflow 价格页有登录墙；ricktoken 源站 522。

## 未竟事项（按优先级）

1. 5 家测试账户充值后跑实扣校准（api75/memecode/thinkai + fluxionai/uuapi/chatfire/toonflow/jiuqingyun 无余额）；
2. WordPress 部署到 aipaihangbang.cn/relay/（DEPLOY.md 已生成在 dist-relay，sitemap 提交）；
3. thinkai 起充金额、toonflow 充值比例两个 commerce 字段待补；
4. 汇率 7.1 口径待用户确认（现用常量+生效日期，人工维护）；
5. 桌面遗留的明文 key txt 文件建议移入回收站并轮换全部 key（聊天中出现过）。

## 深度文档

docs/ 下三份方法论（价格抓取与CNY换算 / 探针系统方案 / 评分体系）+ 两张线上截图。改任何口径前先读对应篇。
