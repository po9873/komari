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

function runAt(url, html, bootstrap, prep) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
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

// 默认用「内网 IP 打开」的地址（= lanOrigin 本身）
function run(html, bootstrap, prep) {
  return runAt('http://10.9.9.9:25774/', html, bootstrap, prep);
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

  // ===== 场景 2：勾选框模式，域名访问（同样默认勾上）=====
  // 局域网里也用域名打开面板是最常见的用法：按「hostname 是不是内网 IP」判断默认值，
  // 会让这个选项永远默认不勾，等于白给。所以默认值只看有没有内网地址可换。
  {
    console.log('场景 2：勾选框模式（域名访问，默认勾上）');
    const w = runAt('https://panel.example.com/', dialogHtml(CMD), { lanOrigin: LAN, toggle: 1 });
    await sleep(100);
    const d = w.document.querySelector('.rt-BaseDialogContent');
    const btn = d.querySelector('.grid').lastElementChild.querySelector('button');
    check('域名访问也默认勾上', btn.getAttribute('data-state') === 'checked');
    check('域名访问时命令已换成内网地址', d.querySelector('textarea').value.includes('-e ' + LAN));

    btn.click();
    await sleep(50);
    check('取消后还原成域名', d.querySelector('textarea').value.includes('-e https://panel.example.com'));
    check('取消的选择写进 localStorage', w.localStorage.getItem('wb_lan_toggle') === '0');

    const w2 = runAt('https://panel.example.com/', dialogHtml(CMD), { lanOrigin: LAN, toggle: 1 },
      (win) => win.localStorage.setItem('wb_lan_toggle', '0'));
    await sleep(100);
    const btn2 = w2.document.querySelector('.grid').lastElementChild.querySelector('button');
    check('记住「不勾」后下次打开不勾', btn2.getAttribute('data-state') === 'unchecked');

    const w3 = runAt('https://panel.example.com/', dialogHtml(CMD), { lanOrigin: LAN, toggle: 1, checked: 0 });
    await sleep(100);
    const btn3 = w3.document.querySelector('.grid').lastElementChild.querySelector('button');
    check('KOMARI_LAN_DEFAULT=0 → 默认不勾', btn3.getAttribute('data-state') === 'unchecked');
    check('该模式下命令保持域名', w3.document.querySelector('textarea').value.includes('panel.example.com'));

    const w4 = runAt('https://panel.example.com/', dialogHtml(CMD), { toggle: 1 });
    await sleep(100);
    check('探测不到内网地址时不插这一行', !w4.document.querySelector('[data-wb-lan]'));
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

  // ===== 场景 6：自动识别的地址不对 → 自己填（不点开不显示任何地址）=====
  {
    console.log('场景 6：手动改内网地址');
    const w = runAt('https://panel.example.com/', dialogHtml(CMD), { lanOrigin: LAN, toggle: 1 });
    await sleep(100);
    const d = w.document.querySelector('.rt-BaseDialogContent');
    const row = d.querySelector('[data-wb-lan]');
    const ta = d.querySelector('textarea');
    check('默认用自动识别的地址', ta.value.includes('-e ' + LAN));
    check('默认界面里没有输入框（不显示地址）', !row.querySelector('input'));

    row.querySelector('[data-wb-lan-edit]').click();
    await sleep(50);
    const inp = row.querySelector('[data-wb-lan-input]');
    check('点「改」才出现输入框', !!inp);

    // 非法地址：不生效
    inp.value = 'nas.lan';
    row.querySelector('[data-wb-lan-ok]').click();
    await sleep(50);
    check('非法地址被拒绝、命令不变', ta.value.includes('-e ' + LAN));

    // 合法地址：生效并记住
    inp.value = 'http://nas.lan:8080/';
    row.querySelector('[data-wb-lan-ok]').click();
    await sleep(80);
    check('改成自定义地址后命令跟着改', ta.value.includes('-e http://nas.lan:8080'));
    check('自定义地址存进 localStorage', w.localStorage.getItem('wb_lan_addr') === 'http://nas.lan:8080');
    check('输入框收起', !row.querySelector('input'));

    // 重新打开（同一浏览器）→ 用记住的地址
    const w2 = runAt('https://panel.example.com/', dialogHtml(CMD), { lanOrigin: LAN, toggle: 1 },
      (win) => win.localStorage.setItem('wb_lan_addr', 'http://nas.lan:8080'));
    await sleep(100);
    check('下次打开仍用自定义地址', w2.document.querySelector('textarea').value.includes('-e http://nas.lan:8080'));

    // 清空 → 回到自动识别
    const row2 = w2.document.querySelector('[data-wb-lan]');
    row2.querySelector('[data-wb-lan-edit]').click();
    await sleep(50);
    row2.querySelector('[data-wb-lan-input]').value = '';
    row2.querySelector('[data-wb-lan-ok]').click();
    await sleep(80);
    check('留空 → 回到自动识别的地址', w2.document.querySelector('textarea').value.includes('-e ' + LAN));
    check('留空后本地记录被清掉', !w2.localStorage.getItem('wb_lan_addr'));
  }

  console.log(fail === 0 ? '\n全部通过 ✓' : `\n${fail} 项失败 ✗`);
  process.exit(fail === 0 ? 0 : 1);
})();
