# 中转站价格抓取与 CNY 换算方法论

> 来自 RelayLens 探针的实战沉淀（2026-10）。适用于 new-api / one-api 系中转站（目前中文中转站的绝对主流），文末附非 new-api 系的兜底方案与踩坑清单。

## 0. 一句话总公式

```
到手价(¥/M tokens) = 基础价($/M) × 组倍率 × 充值比例(¥/1美元额度)
```

三个因子分别来自：站方定价接口的**表达式系数或 model_ratio**、**group_ratio 表**、站方**公示的充值比例**（必须站方声明，不能拿汇率猜）。

---

## 1. 数据源发现：优先打 `/api/pricing`

new-api 系站点绝大多数暴露定价接口，先按顺序探测：

```
GET {origin}/api/pricing          ← 首选，返回全模型倍率 + 全分组倍率
GET {origin}/v1/models            ← 只有模型名，无价格（做交叉校验用）
GET {origin}/api/status           ← 确认是否 new-api 系（返回 system_name 等）
```

**鉴权三种情况**（都实测过）：

| 情况 | 表现 | 对策 |
|---|---|---|
| 免鉴权 | 匿名 200 | 直接采 |
| 接受 sk key | `Authorization: Bearer sk-…` 返回 200 | 用测试 key 采（多数站如此） |
| 只认登录 session | sk key 返回 `{"message":"Unauthorized, invalid access token"}` | 走 §6 浏览器导出 |

注意：**带不带 key 拿到的 `group_ratio` 可能不同**（有的站按用户组过滤），尽量带 key 采，并在数据里记录"带 key 采集"这一事实。

## 2. 响应结构与字段语义

```jsonc
{
  "success": true,
  "data": [{
    "model_name": "gpt-5.6-sol",
    "quota_type": 0,              // 0=按token计费；≠0=按次计费(用 model_price)
    "model_ratio": 2.5,           // ⚠ 见 §3：tiered_expr 模型里这是占位垃圾值
    "completion_ratio": 6,        // 输出价 = 输入价 × 它
    "cache_ratio": 0.1,           // 缓存读价 = 输入价 × 它（可能缺省）
    "enable_groups": ["Codex","GPT 优质"],   // 该模型在哪些分组在售
    "billing_mode": "tiered_expr",           // ★ 分档计费标志
    "billing_expr": "(len < 272000 ? tier(\"base\", p * 5 + c * 30 + cr * 0.5 + cc * 6.25) : tier(\"long_context\", p * 10 + c * 45 + cr * 1 + cc * 12.5)) * (param(\"service_tier\") == \"priority\" ? 2.5 : 1)"
  }],
  "group_ratio": { "Codex": 0.18, "GPT 优质": 0.33, "default": 1, ... }  // 组倍率全表
}
```

## 3. 基础价计算（最容易错的一步）

### 3a. `billing_mode === "tiered_expr"` 的模型 —— 真实价藏在表达式里

`billing_expr` 的**第一个 tier 体**就是基础档（短上下文），系数单位是 **美元/百万 token**：

```
tier("base", p * 5 + c * 30 + cr * 0.5 + cc * 6.25)
     → 输入 $5/M · 输出 $30/M · 缓存读 $0.5/M · 缓存写 $6.25/M
```

- 档名不可靠：见过 `base` / `standard` / `0_272k` / `≤272K`，**按位置取第一个 tier**，别按名字找；
- 系数正则要防干扰项：`cc1h * 4`（1小时缓存写）不能误配成 `cc`——用 `\bcc\s*\*\s*([\d.]+)` 且要求 `cc` 后紧跟数字或空格+`*`；
- 表达式尾部可能挂全局乘子（`* (param("service_tier") == "priority" ? 2.5 : 1)`）——标准档忽略它；
- **此时 `model_ratio` 是占位值**（常见 37.5 全站一刀切）。拿 `model_ratio × 2` 计价会虚高一个数量级——这是 RelayLens 亲手踩过并修掉的 bug。
- 表达式解析失败：**宁缺毋错，跳过该模型**，别回退到占位 ratio。

