/**
 * RelayLens 数据契约(探针与前端共用)
 * 字段与 web/ 九页现有数据结构、api.html 端点响应体对齐。
 */

// ---------- 站点配置(sites.yaml) ----------
export interface SiteConfig {
  name: string;
  base_url: string;
  enabled: boolean;
  tags: string[];
  notes?: string;
  /** 价格解析器名(对应 src/parsers/ 注册表);缺省为 pending */
  parser?: string;
  /** API key 环境变量名(读取 config/secrets/sites.env);健康检查将携带鉴权头 */
  key_env?: string;
  /** 站方声明的主攻方向(声明-检测-验证体系:未声明方向标「未承诺,未检测」) */
  directions?: string[];
  /** 站方声明的分组(primary=主力进主榜;special=特价进特价榜小样本侦察) */
  declared_groups?: Array<{ name: string; models: string[]; tier: "primary" | "special"; billing: "ratio" | "tiered" | "unknown" }>;
  contact_email?: string;
}

export interface ProbeConfig {
  sites: SiteConfig[];
  models: { flagship: string[]; standard: string[]; budget: string[] };
  /** billing 为真实扣费任务:配置了节拍才启用自动对账(与 perf 双窗口同一策略);未配置则只能 CLI 手动触发 */
  schedules: { health: string; price: string; billing?: string; perf_work?: string; perf_off?: string; fingerprint?: string; tokens?: string };
  score_weights: Record<string, Record<string, number>>;
  thresholds: {
    dev_warn: number;
    dev_black: number;
    price_surge_week: number;
    fp_pass: number;
    fp_suspect: number;
    min_batches: number;
  };
}

// ---------- 探针结果 ----------
export type TaskName = "health" | "price" | "billing" | "perf" | "tokens" | "context";

/**
 * TLS 证书证据(随健康检查采集,确定性事实,不参与评分)。
 * 为什么不进分:自签 / CDN 边缘证书 / 域名与 SAN 不一致在小站很常见,与「计费是否诚实」无关,
 * 拿它扣分等于误杀。这里只记录事实,展示层如实标注"不影响可调用性结论"。
 */
export interface TlsInfo {
  host: string;
  port: number;
  /** 采集时点 —— 剩余天数是随时间变化的量,必须和它一起展示 */
  checkedAt: string;
  handshakeOk: boolean;
  /** 用系统 CA 校验证书链是否通过;null = 未做(如 http 站点) */
  chainValid: boolean | null;
  /** 原样保留 openssl/node 错误码(CERT_HAS_EXPIRED / DEPTH_ZERO_SELF_SIGNED_CERT / ERR_TLS_CERT_ALTNAME_INVALID…)*/
  errorCode: string | null;
  /** base_url 的 host 是否落在证书 SAN 内 */
  sanMatch: boolean | null;
  subject: string | null;
  issuer: string | null;
  notAfter: string | null;
  daysLeft: number | null;
  protocol: string | null;
}

/** 探针 A:健康检查原始结果 */
export interface HealthResult {
  task: "health";
  site: string;
  startedAt: string;
  /** /v1/models 列表请求 */
  modelsCheck: { ok: boolean; httpStatus: number | null; latencyMs: number | null; modelCount: number | null; error?: string };
  /** 最小 chat 请求(max_tokens=1) */
  chatCheck: { ok: boolean; httpStatus: number | null; ttftMs: number | null; complete: boolean; error?: string };
  /** 综合判定:HTTP 2xx 且响应完整 */
  overall: { ok: boolean; status: "up" | "degraded" | "down" };
  /** 证书证据:http 站点或握手被跳过时为 { skipped, reason } */
  tls?: TlsInfo | { skipped: true; reason: string };
}

/**
 * 长上下文完整性(标记码法)。确定性证据,不参与评分(见 docs/ 与 .codebuddy/plans 的实施方案)。
 * 判读:complete 全部标记码命中;tail_truncated 末尾连续缺失(典型截断);
 *       compressed 中间有规律缺失(摘要/滑窗);inconclusive 报错/格式不符/无样本 —— 不判负也不判通过。
 */
