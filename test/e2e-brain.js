// 离线验收（真实链路版）：panel.js ⇄ main.js ⇄ cindy.node.request ⇄ worker
//
// 之前 e2e-panel.js 只模拟了「电子脑直接把 status 发给面板」这一层，
// 所以漏掉了 main.js 里 cindy.node.request 的信封解包 bug：
// 宿主返回 {ok:true,result:{ok:true,result:<真值>}}，main.js 少剥一层，
// 面板拿到的就是信封本身 → 显示「未登录 / 0 个 / —」。
//
// 这个测试把 panel.js 和 main.js 真的装进两个 vm 上下文、用一条真 bus 连起来，
// cindy.node.request 按宿主的真实格式（双层信封）应答，worker 是真进程。
'use strict';

const { spawn } = require('node:child_process');
const { readFileSync, mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

const ROOT = join(__dirname, '..');
const WORKER = join(ROOT, 'plugin', 'node', 'worker.cjs');
const PANEL_JS = join(ROOT, 'plugin', 'panel.js');
const MAIN_JS = join(ROOT, 'plugin', 'main.js');

// DOM id 表直接从 panel.js 里扫，别再手抄一份 —— 手抄的那份一旦漏了
// copyBase/copyToken 这类新按钮，panel.js 一执行就在这里炸 null.addEventListener。
function panelElementIds() {
  const code = readFileSync(PANEL_JS, 'utf8');
  const used = new Set();
  for (const m of code.matchAll(/\$\(\s*['"]([^'"]+)['"]\s*\)/g)) used.add(m[1]);
  for (const m of code.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) used.add(m[1]);
  return [...used];
}

// ---------- 1. 真 worker ----------
function makeWorkerClient() {
  return new Promise((resolve, reject) => {
    // 0.1.7 起端口咬死 PREFERRED_PORT，测试必须给独立数据目录与端口，否则会去抢真身占着的 47822
    const child = spawn(process.execPath, [WORKER], { env: { ...process.env, CINDY_TRAE_DATA: mkdtempSync(join(os.tmpdir(), 'trae-e2e-')), CINDY_TRAE_PORT: '47972' }, stdio: ['pipe', 'pipe', 'inherit'] });
    const waiting = new Map();
    let nextId = 1;
    let buf = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('worker 起不来')); }, 25000);

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const pending = waiting.get(msg.id);
        if (!pending) continue;
        waiting.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) pending.reject(new Error(msg.error.message || 'worker 报错'));
        else {
          // worker 回 {jsonrpc,id,result:{ok:true,result:<真值>}}，这里给调用方的是内层信封
          pending.resolve(msg.result);
        }
      }
    });
    child.on('exit', (code) => { if (waiting.size) for (const p of waiting.values()) p.reject(new Error('worker 退出 ' + code)); });

    resolve({
      request(method) {
        const id = nextId++;
        return new Promise((res, rej) => {
          waiting.set(id, { resolve: res, reject: rej });
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: {} }) + '\n');
        });
      },
      close() { child.kill(); },
    });
  });
}

// ---------- 2. 真 bus：两个上下文通过同名 channel 互相投递 ----------
const registry = [];
class FakeChannel {
  constructor(name) { this.name = name; this.onmessage = null; registry.push(this); }
  postMessage(data) {
    for (const peer of registry) {
      if (peer === this || peer.name !== this.name || !peer.onmessage) continue;
      setTimeout(() => { try { peer.onmessage({ data }); } catch (e) { console.error('bus 投递出错', e); } }, 5);
    }
  }
  close() { const i = registry.indexOf(this); if (i >= 0) registry.splice(i, 1); }
}

function makeElement(id) {
  return {
    id, textContent: '', innerHTML: '', className: '', hidden: false, disabled: false, style: {},
    _listeners: {},
    addEventListener(type, fn) { this._listeners[type] = fn; },
  };
}

