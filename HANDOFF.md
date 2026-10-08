# 交接快照（2026-10-04）

## 线上状态

| 项 | 值 |
|---|---|
| 预览域名（当前权威） | **https://weaph8e3.qwenwork.host/** （V10，含全部最新功能） |
| 旧域名 | https://rzr65e8d.qwenwork.host/ （V22 计数，停在倒数第二版，仍在线） |
| 域名说明 | QW Pages 发布不保证域名固定，以每次 publish 返回值为准并告知用户 |
| 最终目标域名 | aipaihangbang.cn/relay/（WordPress 部署未做，dist-relay/DEPLOY.md 有说明） |
| 最后构建内容 | compare 多渠道价+measuredGroup 修复、cheapest 标签/视图/排序、17 模型换代、三因子价格口径 |

## 数据状态

- SQLite：`relaylens/probe/store/relaylens.sqlite`，批次号至 RL-RC-20261004-xxx，审计 hash 链 90+ 条（`cli.ts audit` 可校验）；
- sites.json meta.updated ≈ 2026-10-04（同步于最后一次探针）；
- 在册 12 中转站 + 3 参照系；aicost 定价靠 `store/manual-imports/aicost-pricing-*.json`（需登录 session，最新 10-03 导出）；
- 调度器：原会话的 `npx tsx cli.ts schedule` 进程随会话结束会停止——**接手后第一件事**：进入 relaylens/probe 执行 `npm install`，然后后台拉起 `npx tsx cli.ts schedule`（改过解析器代码后重启调度是铁律，见 AGENTS.md 红线 11）。

## 接手验证清单（10 分钟）

```bash
cd relaylens/probe && npm install
node ../../build-relay.js            # 应输出 15 页进包
node ../../test_compare_render.js    # 13 套件任选,应全绿
npx tsx cli.ts once --task=health    # 免费任务,验证 key 与网络
npx tsx cli.ts report                # 数据健康概览
```

## 待办（优先级序）

1. 7 家测试账户充值 → 逐站实扣校准（成本分/厘级，需用户授权真实扣费）；
2. WordPress 部署 aipaihangbang.cn/relay/ + sitemap 提交；
3. commerce 补录：thinkai 起充金额、toonflow 充值比例；
4. 向用户要 OpenRouter 官方 key → 掉包终局判定（fluxionai 等）；
5. toonflow 登录墙：请用户提供网页账号登录后导出的价格接口，或 F12 抓取；
6. ricktoken.top 源站 522，恢复后再评估接入；
7. 安全：轮换全部 key（曾在聊天记录明文出现），清理桌面明文 key 备份文件。

## 会话积累的关键坑（速查）

- String.replace 替换串含 `$'`/`$&` 会展开——永远用 `()=>to` 形式；
- shell heredoc/sed 写正则常吞反斜杠——改文件用编辑器工具或按行号；
- vm DOM 桩：innerHTML='' 要同时清 children；querySelectorAll 要按选择器作用域过滤；
- CRLF 文件多行匹配要 `[\r\n]+`；
- 探针慢站（aicost/thinkai）单任务可能 10 分钟+，长任务放后台。
