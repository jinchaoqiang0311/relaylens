"use strict";
/* Model inventory: union of stations' latest price snapshots, grouped by family. Read-only. */
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const REPO = path.join(__dirname, "..", "..");
const db = new DatabaseSync(path.join(REPO, "probe", "store", "relaylens.sqlite"), { readOnly: true });

function canonName(raw) {
  let n = String(raw == null ? "" : raw).toLowerCase();
  n = n.replace(/^[a-z0-9._-]+[/]/, "");
  n = n.replace(/[:].*$/, "");
  n = n.replace(/[.]/g, "-");
  n = n.replace(/(?:-(?:preview|customtools|latest|image))+$/g, "");
  return n;
}
const mt = fs.readFileSync(path.join(REPO, "probe", "src", "parsers", "models.ts"), "utf8");
const CANON = new Set([...mt.matchAll(/canon:\s*"([^"]+)"/g)].map(function(m){ return m[1]; }));

const FAM_PREFIXES = [
  ["gpt", "OpenAI"], ["o1", "OpenAI"], ["o3", "OpenAI"], ["o4", "OpenAI"], ["chatgpt", "OpenAI"], ["davinci", "OpenAI"],
  ["claude", "Anthropic"],
  ["gemini", "Google"], ["gemma", "Google"],
  ["deepseek", "DeepSeek"],
  ["glm", "Zhipu"], ["chatglm", "Zhipu"], ["codegeex", "Zhipu"],
  ["kimi", "Moonshot"], ["moonshot", "Moonshot"],
  ["qwen", "Qwen"], ["qwq", "Qwen"],
  ["grok", "xAI"],
  ["doubao", "ByteDance"], ["seed-", "ByteDance"], ["ui-tars", "ByteDance"],
  ["hunyuan", "Tencent"],
  ["minimax", "MiniMax"], ["abab", "MiniMax"],
  ["llama", "Meta"],
  ["mistral", "Mistral"], ["mixtral", "Mistral"], ["codestral", "Mistral"], ["magistral", "Mistral"], ["devstral", "Mistral"], ["pixtral", "Mistral"],
  ["ernie", "Baidu"], ["spark", "iFlytek"], ["step-", "StepFun"], ["yi-", "01.AI"],
  ["nova", "Amazon"], ["command", "Cohere"], ["jamba", "AI21"], ["phi", "Microsoft"], ["baichuan", "Baichuan"], ["mimo", "Xiaomi"],
];
function fam(raw) {
  const n = canonName(raw);
  for (const p of FAM_PREFIXES) if (n.indexOf(p[0]) === 0) return p[1];
  return "Other";
}

const stations = db.prepare("SELECT DISTINCT site FROM batches WHERE task='price'").all().map(function(r){ return r.site; });
const inv = {};
let rawTotal = 0;
for (const site of stations) {
  const row = db.prepare("SELECT summary FROM batches WHERE site=? AND task='price' ORDER BY started_at DESC LIMIT 1").get(site);
  if (!row) continue;
  if (!row.summary) continue;
  let j;
  try { j = JSON.parse(row.summary); } catch (e) { continue; }
  if (!Array.isArray(j.models)) continue;
  for (const m of j.models) {
    if (!m) continue;
    if (!m.model) continue;
    rawTotal++;
    const key = canonName(m.model);
    if (!inv[key]) inv[key] = { key: key, raw: new Set(), stations: new Set(), fam: fam(m.model) };
    inv[key].raw.add(m.model);
    inv[key].stations.add(site);
  }
}
const all = Object.values(inv);
const fams = {};
all.forEach(function(m){ if (!fams[m.fam]) fams[m.fam] = []; fams[m.fam].push(m); });
const order = Object.keys(fams).sort(function(a,b){ return fams[b].length - fams[a].length; });

console.log("== TOTAL ==");
console.log("raw names " + rawTotal + " -> distinct " + all.length + " / stations " + stations.length + " / in CANON " + all.filter(function(m){ return CANON.has(m.key); }).length);
for (const f of order) {
  const arr = fams[f].sort(function(a,b){ return b.stations.size - a.stations.size; });
  const inC = arr.filter(function(m){ return CANON.has(m.key); }).length;
  console.log("");
  console.log("[FAM " + f + "] " + arr.length + " models (" + inC + " in CANON)");
  arr.forEach(function(m){
    const flag = CANON.has(m.key) ? "*" : " ";
    const raws = Array.from(m.raw).slice(0, 3).join(" | ");
    console.log("  " + flag + " " + m.key.padEnd(40) + String(m.stations.size).padStart(2) + " sites  " + raws + (m.raw.size > 3 ? " ..." : ""));
  });
}
console.log("");
console.log("== candidates: >=3 sites but not in CANON ==");
all.filter(function(m){ return !CANON.has(m.key) && m.stations.size >= 3; })
  .sort(function(a,b){ return b.stations.size - a.stations.size; })
  .forEach(function(m){ console.log("  " + m.fam.padEnd(10) + " " + m.key.padEnd(40) + m.stations.size + " sites"); });