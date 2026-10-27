/*
 * 镜像内置：安装命令的内网地址支持。
 *
 * 两种模式（由 entrypoint 注入的 window.__WB_LAN__.toggle 决定）：
 *
 * 1. KOMARI_LAN_TOGGLE=1（勾选框模式）
 *    「一键部署指令」弹窗的「安装选项」末尾出现一条勾选项：
 *        ☑ 安装命令用内网地址（http://<容器内网IP>:<端口>）
 *    - 只在弹窗里存在，弹窗关了就随之消失，其它页面绝不渲染
 *    - 默认勾上（不管是域名还是内网 IP 打开面板）；取消勾选后按浏览器记住选择
 *      KOMARI_LAN_DEFAULT=0 可改成默认不勾（适合只想用域名装 agent 的部署）
 *    - 勾上后：命令框里的面板地址实时换成内网地址（agent 直连、不绕 Cloudflare），
 *      点「复制」拿到的内容同样已改写；取消勾选原样还原
 *    - 内网地址是 entrypoint 启动时探测的容器 IP，每家部署各自不同，镜像里零写死
 *
 * 2. 未开开关（静默模式）
 *    不渲染任何控件，把安装命令的面板地址自动换成「当前访问面板用的地址」。
 *
 * 关键实现细节（历代踩坑）：
 *   a) Komari 的安装命令在 <textarea> 的 value 里，不是文本节点——
 *      TreeWalker 扫文本节点永远扫不到，必须直接写 value。
 *   b) 弹窗是 Radix Dialog（position:fixed），元素 offsetParent 恒为 null，
 *      可见性判断必须用 getBoundingClientRect。
 *   c) 光写 textarea.value 不够：React 下一次重渲染会用自己 state 里的原命令
 *      把 DOM 值盖回去（表现为「勾上了但命令没变/又变回原样」）。
 *      所以要在 textarea 元素上劫持 value 的 setter：React 每次回写都被
 *      我们拦下，改写后再落到 DOM，原始命令单独记在 __wbBox.orig 里。
 */