export type ContextVerdict = "complete" | "tail_truncated" | "compressed" | "inconclusive";

export interface ContextCase {
  targetChars: number;
  reportedPromptTokens: number | null;
  canaries: number;
  returned: number;
  hitPct: number;
  /** 缺失的标记码序号(1-based),可回溯到原文位置 */
  missing: number[];
  verdict: ContextVerdict;
}

export interface ContextResult {
  task: "context";
  site: string;
  checkedAt: string;
  model: string;
  samples: number;
  cases: ContextCase[];
  verdict: ContextVerdict;
  /** 完全通过的档位里的最大字符数;全 inconclusive 时为 null(未测就是未测) */
  maxVerifiedChars: number | null;
}

/** 探针 B:价格快照 */
export interface PriceResult {
  task: "price";
  site: string;
  capturedAt: string;
  currency: "CNY" | "USD";
  models: Array<{
    model: string;
    input: number;      // /M 标价(按 currency);new-api 系 = 「主口径分组」的价(默认组优先,见 groupKind)
    output: number;
    cacheRead: number | null;
    cacheWrite: number | null;
    group: string;
    /** 主口径所在组的组倍率(= 到手价三因子之一) */
    grpRatio?: number;
    /** 官方价格(基础价,不含组倍率):到手价 = base.input × grpRatio × 充值比例 */
    base?: { input: number; output: number; cacheRead: number | null };
    /** 主口径是怎么选的:default=站方默认组(普通注册用户) / median=无默认组取中位倍率组 / cheapest=兜底(旧数据) */
    groupKind?: "default" | "median" | "cheapest";
    /** 该模型全部可用分组的组倍率与价格(额度价口径,不乘充值比例) */
    groups?: Array<{ group: string; ratio: number; input: number; output: number; cacheRead: number | null }>;
    source: string;     // 采集来源(api|pricing-page),可追溯
  }>;
  ratio: { cny: number; usd: number } | null;
  parser: string;       // 解析器名
  parseErrors: string[]; // 解析失败项记录(不影响成功项)
}

/** dist/prices.json —— 比价页数据 */
export interface DistPrices extends DistMeta {
  sites: Array<{
    site: string;
    currency: "CNY" | "USD";
    models: PriceResult["models"];
    ratio: { cny: number; usd: number } | null;
    parser: string;
    capturedAt: string;
  }>;
}

/** 统一批次包装 */
export interface Batch<T = unknown> {
  batchId: string;      // RL-RC-YYYYMMDD-NNN
  site: string;
  task: TaskName;
  startedAt: string;
  ok: boolean;
  result: T;
}

// ---------- 存储 ----------
export interface RawArchive {
  path: string;         // store/raw/{site}/{batchId}.json
  batchId: string;
}

export interface EventRow {
  ts: string;
  site: string;
  type: string;         // outage | degraded | recovered | price_surge | task_failed | ...
  payload: string;      // JSON
}

// ---------- dist 产物 ----------
export interface DistMeta {
  updated: string;      // ISO 8601
  version: string;      // vYYYY.MM.DD-NNN
  license: "CC-BY-4.0";
}

/** dist/stats.json —— 首页信任标语 */
export interface DistStats extends DistMeta {
  sitesMonitored: number;
  healthChecks24h: number;
  batchesTotal: number;
  outages: number;      // 24h 内 down 事件数
}

/** dist/ranking.json —— 榜单(与前端 SITES 字段对齐,P1 仅基础项) */
export interface DistRankingSite {
  name: string;
  status: "g" | "y" | "r";
  avail7d: number | null;   // % · P1 由 health 探针滚动计算
  lastCheckAt: string;
  batches: number;          // 完整批次数(置信度 = min(1, batches/12))
  score: number | null;     // P1 未满 12 批次时为 null(展示"数据不足")
  dataLayer: "p1" | "p2";   // 哪个数据层支撑此站
}
