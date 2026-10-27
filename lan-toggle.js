/* 镜像内置：安装命令的「当前访问地址 / 内网地址」勾选框
 *
 * 由 nginx 在返回面板页面时注入（sub_filter），不需要浏览器插件，
 * 也不需要往面板「自定义 Body」里粘任何东西。
 *
 * 关键点（踩过坑后定的）：
 *   1. 绝不写死任何 IP —— 用 location.host / location.origin，
 *      即「你此刻打开面板用的地址」。别人拉镜像跑，地址自动是他们自己的。
 *   2. 只出现在「一键部署指令」弹窗里，作为弹窗选项列表中的一条选项。
 *      仪表盘 / 节点列表 / 设置等任何其它页面一律不显示。
 *   3. 判定依据不是「一键部署指令」这几个字（那是个常驻导航按钮，每页都有），
 *      而是：页面里有没有真正弹出来的、内含安装命令（install.sh / --endpoint）的弹窗。
 *
 * 三个刻意做得很“赖”的地方（都是被现实打过才加的）：
 *   a. 界面放在 closed shadow root 里 —— 页面样式表 / 广告过滤规则改不到里面；
 *   b. 每 2 秒自检 + MutationObserver 看护 —— 面板重绘 / React 重渲染把它删了就补回来；
 *   c. 弹窗关掉时主动把自己摘掉 —— 绝不在别的页面露面。
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

  /* ---------------- 界面（closed shadow root，插到弹窗选项列表里） ---------------- */

  var root = null;
  var input = null;

  var CSS = [
    ":host{display:block;width:100%}",
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
    host.style.cssText = "all:initial;display:block;width:100%";
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

  /* ---------------- 定位：只认「含安装命令的弹窗」，并插进选项列表 ---------------- */

  function isVisible(el) {
    if (!el) return false;
    var st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0")
      return false;
    // 再确认祖先没有 display:none（offsetParent 为 null 多半是隐藏）
    if (el.offsetParent === null) {
      var p = el.parentElement;
      while (p && p !== document.body) {
        var ps = getComputedStyle(p);
        if (ps.display === "none" || ps.visibility === "hidden") return false;
        p = p.parentElement;
      }
    }
    return true;
  }

  // 找安装命令锚点：扫描文本节点，找到含 install.sh / --endpoint 的那个，向上回到块级容器。
  // 这条命令只存在于「一键部署指令」弹窗里，所以能精准区分“弹窗开着”和“导航只是有个按钮”。
  function findCommandElement() {
    if (!document.body) return null;
    var walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null
    );
    var n;
    while ((n = walker.nextNode())) {
      var v = n.nodeValue || "";
      if (
        v.indexOf("install.sh") !== -1 ||
        v.indexOf("install.ps1") !== -1 ||
        v.indexOf("--endpoint") !== -1
      ) {
        var el = n.parentElement;
        while (
          el &&
          el !== document.body &&
          getComputedStyle(el).display === "inline"
        )
          el = el.parentElement;
        return el || n.parentElement;
      }
    }
    return null;
  }

  // 从命令锚点往上爬，找到弹窗的根容器（dialog / 含 modal 类名的 / 顶层 portal）
  function getModalRoot(fromEl) {
    var el = fromEl;
    while (el && el.parentElement && el.parentElement !== document.body) {
      var role = el.getAttribute ? el.getAttribute("role") : null;
      var cls = (el.className || "").toString();
      if (
        role === "dialog" ||
        /\b(modal|dialog|overlay|portal|popup)\b/i.test(cls)
      ) {
        return el;
      }
      el = el.parentElement;
    }
    // 没匹配到语义标记：回到“父级是 body”的顶层容器
    while (el && el.parentElement && el.parentElement !== document.body) {
      el = el.parentElement;
    }
    return el;
  }

  // 收集弹窗里的“选项勾选框”：有文字 label、且本身不是命令框
  function collectOptionControls(modal) {
    var boxes = modal.querySelectorAll(
      "input[type=checkbox],input[type=radio],[role=switch],[role=checkbox]"
    );
    var out = [];
    for (var i = 0; i < boxes.length; i++) {
      var lab = boxes[i].closest ? boxes[i].closest("label") : null;
      var lb = lab
        ? lab.textContent.trim()
        : (boxes[i].getAttribute("aria-label") || "").trim();
      if (lb && !isCommand(lb)) out.push(boxes[i]);
    }
    if (out.length === 0) out = Array.prototype.slice.call(boxes);
    return out;
  }

  // 弹窗是否打开（且可见）
  function getInstallModal() {
    var cmd = findCommandElement();
    if (!cmd || !isVisible(cmd)) return null;
    var modal = getModalRoot(cmd);
    if (!modal || !isVisible(modal)) return null;
    return modal;
  }

  // 把开关作为“最后一条选项”插进选项列表：找选项控件们的共同祖先，
  // 再插到最后一个选项控件所在行的后面，保证它长得像选项、落在选项区末尾。
  function findMount(modal) {
    var opt = collectOptionControls(modal);
    if (opt.length >= 1) {
      // 共同祖先
      var container = opt[0].parentElement;
      while (container && container !== modal) {
        var allIn = true;
        for (var j = 0; j < opt.length; j++) {
          if (!container.contains(opt[j])) {
            allIn = false;
            break;
          }
        }
        if (!allIn) break;
        if (container.parentElement === modal) break;
        container = container.parentElement;
      }
      // 插到最后一个选项控件的“行”之后
      var lastRow =
        (opt[opt.length - 1].closest &&
          opt[opt.length - 1].closest("label")) ||
        opt[opt.length - 1].parentElement;
      if (container && lastRow && lastRow.parentElement) {
        return { container: lastRow.parentElement, after: lastRow };
      }
      if (container) return { container: container, after: null };
    }
    // 兜底：直接挂到弹窗根里（命令上方），保证弹窗里一定看得见
    return { container: modal, after: null };
  }

  function mountUi() {
    var existing = document.getElementById(HOST_ID);
    var modal = getInstallModal();
    if (!modal) {
      // 弹窗没开：确保移除，绝不在其它页面显示
      if (existing && existing.parentElement) {
        existing.parentElement.removeChild(existing);
      }
      root = null;
      input = null;
      return;
    }
    var m = findMount(modal);
    if (!m || !m.container) return; // 还没渲染好，下一轮再试
    var host = existing;
    if (!host) {
      try {
        buildUi(m.container);
        host = document.getElementById(HOST_ID);
      } catch (e) {
        return;
      }
    }
    // 放到正确位置（最后一个选项之后）
    try {
      if (m.after && m.after.parentElement === m.container) {
        if (host.parentElement !== m.container || host.nextSibling !== m.after.nextSibling) {
          m.container.insertBefore(host, m.after.nextSibling);
        }
      } else if (host.parentElement !== m.container) {
        m.container.appendChild(host);
      }
    } catch (e) {
      try {
        m.container.appendChild(host);
      } catch (e2) {}
    }
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
      onDeploy: !!getInstallModal(),
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
