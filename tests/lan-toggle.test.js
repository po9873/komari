/* jsdom 复刻真实弹窗结构，测试勾选框模式与静默模式 */
const fs = require('fs');
const path = require('path');
let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (e) {
  console.error('缺 jsdom：先执行 npm i --no-save jsdom');
  process.exit(2);
}

const JS_PATH = process.argv[2] || path.join(__dirname, '..', 'lan-toggle.js');
const src = fs.readFileSync(JS_PATH, 'utf8');

// 1:1 复刻 dump 到的真实结构
function dialogHtml(cmd) {
  return `<!doctype html><html><body>
  <div class="rt-BaseDialogContent" data-state="open">
    <div class="rt-Flex"><span>一键部署指令</span></div>
    <div class="rt-SegmentedControlRoot">
      <button class="rt-SegmentedControlItem"><span class="rt-SegmentedControlItemLabelActive">Linux</span></button>
    </div>
    <label class="text-base font-bold">安装选项</label>
    <div class="grid grid-cols-2 gap-2">
      <div class="rt-Flex rt-r-ai-center rt-r-gap-2">
        <button type="button" role="checkbox" aria-checked="false" data-state="unchecked" class="rt-reset rt-BaseCheckboxRoot rt-CheckboxRoot rt-r-size-2 rt-variant-surface"></button>
        <label class="text-sm font-normal">禁用远程控制</label>
      </div>
      <div class="rt-Flex rt-r-ai-center rt-r-gap-2">
        <button type="button" role="checkbox" aria-checked="false" data-state="unchecked" class="rt-reset rt-BaseCheckboxRoot rt-CheckboxRoot rt-r-size-2 rt-variant-surface"></button>
        <label class="text-sm font-normal">禁用自动更新</label>
      </div>
    </div>
    <label>指令</label>
    <textarea class="rt-reset rt-TextAreaInput">${cmd}</textarea>
    <button>复制</button>
  </div>
  </body></html>`;
}

