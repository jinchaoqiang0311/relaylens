/* 矩阵比价视图(2026-10-11):模型×站点价格矩阵,交互对齐 relaybench 比价页。
 * 数据:sites.json compare.tabs(每模型×每站多渠道价)+ realSites(effRatio/实测指标)。
 * 口径:默认美元额度价($/M,跨站可比);到手价视图 = 额度价 × 站方声明充值比例(未声明如实标注,绝不按汇率猜)。
 * 本列最佳 = 同模型各站主口径价最低者(绿色);特价组更低时另挂黄色角标。 */
(function () {
  var MODELS = [], SITES = [], EFF = {}, q = "", effMode = false;

  function fmtP(v) { return v == null ? "—" : "$" + (Math.round(v * 100) / 100); }
  function fmtY(v) { return v == null ? "—" : "¥" + (Math.round(v * 100) / 100); }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function natSort(a, b) { return String(b).localeCompare(String(a), undefined, { numeric: true }); }

  window.renderMatrix = function (payload) {
    var c = payload.compare;
    if (!c || !c.tabs || !c.tabs.length) return;
    MODELS = c.tabs;
    SITES = payload.realSites || [];
    EFF = {};
    SITES.forEach(function (s) { EFF[s.name] = s.effRatio; });
    render();
  };

  function stationOrder() {
    var seen = [], inSet = {};
    MODELS.forEach(function (m) { m.rows.forEach(function (r) { if (!inSet[r.site]) { inSet[r.site] = 1; seen.push(r.site); } }); });
    // 按榜单出现顺序优先(实测站靠前),未知站点追加在后
    var ordered = SITES.map(function (s) { return s.name; }).filter(function (n) { return inSet[n]; });
    seen.forEach(function (n) { if (ordered.indexOf(n) < 0) ordered.push(n); });
    return ordered;
  }

  function filteredModels() {
    return MODELS.filter(function (m) {
      return !q || (m.name + " " + m.key + " " + (m.family || "")).toLowerCase().indexOf(q) > -1;
    });
  }

  function render() {
    var table = document.getElementById("mxTable");
    if (!table) return;
    var stations = stationOrder();
    var models = filteredModels();
    document.getElementById("mxCount").textContent =
      models.length + " 个模型 × " + stations.length + " 个站点" + (q ? "(已筛选)" : "") + (effMode ? " · 到手价视图" : "");

    /* 按模型族分组,族内版本倒序 */
    var fams = [];
    var byFam = {};
    models.forEach(function (m) {
      var f = m.family || "其他";
      if (!byFam[f]) { byFam[f] = []; fams.push(f); }
      byFam[f].push(m);
    });
    Object.keys(byFam).forEach(function (f) {
      byFam[f].sort(function (a, b) { return natSort(a.name, b.name); });
    });

    var h = '<thead><tr><th class="mx-model">模型 <span style="font-weight:400;color:var(--faint)">(官方锚 $/M)</span></th>';
    stations.forEach(function (st) { h += "<th>" + esc(st) + "</th>"; });
    h += "</tr></thead><tbody>";

    fams.forEach(function (f) {
      h += '<tr class="mx-fam"><td colspan="' + (stations.length + 1) + '">' + esc(f) + "</td></tr>";
      byFam[f].forEach(function (m) {
        var priceMap = {};
        m.rows.forEach(function (r) { priceMap[r.site] = r; });
        var cellVal = function (r) {
          if (!r || r.inP == null) return null;
          if (!effMode) return r.inP;
          var ratio = EFF[r.site];
          return ratio == null ? null : Math.round(r.inP * ratio * 100) / 100;
        };
        var vals = stations.map(function (st) { var r = priceMap[st]; return r ? cellVal(r) : null; })
          .filter(function (v) { return v != null; });
        var min = vals.length ? Math.min.apply(null, vals) : null;
        h += '<tr><td class="mx-model" data-mkey="' + esc(m.key) + '" data-mname="' + esc(m.name) + '">' +
          '<div class="nm">' + esc(m.name) + "</div>" +
          '<div class="fm">' + esc(m.family || "") + " · 官方 " + (m.official ? "$" + m.official.in : "—") + "/M" +
          (effMode ? " · 未声明站显示额度价" : "") + "</div></td>";
        stations.forEach(function (st) {
          var r = priceMap[st];
          var v = r ? cellVal(r) : null;
          if (v == null) {
            var undeclared = effMode && r && EFF[st] == null && r.inP != null;
            h += '<td class="' + (undeclared ? "mx-undec" : "") + '">' + (undeclared ? "额度 $" + r.inP + " · 比例未声明" : "—") + "</td>";
            return;
          }
          var isBest = min != null && v === min;
          var cls = isBest ? "mx-best" : "";
          var fmt = effMode ? fmtY(v) : fmtP(v);
          var tip = "";
          if (r) {
            tip = "标价 " + fmtP(r.inP) + "/M(主口径 · " + esc(r.group || "—") + ")";
            if (EFF[st] != null) tip += " → 到手 " + fmtY(Math.round(r.inP * EFF[st] * 100) / 100) + "/M(比例 ¥" + EFF[st] + "=1$)";
            if (r.cacheP != null) tip += " · 缓存 " + fmtP(r.cacheP) + "/M";
            if (r.special) tip += "\n特价组「" + esc(r.special.group) + "」:" + fmtP(r.special.inP) + "/M(倍率 ×" + r.special.ratio + ")";
          }
          h += '<td class="' + cls + '" title="' + esc(tip) + '">' + fmt +
            (r && r.special && r.special.inP != null && r.special.inP < r.inP ? '<div class="mx-spec">特价 ' + (effMode && EFF[st] != null ? fmtY(r.special.inP * EFF[st]) : fmtP(r.special.inP)) + "</div>" : "") +
            "</td>";
        });
        h += "</tr>";
      });
    });
    h += "</tbody>";
    table.innerHTML = h;

    Array.prototype.forEach.call(table.querySelectorAll(".mx-model[data-mkey]"), function (td) {
      td.addEventListener("click", function () {
        /* 点模型 → 单模型价格页(按渠道视图优先,分组明细在「按站聚合」里) */
        location.href = "price.html?model=" + encodeURIComponent(td.dataset.mkey) + "&view=channel";
      });
    });
  }

  /* 模型详情抽屉:各站全部渠道 + 实测质量(与价格矩阵同源) */
  function showDetail(m, stations) {
    var box = document.getElementById("mxDetail");
    box.style.display = "block";
    var realByName = {};
    SITES.forEach(function (s) { realByName[s.name] = s; });
    var h = '<div class="card" style="padding:18px 20px">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">' +
      '<h3 style="font-size:16px;font-weight:800;margin:0">' + esc(m.name) + ' <span style="font-size:12px;color:var(--faint)">' + esc(m.family || "") + "</span></h3>" +
      '<span style="font-size:12px;color:var(--sub)">官方锚:输入 $' + (m.official ? m.official.in : "—") + " / 输出 $" + (m.official ? m.official.out : "—") + "/M" + (m.official && m.official.cr != null ? " · 缓存 $" + m.official.cr : "") + "</span>" +
      '<button class="btn btn-ghost btn-sm" id="mxDClose">收起</button></div>';
    h += '<div style="overflow:auto;margin-top:10px"><table class="mx-detail-table"><thead><tr>' +
      "<th>站点</th><th>分组</th><th>输入 $/M</th><th>输出 $/M</th><th>缓存 $/M</th><th>到手价</th><th>实测质量</th></tr></thead><tbody>";
    stations.forEach(function (st) {
      var r = m.rows.filter(function (x) { return x.site === st; })[0];
      if (!r) return;
      var s = realByName[st] || {};
      var qc = [];
      if (s.dev != null) qc.push('<span class="mx-qchip">对账偏差 ' + s.dev + "%</span>");
      if (s.ttftMs != null) qc.push('<span class="mx-qchip">首字 ' + (s.ttftMs < 1000 ? s.ttftMs + "ms" : (s.ttftMs / 1000).toFixed(1) + "s") + "</span>");
      if (s.fp && s.fp !== "pending") qc.push('<span class="mx-qchip">指纹 ' + (s.fp === "pass" ? "通过" : s.fp === "suspect" ? "存疑" : "未过") + "</span>");
      if (!qc.length) qc.push('<span class="mx-qchip">监测中</span>');
      var eff = EFF[st] != null ? fmtY(Math.round((r.inP || 0) * EFF[st] * 100) / 100) + "/M" : "比例未声明";
      h += "<tr><td><b>" + esc(st) + "</b></td><td>" + esc(r.group || "—") + (r.special ? ' <span class="mx-spec">+特价「' + esc(r.special.group) + "」</span>" : "") +
        "</td><td>" + fmtP(r.inP) + "</td><td>" + fmtP(r.outP) + "</td><td>" + (r.cacheP == null ? "—" : fmtP(r.cacheP)) +
        "</td><td>" + eff + "</td><td>" + qc.join("") + "</td></tr>";
      if (r.special) {
        h += '<tr><td style="color:var(--faint)">└ 特价</td><td>' + esc(r.special.group) + '</td><td class="mx-spec">' + fmtP(r.special.inP) +
          '</td><td class="mx-spec">' + fmtP(r.special.outP) + "</td><td>—</td><td>" + (EFF[st] != null ? fmtY(Math.round(r.special.inP * EFF[st] * 100) / 100) + "/M" : "—") + "</td><td></td></tr>";
      }
    });
    h += "</tbody></table></div></div>";
    box.innerHTML = h;
    document.getElementById("mxDClose").onclick = function () { box.style.display = "none"; };
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  /* 视图切换 + 搜索 + 到手价开关 */
  function bind() {
    var mx = document.getElementById("matrixView"), sv = document.getElementById("siteView");
    var bm = document.getElementById("vBtnMatrix"), bs = document.getElementById("vBtnSite");
    if (!mx || !bm) return;
    function show(which) {
      mx.style.display = which === "mx" ? "" : "none";
      if (sv) sv.style.display = which === "sv" ? "" : "none";
      var av = document.getElementById("allView");
      if (av) av.style.display = which === "all" ? "" : "none";
      bm.className = which === "mx" ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm";
      if (bs) bs.className = which === "sv" ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm";
      var ba = document.getElementById("vBtnAll");
      if (ba) ba.className = which === "all" ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm";
    }
    bm.onclick = function () { show("mx"); };
    if (bs) bs.onclick = function () { show("sv"); };
    var ball = document.getElementById("vBtnAll");
    if (ball) ball.onclick = function () { show("all"); };
    var si = document.getElementById("mxSearch");
    if (si) si.addEventListener("input", function () { q = this.value.trim().toLowerCase(); render(); });
    var ef = document.getElementById("mxEff");
    if (ef) ef.addEventListener("change", function () { effMode = this.checked; render(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();
})();
