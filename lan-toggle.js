/* 镜像内置：安装命令的内网 / 公网地址开关
 *
 * 由 nginx 在返回面板页面时注入（sub_filter），不需要浏览器插件，
 * 也不需要往面板「自定义 Body」里粘任何东西。
 *
 * 容器自己的内网地址由 entrypoint 在启动时探测，
 * 通过 window.__WB_LAN__ 传进来，这个文件里没有任何写死的 IP。
 *
 * 三个刻意做得很“赖”的地方（都是被现实打过才加的）：
 *   1. 界面放在 closed shadow root 里 —— 页面样式表/广告过滤规则改不到里面；
 *   2. 宿主 div 挂在 documentElement 而不是 body —— 面板重绘 body 不会把它带走；
 *   3. 每 2 秒自检一次，被删了就补回来 —— 挡得住「元素杀手」类的扩展。
 */
(function () {
  "use strict";

  var cfg = window.__WB_LAN__ || {};
  var authority = String(cfg.authority || "").trim();
  if (!authority) return;

  var HOST_ID = "wb-lan-host";
  var pageHost = location.host;
  // 本来就是用内网地址访问的：没什么可切换，但仍要显示出来（用户要知道）
  var alreadyLan = !pageHost || authority === pageHost;
  var lanOrigin = "http://" + authority;
  var storageKey = "wb_lan_toggle";
  var enabled = alreadyLan;
  if (!alreadyLan) {
    try {
      enabled = localStorage.getItem(storageKey) === "1";
    } catch (e) {}
  }

  var saved = []; // [{node,value}]，关掉开关时用来还原
  var scheduled = false;
  var busy = false;

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

  function rewrite(text) {
    if (!text || text.indexOf(pageHost) === -1) return text;
    var esc = pageHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text
      .replace(new RegExp("https?://" + esc, "g"), lanOrigin)
      .replace(new RegExp("([\\s\"'(])//" + esc, "g"), "$1//" + authority);
  }

  function patchTextNode(node) {
    var value = node.nodeValue;
    if (!value || value.indexOf(pageHost) === -1) return;
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
      // 全量走一遍文本节点：命令不一定包在 <pre>/<code> 里
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

  // 面板上的「复制」按钮走 clipboard API，这里包一层。
  // 浏览器可能不允许改写（严格模式下会抛错），必须吞掉异常，否则界面渲染不出来
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      var nativeWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = function (t) {
        return nativeWrite(enabled ? rewrite(String(t)) : t);
      };
    }
  } catch (e) {}

  /* ---------------- 界面（closed shadow root） ---------------- */

  var root = null;
  var input = null;
  var where = null;

  var CSS = [
    ".wb{position:fixed;right:14px;bottom:14px;z-index:2147483647;display:flex;",
    "align-items:center;gap:8px;padding:10px 14px;border-radius:999px;",
    "font:13px/1.35 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',system-ui,sans-serif;",
    "color:#fafafa;cursor:pointer;user-select:none;",
    "box-shadow:0 8px 26px rgba(0,0,0,.45);transition:background .15s,border-color .15s}",
    ".wb input{margin:0;width:15px;height:15px;cursor:pointer;accent-color:#22c55e}",
    ".wb .addr{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;opacity:.85}",
    ".wb.on{background:rgba(22,101,52,.96);border:1px solid rgba(74,222,128,.6)}",
    ".wb.off{background:rgba(24,24,27,.94);border:1px solid rgba(255,255,255,.2)}",
    ".wb.hidden{display:none}",
  ].join("");

  function paint() {
    if (!root) return;
    var box = root.querySelector(".wb");
    if (!box) return;
    box.className = alreadyLan ? "wb on" : enabled ? "wb on" : "wb off";
  }

  function toggle(on) {
    enabled = !!on;
    if (!alreadyLan) {
      try {
        localStorage.setItem(storageKey, enabled ? "1" : "0");
      } catch (e) {}
    }
    if (input) input.checked = enabled;
    if (enabled) {
      pass();
      schedule();
    } else {
      restore();
    }
    paint();
  }

  function buildUi() {
    var host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all:initial";
    // 挂到 <html>，不进 <body>：面板重绘自身内容时不会把它一并清掉
    (document.documentElement || document.body).appendChild(host);

    root = host.attachShadow({ mode: "closed" });
    root.appendChild(document.createElement("style")).textContent = CSS;

    var box = document.createElement("label");
    box.className = "wb";
    box.title = alreadyLan
      ? "当前就是用容器内网地址打开的，安装命令里的地址无需改写。"
      : "勾选后，面板里复制出来的安装命令会改用容器内网地址（不经过 Cloudflare）。\n给公网机器装节点时请取消勾选。";

    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = enabled;
    input.disabled = alreadyLan;
    input.addEventListener("change", function () {
      toggle(input.checked);
    });

    var label = document.createElement("span");
    label.textContent = alreadyLan ? "当前已是内网地址" : "安装命令用内网地址";

    where = document.createElement("span");
    where.className = "addr";
    where.textContent = authority;

    box.appendChild(input);
    box.appendChild(label);
    box.appendChild(where);
    root.appendChild(box);
    paint();
  }

  function ensureUi() {
    if (document.getElementById(HOST_ID)) return;
    try {
      buildUi();
    } catch (e) {}
  }

  /* ---------------- 启动 + 自检看护 ---------------- */

  function boot() {
    ensureUi();
    if (enabled) {
      pass();
      schedule();
    }
    setInterval(ensureUi, 2000);
    try {
      new MutationObserver(schedule).observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    } catch (e) {}
    window.__WB_LAN_READY__ = {
      authority: authority,
      pageHost: pageHost,
      alreadyLan: alreadyLan,
      enabled: enabled,
      rendered: !!document.getElementById(HOST_ID),
    };
    // 排查用：在控制台输入 __WB_LAN_READY__ 就能看到它到底有没有跑起来
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
