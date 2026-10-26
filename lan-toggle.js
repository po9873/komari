/* 镜像内置：安装命令的内网 / 公网地址开关
 *
 * 由 nginx 在返回面板首页时注入（sub_filter），不需要浏览器插件，
 * 也不需要往面板「自定义 Body」里粘任何东西。
 *
 * 容器自己的内网地址由 entrypoint 在启动时探测，
 * 通过 window.__WB_LAN__ 传进来，这个文件里没有任何写死的 IP。
 */
(function () {
  "use strict";

  if (window.top !== window.self) return;

  var cfg = window.__WB_LAN__ || {};
  var authority = String(cfg.authority || "").trim();
  if (!authority) return;

  var pageHost = location.host;
  // 本来就是在用内网地址访问，没有可切换的东西
  if (!pageHost || authority === pageHost) return;

  var lanOrigin = "http://" + authority;
  var storageKey = "wb_lan_toggle";
  var enabled = false;
  try {
    enabled = localStorage.getItem(storageKey) === "1";
  } catch (e) {}

  var saved = []; // [{node, value}]，关掉开关时用来还原
  var observer = null;
  var scheduled = false;
  var busy = false;

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

  function patchElement(el) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      var v = el.value;
      if (!isCommand(v)) return;
      var nv = rewrite(v);
      if (nv === v) return;
      saved.push({ node: el, value: v });
      el.value = nv;
      return;
    }
    if (!isCommand(el.textContent)) return;
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) patchTextNode(node);
  }

  function pass() {
    if (!enabled || busy) return;
    busy = true;
    try {
      var list = document.querySelectorAll("pre, code, textarea, input");
      for (var i = 0; i < list.length; i++) patchElement(list[i]);
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

  function watch() {
    if (observer) return;
    observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function unwatch() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
  }

  /* ---------------- 界面 ---------------- */

  var box = null;
  var input = null;
  var addr = null;

  function paint() {
    if (!box) return;
    box.style.background = enabled ? "rgba(22,101,52,.95)" : "rgba(24,24,27,.92)";
    box.style.borderColor = enabled ? "rgba(74,222,128,.55)" : "rgba(255,255,255,.16)";
    addr.style.color = enabled ? "#bbf7d0" : "#a1a1aa";
  }

  function buildUi() {
    if (box) return;

    box = document.createElement("label");
    box.id = "wb-lan-switch";
    box.setAttribute(
      "title",
      "勾选后，面板里复制出来的安装命令会改用容器内网地址（不经过 Cloudflare）。\n" +
        "给公网机器装节点时请取消勾选。"
    );
    box.style.cssText = [
      "position:fixed",
      "right:14px",
      "bottom:14px",
      "z-index:2147483000",
      "display:flex",
      "align-items:center",
      "gap:8px",
      "padding:8px 12px",
      "border:1px solid rgba(255,255,255,.16)",
      "border-radius:999px",
      "background:rgba(24,24,27,.92)",
      "color:#fafafa",
      "font:12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif",
      "cursor:pointer",
      "user-select:none",
      "box-shadow:0 6px 20px rgba(0,0,0,.35)",
      "backdrop-filter:blur(6px)",
    ].join(";");

    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = enabled;
    input.style.cssText = "margin:0;width:14px;height:14px;cursor:pointer;accent-color:#22c55e";

    var text = document.createElement("span");
    text.textContent = "安装命令用内网地址";

    addr = document.createElement("span");
    addr.textContent = authority;
    addr.style.cssText =
      "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#a1a1aa";

    box.appendChild(input);
    box.appendChild(text);
    box.appendChild(addr);

    input.addEventListener("change", function () {
      setEnabled(input.checked, true);
    });

    document.body.appendChild(box);
    paint();
  }

  function setEnabled(on, persist) {
    enabled = !!on;
    if (persist) {
      try {
        localStorage.setItem(storageKey, enabled ? "1" : "0");
      } catch (e) {}
    }
    if (input) input.checked = enabled;
    if (enabled) {
      watch();
      pass();
    } else {
      restore();
      unwatch();
    }
    paint();
  }

  /* ---------------- 复制交给它 ---------------- */

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

  // 面板上的「复制」按钮走的是 clipboard API，这里包一层
  // 浏览器可能不允许改写（严格模式下会抛错），所以必须吞掉异常，
  // 否则后面的界面就渲染不出来
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      var nativeWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = function (t) {
        return nativeWrite(enabled ? rewrite(String(t)) : t);
      };
    }
  } catch (e) {}

  /* ---------------- 启动 ---------------- */

  function boot() {
    buildUi();
    if (enabled) {
      watch();
      pass();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
