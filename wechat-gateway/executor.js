/**
 * 指令白名单执行器 + 串行队列。
 * 安全设计:
 * 1. 微信消息绝不透传给 shell / AI 当指令,只允许下方注册表里的任务;
 * 2. billing(真实扣费)必须二次确认:「确认」继续,5 分钟内有效,「取消」放弃;
 * 3. 同一时刻只跑一个长任务,避免并发写坏 sqlite(项目铁律)。
 */
const { spawn } = require("node:child_process");
const { statusSummary, siteDetail, metaSummary } = require("./status");

const CONFIRM_TTL_MS = 5 * 60 * 1000;

/** 探针任务白名单;danger=true 需二次确认 */
const TASKS = {
  "health": { args: "once --task=health", danger: false, desc: "健康检查全量(免费)" },
  "price": { args: "once --task=price", danger: false, desc: "定价抓取全量(免费)" },
  "perf": { args: "perf --site=all --force", danger: false, desc: "TTFT+流式专项" },
  "fingerprint": { args: "fingerprint --site=all", danger: false, desc: "跨站差分指纹" },
  "sync": { args: "sync", danger: false, desc: "重建 sites.json" },
  "billing": { args: null, danger: true, desc: "真实扣费,需指明 --site=站名,二次确认后执行" },
};

const HELP = [
  "🤖 RelayLens 微信指令",
  "状态 - 全站汇总",
  "站点 <关键词> - 单站详情",
  "口径 - 汇率/权重版本",
  "任务 <名> - health/price/perf/fingerprint/sync/billing",
  "确认 / 取消 - billing 等危险任务二次确认",
  "cb <问题> - 问 CodeBuddy(需管理员在本机启用)",
  "帮助 - 本列表",
].join("\n");

class Executor {
  constructor(cfg) {
    this.cfg = cfg;
    this.pendingConfirm = new Map(); // userId -> { argv, expireAt }
    this.queue = [];
    this.running = false;
    this.queueSeq = 0;
  }

  /**
   * 处理一条指令。返回值:要立即回复的文本(可空,空=结果将异步推送)。
   * notify: 异步推送函数(text) => Promise
   */
  async handle(userId, text, notify) {
    const argv = String(text || "").trim().split(/\s+/).filter(Boolean);
    if (argv.length === 0) return HELP;
    const cmd = argv[0].toLowerCase();

    switch (cmd) {
      case "帮助":
      case "help":
      case "?":
        return HELP;
      case "状态":
      case "status":
        return statusSummary(this.cfg.sitesJson);
      case "站点":
      case "site":
        return siteDetail(this.cfg.sitesJson, argv.slice(1).join(" "));
      case "口径":
      case "meta":
        return metaSummary(this.cfg.sitesJson);
      case "任务":
      case "task":
        return this.handleTask(userId, argv.slice(1), notify);
      case "确认":
      case "confirm":
        return this.takeConfirm(userId, notify);
      case "取消":
      case "cancel":
        return this.pendingConfirm.delete(userId) ? "已取消待确认任务" : "没有待确认的任务";
      case "cb":
        return this.handleCodebuddy(argv.slice(1).join(" "), notify);
      default:
        return `未知指令「${argv[0]}」。回复「帮助」查看指令列表。`;
    }
  }

  /** ---------- 探针任务 ---------- */
  handleTask(userId, rest, notify) {
    const name = (rest[0] || "").toLowerCase();
    if (!name) {
      return "可用任务: " + Object.entries(TASKS).map(([k, v]) => `${k}(${v.danger ? "需确认" : ""})`).join(" ");
    }
    const task = TASKS[name];
    if (!task) return `未知任务「${name}」。可用: ${Object.keys(TASKS).join(" / ")}`;

    if (task.danger) {
      // 危险任务:记录待确认,绝不直接执行
      this.pendingConfirm.set(userId, { task: name, rest, expireAt: Date.now() + CONFIRM_TTL_MS });
      return (
        `⚠「${name}」会产生真实扣费(分/厘级)。\n将执行: ${this.cfg.probe.cmd} ${rest.join(" ")}\n` +
        `回复「确认」继续,「取消」放弃(5 分钟内有效)。`
      );
    }

    const cmdLine = `${this.cfg.probe.cmd} ${task.args}`;
    return this.enqueue(cmdLine, this.cfg.probe, notify);
  }

  takeConfirm(userId, notify) {
    const pending = this.pendingConfirm.get(userId);
    if (!pending) return "没有待确认的任务";
    this.pendingConfirm.delete(userId);
    if (Date.now() > pending.expireAt) return "待确认任务已过期,请重新发起";
    if (pending.task !== "billing") return "该任务无需确认";
    if (pending.rest.length < 2) return "缺少 --site=站名 参数,请重新发起";
    const cmdLine = `${this.cfg.probe.cmd} ${pending.rest.join(" ")}`;
    return this.enqueue(cmdLine, this.cfg.probe, notify);
  }

  /** ---------- CodeBuddy headless(可选) ---------- */
  handleCodebuddy(question, notify) {
    const cb = this.cfg.codebuddy || {};
    if (!cb.enabled) return "CodeBuddy headless 未启用(管理员需在 config.json 中开启 codebuddy.enabled)";
    if (!question) return "用法: cb <问题>";
    const args = (cb.args || []).join(" ");
    // 问题只作为最后一个参数传入并去掉引号,防止拼接出额外命令
    const safeQ = question.replace(/["`$]/g, "");
    return this.enqueue(`${cb.cmd} ${args} "${safeQ}"`, { cwd: this.cfg.probe.cwd, timeoutMin: cb.timeoutMin || 10 }, notify);
  }

  /** ---------- 串行队列 ---------- */
  enqueue(cmdLine, opts, notify) {
    const id = ++this.queueSeq;
    const pos = this.queue.length + (this.running ? 1 : 0);
    this.queue.push({ id, cmdLine, opts });
    this.pump(notify);
    return pos > 1
      ? `已入队 #${id}(排队第 ${pos} 位): ${cmdLine}`
      : `已开始 #${id}: ${cmdLine}\n完成后自动推送结果。`;
  }

  pump(notify) {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = true;
    runShell(job.cmdLine, job.opts)
      .then((out) =>
        notifySafe(notify, `✅ #${job.id} 完成\n${out}`)
      )
      .catch((e) => notifySafe(notify, `❌ #${job.id} 失败\n${e.message}`))
      .finally(() => {
        this.running = false;
        this.pump(notify);
      });
  }
}

function notifySafe(notify, text) {
  if (typeof notify !== "function") return Promise.resolve();
  return Promise.resolve()
    .then(() => notify(text))
    .catch((e) => console.error("[wechat-gateway] 推送失败:", e.message));
}

/** 执行 shell 命令,返回末尾输出摘要;永不回显 key */
function runShell(cmdLine, opts) {
  const timeoutMs = ((opts.timeoutMin || 30) * 60 + 30) * 1000;
  return new Promise((resolve, reject) => {
    const child = spawn(cmdLine, {
      shell: true,
      cwd: opts.cwd,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1" },
    });
    let out = "";
    const grab = (c) => {
      out += c.toString();
      if (out.length > 400000) out = out.slice(-200000); // 防止长日志撑爆内存
    };
    child.stdout.on("data", grab);
    child.stderr.on("data", grab);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`进程启动失败: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const tail = out.trim().split("\n").slice(-12).join("\n");
      if (code === 0) resolve(tail || "(无输出)");
      else reject(new Error(`exit=${code}\n${tail}`));
    });
  });
}

module.exports = { Executor, TASKS };
