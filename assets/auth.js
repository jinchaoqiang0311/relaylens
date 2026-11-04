/* RelayLens shared login component
 * RL_API_BASE - worker address (fill after deploy; placeholder = honest "not online" prompts)
 * rlSession() / rlLogin(then) / rlApi(method, path, body) */
var RL_API_BASE = "";

function _rlToast(m) { if (typeof toast === "function") toast(m); else alert(m); }
function rlSession() {
  try {
    var s = JSON.parse(localStorage.getItem("rl_session") || "null");
    if (s && s.expires_at && new Date(s.expires_at) < new Date()) { localStorage.removeItem("rl_session"); return null; }
    return s;
  } catch (e) { return null; }
}
function rlSaveSession(j) { localStorage.setItem("rl_session", JSON.stringify(j)); }
function rlLogout() { localStorage.removeItem("rl_session"); }
function rlApi(method, path, body) {
  return fetch(RL_API_BASE + path, {
    method: method,
    headers: Object.assign({ "Content-Type": "application/json" }, rlSession() ? { Authorization: "Bearer " + rlSession().token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
}

function rlLogin(then) {
  if (!RL_API_BASE) { _rlToast("账号服务尚未上线——部署 api-worker 后回填 RL_API_BASE 即启用"); return; }
  var s = rlSession();
  if (s) { then(s); return; }
  localStorage.setItem("rl_return", location.pathname.split("/").pop() + location.hash);
  _rlModal(then);
}

function _rlModal(then) {
  var m = document.createElement("div");
  m.id = "rlLoginMask";
  m.style.cssText = "position:fixed;inset:0;background:rgba(12,22,51,.55);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px";
  m.innerHTML =
    '<div style="background:#fff;border-radius:16px;max-width:420px;width:100%;padding:26px 28px">' +
    '<div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0;font-size:18px">登录 RelayLens</h3><button id="rlX" style="border:none;background:none;font-size:24px;cursor:pointer">×</button></div>' +
    '<p style="font-size:12.5px;color:#667085;background:#f0f5ff;border-radius:9px;padding:10px 12px;line-height:1.7">邮箱验证码或 GitHub 登录。登录后可发表评论、认领站点。</p>' +
    '<div id="rlStep1"><input id="rlEmail" type="email" placeholder="邮箱 you@example.com" style="width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #d0d5dd;border-radius:9px;margin-bottom:10px">' +
    '<button id="rlSend" style="width:100%;padding:10px;border:none;border-radius:9px;background:#2b5cf0;color:#fff;font-weight:700;cursor:pointer">发送验证码</button>' +
    '<div style="text-align:center;margin:12px 0;color:#98a2b3;font-size:12px">—— 或 ——</div>' +
    '<button id="rlGh" style="width:100%;padding:10px;border:1px solid #d0d5dd;border-radius:9px;background:#fff;font-weight:700;cursor:pointer">使用 GitHub 登录</button></div>' +
    '<div id="rlStep2" style="display:none"><input id="rlCode" inputmode="numeric" maxlength="6" placeholder="6 位验证码" style="width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #d0d5dd;border-radius:9px;letter-spacing:4px;margin-bottom:10px">' +
    '<button id="rlVerify" style="width:100%;padding:10px;border:none;border-radius:9px;background:#2b5cf0;color:#fff;font-weight:700;cursor:pointer">验证并登录</button></div>' +
    '<div id="rlErr" style="display:none;background:#fee4e2;color:#b42318;font-size:12.5px;padding:8px 12px;border-radius:8px;margin-top:10px"></div></div>';
  document.body.appendChild(m);
  var err = function (t) { var e = m.querySelector("#rlErr"); e.textContent = t; e.style.display = "block"; };
  m.querySelector("#rlX").onclick = function () { m.remove(); };
  m.querySelector("#rlGh").onclick = function () { location.href = RL_API_BASE + "/auth/github/start"; };
  m.querySelector("#rlSend").onclick = async function () {
    var email = m.querySelector("#rlEmail").value.trim();
    this.disabled = true;
    try {
      var r = await rlApi("POST", "/auth/email/start", { email: email });
      var j = await r.json();
      if (!r.ok) { err(j.error === "email_provider_not_configured" ? "邮件服务未配置(部署侧需 RESEND_API_KEY)" : j.error); return; }
      m.querySelector("#rlStep1").style.display = "none";
      m.querySelector("#rlStep2").style.display = "block";
    } catch (e) { err("网络错误"); } finally { this.disabled = false; }
  };  m.querySelector("#rlVerify").onclick = async function () {
    var code = m.querySelector("#rlCode").value.trim();
    var email = m.querySelector("#rlEmail").value.trim();
    this.disabled = true;
    try {
      var r = await rlApi("POST", "/auth/email/verify", { email: email, code: code });
      var j = await r.json();
      if (!r.ok) { err(j.error === "code_mismatch" ? "验证码不对" : j.error); return; }
      rlSaveSession(j);
      m.remove();
      _rlToast("登录成功");
      if (then) then(j);
    } catch (e) { err("网络错误"); } finally { this.disabled = false; }
  };
  m.addEventListener("click", function (e) { if (e.target === m) m.remove(); });
}