(async () => {
  const worker = await makeWorkerClient();
  // makeWorkerClient 给的是内层信封 {ok:true,result:<真值>}，基准值要取真值
  const rawStatus = await worker.request('trae/status');
  const realStatus = rawStatus && rawStatus.result !== undefined ? rawStatus.result : rawStatus;
  console.log('真 worker: signedIn=%s account=%s models=%d port=%s',
    realStatus.signedIn, realStatus.accountName, realStatus.modelCount, realStatus.port);

  // ---- 面板上下文 ----
  const el = {};
  for (const id of panelElementIds()) el[id] = makeElement(id);

  const fetches = [];
  const panelSandbox = {
    document: { getElementById: (id) => el[id] || null },
    BroadcastChannel: FakeChannel,
    fetch: async (url) => { fetches.push(url); return { ok: true }; },
    navigator: { clipboard: { writeText: async () => {} } },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout, console,
  };
  vm.createContext(panelSandbox);
  vm.runInContext(readFileSync(PANEL_JS, 'utf8'), panelSandbox, { filename: 'panel.js' });

  // ---- 电子脑上下文 ----
  const toolCalls = [];
  const brainSandbox = {
    BroadcastChannel: FakeChannel,
    // 宿主的真实应答形状：外层 invoke 信封 + 内层 worker result
    cindy: {
      node: {
        async request(req) {
          const inner = await worker.request(req.method);       // {ok:true,result:<真值>}
          return { ok: true, result: inner };                    // ← 宿主再包一层
        },
      },
      onHostMessage(fn) { this._host = fn; },
      send(msg) { toolCalls.push(msg); },
    },
    setTimeout, clearTimeout, console,
  };
  vm.createContext(brainSandbox);
  vm.runInContext(readFileSync(MAIN_JS, 'utf8'), brainSandbox, { filename: 'main.js' });

  // 让面板发起 load()
  await new Promise((r) => setTimeout(r, 1200));

  const checks = [];
  const expect = (name, got, want) => {
    const pass = typeof want === 'function' ? want(got) : got === want;
    checks.push({ name, pass, got });
  };

  const signedIn = realStatus.signedIn === true;
  const account = realStatus.accountName || realStatus.user || '';

  expect('唤醒 fetch', fetches[0], 'cindy-ghost://trae-bridge/wake');
  // 未登录的机器上账号/模型/额度都拿不到，逐项硬断言只会误报，这里同样降级成跳过。
  const guarded = (name, got, want) => {
    if (!signedIn) { console.log(`SKIP  ${name}（未登录 Trae，跳过）`); return; }
    expect(name, got, want);
  };
  guarded('账号不是「未登录」', el.accountName.textContent, (v) => v === account);
  guarded('模型数不是「0 个」', el.modelCount.textContent, realStatus.modelCount + ' 个');
  guarded('额度已显示', el.quota.textContent, (v) => /已用 [\d.]+ \/ [\d.]+/.test(v));
  const firstId = (realStatus.models && realStatus.models[0] && realStatus.models[0].id) || '';
  guarded('模型列表已渲染', el.models.innerHTML, (v) => firstId !== '' && v.includes(firstId));
  guarded('BaseURL 已填', el.baseUrl.textContent, (v) => v === realStatus.baseUrl);
  // 面板默认打码（renderToken），所以断言的是打码形态而不是明文。
  guarded('Token 默认打码但前 6 后 4 对得上', el.token.textContent,
    (v) => v.startsWith(realStatus.token.slice(0, 6)) && v.endsWith(realStatus.token.slice(-4)) && !v.includes(realStatus.token));
  expect('端口已显示', el.port.textContent, (v) => String(v) === String(realStatus.port));
  expect('指示灯跟登录态一致', el.dot.className, signedIn ? 'dot ok' : 'dot err');

  // ---- 工具调用也走同一条解包路径 ----
  const host = brainSandbox.cindy._host;
  await host({ type: 'tool-call', tool: 'trae_status', callId: 'c1' });
  await host({ type: 'tool-call', tool: 'trae_endpoint', callId: 'c2' });
  const statusCall = toolCalls.find((c) => c.callId === 'c1');
  const epCall = toolCalls.find((c) => c.callId === 'c2');
  expect('工具 trae_status 成功', statusCall && statusCall.ok, true);
  expect('工具 trae_status 文本含真账号', statusCall && statusCall.result && statusCall.result.text,
    (v) => typeof v === 'string' && (signedIn ? v.includes(account) && !v.includes('未登录') : v.includes('未登录')));
  // 未登录时 endpoint 按设计回 ok:false：断言跟登录态走，别把环境缺失报成产品失败。
  expect('工具 trae_endpoint 成功', epCall && epCall.ok, signedIn);
  expect('工具 trae_endpoint 文本含 BaseURL', epCall && epCall.result && epCall.result.text,
    (v) => signedIn ? (typeof v === 'string' && v.includes(realStatus.baseUrl)) : v == null);

  worker.close();
  registry.length = 0;

  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed++;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.pass ? '' : '  got=' + String(JSON.stringify(c.got ?? null)).slice(0, 160)}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} 通过`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FAIL:', e && e.stack ? e.stack : e); process.exit(1); });
