/* 镜像内置：安装命令的「当前访问地址 / 内网地址」勾选框
 *
 * 由 nginx 在返回面板页面时注入（sub_filter），不需要浏览器插件，
 * 也不需要往面板「自定义 Body」里粘任何东西。
 *
 * 这次按反馈重做的关键点：
 *   1. 绝不写死任何 IP —— 用 window.location.host / location.origin，
 *      也就是「你此刻打开这个面板用的地址」。别人拉镜像跑，地址自动是他们自己的。
 *   2. 不再是右下角每个页面都冒出来的悬浮胶囊；
 *      改成直接插到「一键部署指令」页面的「安装选项」分组里，像个真正的选项。
 *   3. 只在「一键部署指令」页面出现，仪表盘 / 设置 / 其它页面一律不显示。
 *
 * 三个刻意做得很“赖”的地方（都是被现实打过才加的）：
 *   a. 界面放在 closed shadow root 里 —— 页面样式表 / 广告过滤规则改不到里面；
 *   b. 每 2 秒自检 + MutationObserver 看护 —— 面板重绘 / React 重渲染把它删了就补回来；
 *   c. 不在部署页时主动把自己摘掉 —— 绝不在别的页面露面。
 */
(function () {
  "use strict";

  var HOST_ID = "wb-lan-host";
  var pageHost = location.host;
  // 用「当前打开面板用的地址」作为安装命令的 endpoint，绝不写死部署者的 IP
  var lanOrigin = location.origin; // 含 scheme，例如 http://192.168.6.33:25774 或 https://komari.lan

  function isPrivateHost(h) {
    if (!h) return false;
    return /(^127\.)|(^10\.)|(^192\.168\.)|(^172\.(1[6-9]|2\d|3[01])\.)|(^169\.254\.)|(^localhost(:[0-9]+)?$)|(^\[::1\])|(^::1$)/.test(h);
  }
  // 内网 IP / 本机默认开；公网域名默认关，但勾选框始终可见，用户可手动切换
  var enabled = isPrivateHost(pageHost);
  try {
    var saved0 = localStorage.getItem("wb_lan_toggle");
    if (saved0 !== null) enabled = saved0 === "1";
  } catch (e) {}

  var saved = []; // [{node,value}]，关掉开关时用来还原
  var scheduled = false;
  var busy = false;
  var uiPending = false;

  /* ---------------- 改写安装命令 ---------------- */

  function isCommand(text) {
    if (!text) return false;
    return (
      text.indexOf("install.sh") !== -1 ||
      text.indexOf("install.ps1") !== -1 ||
      text.indexOf("komari-agent") !== -1 ||
      text.indexOf("--endpoint") !== -1
    );
  }

  // 从命令里抓出「面板地址」（--endpoint 后面那个），把它整体换成当前访问地址。
  // 这样无论是下载脚本的 URL 还是 --endpoint，凡是面板自己的地址都会被一起换掉；
  // 在公网访问时 panelOrigin === location.origin，等于不改，安全无副作用。
  function rewrite(text) {
    if (!text) return text;
    var m = text.match(/(--endpoint\s+)(https?:\/\/[^\s"']+)/i);
    if (!m) return text;
    var panelOrigin = m[2].replace(/\/+$/, "");
    var target = lanOrigin.replace(/\/+$/, "");
    if (panelOrigin === target) return text;
    var esc = panelOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(new RegExp(esc, "g"), target);
  }

  function patchTextNode(node) {
    var value = node.nodeValue;
    if (!value || !isCommand(value)) return;
    var next = rewrite(value);
    if (next === value) return;
    saved.push({ node: node, value: value });
    node.nodeValue = next;
  }

  function patchForm(el) {
    var v = el.value;
    if (!isCommand(v)) return;
    var nv = rewrite(v);
    if (nv === v) return;
    saved.push({ node: el, value: v });
    el.value = nv;
  }

  function pass() {
    if (!enabled || busy) return;
    busy = true;
    try {
      var list = document.querySelectorAll("textarea, input[type=text]");
      for (var i = 0; i < list.length; i++) patchForm(list[i]);
      var walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        null
      );
      var node;
      while ((node = walker.nextNode())) patchTextNode(node);
    } catch (e) {
    } finally {
      busy = false;
    }
  }

  function restore() {
    for (var i = saved.length - 1; i >= 0; i--) {
      try {
        var item = saved[i];
        if (item.node.tagName === "TEXTAREA" || item.node.tagName === "INPUT") {
          item.node.value = item.value;
        } else {
          item.node.nodeValue = item.value;
        }
      } catch (e) {}
    }
    saved = [];
  }

  function schedule() {
    if (scheduled || !enabled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      pass();
    });
  }

  // 复制时拦截：选中的是安装命令就改写后再写剪贴板
  document.addEventListener(
    "copy",
    function (e) {
      if (!enabled || !e.clipboardData) return;
      var sel = document.getSelection();
      var picked = sel ? sel.toString() : "";
      if (!isCommand(picked)) return;
      var out = rewrite(picked);
      if (out === picked) return;
      e.clipboardData.setData("text/plain", out);
      e.preventDefault();
    },
    true
  );

  // 面板上的「复制」按钮走 clipboard API，这里包一层（严格模式可能抛错，吞掉）
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      var nativeWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = function (t) {
        return nativeWrite(enabled ? rewrite(String(t)) : t);
      };
    }
  } catch (e) {}

  /* ---------------- 界面（closed shadow root，插到安装选项里） ---------------- */

  var root = null;
  var input = null;

  var CSS = [
    ":host{display:block;grid-column:1/-1}",
    ".row{display:flex;align-items:center;gap:8px;padding:9px 11px;margin:6px 0;border-radius:8px;",
    "font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',system-ui,sans-serif;",
    "color:#e4e4e7;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);cursor:pointer;user-select:none}",
    ".row:hover{background:rgba(255,255,255,.07)}",
    ".row input{margin:0;width:16px;height:16px;cursor:pointer;accent-color:#22c55e;flex:0 0 auto}",
    ".row .lbl{flex:1 1 auto}",
    ".row .addr{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;opacity:.8;font-size:12px;flex:0 0 auto}",
    ".row.on{border-color:rgba(74,222,128,.55);background:rgba(34,197,94,.12)}",
  ].join("");

  function paint() {
    if (!root) return;
    var box = root.querySelector(".row");
    if (box) box.className = enabled ? "row on" : "row";
  }

  function toggle(on) {
    enabled = !!on;
    try {
      localStorage.setItem("wb_lan_toggle", enabled ? "1" : "0");
    } catch (e) {}
    if (input) input.checked = enabled;
    if (enabled) {
      pass();
      schedule();
    } else {
      restore();
    }
    paint();
  }

  function buildUi(container) {
    var host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all:initial;display:block;grid-column:1/-1";
    container.appendChild(host);

    root = host.attachShadow({ mode: "closed" });
    root.appendChild(document.createElement("style")).textContent = CSS;

    var box = document.createElement("label");
    box.className = "row";
    box.title =
      "勾选后，面板里复制出来的安装命令会把「面板地址」换成你当前打开面板用的地址（" +
      pageHost +
      "），agent 直连此地址、不经过 Cloudflare。\n在公网访问时勾选无效（本就是公网地址）。";

    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = enabled;
    input.addEventListener("change", function () {
      toggle(input.checked);
    });

    var label = document.createElement("span");
    label.className = "lbl";
    label.textContent = "安装命令用内网地址（当前：" + pageHost + "）";

    var where = document.createElement("span");
    where.className = "addr";
    where.textContent = pageHost;

    box.appendChild(input);
    box.appendChild(label);
    box.appendChild(where);
    root.appendChild(box);
    paint();
    if (enabled) {
      pass();
      schedule();
    }
  }

  /* ---------------- 页面定位：只在「一键部署指令」页，且插到安装选项里 ---------------- */

  function normalize(s) {
    return (s || "").replace(/\s/g, "");
  }

  function isDeployPage() {
    if (!document.body) return false;
    var t = document.body.innerText || document.body.textContent || "";
    return normalize(t).indexOf("一键部署指令") !== -1 ||
      normalize(t).indexOf("安装选项") !== -1;
  }

  function findOptionsContainer() {
    // 1) 找「安装选项」标题
    var heads = document.querySelectorAll(
      "h1,h2,h3,h4,h5,h6,div,span,p,section,label"
    );
    var heading = null;
    for (var i = 0; i < heads.length; i++) {
      var el = heads[i];
      if (
        el.children.length <= 1 &&
        el.textContent &&
        normalize(el.textContent).indexOf("安装选项") !== -1
      ) {
        heading = el;
        break;
      }
    }
    if (!heading) return null;

    // 2) 标题所在区块里找包含复选框的容器
    var scope = heading.parentElement || heading;
    var boxes = scope.querySelectorAll("input[type=checkbox]");
    if (boxes.length === 0) {
      scope = scope.parentElement || scope;
      boxes = scope.querySelectorAll("input[type=checkbox]");
    }
    if (boxes.length === 0) return null;

    // 3) 向上收到「包含这些复选框的最小公共容器」
    var container = boxes[boxes.length - 1].parentElement;
    while (
      container &&
      container.parentElement &&
      container.querySelectorAll("input[type=checkbox]").length < 2 &&
      container.tagName !== "BODY"
    ) {
      container = container.parentElement;
    }
    return container;
  }

  // 找不到安装选项容器时的兜底：插到「指令」区块之前，保证部署页一定看得见
  function findFallbackMount() {
    var heads = document.querySelectorAll(
      "h1,h2,h3,h4,h5,h6,div,span,p,section,label"
    );
    for (var i = 0; i < heads.length; i++) {
      var el = heads[i];
      if (
        el.children.length <= 1 &&
        el.textContent &&
        normalize(el.textContent).indexOf("指令") !== -1
      ) {
        var sec = el.parentElement || el;
        // 挂在指令区的父容器里、作为最后一个块（出现在命令上方）
        while (sec && sec.parentElement && sec.tagName !== "BODY" &&
               sec.querySelectorAll("input,pre,code,textarea").length === 0) {
          sec = sec.parentElement;
        }
        return sec;
      }
    }
    return null;
  }

  function findMount() {
    var opt = findOptionsContainer();
    if (opt) return opt;
    return findFallbackMount();
  }

  function mountUi() {
    var existing = document.getElementById(HOST_ID);
    if (!isDeployPage()) {
      // 不在部署页：确保移除，绝不在其它页面显示
      if (existing && existing.parentElement) {
        existing.parentElement.removeChild(existing);
      }
      root = null;
      input = null;
      return;
    }
    var container = findMount();
    if (!container) return; // 页面还没渲染好，下一轮再试
    if (existing) {
      if (existing.parentElement !== container) {
        if (existing.parentElement) existing.parentElement.removeChild(existing);
        container.appendChild(existing);
      }
      return;
    }
    try {
      buildUi(container);
    } catch (e) {}
  }

  function scheduleUi() {
    if (uiPending) return;
    uiPending = true;
    setTimeout(function () {
      uiPending = false;
      mountUi();
    }, 300);
  }

  /* ---------------- 启动 + 自检看护 ---------------- */

  function boot() {
    mountUi();
    if (enabled) {
      pass();
      schedule();
    }
    setInterval(mountUi, 2000);
    try {
      new MutationObserver(scheduleUi).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    } catch (e) {}
    try {
      new MutationObserver(schedule).observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    } catch (e) {}
    window.__WB_LAN_READY__ = {
      pageHost: pageHost,
      lanOrigin: lanOrigin,
      enabled: enabled,
      onDeploy: isDeployPage(),
      rendered: !!document.getElementById(HOST_ID),
    };
    // 排查用：在控制台输入 __WB_LAN_READY__ 就能看到它到底有没有跑起来、挂在哪
    try {
      console.info("[内网开关] 已加载 ->", window.__WB_LAN_READY__);
    } catch (e) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
