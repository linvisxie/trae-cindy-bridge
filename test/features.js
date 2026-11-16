// 0.1.9 七项体验补齐的离线验收：日志落盘、本地用量账本、状态新字段、错误码人话。
// 真起 worker（独立端口 + 临时数据目录），全程走真 HTTP。
//
// 0.1.10 起 /healthz 只剩最小集（ok / port / modelCount），完整状态改到带鉴权的
// GET /status。预置一次性随机 token，只以带鉴权的 /status 确认本次 worker 就绪。
// 完全隔离的 standalone 离线测试，禁止登录态和任何 live 模型请求。
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const net = require('node:net');
const { randomBytes } = require('node:crypto');

let PORT;
const WORKER = path.join(__dirname, '..', 'plugin', 'node', 'bootstrap.cjs');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}${extra !== undefined ? '  → ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${extra !== undefined ? '  got=' + extra : ''}`); }
}
function skip(name, why) {
  console.log(`  --   ${name}（跳过：${why}）`);
}

function request(method, p, body, token, timeout = 90000) {
  return new Promise((resolve) => {
    const http = require('node:http');
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: {
        ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        host: '127.0.0.1',
      },
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    if (data) req.write(data);
    req.end();
  });
}

function readState(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')); } catch { return {}; }
}

async function reservePort() {
  const requested = process.env.FEATURES_PORT === undefined ? 0 : Number(process.env.FEATURES_PORT);
  if (!Number.isInteger(requested) || requested < 0 || requested > 65535) throw new Error('Invalid FEATURES_PORT');
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requested, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  return port;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-features-'));
  const dataDir = path.join(root, 'data');
  const token = randomBytes(32).toString('hex');
  let child;
  let stopped;
  let ended = false;
  let childFailure;
  // Keep only allowlisted bootstrap ownership diagnostics, never raw worker output/token.
  let ownershipFailure = '';
  const assertAlive = () => {
    if (childFailure) throw new Error(childFailure + (ownershipFailure ? `; ${ownershipFailure}` : ''));
    if (ended) throw new Error('worker exited unexpectedly');
  };
  try {
  PORT = await reservePort();
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(XDG_|APPDATA$|LOCALAPPDATA$|USERPROFILE$|HOME$|HOMEDRIVE$|HOMEPATH$|NODE_OPTIONS$|NODE_PATH$)/i.test(key)) delete env[key];
  }
  const dirs = {
    APPDATA: 'roaming', LOCALAPPDATA: 'local', USERPROFILE: 'home', HOME: 'home',
    XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'share', XDG_CACHE_HOME: 'cache',
    XDG_STATE_HOME: 'state', XDG_RUNTIME_DIR: 'run',
    XDG_CONFIG_DIRS: 'config-dirs', XDG_DATA_DIRS: 'data-dirs',
    TEMP: 'tmp', TMP: 'tmp', TMPDIR: 'tmp',
  };
  for (const [key, dir] of Object.entries(dirs)) {
    env[key] = path.join(root, dir);
    fs.mkdirSync(env[key], { recursive: true });
  }
  env.HOMEDRIVE = path.parse(env.HOME).root.replace(/[\\/]$/, '');
  env.HOMEPATH = env.HOME.slice(env.HOMEDRIVE.length);
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ token }), { mode: 0o600 });
  Object.assign(env, { CINDY_TRAE_DATA: dataDir, CINDY_TRAE_PORT: String(PORT) });
  child = spawn(process.execPath, [WORKER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  stopped = new Promise((resolve) => {
    child.once('error', (err) => { childFailure = `worker startup failed: ${err.message}`; ended = true; resolve(); });
    child.once('exit', (code, signal) => {
      childFailure = `worker exited: code=${code}, signal=${signal}`;
      ended = true;
    });
    child.once('close', resolve);
  });
  let diagnosticTail = '';
  child.stderr.on('data', (c) => {
    diagnosticTail = (diagnosticTail + String(c)).slice(-4096);
    const match = diagnosticTail.match(/(?:INSTALL_DIR|DATA_DIR) ownership (?:unavailable \([A-Z0-9_ -]+\)|requires Windows named pipes \(or Linux abstract sockets for offline CI\))/);
    if (match) ownershipFailure = match[0];
  });
  child.stdout.on('data', () => {});

  let ready = false;
  for (let i = 0; i < 160; i++) {
    assertAlive();
    const r = await request('GET', '/status', undefined, token, 1500);
    assertAlive();
    if (r.status === 200) {
      const s = JSON.parse(r.text);
      if (s.token !== token || s.port !== PORT || s.logFile !== path.join(dataDir, 'bridge.log')) {
        throw new Error('Authenticated status does not identify our worker');
      }
      if (s.signedIn !== false) throw new Error('Offline isolation failed: worker is signed in');
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('worker startup timed out (no authenticated status from our worker)');
  const healthRes = await request('GET', '/healthz');
  const health = JSON.parse(healthRes.text);

  console.log('\n--- /healthz 最小集（不泄露本地 Token）---');
  ok('healthz 只有 ok/port/modelCount', JSON.stringify(Object.keys(health).sort()) === '["modelCount","ok","port"]', JSON.stringify(Object.keys(health)));
  ok('healthz 不带 token', health.token === undefined);
  ok('healthz 不带用户账号', health.user === undefined);
  ok('portIsOurs 需要的三个字段都在', health.ok === true && typeof health.port === 'number' && 'modelCount' in health);

  ok('state.json 保留本次随机本地 token', readState(dataDir).token === token);

  console.log('\n--- /status 需要鉴权 ---');
  const anon = await request('GET', '/status');
  ok('无 token 打 /status 回 401', anon.status === 401, anon.status);
  let anonBody = {};
  try { anonBody = JSON.parse(anon.text); } catch {}
  ok('401 的提示是中文', /[\u4e00-\u9fa5]/.test(anonBody?.error?.message || ''), anonBody?.error?.message);

  const statusRes = await request('GET', '/status', undefined, token);
  ok('带 token 打 /status 回 200', statusRes.status === 200, statusRes.status);
  let status = {};
  try { status = JSON.parse(statusRes.text); } catch {}
  if (status.signedIn !== false) throw new Error('Offline isolation failed: worker is signed in');
  ok('离线测试未登录（禁止 live 模型请求）', status.signedIn === false);
  ok('/v1/status 也能取到完整状态', (await request('GET', '/v1/status', undefined, token)).status === 200);

  console.log('\n--- 状态对象新字段 ---');
  ok('status 带 usage', status.usage !== undefined, typeof status.usage);
  ok('status 带 checkin', status.checkin !== undefined, JSON.stringify(status.checkin).slice(0, 120));
  ok('status 带 localUsage', status.localUsage !== undefined && status.localUsage.today !== undefined);
  ok('status 带 logFile', typeof status.logFile === 'string' && status.logFile.endsWith('bridge.log'), status.logFile);
  ok('checkin 带下次开轮时间', Number.isFinite(Number(status.checkin.nextAt)), new Date(status.checkin.nextAt).toISOString());
  // 未登录时 refreshUsage 走的是 error 分支，只写 { at, error }，压根没有这两个键，
  // 所以只能在登录态下硬断言，否则离线跑测试必挂（issue #8）。
  // 注：Trae 的用量接口没有「额度重置时间」这个字段（实测 web_user_ent_usage 只有
  // usage_summary.consumption_ratio），所以这里只断言 expiresAt —— 它来自各额度包的
  // 到期时间，是上游真给的数据，不是编的。
  skip('额度带到期时间 expiresAt', '离线测试禁止登录/上游请求');
  skip('上游没有 resetAt 时不凭空造', '同上');

  console.log('\n--- 日志落盘 ---');
  const logPath = path.join(dataDir, 'bridge.log');
  ok('bridge.log 已创建', fs.existsSync(logPath), logPath);
  const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  ok('日志有内容', logText.length > 0, logText.length + ' 字节');
  ok('日志行带 ISO 时间戳', /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[trae-bridge\]/m.test(logText), (logText.split('\n')[0] || '').slice(0, 60));
  ok('日志里有监听得端口记录', /已在 127\.0\.0\.1:\d+ 监听/.test(logText));

  console.log('\n--- 模型倍率与档位 ---');
  const modelsRes = await request('GET', '/v1/models', undefined, token);
  let models = [];
  try { models = (JSON.parse(modelsRes.text).data) || []; } catch {}
  // 200 是接口能用，跟登没登录无关，硬断言；有模型才继续（issue #8）。
  ok('/v1/models 可用', modelsRes.status === 200, modelsRes.status);
  if (!models.length) {
    skip('模型列表非空', '/v1/models 返回 0 个（多半是没登录 Trae）');
    skip('倍率/档位相关断言', '/v1/models 空（多半是没登录 Trae）');
  } else {
    // 上游对 custom_model_* / title_generation 这类不给倍率，参考实现也明确
    // 「parsed-but-absent, never fabricated」，所以只要求「有倍率的模型必须都露出来」，
    // 另外反向断言「没倍率的不许编一个」。
    const withFactor = models.filter((m) => m.price_factor !== undefined);
    ok('有倍率的模型都带 price_factor', withFactor.length > 0, withFactor.length + '/' + models.length);
    const labelHasFactor = models.filter((m) => /· (免费|x[\d.]+)/.test(m.name || ''));
    ok('name 里的倍率与 price_factor 一一对应', labelHasFactor.length === withFactor.length,
      labelHasFactor.length + ' 个带标签 / ' + withFactor.length + ' 个带倍率');
    const fabricated = models.filter((m) => m.price_factor === undefined && /· (免费|x[\d.]+)/.test(m.name || ''));
    ok('没倍率的模型不编造倍率', fabricated.length === 0, fabricated.map((m) => m.id).slice(0, 3).join(','));
    const withEffort = models.filter((m) => Array.isArray(m.reasoning?.supported_efforts) && m.reasoning.supported_efforts.length > 0);
    ok('推理模型带档位列表', withEffort.length > 0, withEffort.length + ' 个带档位');
    // 档位必须是上游线上的名字映射过来的，不能出现上游不认的 minimal 之类。
    const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
    const badEffort = models.flatMap((m) => (m.reasoning?.supported_efforts || []).filter((e) => !EFFORTS.includes(e)));
    ok('档位名都在 low/medium/high/xhigh/max 里', badEffort.length === 0, badEffort.slice(0, 5).join(','));
    // 只报上游明说 options 的模型（support_thinking === true）不该被塞满五档。
    const partial = withEffort.filter((m) => m.reasoning.supported_efforts.length < EFFORTS.length);
    ok('明说档位的模型只报它明说的', partial.every((m) => m.reasoning.supported_efforts.length > 0),
      partial.map((m) => m.id + '=' + m.reasoning.supported_efforts.join('/')).join(' '));
    // 上下文窗口取实测可用上限（MEASURED_CONTEXT），不是目录里的 dev：不能全是同一个数
    // （那样等于没读），也不能把 168000 这个「保守输入上限」当窗口（src: prompt_max_tokens）。
    const ctxSet = new Set(models.map((m) => m.context_window));
    ok('上下文窗口不是一刀切', ctxSet.size > 1, [...ctxSet].sort((a, b) => a - b).join('/'));
    const wrongCtx = models.filter((m) => m.context_window === 168000 || m.context_window === 936000);
    ok('没把 prompt_max_tokens 当窗口', wrongCtx.length === 0, wrongCtx.map((m) => m.id).slice(0, 3).join(','));
    const maxed = models.filter((m) => Number(m.max_context_window) > Number(m.context_window));
    ok('max_context_window 不小于 context_window', models.every((m) => Number(m.max_context_window || 0) >= Number(m.context_window || 0)),
      maxed.length + ' 个带更大 max');
    // 实测出来的 1M 必须真的报出去 —— 这是用户明确要的能力，退回 200K 就是回归。
    const wide = models.filter((m) => Number(m.context_window) >= 1000000);
    ok('有模型报到 1M 上下文', wide.length > 0, wide.length + ' 个 >=1M');
    // 只列能聊的模型：custom_model_* 多在本机 3003/4023，工具模型根本不该进选择器。
    const junk = models.filter((m) => /^(custom_model_|title_generation$|input_optimization$|fast_apply|summary$)/.test(m.id));
    ok('模型列表里没有自建槽/工具模型', junk.length === 0, junk.map((m) => m.id).slice(0, 5).join(','));
  }

  const target = models.find((m) => (m.reasoning?.supported_efforts || []).length > 0) || models[0];
  console.log('\n--- 离线模式：0 upstream，禁止 live 模型请求 ---');
  skip('真实 chat / 上游兜底 / 请求记账', '此测试只允许离线验收，不存在 live 分支');
  ok('离线账本没有模型请求', status.localUsage.today.requests === 0, status.localUsage.today.requests);

  console.log('\n--- 未登录也能验的输入校验 ---');
  // 鉴权失败这条路必须是中文人话
  const noTok = await request('POST', '/v1/chat/completions', {
    model: target ? target.id : 'auto', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8,
  });
  ok('无 token 回 401', noTok.status === 401, noTok.status);
  let noTokBody = {};
  try { noTokBody = JSON.parse(noTok.text); } catch {}
  ok('401 的提示是中文', /[\u4e00-\u9fa5]/.test(noTokBody?.error?.message || ''), noTokBody?.error?.message);

  // 畸形请求体：以前一律 500，现在应是 400
  const broken = await request('POST', '/v1/chat/completions', undefined, token);
  ok('空 body 打 chat 回 400 而不是 500', broken.status === 400, broken.status);

  // 三条协议对畸形 tool 输入都该在查登录态之前回 400（issue #3）
  const malformed = [
    ['chat', '/v1/chat/completions', { model: 'auto', messages: [{ role: 'tool', content: 'x' }] }],
    ['anthropic', '/v1/messages', { model: 'auto', max_tokens: 8, messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'x' }] }] }],
    ['responses', '/v1/responses', { model: 'auto', input: [{ type: 'function_call_output', output: 'x' }] }],
  ];
  for (const [name, p, body] of malformed) {
    const r = await request('POST', p, body, token);
    ok(`${name} 畸形 tool 输入回 400`, r.status === 400, r.status);
    let b = {};
    try { b = JSON.parse(r.text); } catch {}
    ok(`${name} 的报错说明了哪里不对`, /请求格式不对/.test(b?.error?.message || ''), (b?.error?.message || '').slice(0, 60));
  }

  // 上游错误帧的人工化映射：直接按 worker 的映射表校对（同一份规则文件里）
  const src = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'node', 'worker.cjs'), 'utf8');
  ok('映射表覆盖登录失效', /Trae 不认当前凭证了/.test(src));
  ok('映射表覆盖额度耗尽', /额度耗尽|SOLO 额度/.test(src));
  ok('映射表覆盖限流', /限流/.test(src));
  ok('映射表覆盖连不上', /连不上 Trae/.test(src));

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  assertAlive();
  process.exitCode = fail ? 1 : 0;
  } finally {
    // Only terminate the ChildProcess we spawned; never inspect/kill a port owner.
    if (child && !ended) {
      child.kill();
      let timer;
      await Promise.race([stopped, new Promise((resolve) => { timer = setTimeout(resolve, 5000); })]);
      clearTimeout(timer);
      if (!ended) {
        child.kill('SIGKILL');
        await stopped;
      }
    }
    if (stopped) await stopped;
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.log('FAIL: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
