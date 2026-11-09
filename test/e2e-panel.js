// 离线验收：panel.js 在模拟 DOM + 模拟电子脑下能否把状态渲染出来。
// 不碰 Cindy，只证明「脚本能跑、字段能填、请求能被应答」这条链是通的。
// 数据用真实 worker 的 trae/status 结果，避免拿假字段自娱自乐。
'use strict';

const { spawn } = require('node:child_process');
const { readFileSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

const ROOT = join(__dirname, '..');
const WORKER = join(ROOT, 'plugin', 'node', 'bootstrap.cjs');
const PANEL_JS = join(ROOT, 'plugin', 'panel.js');
const PANEL_HTML = join(ROOT, 'plugin', 'panel.html');

// ---------- 1. 拿真实 status ----------
function askWorker(method, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    // 端口是咬死的 PREFERRED_PORT，测试必须给独立数据目录与端口，否则会去抢真身占着的 47822
    const child = spawn(process.execPath, [WORKER], { env: { ...process.env, CINDY_TRAE_DATA: mkdtempSync(join(os.tmpdir(), 'trae-e2e-')), CINDY_TRAE_PORT: '47971' }, stdio: ['pipe', 'pipe', 'inherit'] });
    const timer = setTimeout(() => { child.kill(); reject(new Error('worker 超时')); }, timeoutMs);
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== 1) continue;
        clearTimeout(timer);
        child.kill();
        if (msg.error) reject(new Error(msg.error.message || 'worker 报错'));
        // worker 的回包是双层的：{jsonrpc,id,result:{ok:true,result:<真实值>}}
        else {
          const outer = msg.result;
          if (outer && outer.ok === false) reject(new Error(outer.message || 'worker 返回失败'));
          else resolve(outer && outer.result !== undefined ? outer.result : outer);
        }
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }) + '\n');
  });
}

// ---------- 2. 面板要用到的 DOM id，直接从不变量里读，避免两边各改各的 ----------
function panelIds() {
  const code = readFileSync(PANEL_JS, 'utf8');
  const html = readFileSync(PANEL_HTML, 'utf8');
  const used = new Set();
  for (const m of code.matchAll(/\$\(\s*['"]([^'"]+)['"]\s*\)/g)) used.add(m[1]);
  for (const m of code.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) used.add(m[1]);
  const declared = new Set();
  for (const m of html.matchAll(/id="([^"]+)"/g)) declared.add(m[1]);
  return { used: [...used], declared };
}

function makeElement(id) {
  return {
    id, textContent: '', innerHTML: '', className: '', hidden: false, disabled: false,
    addEventListener(type, fn) { this[type] = fn; },
  };
}