### 3b. 普通模型 —— 官方约定的倍率制

```
基础输入价($/M) = model_ratio × $2        // new-api 默认约定：ratio 1 = $0.002/1K = $2/M
基础输出价      = 基础输入价 × completion_ratio
基础缓存读价    = 基础输入价 × cache_ratio
```

⚠ **这个 `$2` 锚点不是普世真理**：它是 quota_per_unit=500000（50万额度=1美元）+ $0.002/1K 的默认约定。站方可自定义（有的全站 model_ratio=37.5 但**不是** tiered，锚完全不同）。怎么知道锚对不对？→ §5 实扣校准。

### 3c. `quota_type ≠ 0`（按次计费，生图类常见）

单价 = `model_price`（单位是"美元额度/次"），同样要 × 组倍率 × 充值比例。

## 4. 组倍率与分组选择策略

```
渠道价 = 基础价 × group_ratio[组名]
```

**选哪个组作为"对用户展示的价格"是产品决策，三个教训：**

1. **不要取"最低组"**——最低组往往是特价号池/VIP限定/内部测试组，普通注册用户在 `default`。取最低=虚低价误导（RelayLens 早期版本栽过）；
2. **主口径 = 默认组**（`default/默认/普通用户/normal` 正则匹配）；无默认组取**中位倍率组**并标注口径；
3. **警惕占位组**：「测试专用」这类组价格常是正式组数倍（脏数据），别让它进最低价；
4. 全部组的价都存下来（`groups[]` 数组），前端并列展示 + 组名透明，让用户自己看到"同站不同组差 12 倍"这个事实。

## 5. 验证：拿真金白银对质（强烈建议做）

页面价可能是假的。验证方法：**用自己的测试 key 真实消费，比对账单**。

```
1. 记录消费前余额 before（站方 /api/usage 或 /api/data 端点，或直接读账单流水）
2. 发 N 轮已知 token 数的请求（短 prompt + 记录 usage 返回）
3. 记录消费后余额 after → 实扣 = before - after
4. 应扣 = Σ (fresh输入tok/1M × 输入价 + 缓存tok/1M × 缓存价 + 输出tok/1M × 输出价) × 组倍率 × 500000
   （500000 = 每美元额度数；aicost 实测分毫对平：quota = ($系数 × tok/1M × 组倍率) × 500000）
5. 校准因子 = 实扣 ÷ 应扣
   ≈1        → 页面价可信，标"实扣一致"
   显著≠1    → 锚点假设破了 或 站方计费有小动作，用因子修正展示价或降级标注
```

两个细节：
- **因子按模型生效**，别把 GPT 轮次测出的因子外推到 deepseek 行（站方对不同模型可配不同倍率）；
- **因子绑定价格表版本**：给价表算内容哈希，重采后哈希没变则校准仍有效，变了才作废——否则例行重采会把验证角标天天打没。

## 6. session 鉴权站的兜底：浏览器 Console 导出

sk key 不被定价接口接受时（如 aicost），让**有登录态的人**（自己注册测试号即可）在站方页面 F12 执行：

```js
(async () => {
  const uid = (JSON.parse(localStorage.getItem('uid') || 'null') || localStorage.getItem('user_id') || '');
  const tryFetch = h => fetch('/api/pricing', { credentials: 'include', headers: h });
  let r = await tryFetch({});
  if (!r.ok) r = await tryFetch(uid ? { 'new-api-user': String(uid) } : {});
  if (!r.ok) { console.error('HTTP', r.status); return; }
  const j = await r.json();
  const d = new Date(), ymd = '' + d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(j)], { type: 'application/json' }));
  a.download = 'SITEPRICING-' + ymd + '.json'; a.click();
  console.log('导出完成', (j.data||[]).length, '模型', Object.keys(j.group_ratio||{}).length, '组');
})();
```

导出文件与在线接口**同构**，后续管线完全复用。

