// 端到端验证：解包 .cindy → 校验结构 → 用包里的 worker 真起一次服务 → 发一轮对话
// 这是"包本身能不能用"的判据，不是"能不能装进 Cindy"（后者只能靠实机导入）。
'use strict';

const { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');
const { extractZip } = require('./_unzip.cjs');

const PKG = join(__dirname, '..', 'dist', 'trae-cindy-bridge.cindy');
// 免费、快的模型优先；想换模型：node test/e2e-package.js <模型 id>
const PREFERRED_MODEL = process.argv[2] || 'deepseek-v4.1-flash';
const fail = [];
const pass = [];
const skipped = [];

function ok(msg) { pass.push(msg); console.log('  ok   ' + msg); }
function bad(msg) { fail.push(msg); console.log('  FAIL ' + msg); }
function skip(msg) { skipped.push(msg); console.log('  SKIP ' + msg); }

// 上游额度打光（4008 / quota）是账号状态，不是代码回归。
// 这几条必须真打上游才看得出结论，所以命中额度就降级为 SKIP，不能记成 FAIL。
function isQuota(status, body) {
  if (status === 402) return true;
  return /4008|[Qq]uota|额度|SOLO 额度|exceeded the quota/.test(String(body || ''));
}

if (!existsSync(PKG)) { console.error('包不存在：' + PKG); process.exit(1); }

// ---- 1. 解包（用内置 zip 读取器，不依赖 PowerShell，跨平台一致） ----
const work = mkdtempSync(join(tmpdir(), 'cindy-trae-e2e-'));
try {
  extractZip(PKG, work);
  ok('zip 能正常解包');
} catch (e) {
  bad('解包失败：' + String(e.message).slice(0, 300));
  process.exit(1);
}

// ---- 2. 结构 ----
const MUST = ['ghost.json', 'main.js', 'panel.html', 'panel.js', join('node', 'worker.cjs'), join('node', 'adapters.cjs'), join('node', 'update.cjs')];
for (const rel of MUST) {
  if (existsSync(join(work, rel))) ok(`包含 ${rel}`);
  else bad(`缺少 ${rel}`);
}

// MIT 要求分发时随附许可与版权声明。.cindy 会跑到别人机器上，那就算分发。
for (const rel of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']) {
  if (existsSync(join(work, rel))) ok(`包含 ${rel}（许可与第三方声明）`);
  else bad(`缺少 ${rel}：MIT 要求分发时随附许可与版权声明`);
}
if (!existsSync(join(work, 'ghost.json'))) process.exit(1);

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(work, 'ghost.json'), 'utf8'));
  ok('ghost.json 在包根且是合法 JSON');
} catch (e) {
  bad('ghost.json 解析失败：' + e.message);
  process.exit(1);
}

if (manifest.id === 'trae-bridge') ok('id 正确'); else bad(`id 不对：${manifest.id}`);
if (manifest.schemaVersion === 3) ok('schemaVersion=3'); else bad('schemaVersion 不是 3');
if (typeof manifest.minCindyVersion === 'string') ok('声明了 minCindyVersion'); else bad('缺 minCindyVersion');
if (manifest.node && manifest.node.lifecycle === 'resident') ok('node.lifecycle=resident（随插件常驻）');
else bad('node.lifecycle 不是 resident');
if (manifest.command) ok(`command="${manifest.command}"（插件页「使用」按钮可用）`); else bad('缺 command');

// ---- 3. 用包里的 worker 真起一次 ----
const port = 47871;
const dataDir = join(work, '_e2e-data');
mkdirSync(dataDir, { recursive: true });

const child = spawn(process.execPath, [join(work, 'node', 'worker.cjs')], {
  cwd: work,
  env: { ...process.env, CINDY_TRAE_DATA: dataDir, CINDY_TRAE_PORT: String(port) },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (b) => { stderr += b.toString(); });

let buf = '';
const waiting = new Map();
child.stdout.on('data', (b) => {
  buf += b.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const r = waiting.get(msg.id);
      if (r) { waiting.delete(msg.id); r(msg); }
    } catch {}
  }
});

let seq = 0;
function rpc(method, timeoutMs = 60000) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { waiting.delete(id); reject(new Error('timeout ' + method)); }, timeoutMs);
    waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: {} }) + '\n');
  });
}