(async () => {
  const { used, declared } = panelIds();
  const missing = used.filter((id) => !declared.has(id));
  if (missing.length) {
    console.error('FAIL: panel.js 用了 panel.html 里没有的 id：' + missing.join(','));
    process.exit(1);
  }
  console.log(`panel.js 用到的 ${used.length} 个 id 在 panel.html 里都有`);

  const status = await askWorker('trae/status');
  console.log('worker status: signedIn=%s account=%s models=%d port=%s',
    status.signedIn, status.accountName, status.modelCount, status.port);

  const el = {};
  for (const id of used) el[id] = makeElement(id);
  const document = { getElementById: (id) => el[id] || null };

  // 模拟 BroadcastChannel 的另一端 = 电子脑（真实 main.js 的应答语义）
  const bus = [];
  class FakeChannel {
    constructor(name) { this.name = name; bus.push(this); }
    postMessage(data) {
      // 面板 → 电子脑：模拟 main.js 的 reqId 去重 + 异步应答
      if (data && data.__panel === true) {
        setTimeout(() => {
          let value;
          if (data.action === 'status') value = status;
          else if (data.action === 'endpoint') {
            value = { ok: true, baseUrl: status.baseUrl, token: status.token, models: status.models };
          } else value = null;
          if (this.onmessage) this.onmessage({ data: { __brain: true, reqId: data.reqId, value } });
        }, 30);
      }
    }
    set onmessage(fn) { this._onmessage = fn; }
    get onmessage() { return this._onmessage; }
  }

  const fetches = [];
  let clipboard = '';
  const sandbox = {
    document,
    BroadcastChannel: FakeChannel,
    fetch: async (url) => { fetches.push(url); return { ok: true, json: async () => ({ state: 'running' }) }; },
    navigator: { clipboard: { writeText: async (t) => { clipboard = String(t); } } },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout,
    console,
  };

  const code = readFileSync(PANEL_JS, 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'panel.js' });

  // 等 load() 完成
  await new Promise((r) => setTimeout(r, 800));

  const checks = [];
  const expect = (name, got, want) => {
    const pass = typeof want === 'function' ? want(got) : got === want;
    checks.push({ name, pass, got });
  };

  expect('唤醒 fetch 打到 cindy-ghost://trae-bridge/wake', fetches[0], 'cindy-ghost://trae-bridge/wake');
  expect('标题', el.title.textContent, 'Trae 桥');

  // 未登录的机器上（没有 Trae CN 客户端）账号/模型这些全空，逐项硬断言只会误报。
  // 这里把「必须依赖登录态」的几项在未登录时降级成跳过，而不是判失败（issue #7）。
  const signedIn = status.signedIn === true;
  const guarded = (name, got, want) => {
    if (!signedIn) { console.log(`SKIP  ${name}（未登录 Trae，跳过）`); return; }
    expect(name, got, want);
  };
  guarded('账号', el.accountName.textContent, status.accountName);
  guarded('模型数', el.modelCount.textContent, status.modelCount + ' 个');
  guarded('额度含已用', el.quota.textContent, (v) => /已用 [\d.]+ \/ [\d.]+/.test(v));
  const firstModelId = (status.models && status.models[0] && status.models[0].id) || '';
  guarded('模型列表已渲染（不再显示「还没模型」）', el.models.innerHTML,
    (v) => firstModelId !== '' && v.includes(firstModelId) && !v.includes('还没有模型'));
  guarded('BaseURL 已填', el.baseUrl.textContent, status.baseUrl);
  // Token 默认打码（panel.js 的 renderToken），断言的是「前 6 + 后 4」的形态，不是明文。
  guarded('Token 默认打码', el.token.textContent,
    (v) => v.startsWith(status.token.slice(0, 6)) && v.endsWith(status.token.slice(-4)) && !v.includes(status.token));
  guarded('区域已填', el.region.textContent, (v) => v === String(status.region || '').toUpperCase());

  expect('端口', el.port.textContent, (v) => String(v) === String(status.port));
  // 面板指示灯本来就是登录绿、未登录红（panel.js 里 signedIn ? ok : err），
  // 未登录时硬断言 dot ok 等于让测试和实现互相打脸（issue #8）。
  expect('指示灯状态跟登录态一致', el.dot.className, signedIn ? 'dot ok' : 'dot err');
  expect('登录态 chip 跟登录态一致', el.signState.textContent, signedIn ? '已登录' : '未登录');
  expect('日志路径已填', el.logFile.textContent, (v) => String(v).endsWith('bridge.log'));
  expect('未登录/正常态都不该常驻显示 hint', el.hint.hidden, signedIn ? true : (status.hint ? false : true));

  // 点一下「显示」，token 必须变明文；再点回去必须复原 —— 这条是打码逻辑的真验收。
  if (signedIn && typeof el.showToken.click === 'function') {
    el.showToken.click();
    expect('点显示后 token 变明文', el.token.textContent, status.token);
    el.showToken.click();
    expect('再点隐藏后 token 复原打码', el.token.textContent, (v) => !v.includes(status.token));
  } else {
    console.log('SKIP  打码切换（未登录或没绑 click）');
  }

  // 复制按钮：真调一遍，断言剪贴板拿到的是完整值而不是打码值。
  if (signedIn && typeof el.copyToken.click === 'function') {
    await el.copyToken.click();
    expect('复制 Token 拿到明文', clipboard, status.token);
  } else {
    console.log('SKIP  复制 Token（未登录或没绑 click）');
  }

  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed++;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '  got=' + JSON.stringify(c.got).slice(0, 140)}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} 通过`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
