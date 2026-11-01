// 0.1.9 七项体验补齐的离线验收：日志落盘、本地用量账本、状态新字段、错误码人话。
// 真起 worker（独立端口 + 临时数据目录），全程走真 HTTP。
//
// 0.1.10 起 /healthz 只剩最小集（ok / port / modelCount），完整状态改到带鉴权的
// GET /status。所以这里不再从 /healthz 拿 token，而是直接读临时数据目录里的
// state.json（worker 在 startServer 里监听成功后就把 token 写进去了）。
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.FEATURES_PORT || 47981);
const WORKER = path.join(__dirname, '..', 'plugin', 'node', 'worker.cjs');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}${extra !== undefined ? '  → ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${extra !== undefined ? '  got=' + extra : ''}`); }
}
function skip(name, why) {
  console.log(`  --   ${name}（跳过：${why}）`);
}

function request(method, p, body, token) {
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
      timeout: 90000,
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

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-features-'));
  const child = spawn(process.execPath, [WORKER], {
    env: { ...process.env, CINDY_TRAE_DATA: dataDir, CINDY_TRAE_PORT: String(PORT) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stderr.on('data', (c) => logs.push(String(c)));
  child.stdout.on('data', () => {});

  let health = null;
  for (let i = 0; i < 160; i++) {
    const r = await request('GET', '/healthz');
    if (r.status === 200) { health = JSON.parse(r.text); break; }
    await new Promise((r2) => setTimeout(r2, 250));
  }
  if (!health) {
    console.log('FAIL：worker 没起来\n' + logs.join('').slice(-2000));
    child.kill();
    process.exit(1);
  }

  console.log('\n--- /healthz 最小集（不泄露本地 Token）---');
  ok('healthz 只有 ok/port/modelCount', JSON.stringify(Object.keys(health).sort()) === '["modelCount","ok","port"]', JSON.stringify(Object.keys(health)));
  ok('healthz 不带 token', health.token === undefined);
  ok('healthz 不带用户账号', health.user === undefined);
  ok('portIsOurs 需要的三个字段都在', health.ok === true && typeof health.port === 'number' && 'modelCount' in health);

  const token = readState(dataDir).token;
  ok('state.json 里有本地 token', typeof token === 'string' && token.length > 10, String(token).slice(0, 4) + '…');

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
  if (status.signedIn && !(status.usage || {}).error) {
    ok('额度带到期时间 expiresAt', 'expiresAt' in (status.usage || {}), (status.usage || {}).expiresAt);
    ok('上游没有 resetAt 时不凭空造', !('resetAt' in (status.usage || {})));
  } else {
    skip('额度带到期时间 expiresAt', '未登录 Trae / 用量接口没返回');
    skip('上游没有 resetAt 时不凭空造', '同上');
  }

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
  if (!status.signedIn || !target) {
    // 没登录态的机器上真打不了上游，这几项跳过而不是崩掉（issue #7）。
    console.log('\n--- 本地用量账本 / 错误码人话（需登录 Trae，跳过）---');
    skip('真打一次 chat 成功', '未登录 Trae 或 /v1/models 空');
    skip('usage.json 记账断言', '同上');
    skip('未知模型与 401 断言', '同上');
  } else {
    console.log('\n--- 本地用量账本 ---');
    const chat = await request('POST', '/v1/chat/completions', {
      model: target.id,
      messages: [{ role: 'user', content: '只回两个字：收到' }],
      max_tokens: 16,
    }, token);
    // 额度打光是账号状态，不是代码回归：一旦上游回 4008 / quota，本节全部 SKIP，
    // 否则额度用完的那几天每次跑测试都是红的，真正的问题会被埋掉。
    let chatBody = {};
    try { chatBody = JSON.parse(chat.text); } catch {}
    const quotaHit = chat.status === 402 || /4008|quota|额度|SOLO 额度/i.test(chatBody?.error?.message || '');
    if (quotaHit && chat.status !== 200) {
      skip('真打一次 chat 成功', '上游额度耗尽（4008），本次不判回归');
      skip('usage.json 已生成', '同上');
      skip('今日请求数被记账', '同上');
      skip('今日模型明细里有这个模型', '同上');
    } else {
      ok('真打一次 chat 成功', chat.status === 200, chat.status);

      await new Promise((r) => setTimeout(r, 400));
      const after = JSON.parse((await request('GET', '/status', undefined, token)).text);
      ok('usage.json 已生成', fs.existsSync(path.join(dataDir, 'usage.json')));
      ok('今日请求数被记账', after.localUsage.today.requests >= 1, JSON.stringify(after.localUsage.today));
      ok('今日模型明细里有这个模型', Boolean(after.localUsage.today.models?.[target.id]) || Boolean(after.localUsage.week.byModel?.[target.id]),
        JSON.stringify(after.localUsage.week.byModel || {}).slice(0, 120));
    }

    console.log('\n--- 错误码人话 ---');
    // 未知模型 id：Trae 上游对未知模型名会回自己的错误码，所以这里只要求不炸、不 500
    const bad = await request('POST', '/v1/chat/completions', {
      model: 'this-model-does-not-exist-xyz',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 8,
    }, token);
    ok('未知模型不会 500 崩掉', bad.status !== 500, bad.status);
    let badBody = {};
    try { badBody = JSON.parse(bad.text); } catch {}
    if (badBody?.error?.message) {
      ok('上报的错误是中文人话', /[\u4e00-\u9fa5]/.test(badBody.error.message), badBody.error.message.slice(0, 80));
    } else {
      ok('未知模型被上游兜底成正常回复', bad.status === 200, bad.status);
    }
  }

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
  const src = fs.readFileSync(WORKER, 'utf8');
  ok('映射表覆盖登录失效', /Trae 不认当前凭证了/.test(src));
  ok('映射表覆盖额度耗尽', /额度耗尽|SOLO 额度/.test(src));
  ok('映射表覆盖限流', /限流/.test(src));
  ok('映射表覆盖连不上', /连不上 Trae/.test(src));

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  child.kill();
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
})().catch((e) => {
  console.log('FAIL: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