function run(html, bootstrap, prep) {
  const dom = new JSDOM(html, { url: 'http://10.9.9.9:25774/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  // jsdom 无布局：stub 可见性相关 API
  w.Element.prototype.getBoundingClientRect = function () { return { width: 300, height: 20, top: 0, left: 0, right: 300, bottom: 20 }; };
  w.getComputedStyle = function (el) { return { display: 'block', visibility: 'visible' }; };
  if (prep) prep(w);
  if (bootstrap) w.eval(`window.__WB_LAN__ = ${JSON.stringify(bootstrap)};`);
  w.eval(src);
  // 触发 boot（readyState 已是 complete 时 boot 同步执行；保险起见派发事件）
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  return w;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  const CMD = 'wget -qO- https://raw.githubusercontent.com/komari-monitor/komari-agent/refs/heads/main/install.sh | sudo bash -s -- -e https://panel.example.com -t TOKEN123';
  const LAN = 'http://10.9.9.9:25774';
  let fail = 0;
  const check = (name, ok) => { console.log(ok ? '  ✓' : '  ✗', name); if (!ok) fail++; };

  // ===== 场景 1：勾选框模式，弹窗打开（用 IP 访问 → 默认勾上）=====
  {
    console.log('场景 1：勾选框模式（IP 访问，默认勾上）');
    const w = run(dialogHtml(CMD), { lanOrigin: LAN, toggle: 1 });
    await sleep(100);
    const d = w.document.querySelector('.rt-BaseDialogContent');
    const grid = d.querySelector('.grid');
    const rows = grid.children;
    check('选项行数 = 原生 2 + 我们 1', rows.length === 3);
    const ours = rows[rows.length - 1];
    check('我们的行在选项列表末尾', ours.textContent.includes('安装命令用内网地址'));
    check('行内含 Radix checkbox', !!ours.querySelector('button[role=checkbox]'));
    check('默认勾上（IP 访问）', ours.querySelector('button').getAttribute('data-state') === 'checked');
    const ta = d.querySelector('textarea');
    check('命令框 -e 已换成内网地址', ta.value.includes('-e ' + LAN));
    check('下载 URL 未被动过', ta.value.includes('https://raw.githubusercontent.com/komari-monitor/komari-agent/refs/heads/main/install.sh'));
    check('公网域名已消失', !ta.value.includes('panel.example.com'));
    // 取消勾选 → 还原
    ours.querySelector('button').click();
    await sleep(50);
    check('取消后 data-state=unchecked', ours.querySelector('button').getAttribute('data-state') === 'unchecked');
    check('取消后命令还原为公网域名', ta.value.includes('-e https://panel.example.com') && !ta.value.includes(LAN));
    // 再勾上
    ours.querySelector('button').click();
    await sleep(50);
    check('再勾上又换成内网地址', ta.value.includes('-e ' + LAN));
    // React 重渲染（模拟用户点了原生选项）：textarea 被 React 写回原始命令 → 我们的循环应再次改写
    ta.value = CMD;
    await sleep(900);
    check('React 重渲染后 800ms 内自动再改写', ta.value.includes('-e ' + LAN));
  }

  // ===== 场景 2：勾选框模式，公网域名访问（默认不勾）=====
  {
    console.log('场景 2：勾选框模式（域名访问，默认不勾，可手动勾）');
    const dom = new JSDOM(dialogHtml(CMD), { url: 'https://panel.example.com/', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    w.Element.prototype.getBoundingClientRect = function () { return { width: 300, height: 20, top: 0, left: 0, right: 300, bottom: 20 }; };
    w.getComputedStyle = function () { return { display: 'block', visibility: 'visible' }; };
    w.eval('window.__WB_LAN__ = ' + JSON.stringify({ lanOrigin: LAN, toggle: 1 }) + ';');
    w.eval(src);
    await sleep(100);
    const d = w.document.querySelector('.rt-BaseDialogContent');
    const ours = d.querySelector('.grid').lastElementChild;
    check('默认不勾', ours.querySelector('button').getAttribute('data-state') === 'unchecked');
    check('命令保持公网域名', d.querySelector('textarea').value.includes('panel.example.com'));
    ours.querySelector('button').click();
    await sleep(50);
    check('手动勾上 → 换内网地址', d.querySelector('textarea').value.includes('-e ' + LAN));
  }

  // ===== 场景 3：无弹窗（仪表盘）→ 不创建任何东西 =====
  {
    console.log('场景 3：无弹窗页面');
    const dom = new JSDOM('<!doctype html><html><body><div class="dash">在线 8/9</div></body></html>',
      { url: 'http://10.9.9.9:25774/', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    w.eval('window.__WB_LAN__ = ' + JSON.stringify({ lanOrigin: LAN, toggle: 1 }) + ';');
    w.eval(src);
    await sleep(100);
    check('页面零新增元素（body 子元素数不变）', w.document.body.children.length === 1);
  }

  // ===== 场景 4：静默模式（无 bootstrap）→ 无 UI、textarea 自动改写 =====
  {
    console.log('场景 4：静默模式');
    const w = run(dialogHtml(CMD), null);
    await sleep(100);
    check('选项网格行数不变（仍是原生 2 行，没插我们的行）', w.document.querySelector('.grid').children.length === 2);
    const ta = w.document.querySelector('textarea');
    check('textarea 命令 -e 已换成当前访问地址', ta.value.includes('-e http://10.9.9.9:25774'));
    check('下载 URL 未被动过', ta.value.includes('raw.githubusercontent.com'));
  }

  // ===== 场景 5：复制钩子（clipboard.writeText 被改写）=====
  {
    console.log('场景 5：复制钩子');
    const calls = [];
    const w = run(dialogHtml(CMD), { lanOrigin: LAN, toggle: 1 }, (win) => {
      Object.defineProperty(win.navigator, 'clipboard', {
        configurable: true,
        value: { writeText: function (t) { calls.push(t); return Promise.resolve(); } },
      });
    });
    await sleep(100);
    check('剪贴板钩子已挂上', !!w.navigator.clipboard.__wbHooked);
    await w.navigator.clipboard.writeText(CMD);
    check('勾上时复制 → 换成内网地址', calls[0].includes('-e ' + LAN));
    check('复制内容里的下载地址未被动过', calls[0].includes('raw.githubusercontent.com'));
    const dd = w.document.querySelector('.rt-BaseDialogContent');
    dd.querySelector('.grid').lastElementChild.querySelector('button').click();
    await sleep(50);
    await w.navigator.clipboard.writeText(CMD);
    check('取消勾选后复制 → 保持原样', calls[1].includes('-e https://panel.example.com'));
  }

  console.log(fail === 0 ? '\n全部通过 ✓' : `\n${fail} 项失败 ✗`);
  process.exit(fail === 0 ? 0 : 1);
})();