(function () {
  "use strict";

  var boot = window.__WB_LAN__ || {};
  var lanOrigin = (boot.lanOrigin || "").replace(/\/+$/, "");
  var toggleMode = !!boot.toggle;
  var DEBUG = !!boot.debug;
  var STORE_KEY = "wb_lan_toggle";
  var ADDR_KEY = "wb_lan_addr"; // 用户手动改过的内网地址（本浏览器记住）
  var override = "";
  try {
    override = localStorage.getItem(ADDR_KEY) || "";
  } catch (e) {}
  var TA_DESC = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");

  /* ---------- 命令识别与地址改写 ---------- */

  function isCommand(text) {
    if (!text) return false;
    return (
      text.indexOf("install.sh") !== -1 ||
      text.indexOf("install.ps1") !== -1 ||
      text.indexOf("komari-agent") !== -1 ||
      text.indexOf("--endpoint") !== -1 ||
      /(?:^|\s)-e\s+https?:\/\//.test(text)
    );
  }

  // Komari 实际命令用 `-e`（Linux/macOS/Windows）或 `--endpoint`，两种都要认。
  // 兜底找面板地址时必须排除「下载安装脚本的 URL」（GitHub 的，绝不能改）。
  function findPanelOrigin(text, urls) {
    var m = text.match(/(?:^|\s)(?:--endpoint|-e)\s+(https?:\/\/[^\s"'<>]+)/i);
    if (m) return m[1];
    for (var i = 0; i < urls.length; i++) {
      var u = urls[i];
      if (/install\.(sh|ps1)/i.test(u)) continue;
      if (/github|gitee|gitlab|ghproxy|jsdelivr/i.test(u)) continue;
      return u;
    }
    return null;
  }

  function rewrite(text, target) {
    if (!text) return text;
    var urls = text.match(/https?:\/\/[^\s"'<>]+/g);
    if (!urls || !urls.length) return text;
    var found = findPanelOrigin(text, urls);
    if (!found) return text;
    var panelOrigin = found.replace(/\/+$/, "");
    target = (target || "").replace(/\/+$/, "");
    if (!target || panelOrigin === target) return text;
    var esc = panelOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(new RegExp(esc, "g"), target);
  }

  // 优先级：用户在弹窗里自己填的 > 容器启动时探测/环境变量给的 > 当前访问地址
  function targetOrigin() {
    return override || lanOrigin || location.origin;
  }

  /* ---------- 可见性：弹窗是 position:fixed，offsetParent 恒为 null ---------- */

  function visible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden";
  }

  /* ---------- 状态与调试日志 ---------- */

  var state = { checked: null, row: null, log: [] };

  function slog(msg, v) {
    if (!DEBUG) return;
    try {
      state.log.push(msg + " chk=" + state.checked + " v=" + (v || "").slice(-28));
      if (state.log.length > 28) state.log.shift();
    } catch (e) {}
  }

  /* ---------- textarea：劫持 value setter，React 回写也逃不掉 ---------- */

  function taBox(ta) {
    if (ta.__wbBox) return ta.__wbBox;
    var box = {
      ta: ta,
      orig: TA_DESC.get.call(ta), // 面板自己给的原始命令
      write: function (v) {
        TA_DESC.set.call(ta, v); // 我们自己的写入，不走拦截，避免污染 orig
      },
    };
    try {
      Object.defineProperty(ta, "value", {
        configurable: true,
        get: function () {
          return TA_DESC.get.call(ta);
        },
        set: function (v) {
          box.orig = v; // React 回填的一定是面板原始命令
          var out = state.checked ? rewrite(v, targetOrigin()) : v;
          TA_DESC.set.call(ta, out);
          if (out !== v) slog("trap", out);
        },
      });
    } catch (e) {}
    ta.__wbBox = box;
    return box;
  }

  function applyAll(dlg) {
    var tas = dlg.querySelectorAll("textarea");
    for (var i = 0; i < tas.length; i++) {
      var box = taBox(tas[i]);
      var want = state.checked ? rewrite(box.orig, targetOrigin()) : box.orig;
      if (TA_DESC.get.call(tas[i]) !== want) {
        box.write(want);
        slog("apply", want);
      }
    }
  }

  function getDialog() {
    var list = document.querySelectorAll(".rt-BaseDialogContent");
    for (var i = list.length - 1; i >= 0; i--) {
      if (visible(list[i]) && list[i].querySelector("textarea")) return list[i];
    }
    return null;
  }

  /* ---------- 静默模式：不渲染控件，只把地址换成当前访问地址 ---------- */

  function silentPass() {
    var i, box;
    try {
      var tas = document.querySelectorAll("textarea");
      for (i = 0; i < tas.length; i++) {
        if (!visible(tas[i])) continue;
        box = taBox(tas[i]);
        var want = rewrite(box.orig, location.origin.replace(/\/+$/, ""));
        if (TA_DESC.get.call(tas[i]) !== want) box.write(want);
      }
    } catch (e) {}
    try {
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      var n,
        target = location.origin.replace(/\/+$/, "");
      while ((n = walker.nextNode())) {
        var value = n.nodeValue;
        if (!value || !isCommand(value)) continue;
        var next = rewrite(value, target);
        if (next !== value) n.nodeValue = next;
      }
    } catch (e) {}
  }

  /* ---------- 勾选框模式 ---------- */

  // 默认值：默认勾上（用内网地址装 agent）。
  // 不能用「访问地址是不是内网 IP」来判断——很多人在局域网里也用域名打开面板，
  // 那时 hostname 是域名，按 IP 判断会永远默认不勾，等于这个选项白给。
  // 想默认用域名的人：KOMARI_LAN_DEFAULT=0，或自己取消勾选（记在 localStorage 里）。
  function defaultChecked() {
    try {
      var v = localStorage.getItem(STORE_KEY);
      if (v === "1") return true;
      if (v === "0") return false;
    } catch (e) {}
    if (!lanOrigin) return false; // 探测不到内网地址，勾了也没有可换的地址
    if (boot.checked === 0) return false;
    return true;
  }

  function applyCheck(btn) {
    btn.setAttribute("aria-checked", state.checked ? "true" : "false");
    btn.setAttribute("data-state", state.checked ? "checked" : "unchecked");
  }

  function ensureRow(dlg) {
    if (!lanOrigin) return false; // 没有可换的内网地址：不插这个没用的选项
    if (state.row && dlg.contains(state.row)) return true;
    state.row = null;
    var labels = dlg.querySelectorAll("label");
    var grid = null;
    for (var i = 0; i < labels.length; i++) {
      if (labels[i].textContent.trim() === "安装选项") {
        grid = labels[i].nextElementSibling;
        break;
      }
    }
    if (!grid) return false;

    var row = document.createElement("div");
    row.className = "rt-Flex rt-r-ai-center rt-r-gap-2";
    row.style.gridColumn = "1 / -1";
    row.setAttribute("data-wb-lan", "1");

    var btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "checkbox");
    btn.className =
      "rt-reset rt-BaseCheckboxRoot rt-CheckboxRoot rt-r-size-2 rt-variant-surface";

    var lab = document.createElement("label");
    lab.className = "text-sm font-normal";
    lab.style.cursor = "pointer";
    // 不写具体 IP/端口：那是每台部署各自不同的（容器 IP、nginx 端口都不一样），
    // 钉在界面上既是错的也会误导。真正的地址看命令框里的 -e 就知道。
    lab.textContent = "安装命令用内网地址";

    // 「改」：自动识别的地址不对时，自己填一个（不点开不显示任何地址）
    var edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "改";
    edit.title = "改内网地址";
    edit.setAttribute("data-wb-lan-edit", "1");
    edit.style.cssText =
      "margin-left:4px;padding:0 2px;font-size:12px;line-height:1;opacity:.55;cursor:pointer;background:none;border:0;color:inherit;text-decoration:underline;text-underline-offset:2px";

    row.appendChild(btn);
    row.appendChild(lab);
    row.appendChild(edit);
    grid.appendChild(row);

    function setOverride(v) {
      override = (v || "").replace(/\/+$/, "");
      try {
        if (override) localStorage.setItem(ADDR_KEY, override);
        else localStorage.removeItem(ADDR_KEY);
      } catch (e) {}
      applyAll(dlg);
      slog("override", override);
    }

    function openEditor() {
      if (row.querySelector("input")) return;
      var inp = document.createElement("input");
      inp.type = "text";
      inp.value = override || ""; // 空着 = 用自动识别的地址
      inp.placeholder = "留空=自动识别";
      inp.setAttribute("data-wb-lan-input", "1");
      inp.style.cssText =
        "width:170px;font-size:12px;padding:2px 6px;margin-left:4px;border:1px solid rgba(128,128,128,.45);border-radius:4px;background:transparent;color:inherit";
      var ok = document.createElement("button");
      ok.type = "button";
      ok.textContent = "确定";
      ok.setAttribute("data-wb-lan-ok", "1");
      ok.style.cssText = "font-size:12px;padding:2px 6px;margin-left:4px;cursor:pointer";
      var no = document.createElement("button");
      no.type = "button";
      no.textContent = "取消";
      no.setAttribute("data-wb-lan-cancel", "1");
      no.style.cssText = "font-size:12px;padding:2px 6px;margin-left:2px;cursor:pointer;opacity:.7";
      lab.style.display = "none";
      edit.style.display = "none";
      row.appendChild(inp);
      row.appendChild(ok);
      row.appendChild(no);
      try {
        inp.focus();
      } catch (e) {}

      function close() {
        inp.remove();
        ok.remove();
        no.remove();
        lab.style.display = "";
        edit.style.display = "";
      }
      function commit() {
        var v = (inp.value || "").trim().replace(/\/+$/, "");
        if (v && !/^https?:\/\/[^\s/]+$/i.test(v)) {
          inp.style.borderColor = "#e5484d";
          return;
        }
        setOverride(v);
        close();
      }
      ok.addEventListener("click", commit);
      no.addEventListener("click", close);
      inp.addEventListener("keydown", function (e) {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") close();
      });
    }

    edit.addEventListener("click", function (e) {
      e.preventDefault();
      openEditor();
    });

    function flip() {
      state.checked = !state.checked;
      applyCheck(btn);
      try {
        localStorage.setItem(STORE_KEY, state.checked ? "1" : "0");
      } catch (e) {}
      slog(state.checked ? "click->ON" : "click->OFF", "");
      applyAll(dlg);
    }

    btn.addEventListener("click", function (e) {
      e.preventDefault();
      flip();
    });
    lab.addEventListener("click", function (e) {
      e.preventDefault();
      flip();
    });

    state.row = row;
    applyCheck(btn);
    return true;
  }

  function togglePass() {
    var dlg = getDialog();
    if (!dlg) {
      state.row = null; // 弹窗关了：控件随 DOM 消失，只保留勾选状态
      return;
    }
    if (state.checked === null) state.checked = defaultChecked();
    if (!ensureRow(dlg)) return;
    applyAll(dlg);
  }

  /* ---------- 复制拦截：剪贴板 API + copy 事件双保险 ---------- */

  function hookClipboard() {
    try {
      if (!navigator.clipboard || navigator.clipboard.__wbHooked) return;
      var orig = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = function (t) {
        try {
          var on = toggleMode ? state.checked : true;
          if (on && isCommand(t)) {
            var out = rewrite(t, toggleMode ? targetOrigin() : location.origin);
            if (out !== t) return orig(out);
          }
        } catch (e) {}
        return orig(t);
      };
      navigator.clipboard.__wbHooked = true;
    } catch (e) {}
  }

  document.addEventListener(
    "copy",
    function (e) {
      try {
        if (!e.clipboardData) return;
        var on = toggleMode ? state.checked : true;
        if (!on) return;
        var picked = window.getSelection ? window.getSelection().toString() : "";
        if (!isCommand(picked)) return;
        var target = toggleMode ? targetOrigin() : location.origin;
        var out = rewrite(picked, target);
        if (out !== picked) {
          e.clipboardData.setData("text/plain", out);
          e.preventDefault();
        }
      } catch (err) {}
    },
    true
  );

  /* ---------- 启动 ---------- */

  function bootFn() {
    hookClipboard();
    var pass = toggleMode ? togglePass : silentPass;
    pass();
    setInterval(pass, toggleMode ? 600 : 1500);
    try {
      new MutationObserver(pass).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-state", "value"],
      });
    } catch (e) {}
    if (DEBUG) {
      window.__WB_LAN_READY__ = {
        lanOrigin: lanOrigin || null,
        toggle: toggleMode,
        href: location.href,
        dbg: state,
      };
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootFn);
  } else {
    bootFn();
  }
})();