## 7. 跨站模型名归一化（比价必备）

同一模型各家写法不一：`claude-sonnet-5.5`（OpenRouter）vs `claude-sonnet-5-5`（中转站）vs `deepseek-v4-1-flash`（thinkai）；锚点侧还有 `-preview`、`:batch`、`vendor/` 前缀。统一规则：

```js
function canonName(raw) {
  let n = String(raw || "").toLowerCase();
  n = n.replace(/^[a-z0-9._-]+\//, "");   // 去 vendor/ 前缀(openai/、~anthropic/)
  n = n.replace(/:.*$/, "");              // 去 :batch 等冒号后缀
  n = n.replace(/\./g, "-");              // 点号 → 连字符
  n = n.replace(/(?:-(?:preview|customtools|latest|image))+$/g, "");  // 循环剥预览类后缀
  return n;
}
```

匹配用**精确等值**（归一化后），不要用前缀/包含——否则 `glm-5.3-flash`、`deepseek-v4-1-flash-hc`、`gpt-5.6-sol-pro` 这些派生名会误并成正主。

## 8. 充值比例（CNY 化的关键，最容易被偷懒的环节）

- 中转站卖的是**额度**，$ 符号是额度单位不是美元现金。人民币成本 = 额度价 × **站方公示的充值比例**（¥X = 1 美元额度）；
- 比例来源只有两个可信渠道：站方充值页公示 / 与站方确认。拿到后**记录来源和核实日期**；
- **绝不能用银行汇率代替充值比例**（那是官方直连 API 的换算方式）；也不能反过来把美元数字直接标 ¥——某排行榜站（apiranking.com）就犯了这个错：其 ¥ 价 = 官方美元价 × 倍率，汇率当 1，全站价格低估约 7 倍（13 组样本反推 base 恒为 3.0 = Sonnet 官方 $3 价）；
- 比例未声明的站：**不给人民币价**，显示额度价并明示原因。宁缺毋滥是信任资产；
- 注意「比例与倍率是同一价格的两种写法」：¥1=10$ 额度的站往往把倍率抬高 10 倍，单独看任何一个都会误判，只有到手价可比。

## 9. 参考实现（RelayLens 仓库内文件）

| 能力 | 文件 |
|---|---|
| new-api 解析器（含 tiered 表达式/分组/主口径） | `relaylens/probe/src/parsers/newapi.ts` |
| 模型登记表与归一化 | `relaylens/probe/src/parsers/models.ts` |
| 实扣校准（因子/哈希/逐模型覆盖） | `relaylens/probe/src/probes/billing.ts` + `src/sync.ts` 的 `calibOf` |
| 通用出表脚本 | `node relaylens/probe/scripts/gen-station-cny.cjs <pricing.json> <充值比例> <前缀>` |

## 10. 踩坑清单（每一条都是真金白银换来的）

1. `model_ratio=37.5` 全站一刀切 = tiered_expr 占位，直接乘 `$2` 虚高 15 倍；
2. 取"最低组倍率"当展示价 = 把 VIP/号池限定价卖给普通用户；
3. 美元数字直接标 ¥（汇率当 1）= 低估 7 倍；
4. 用银行汇率算"到手价" = 中转站根本不是美元现金结算，数字对不上任何人的账单；
5. 校准因子全站一刀切 = 把 GPT 的组归属误差外推到所有模型；
6. 重采价格后按时间戳作废校准 = 价没变也把验证角标打没，角标天天闪；
7. 模型名按包含匹配 = 派生名（-flash/-hc/-pro/点号变体）混进正主价格；
8. 长上下文分档模型只采基础档 = 用户超长请求时被高价档背刺（应至少记录第二档系数）；
9. 按次计费模型混进 token 价格表 = 生图模型"输出 ¥4500/M"这种吓人数字（它其实是按张收费）；
10. usage 自报 token 可能是虚的（实测有站注入 +4858 tok/请求）——对账要用**独立估算的 token 数**做基准，别拿站方返回值算站方自己。
