/*
 * 镜像内置：安装命令自动改用「当前访问面板的地址」
 * 由 nginx 在返回面板页面时注入（sub_filter），不需要浏览器插件，也不渲染任何 UI。
 *
 * 行为：扫描页面里的安装命令（含 install.sh / install.ps1 / komari-agent / --endpoint），
 *       把其中的面板地址（下载 URL 与 --endpoint 参数）整体替换为 location.origin
 *       ——也就是你此刻打开面板用的那个地址。
 *
 * 效果：
 *   - 用内网 IP / 内网域名访问面板 -> 复制出的安装命令用内网地址，agent 直连、不绕 Cloudflare
 *   - 用公网域名访问面板         -> 复制出的安装命令用公网域名
 *
 * 不渲染任何控件，不暴露内网 IP，不影响页面其它内容；找不到安装命令时什么都不做。
 */
(function () {
  "use strict";

  var lanOrigin = location.origin; // 你当前打开面板用的地址

  function isCommand(text) {
    if (!text) return false;
    return (
      text.indexOf("install.sh") !== -1 ||
      text.indexOf("install.ps1") !== -1 ||
      text.indexOf("komari-agent") !== -1 ||
      text.indexOf("--endpoint") !== -1
    );
  }

  // 把命令里的面板地址整体换成当前访问地址（下载 URL 与 --endpoint 一起换）
  function rewrite(text) {
    if (!text) return text;
    var urls = text.match(/https?:\/\/[^\s"'<>]+/g);
    if (!urls || !urls.length) return text;
    var m = text.match(/--endpoint\s+(https?:\/\/[^\s"'<>]+)/i);
    var panelOrigin = (m ? m[1] : urls[0]).replace(/\/+$/, "");
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
    node.nodeValue = next;
  }

  function pass() {
    try {
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      var n;
      while ((n = walker.nextNode())) patchTextNode(n);
    } catch (e) {}
  }

  // 复制时同步改写剪贴板内容
  document.addEventListener("copy", function (e) {
    if (!e.clipboardData) return;
    var sel = window.getSelection();
    var picked = sel ? sel.toString() : "";
    if (!isCommand(picked)) return;
    var out = rewrite(picked);
    if (out === picked) return;
    e.clipboardData.setData("text/plain", out);
    e.preventDefault();
  }, true);

  function boot() {
    pass();
    setInterval(pass, 2000);
    try {
      new MutationObserver(pass).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    } catch (e) {}
    // 调试用：确认脚本已注入、当前生效的访问地址
    window.__WB_LAN__ = { lanOrigin: lanOrigin, autoRewrite: true };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
