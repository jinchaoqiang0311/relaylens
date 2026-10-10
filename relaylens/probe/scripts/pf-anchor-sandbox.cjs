/* PF 锚点校准沙盘:对比「统一锚」与「分模型类别锚」下各站 PF 分与场景综合分的变化
   只读分析,不改任何数据。 */
const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..", "..", ".."); // scripts→probe→relaylens→仓库根
const W = JSON.parse(fs.readFileSync(path.join(REPO, "relaylens", "shared", "weights.json"), "utf8"));
const S = JSON.parse(fs.readFileSync(path.join(REPO, "relaylens-home", "data", "sites.json"), "utf8"));

// 当前统一锚(与 score.ts pfScore 一致):<=1s=100, >=8s=0 线性
function pfUnified(ms) { const s = ms / 1000; return Math.max(0, Math.min(100, 100 - ((s - 1) / 7) * 100)); }

// 候选方案(供拍板,未生效):
// A. 双锚:普通模型不变;推理系/高注入链路放宽为 <=2s=100, >=12s=0
//    依据:推理模型首 token 含思考调度;号池注入 4~5k token 的预填充是链路固有成本
// B. 三档:普通(1s/8s)、推理(2s/12s)、快响应小模型(0.6s/5s)
// C. 只把满分点从 1s 放宽到 1.5s,底线 8s 不变(最保守)
const SCHEMES = {
  unified:  { label: "现行统一锚", anchors: { normal: [1, 8] } },
  A_dual:   { label: "方案A 双锚(普通1/8, 推理2/12)", anchors: { normal: [1, 8], reasoning: [2, 12] } },
  C_mild:   { label: "方案C 温和(满分点1.5s, 底线8s)", anchors: { normal: [1.5, 8] } },
};
function pfByAnchors(ms, a) { const s = ms / 1000; const [lo, hi] = a; return Math.max(0, Math.min(100, 100 - ((s - lo) / (hi - lo)) * 100)); }

// 每站 TTFT 与测量模型
const rows = S.realSites.filter(r => r.ttftMs != null).map(r => ({
  name: r.name, ttftMs: r.ttftMs, samples: r.metrics && r.metrics.ttftSamples,
  model: (r.probe && r.probe.model) || "gpt-5.5",
  score: r.score,
}));

console.log("== 实测 TTFT 分布 ==");
rows.sort((a, b) => a.ttftMs - b.ttftMs).forEach(r => {
  console.log(`${r.name.padEnd(14)} ttft=${String(r.ttftMs).padStart(6)}ms samples=${String(r.samples).padStart(3)} model=${r.model}`);
});

// 注:探针统一用 gpt-5.5 测量,没有分模型类别测量 → 「分模型锚点」目前没有数据入口!
// 沙盘先回答:如果按方案放宽锚点,哪些站的 PF/综合分会变、变多少。
console.log("\n== 各方案 PF 分对比 ==");
const header = ["site".padEnd(14), "ttft(s)".padEnd(8), ...Object.keys(SCHEMES).map(k => k.padEnd(10))].join("");
console.log(header);
rows.forEach(r => {
  const cells = Object.entries(SCHEMES).map(([k, sc]) => String(Math.round(pfByAnchors(r.ttftMs, sc.anchors.normal))).padEnd(10));
  console.log([r.name.padEnd(14), (r.ttftMs / 1000 + "s").padEnd(8), ...cells].join(""));
});

// 场景综合分影响(仅 PF 权重部分,其余指标不变 → Δ综合 = ΔPF × 权重占比)
console.log("\n== 场景综合分变化(Δ = (新PF-旧PF)×PF权重/该场景权重和,其余未测时按重归一化) ==");
for (const scene of ["all", "code", "office", "ecom", "drama", "biz"]) {
  const sw = W.scenes[scene];
  const wsum = Object.keys(sw).filter(k => k !== "label").reduce((s, k) => s + sw[k], 0);
  const pfW = sw.PF || 0;
  if (!pfW) { console.log(`${scene}: PF权重0,跳过`); continue; }
  console.log(`-- 场景 ${scene} (PF权重 ${pfW}/${wsum}) --`);
  rows.forEach(r => {
    const oldPf = pfByAnchors(r.ttftMs, SCHEMES.unified.anchors.normal);
    for (const key of ["A_dual", "C_mild"]) {
      const newPf = pfByAnchors(r.ttftMs, SCHEMES[key].anchors.normal);
      const d = ((newPf - oldPf) * pfW / wsum);
      if (Math.abs(d) >= 0.5) console.log(`   ${r.name.padEnd(14)} ${key}: ${d >= 0 ? "+" : ""}${d.toFixed(1)} 分`);
    }
  });
}