(async () => {
  day: {
    // 等 worker 自己 boot
    await new Promise((r) => setTimeout(r, 7000));

    let st;
    try {
      const res = await rpc('trae/status');
      st = res.result && res.result.result;
    } catch (e) {
      bad('trae/status 调用失败：' + e.message);
      break day;
    }
    if (!st || st.ok !== true) { bad('status 未返回 ok'); break day; }
    ok(`worker 起来了（端口 ${st.port}）`);
    if (st.signedIn === true) ok(`读到 Trae 登录态：${st.user || '(无名)'}`);
    else bad('没读到 Trae 登录态：' + (st.hint || ''));

    if (st.modelCount >= 1) ok(`模型目录 ${st.modelCount} 个`);
    else bad('模型目录为空');

    if (st.token && st.token.length >= 16) ok('端点 token 已生成');
    else bad('token 缺失');

    // 真打一轮
    if (st.signedIn && st.modelCount > 0) {
      const model = st.models.find((x) => x.id === PREFERRED_MODEL) || st.models[0];
      try {
        const res = await fetch(st.baseUrl + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + st.token },
          body: JSON.stringify({ model: model.id, messages: [{ role: 'user', content: '只回答两个字：收到' }], stream: false, max_tokens: 50 }),
          signal: AbortSignal.timeout(90000),
        });
        if (res.status === 200) {
          const j = await res.json();
          const text = (j.choices?.[0]?.message?.content || '').trim();
          if (text.length > 0) ok(`对话成功（${model.id}）：${text.slice(0, 40)}`);
          else bad('对话 200 但内容为空');
        } else {
          const body = await res.text();
          if (isQuota(res.status, body)) skip(`对话 HTTP ${res.status}（4008 额度耗尽，账号状态非回归）`);
          else bad('对话 HTTP ' + res.status + ' ' + body.slice(0, 200));
        }
      } catch (e) {
        bad('对话请求失败：' + e.message);
      }
    }

    // 无 token 必须 401
    try {
      const r = await fetch(st.baseUrl + '/models', { signal: AbortSignal.timeout(10000) });
      if (r.status === 401) ok('无 token 请求被拒（401）');
      else bad(`无 token 返回 ${r.status}，应为 401`);
    } catch (e) { bad('鉴权测试失败：' + e.message); }

    // 两条新协议路由必须在包里也活着（claude-code / codex 引擎靠它们）
    if (st.signedIn && st.modelCount > 0) {
      const model = st.models.find((x) => x.id === PREFERRED_MODEL) || st.models[0];
      const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + st.token };
      try {
        const r = await fetch(st.baseUrl + '/messages', {
          method: 'POST', headers: H,
          body: JSON.stringify({ model: model.id, max_tokens: 32, stream: false, messages: [{ role: 'user', content: '只回答两个字：收到' }] }),
          signal: AbortSignal.timeout(90000),
        });
        const body = await r.text();
        let j = null;
        try { j = r.status === 200 ? JSON.parse(body || '{}') : null; } catch (e) { bad('/v1/messages 回的 JSON 解析失败：' + e.message); }
        if (j && j.type === 'message') ok('/v1/messages 可用（Anthropic 协议）');
        else if (isQuota(r.status, body)) skip(`/v1/messages HTTP ${r.status}（4008 额度耗尽，账号状态非回归）`);
        else bad('/v1/messages HTTP ' + r.status + ' ' + body.slice(0, 160));
      } catch (e) { bad('/v1/messages 失败：' + e.message); }

      try {
        const r = await fetch(st.baseUrl + '/responses', {
          method: 'POST', headers: H,
          body: JSON.stringify({ model: model.id, max_output_tokens: 32, stream: false, input: '只回答两个字：收到' }),
          signal: AbortSignal.timeout(90000),
        });
        const body = await r.text();
        const j = r.status === 200 ? JSON.parse(body || '{}') : null;
        if (j && j.object === 'response') ok('/v1/responses 可用（Responses 协议）');
        else if (isQuota(r.status, body)) skip(`/v1/responses HTTP ${r.status}（4008 额度耗尽，账号状态非回归）`);
        else bad('/v1/responses HTTP ' + r.status + ' ' + body.slice(0, 160));
      } catch (e) { bad('/v1/responses 失败：' + e.message); }
    }
  }

  child.kill();
  try { rmSync(work, { recursive: true, force: true }); } catch {}

  console.log('\n结果：' + pass.length + ' 通过，' + fail.length + ' 失败' + (skipped.length ? '，' + skipped.length + ' 跳过（额度耗尽）' : ''));
  if (skipped.length) {
    console.log('\n跳过项：');
    for (const s of skipped) console.log('  - ' + s);
  }
  if (fail.length) {
    console.log('\n失败项：');
    for (const f of fail) console.log('  x ' + f);
    if (stderr) console.log('\nworker stderr 尾部：\n' + stderr.slice(-800));
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => { console.error('E2E 异常：' + e.message); child.kill(); process.exit(1); });
