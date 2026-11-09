// 第二轮复审的行为回归。只用临时目录、假凭据/上游与假安装器，不联网、不换票、不覆盖插件。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const updater = require('../plugin/node/update.cjs');
const ROOT = path.resolve(__dirname, '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin/ghost.json')));
const IS_TRAE = MANIFEST.id === 'trae-bridge';
const temporary = [];
test.after(() => { for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true }); });

function worker(options = {}) {
  const file = path.join(ROOT, 'plugin/node/worker.cjs');
  const baseRequire = createRequire(file);
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'bridge-review-'));
  temporary.push(dir);
  const launches = [], exits = [], ownershipCalls = [];
  const owner = {
    held: true,
    assertHeld() { if (!this.held) throw new Error('fixture ownership lost'); },
  };
  const installation = { ...owner };
  const ctx = vm.createContext({
    __CINDY_BRIDGE_OWNERSHIP: options.unowned ? undefined : { installation, data: owner },
    __dirname: path.dirname(file), Buffer, URL, TextDecoder, AbortController, AbortSignal,
    fetch: async () => { throw new Error('unexpected fixture fetch'); },
    require(id) {
      if (id === './update-status.cjs') return { ...baseRequire(id), updateDirectory: () => path.join(dir, 'update') };
      if (id === './ownership.cjs') return { pipeName: (_directory, scope = 'data') => '\\\\.\\pipe\\fixture-' + scope, async acquireOwnership(directory) {
        ownershipCalls.push(directory);
        throw new Error('worker must not acquire ownership');
      } };
      if (id === './trae.cjs') return options.trae || {
        ...baseRequire(id), readTraeCredential: () => ({ ok: false, reason: 'not-found' }),
      };
      if (id === 'node:fs' && options.fs) return { ...baseRequire(id), ...options.fs };
      if (id === 'node:child_process') return {
        ...baseRequire(id),
        spawn() {
          const child = new EventEmitter(); child.unref = () => {};
          launches.push(child);
          queueMicrotask(() => child.emit(options.spawnError ? 'error' : 'spawn', options.spawnError));
          return child;
        },
      };
      return baseRequire(id);
    },
    process: {
      env: { ...process.env, APPDATA: dir, LOCALAPPDATA: dir, USERPROFILE: dir, HOME: dir, CINDY_QODER_DATA: dir, CINDY_TRAE_DATA: dir },
      stderr: { write() {} }, platform: process.platform, arch: process.arch,
      pid: process.pid, execPath: process.execPath, exit() { throw new Error('test must not exit worker'); },
    },
    setTimeout(fn, ms) { if (ms === 800) { exits.push(fn); return 0; } return setTimeout(fn, ms); },
    clearTimeout,
  });
  // Retain the real implementation, omit resident boot and stdio event registration.
  vm.runInContext(fs.readFileSync(file, 'utf8').split('// JSON-RPC over stdio')[0], ctx, { filename: file });
  return { ctx, dir, launches, exits, owner, installation, ownershipCalls, run: (source) => vm.runInContext(source, ctx) };
}

test('worker requires both bootstrap owners and never acquires ownership itself', async () => {
  const w = worker();
  await Promise.all([w.run('ensureOwnership()'), w.run('ensureOwnership()')]);
  assert.deepEqual(w.ownershipCalls, []);
  w.run('saveState({fixture:true})');
  for (const owner of [w.installation, w.owner]) {
    owner.held = false;
    await assert.rejects(w.run('ensureOwnership()'), /ownership|required|lost/i);
    assert.throws(() => w.run('saveState({fixture:false})'), /ownership|required|lost/i);
    owner.held = true;
    const heldAssertion = owner.assertHeld;
    owner.assertHeld = () => { throw new Error('fixture ownership lost'); };
    await assert.rejects(w.run('ensureOwnership()'), /ownership lost/);
    owner.assertHeld = heldAssertion;
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.dir, 'state.json'))).fixture, true);
  assert.throws(() => worker({ unowned: true }), /bootstrap|ownership|required/i);
  const denied = worker();
  denied.installation.held = false;
  assert.throws(() => denied.run('saveState({fixture:true})'), /ownership|required|lost/i);
  denied.run("refreshCredential=async()=>{throw Error('must not read credentials')};startServer=async()=>{throw Error('must not listen')}");
  await assert.rejects(denied.run('boot()'), /ownership|required|lost/i);
  assert.deepEqual(denied.ownershipCalls, []);
  assert.deepEqual(fs.readdirSync(denied.dir), []);
  assert.equal(denied.launches.length, 0);
});

async function request(w, route, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST'; req.url = route;
  req.headers = { host: '127.0.0.1', authorization: 'Bearer local-test' };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = Object.assign(new EventEmitter(), {
    text: '', writeHead(status) { this.status = status; this.headersSent = true; },
    write(chunk) { this.text += chunk; return true; }, end(chunk = '') { this.text += chunk; this.writableEnded = true; },
  });
  w.ctx.req = req; w.ctx.res = res;
  await w.run('handle(req,res)');
  return res;
}

for (const input of [123, 0]) for (const route of ['/v1/messages', '/v1/responses']) for (const stream of [false, true]) {
  test(`usage ${route} stream=${stream} actual input=${input}`, async () => {
    const w = worker();
    w.run(`token='local-test';models=[{key:'test',name:'Test'}];refreshCredential=async()=>({token:'fixture'});
      streamChat=async function*(){yield{choices:[{delta:{content:'hi'},finish_reason:'stop'}],usage:{prompt_tokens:${input},completion_tokens:45,total_tokens:${input + 45}}};}`);
    const body = route.endsWith('messages')
      ? { model: 'test', messages: [{ role: 'user', content: 'Hi' }], stream }
      : { model: 'test', input: 'Hi', stream };
    const res = await request(w, route, body);
    assert.equal(res.status, 200);
    const book = JSON.parse(fs.readFileSync(path.join(w.dir, 'usage.json')));
    const stats = Object.values(book.days)[0].models.test;
    assert.equal(stats.in, input); assert.equal(stats.out, 45);
    if (!stream) assert.equal(JSON.parse(res.text).usage.input_tokens, input);
    if (stream && route.endsWith('messages')) {
      const events = res.text.split('\n').filter(s => s.startsWith('data: ')).map(s => JSON.parse(s.slice(6)));
      assert.equal(events.find(e => e.type === 'message_delta').usage.input_tokens, input);
    }
  });
}

const validManifest = { ...MANIFEST, version: '99.0.0' };
function entries(manifest = validManifest) {
  return ['ghost.json', 'main.js', 'panel.js', 'panel.html', 'node/worker.cjs', 'node/bootstrap.cjs', 'node/adapters.cjs', 'node/update.cjs', 'node/ownership.cjs', 'node/download.cjs', 'node/update-status.cjs', ...(IS_TRAE ? ['node/trae.cjs'] : [])]
    .map(name => ({ name, data: Buffer.from(name === 'ghost.json' ? JSON.stringify(manifest) : 'fixture') }));
}
const expected = { id: MANIFEST.id, version: '99.0.0', currentVersion: MANIFEST.version, required: ['node/bootstrap.cjs', 'node/adapters.cjs', 'node/update.cjs', 'node/ownership.cjs', 'node/download.cjs', 'node/update-status.cjs', ...(IS_TRAE ? ['node/trae.cjs'] : [])] };
// Small ZIP writer for controlled updater fixtures (stored entries, valid CRC).
function zip(list) {
  const local = [], central = []; let offset = 0;
  for (const { name, data } of list) {
    const n = Buffer.from(name); let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
    crc = (crc ^ 0xffffffff) >>> 0;
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20,4); h.writeUInt32LE(crc,14);
    h.writeUInt32LE(data.length,18); h.writeUInt32LE(data.length,22); h.writeUInt16LE(n.length,26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20,4); c.writeUInt16LE(20,6); c.writeUInt32LE(crc,16);
    c.writeUInt32LE(data.length,20); c.writeUInt32LE(data.length,24); c.writeUInt16LE(n.length,28); c.writeUInt32LE(offset,42);
    local.push(h,n,data); central.push(c,n); offset += h.length+n.length+data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(list.length,8);
  end.writeUInt16LE(list.length,10); end.writeUInt32LE(cd.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,cd,end]);
}
function prepareUpdate(w, list) {
  const bytes = zip(list);
  const name = IS_TRAE ? 'trae-cindy-bridge.cindy' : 'cindy-qoder-bridge.cindy';
  const url = `https://github.com/${w.run('UPDATE_REPO')}/releases/download/v99.0.0/${name}`;
  w.ctx.fetch = async (requested, options) => {
    assert.equal(requested, url); assert.equal(options.redirect, 'manual');
    return new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } });
  };
  w.ctx.asset = { name, url, size: bytes.length, digest: 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex') };
  w.run(`checkUpdate=async()=>({current:'${MANIFEST.version}',latest:'99.0.0',hasUpdate:true,asset})`);
}

for (const field of ['digest', 'size']) test(`update rejects incorrect ${field} before installer launch`, async () => {
  const w = worker(); prepareUpdate(w, entries());
  w.ctx.asset[field] = field === 'digest' ? 'sha256:' + '0'.repeat(64) : w.ctx.asset.size + 1;
  await assert.rejects(w.run('applyUpdate()'));
  assert.equal(w.launches.length, 0); assert.equal(w.exits.length, 0);
});

test('update recovery blocks unsafe journals before boot and permits safe outcomes', async () => {
  const journal = require('../plugin/node/update-status.cjs');
  for (const [status, phase, blocked] of [
    ['rollback_failed','rolling_back',true], ['in_progress','copying',true],
    ['in_progress','rolling_back',true], ['not_started','failed',false],
    ['handed_off','waiting',false], ['rollback_succeeded','complete',false], ['success','complete',false],
  ]) {
    const w = worker(), dir = path.join(w.dir, 'update');
    const attempt = journal.begin(dir, 'attempt-abc');
    journal.writeResult(attempt, {status, phase});
    w.run("actualPort=1;refreshCredential=async()=>{throw Error('unexpected credential read')}");
    if (blocked) await assert.rejects(w.run('boot()'), /Cindy.*result\.json/);
    else await w.run('boot()');
    assert.equal(journal.readLatest(dir).status, status);
  }
  const w = worker(), dir = path.join(w.dir, 'update');
  const attempt = journal.begin(dir, 'attempt-abc');
  fs.writeFileSync(path.join(attempt, 'result.json'), 'broken JSON');
  assert.equal(journal.readLatest(dir).status, 'unknown');
  await assert.rejects(w.run('boot()'), /Cindy/);
});

for (const [status, phase] of [
  ['in_progress', 'copying'], ['in_progress', 'rolling_back'],
  ['rollback_failed', 'rolling_back'], ['unknown', 'unreadable'],
]) test(`applyUpdate preserves unresolved ${status}/${phase} journal before any new attempt`, async () => {
  const journal = require('../plugin/node/update-status.cjs');
  const w = worker(), dir = path.join(w.dir, 'update');
  const attempt = journal.begin(dir, 'attempt-abc');
  journal.writeResult(attempt, { status, phase });
  if (status === 'unknown') fs.writeFileSync(path.join(attempt, 'result.json'), 'broken JSON');
  const pointer = fs.readFileSync(path.join(dir, 'latest-attempt.json'));
  const result = fs.readFileSync(path.join(attempt, 'result.json'));
  const contents = fs.readdirSync(dir).sort();
  w.run("checkUpdate=async()=>{throw Error('must not check releases before recovery')}");
  await assert.rejects(w.run('applyUpdate()'), /Cindy/);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'latest-attempt.json')), pointer);
  assert.deepEqual(fs.readFileSync(path.join(attempt, 'result.json')), result);
  assert.deepEqual(fs.readdirSync(dir).sort(), contents);
  assert.equal(w.launches.length, 0); assert.equal(w.exits.length, 0);
});

test('applyUpdate preserves pending handed_off journal without launching another installer', async () => {
  const journal = require('../plugin/node/update-status.cjs');
  const w = worker(), dir = path.join(w.dir, 'update');
  prepareUpdate(w, entries());
  const attempt = journal.begin(dir, 'attempt-abc');
  journal.writeResult(attempt, { status: 'handed_off', phase: 'waiting' });
  const pointer = fs.readFileSync(path.join(dir, 'latest-attempt.json'));
  const result = fs.readFileSync(path.join(attempt, 'result.json'));
  const contents = fs.readdirSync(dir).sort();
  await assert.rejects(w.run('applyUpdate()'), /安装器|交接|pending|handed.off/i);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'latest-attempt.json')), pointer);
  assert.deepEqual(fs.readFileSync(path.join(attempt, 'result.json')), result);
  assert.deepEqual(fs.readdirSync(dir).sort(), contents);
  assert.equal(w.launches.length, 0); assert.equal(w.exits.length, 0);
});

test('valid package belongs to this plugin', () => { assert.equal(updater.validatePackage(entries(), expected).id, MANIFEST.id); });
for (const [label, alter] of [
  ['wrong id', () => entries({ ...validManifest, id: 'another-plugin' })],
  ['wrong version', () => entries({ ...validManifest, version: '0.0.1' })],
  ['non-JSON manifest', () => entries().map(e => e.name === 'ghost.json' ? { ...e, data: Buffer.from('not JSON') } : e)],
  ['missing main', () => entries().filter(e => e.name !== 'main.js')],
  ['missing worker', () => entries().filter(e => e.name !== 'node/worker.cjs')],
  ['missing bootstrap', () => entries().filter(e => e.name !== 'node/bootstrap.cjs')],
  ['missing owner', () => entries().filter(e => e.name !== 'node/ownership.cjs')],
  ['invalid declared entry', () => entries({ ...validManifest, entry: '../outside.js' })],
]) {
  test(`updater refuses ${label} before launching installer`, async () => {
    const w = worker(); prepareUpdate(w, alter());
    await assert.rejects(w.run('applyUpdate()'));
    assert.equal(w.launches.length, 0); assert.equal(w.exits.length, 0);
  });
}
for (const code of ['ENOENT', 'EACCES']) test(`installer ${code} leaves worker running and cleans staging`, async () => {
  const w = worker({ spawnError: Object.assign(new Error(code), { code }) }); prepareUpdate(w, entries());
  await assert.rejects(w.run('applyUpdate()'), new RegExp(code));
  assert.equal(w.launches.length, 1); assert.equal(w.exits.length, 0);
  const updateDir = path.join(w.dir, 'update');
  const journal = require('../plugin/node/update-status.cjs').readLatest(updateDir);
  assert.equal(journal.status, 'not_started'); assert.equal(journal.phase, 'failed');
  assert.match(journal.error, new RegExp(code));
  assert.equal(journal.hostReceipt, 'requires_host_install');
  assert.ok(!fs.readdirSync(updateDir).some(name => name.startsWith('stage-')));
});
test('successful handoff retains update lock until exit', async () => {
  const w = worker(); prepareUpdate(w, entries());
  const first = await w.run('applyUpdate()');
  const pointerPath = path.join(w.dir, 'update', 'latest-attempt.json');
  const pointer = fs.readFileSync(pointerPath);
  const second = await w.run('applyUpdate()');
  assert.equal(first.applied, true); assert.equal(second.applied, false);
  assert.deepEqual(fs.readFileSync(pointerPath), pointer);
  const script = fs.readFileSync(first.scriptPath, 'utf8');
  assert.ok(script.includes("$installationPipe = '\\\\.\\pipe\\fixture-install'"));
  assert.ok(script.includes("$ownershipPipe = '\\\\.\\pipe\\fixture-data'"));
  assert.ok(script.includes('$latestPointer = ' + updater.psQuote(path.join(w.dir, 'update', 'latest-attempt.json'))));
  const result = JSON.parse(fs.readFileSync(first.resultPath));
  assert.equal(result.status, 'handed_off'); assert.equal(result.phase, 'waiting');
  assert.equal(result.hostReceipt, 'requires_host_install');
  assert.match(first.backup, /\.bak-.*-attempt-[a-f0-9-]+$/);
  assert.equal(w.exits.length, 1); assert.equal(w.launches.length, 1);
});
test('release selection uses exact plugin package name', async () => {
  const w = worker();
  w.ctx.fetch = async () => ({ ok: true, json: async () => ({ tag_name: 'v99.0.0', assets: [
    { name: 'unrelated.cindy', browser_download_url: 'wrong' },
    { name: IS_TRAE ? 'trae-cindy-bridge.cindy' : 'cindy-qoder-bridge.cindy', browser_download_url: 'right' },
  ] }) });
  assert.equal((await w.run('checkUpdate()')).asset.url, 'right');
});

if (IS_TRAE) {
  const future = () => Date.now() + 3600000;
  test('renewed credential survives force refresh and cache expiry; login changes and logout still work', async () => {
    let disk = { token: 'old', refreshToken: 'R0', expiresAtMs: 1, userId: 'A' }, calls = 0;
    const w = worker({ trae: {
      readTraeCredential: () => disk ? { ok: true, credential: { ...disk }, identity: { storagePath: 'same-storage' } } : { ok: false },
      async refreshAccessToken(c) { calls++; assert.equal(c.refreshToken, 'R0'); assert.equal(calls, 1); return { token: 'new', refreshToken: 'R1', expiresAtMs: future() }; },
    } });
    await w.run('refreshCredential(true)'); await w.run('refreshCredential(true)');
    w.run('credentialAt=0'); await w.run('refreshCredential(false)');
    assert.equal(w.run('credential.token'), 'new'); assert.equal(w.run('credential.refreshToken'), 'R1'); assert.equal(calls, 1);
    disk = { token: 'disk-new', refreshToken: 'R2', expiresAtMs: future(), userId: 'A' };
    await w.run('refreshCredential(true)'); assert.equal(w.run('credential.token'), 'disk-new');
    disk = { token: 'B', refreshToken: 'RB', expiresAtMs: future(), userId: 'B' };
    await w.run('refreshCredential(true)'); assert.equal(w.run('credential.userId'), 'B');
    disk = null; await w.run('refreshCredential(true)'); assert.equal(w.run('credential'), undefined);
  });
  test('late renewal cannot overwrite a different login', async () => {
    let disk = { token: 'A', refreshToken: 'RA', expiresAtMs: future(), userId: 'A' }, finish;
    const w = worker({ trae: {
      readTraeCredential: () => ({ ok: true, credential: { ...disk }, identity: { storagePath: 'same-storage' } }),
      refreshAccessToken: () => new Promise(resolve => { finish = resolve; }),
    } });
    await w.run('refreshCredential(true)'); const pending = w.run("renewCredential('fixture')");
    disk = { token: 'B', refreshToken: 'RB', expiresAtMs: future(), userId: 'B' }; await w.run('refreshCredential(true)');
    finish({ token: 'late-A', refreshToken: 'RA2', expiresAtMs: future() });
    assert.equal(await pending, false); assert.equal(w.run('credential.token'), 'B');
  });
  test('same-generation concurrent renewals share one exchange', async () => {
    let finish, calls = 0;
    const w = worker({ trae: {
      readTraeCredential: () => ({ ok: true, credential: { token: 'A', refreshToken: 'RA', expiresAtMs: future() }, identity: {} }),
      refreshAccessToken: () => { calls++; return new Promise(resolve => { finish = resolve; }); },
    } });
    await w.run('refreshCredential(true)'); const a = w.run("renewCredential('a')"), b = w.run("renewCredential('b')");
    finish({ token: 'new', refreshToken: 'R2', expiresAtMs: future() }); await Promise.all([a, b]);
    assert.equal(calls, 1); assert.equal(w.run('credential.token'), 'new');
  });
}

// ---------- 错误状态只写不清（2026-11-04 线上看到的那条红字） ----------
// 现象：worker 启动时后台补额度失败一次，之后即使刷新成功，「额度读取失败：fetch failed」
// 仍永久挂在面板和状态文本上。原因是 lastError 只有赋值、从没清空。
// 这里钉住的是：成功刷新必须按来源清掉自己的失败，且不同来源互不误清。
{
  const usageFail = () => { throw new Error('fetch failed'); };
  const usageOk = () => ({ total: 2700, used: 74.33, remaining: 2625.67, unit: 'credits' });

  test('a later successful usage refresh clears the earlier usage error', async () => {
    let mode = 'fail';
    const w = worker({ trae: {
      readTraeCredential: () => ({ ok: true, credential: { token: 'A', refreshToken: 'RA', expiresAtMs: Date.now() + 3600000 }, identity: {} }),
      refreshUsage: () => (mode === 'fail' ? usageFail() : usageOk()),
      refreshCheckin: async () => ({ enabled: true, checkedIn: false }),
      fetchModels: async () => ({ models: [{ key: 'm', name: 'M' }] }),
    } });
    await w.run('refreshCredential(true)');

    await w.run("refreshUsage(true)");                       // 第一次失败
    assert.match(w.run('lastErrorText()'), /额度读取失败/);   // 有错误

    mode = 'ok';
    await w.run("refreshUsage(true)");                       // 第二次成功
    assert.equal(w.run('lastErrorText()'), '');              // 错误必须被清掉
    assert.equal((await w.run('buildStatus()')).lastError, '');
  });

  test('a successful model refresh does not clear a usage error, and vice versa', async () => {
    const w = worker({ trae: {
      readTraeCredential: () => ({ ok: true, credential: { token: 'A', refreshToken: 'RA', expiresAtMs: Date.now() + 3600000 }, identity: {} }),
      refreshUsage: () => usageFail(),
      refreshCheckin: async () => ({ enabled: true, checkedIn: false }),
      fetchModels: async () => ({ models: [{ key: 'm', name: 'M' }] }),
    } });
    await w.run('refreshCredential(true)');
    await w.run("refreshUsage(true)");
    await w.run("refreshModels(true)");                      // 模型成功，不该清掉额度错误
    assert.match(w.run('lastErrorText()'), /额度读取失败/);
    assert.equal(w.run('errors.usage') !== null, true);
    assert.equal(Boolean(w.run('errors.models')), false);
  });

  test('the error text says how long ago it happened', async () => {
    const w = worker({ trae: {} });
    w.run("setError('usage','额度读取失败：fetch failed')");
    assert.match(w.run('lastErrorText()'), /秒前/);
    w.run("errors.usage.at = Date.now() - 5 * 60 * 1000");
    assert.match(w.run('lastErrorText()'), /5 分钟前/);
    w.run("errors.usage.at = Date.now() - 3 * 3600 * 1000");
    assert.match(w.run('lastErrorText()'), /3 小时前/);
  });

  test('stale quota is flagged so an old number cannot pass for the current one', async () => {
    let mode = 'ok';
    const w = worker({ trae: {
      readTraeCredential: () => ({ ok: true, credential: { token: 'A', refreshToken: 'RA', expiresAtMs: Date.now() + 3600000 }, identity: {} }),
      refreshUsage: () => (mode === 'ok' ? usageOk() : usageFail()),
      refreshCheckin: async () => ({ enabled: true, checkedIn: false }),
      fetchModels: async () => ({ models: [{ key: 'm', name: 'M' }] }),
    } });
    await w.run('refreshCredential(true)');
    await w.run("refreshUsage(true)");
    assert.equal((await w.run('buildStatus()')).quotaStale, false);
    mode = 'fail';
    await w.run("refreshUsage(true)");
    assert.equal((await w.run('buildStatus()')).quotaStale, true);   // 旧值必须被标出来
  });
}

// ---------- 缓存与推理明细被写死成 0（2026-11-04 面板命中率恒为 0%） ----------
// 现象：Cindy 里缓存读/写恒 0、命中率 0%，看着像上游没缓存。实际是适配层把
// prompt_tokens_details.cached_tokens 和 completion_tokens_details.reasoning_tokens
// 写死了，上游真值被丢掉。实测上游给的是 cached=1792 / prompt=2034。
{
  const adapters = require('../plugin/node/adapters.cjs');
  const UPSTREAM = {
    prompt_tokens: 2034, completion_tokens: 11,
    prompt_tokens_details: { cached_tokens: 1792 },
    completion_tokens_details: { reasoning_tokens: 9 },
  };

  test('responses usage passes upstream cached and reasoning tokens through', () => {
    const u = adapters.responsesUsage(UPSTREAM, 0);
    assert.equal(u.input_tokens, 2034);
    assert.equal(u.input_tokens_details.cached_tokens, 1792);
    assert.equal(u.output_tokens_details.reasoning_tokens, 9);
    assert.equal(u.total_tokens, 2045);
  });

  // ---- Anthropic usage 的 input_tokens 语义 ----
  //
  // OpenAI 的 prompt_tokens 是「输入总量」，**包含**命中缓存的部分；
  // Anthropic 的 input_tokens 是「没走缓存的部分」。Cindy 算命中率用
  //   read / (input_tokens + read + write)
  // 如果把 prompt_tokens 直接当 input_tokens 发，缓存 token 会在分子分母各算一次。
  // 实测 2355/2361（真实 99.75%）会被算成 49.94%——这正是「读有值、命中率却很低」的元凶。

  test('anthropic input_tokens excludes the cached part (no double counting)', () => {
    const u = adapters.anthropicUsage(UPSTREAM, 0);
    // UPSTREAM: prompt_tokens=2034, cached_tokens=1792
    assert.equal(u.input_tokens, 2034 - 1792);
    assert.equal(u.output_tokens, 11);
    assert.equal(u.cache_read_input_tokens, 1792);
  });

  test('anthropic hit rate computed the way Cindy does matches the real one', () => {
    // 复现实测到的数字：prompt=2361, read=2355
    const usage = { prompt_tokens: 2361, completion_tokens: 18, prompt_tokens_details: { cached_tokens: 2355 } };
    const u = adapters.anthropicUsage(usage, 0);
    const cindyRate = u.cache_read_input_tokens / (u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens);
    const realRate = 2355 / 2361;
    assert.equal(Number(cindyRate.toFixed(4)), Number(realRate.toFixed(4)));
    // 旧写法会得到 49.94%，钉死这个数防止回退
    assert.notEqual(Number((cindyRate * 100).toFixed(2)), 49.94);
  });

  test('anthropic subtracts cache write as well as cache read', () => {
    const withWrite = {
      prompt_tokens: 2034, completion_tokens: 11,
      prompt_tokens_details: { cached_tokens: 1792, cache_write_tokens: 240 },
    };
    const au = adapters.anthropicUsage(withWrite, 0);
    assert.equal(au.input_tokens, 2034 - 1792 - 240);
    assert.equal(au.cache_read_input_tokens, 1792);
    assert.equal(au.cache_creation_input_tokens, 240);
  });

  test('anthropic input_tokens never goes negative', () => {
    // 上游计价口径边界上偶尔 cached + write 会略大于 prompt
    const odd = { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 40 } };
    assert.equal(adapters.anthropicUsage(odd, 0).input_tokens, 0);
  });

  test('anthropic always emits both cache fields so Cindy sees usage as complete', () => {
    // Cindy 用 hasOwnProperty 检查四个字段，缺一个就 complete=false，
    // 那一轮会被当成未结算，连命中率都不显示。
    const bare = { prompt_tokens: 100, completion_tokens: 5 };
    const a = adapters.anthropicUsage(bare, 0);
    for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
      assert.ok(Object.prototype.hasOwnProperty.call(a, k), 'anthropic usage 缺字段: ' + k);
    }
    assert.equal(a.cache_read_input_tokens, 0);
    assert.equal(a.cache_creation_input_tokens, 0);
  });

  test('responses keeps prompt_tokens as input_tokens (different semantics)', () => {
    // Responses 这边 Cindy 把 input_tokens 当总量、明细另放 input_tokens_details，
    // 所以**不能**减，减了反而少算。
    const u = adapters.responsesUsage(UPSTREAM, 0);
    assert.equal(u.input_tokens, 2034);
    assert.equal(u.input_tokens_details.cached_tokens, 1792);
    assert.equal(u.output_tokens_details.reasoning_tokens, 9);
  });

  test('missing cache detail falls back to 0 instead of undefined', () => {
    const bare = { prompt_tokens: 100, completion_tokens: 5 };
    assert.equal(adapters.responsesUsage(bare, 0).input_tokens_details.cached_tokens, 0);
    assert.equal(adapters.responsesUsage(bare, 0).output_tokens_details.reasoning_tokens, 0);
    assert.deepEqual(adapters.census(null), { cached: 0, written: 0, reasoning: 0 });
  });

  test('cache write tokens are carried through to both protocols', () => {
    const withWrite = {
      prompt_tokens: 2034, completion_tokens: 11,
      prompt_tokens_details: { cached_tokens: 1792, cache_write_tokens: 240 },
      completion_tokens_details: { reasoning_tokens: 9 },
    };
    const ru = adapters.responsesUsage(withWrite, 0);
    assert.equal(ru.input_tokens_details.cached_tokens, 1792);
    assert.equal(ru.input_tokens_details.cache_write_tokens, 240);
    const au = adapters.anthropicUsage(withWrite, 0);
    assert.equal(au.cache_read_input_tokens, 1792);
    assert.equal(au.cache_creation_input_tokens, 240);
  });

  test('cache_creation_tokens is accepted as an alias', () => {
    const alias = { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cache_creation_tokens: 80 } };
    assert.equal(adapters.census(alias).written, 80);
    const noWrite = { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 5 } };
    assert.equal(adapters.census(noWrite).written, 0);
    // responses 侧没写就不编一个字段出来
    assert.equal(adapters.responsesUsage(noWrite, 0).input_tokens_details.cache_write_tokens, undefined);
  });

  test('a real zero cache hit stays zero and is not treated as missing', () => {
    const noHit = {
      prompt_tokens: 50, completion_tokens: 3,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    };
    assert.equal(adapters.responsesUsage(noHit, 0).input_tokens_details.cached_tokens, 0);
    assert.equal(adapters.anthropicUsage(noHit, 0).cache_read_input_tokens, 0);
  });

}

// Third review: malformed successful HTTP responses must preserve the last quota.
for (const bad of ['not JSON', '{}', '{"code":"TOKEN_EXPIRED"}', '{"success":false}', ...(IS_TRAE ? ['{"usage_summary":{"total_amount":100,"consumed_amount":"bad"}}', '{"usage_summary":{"total_amount":100,"consumed_amount":-1}}', '{"usage_summary":{"total_amount":100,"consumption_ratio":null}}'] : [])]) {
  test(`invalid quota payload preserves old value: ${bad}`, async () => {
    const w = worker();
    w.run("refreshCredential=async()=>({token:'fixture'})");
    const good = IS_TRAE ? {usage_summary:{total_amount:2000,consumed_amount:743}} : {userQuota:{total:2000,used:743}};
    let body=JSON.stringify(good);
    const fake=async()=>new Response(body,{status:200});
    const original=global.fetch;
    try {
      if(IS_TRAE) global.fetch=fake; else w.ctx.fetch=fake;
      await w.run('refreshUsage(true)'); assert.equal(w.run('lastQuota.total'),2000);assert.equal(w.run('lastQuota.used'),743);
      w.run("setError('models','model failure')");
      body=bad;await w.run('refreshUsage(true)');
      assert.equal(w.run('lastQuota.total'),2000);assert.equal(w.run('lastQuota.used'),743);assert.equal(w.run('lastQuota.stale'),true);assert.ok(w.run('errors.usage'));
      body=JSON.stringify(good);await w.run('refreshUsage(true)');
      assert.equal(Boolean(w.run('lastQuota.stale')),false);assert.equal(Boolean(w.run('errors.usage')),false);assert.ok(w.run('errors.models'));
    } finally {global.fetch=original;}
  });
}
test('explicit zero quota remains a successful response',async()=>{
 const w=worker();w.run("refreshCredential=async()=>({token:'fixture'})");const original=global.fetch;
 const fake=async()=>new Response(JSON.stringify(IS_TRAE?{usage_summary:{total_amount:0,consumed_amount:0}}:{userQuota:{total:0,used:0}}));
 try{if(IS_TRAE)global.fetch=fake;else w.ctx.fetch=fake;await w.run('refreshUsage(true)');assert.equal(w.run('lastQuota.total'),0);assert.equal(Boolean(w.run('errors.usage')),false);}finally{global.fetch=original;}
});
if(!IS_TRAE)test('invalid presentation falls back to a valid legacy quota',async()=>{
 const w=worker();w.run("refreshCredential=async()=>({token:'fixture'})");let calls=0;
 w.ctx.fetch=async()=>new Response(JSON.stringify(++calls===1?{code:'TOKEN_EXPIRED'}:{userQuota:{total:2000,used:800}}));
 await w.run('refreshUsage(true)');assert.equal(calls,2);assert.equal(w.run('lastQuota.used'),800);assert.equal(w.run('lastUsage.source'),'quota/usage');
});
if(IS_TRAE){
 for(const reason of ['no-auth-key','not-found'])test(`automatic credential refresh clears ${reason} without renewing`,async()=>{
  let missing=false,calls=0;
  const w=worker({trae:{readTraeCredential:()=>missing?{ok:false,reason}:{ok:true,credential:{token:'A',refreshToken:'R',expiresAtMs:Date.now()+3600000},identity:{}},refreshAccessToken:async()=>{calls++;throw Error('must not renew');}}});
  await w.run('refreshCredential(true)');missing=true;w.run('credentialAt=0;credential.expiresAtMs=1');
  assert.equal(await w.run('refreshCredential(false)'),undefined);assert.equal(calls,0);assert.equal(w.run('identity'),undefined);
 });
 test('automatic logout invalidates an in-flight renewal',async()=>{
  let missing=false,finish;
  const w=worker({trae:{readTraeCredential:()=>missing?{ok:false,reason:'no-auth-key'}:{ok:true,credential:{token:'A',refreshToken:'R',expiresAtMs:Date.now()+3600000},identity:{}},refreshAccessToken:()=>new Promise(r=>{finish=r})}});
  await w.run('refreshCredential(true)');const pending=w.run("renewCredential('test')");missing=true;w.run('credentialAt=0');await w.run('refreshCredential(false)');finish({token:'late',expiresAtMs:Date.now()+3600000});assert.equal(await pending,false);assert.equal(w.run('credential'),undefined);
 });
 test('temporary read failure retains an unexpired credential',async()=>{
  let broken=false;
  const w=worker({trae:{readTraeCredential:()=>broken?{ok:false,reason:'decrypt-failed'}:{ok:true,credential:{token:'A',expiresAtMs:Date.now()+3600000},identity:{}}}});
  await w.run('refreshCredential(true)');broken=true;w.run('credentialAt=0');assert.equal((await w.run('refreshCredential(false)')).token,'A');
 });
}

for (const route of ['/v1/messages', '/v1/responses']) test('partial usage survives error ' + route, async () => {
  const w = worker();
  w.run("token='local-test';models=[{key:'test',name:'Test'}];refreshCredential=async()=>({token:'fixture'});streamChat=async function*(){yield{choices:[{delta:{content:'hi'}}],usage:{prompt_tokens:123,completion_tokens:45}};throw Object.assign(Error('quota'),{status:402,upstreamCode:4008});}");
  const res = await request(w, route, { model:'test', messages:[{role:'user',content:'Hi'}], input:'Hi', stream:false });
  assert.equal(res.status,402);
  const stats = Object.values(JSON.parse(fs.readFileSync(path.join(w.dir,'usage.json'))).days)[0].models.test;
  assert.equal(stats.in,123); assert.equal(stats.out,45);
});

// Exercise the real worker -> adapter streaming path, not a standalone adapter callback.
for (const [status, upstreamCode, type] of [
  [402, 4008, 'hard_credit'], [402, 4222, 'hard_credit'],
  [429, 4011, 'rate_limit'], [401, 1001, 'auth_expired'],
]) for (const route of ['/v1/messages', '/v1/responses']) {
  test(`streaming worker error mapping ${route} ${status}/${upstreamCode}`, async () => {
    const w = worker();
    w.run(`token='local-test';models=[{key:'test',name:'Test'}];
      refreshCredential=async()=>({token:'fixture'});
      globalThis.fixtureError=Object.assign(Error('raw upstream fixture ${upstreamCode}'),{status:${status},upstreamCode:${upstreamCode}});
      streamChat=async function*(){
        yield{choices:[{delta:{content:'hi'}}],usage:{prompt_tokens:123,completion_tokens:45,total_tokens:168}};
        throw fixtureError;
      };`);
    const expected = w.run('errorBodyOf(fixtureError).error');
    assert.equal(expected.type, type);
    assert.match(expected.message, /[\u4e00-\u9fff]/);
    const res = await request(w, route, {
      model: 'test', messages: [{ role: 'user', content: 'Hi' }], input: 'Hi', stream: true,
    });
    assert.equal(res.status, 200);
    assert.equal(res.writableEnded, true);
    const events = res.text.split('\n').filter(line => line.startsWith('data: '))
      .map(line => JSON.parse(line.slice(6)));
    const failures = events.filter(e => e.type === 'error' || e.type === 'response.failed');
    assert.equal(failures.length, 1);
    assert.equal(events.at(-1), failures[0]);
    assert.equal(events.some(e => ['message_stop', 'message_delta', 'response.completed', 'response.incomplete'].includes(e.type)), false);
    const error = route.endsWith('messages') ? failures[0].error : failures[0].response.error;
    assert.equal(error.message, expected.message);
    assert.equal(error.code, expected.type);
    assert.equal(res.text.includes(w.run('fixtureError.message')), false);
    if (route.endsWith('responses')) {
      assert.equal(failures[0].response.status, 'failed');
      assert.equal(failures[0].response.usage.input_tokens, 123);
      assert.equal(failures[0].response.usage.output_tokens, 45);
    }
    const stats = Object.values(JSON.parse(fs.readFileSync(path.join(w.dir, 'usage.json'))).days)[0].models.test;
    assert.equal(stats.in, 123);
    assert.equal(stats.out, 45);
  });
}

test('failed atomic rename preserves usage and state files', () => {
  const w = worker({ fs: { renameSync() { throw Object.assign(Error('busy'), {code:'EBUSY'}); } } });
  for (const name of ['usage.json','state.json']) {
    const file = path.join(w.dir,name); fs.writeFileSync(file,'{"old":true}');
    w.ctx.atomicFile = file;
    assert.throws(() => w.run('writeJsonAtomic(atomicFile,{changed:true})'), /busy/);
    if (name === 'state.json') w.run('saveState({changed:true})');
    assert.equal(fs.readFileSync(file,'utf8'),'{"old":true}');
  }
  assert.equal(fs.readdirSync(w.dir).some(f => f.endsWith('.tmp')),false);
});

async function traeChunks(events) {
  const original = global.fetch;
  global.fetch = async () => new Response(events.map(([event,data]) => 'event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n').join(''));
  try {
    const chunks = [];
    for await (const chunk of require('../plugin/node/trae.cjs').streamChat({token:'fixture'}, {}, {model:'test',messages:[{role:'user',content:'hi'}]})) chunks.push(chunk);
    return chunks;
  } finally { global.fetch = original; }
}
test('tool fragments preserve abnormal upstream finish reasons', async () => {
  for (const reason of ['length','content_filter','stop']) {
    const chunks = await traeChunks([
      ['output',{tool_calls:[{index:0,id:'call',function:{name:'test',arguments:'{"x":'}}]}],
      ['done',{finish_reason:reason}],
    ]);
    assert.equal(chunks.at(-1).choices[0].finish_reason, reason === 'stop' ? 'tool_calls' : reason);
  }
});

test('upstream 1001 is authentication failure', async () => {
  await assert.rejects(traeChunks([['error',{code:1001,message:'expired'}]]), e => e.status === 401);
});

test('package source comparison covers trae and rejects unmapped entries', () => {
  const file = path.join(ROOT,'.github/scripts/verify-package.cjs');
  const src = fs.readFileSync(file,'utf8');
  const block = src.slice(src.indexOf('const packagedByRepoPath ='),src.indexOf("check('包内每个文件"));
  function compare(entries) {
    const ctx = vm.createContext({ entries, manifest:{}, hasGit:true, gitBlob(rel) { assert.equal(rel,'plugin/node/trae.cjs'); return Buffer.from('source'); } });
    vm.runInContext(block+';globalThis.result=drift;',ctx);
    return ctx.result;
  }
  assert.equal(compare([{name:'node/trae.cjs',data:Buffer.from('ALTERED CODE')}]).length,1);
  assert.equal(compare([{name:'unmapped.cjs',data:Buffer.from('source')}]).length,1);
  assert.equal(compare([{name:'node/trae.cjs',data:Buffer.from('source')}]).length,0);
});

test('reasoning token count reaches Chat and Responses usage', async () => {
  const chunks = await traeChunks([['token_usage',{prompt_tokens:3,completion_tokens:5,total_tokens:8,reasoning_tokens:2}],['done',{finish_reason:'stop'}]]);
  assert.equal(chunks.at(-1).usage.completion_tokens_details.reasoning_tokens,2);
  const opts = {model:'test'};
  const response = await require('../plugin/node/adapters.cjs').responsesMessage({done:false,value:chunks.at(-1)},{next:async()=>({done:true})},opts);
  assert.equal(response.usage.output_tokens_details.reasoning_tokens,2);
});

test('Host authority validates complete IPv6, IPv4 and port', () => {
  const w = worker();
  for (const [allowed,hosts] of [
    [true,['localhost','localhost:80','127.0.0.1','127.255.255.255:65535','[::1]','[::1]:47822']],
    [false,['[::1].evil.example','[::1]:80.evil','[::1]:','[::1]:0','[::1]:65536','[::1]:-1','[::1]:abc','::1','127.256.0.1','127.0.0.999','localhost:abc','localhost:0','evil.example']],
  ]) for (const host of hosts) {
    w.ctx.host = host;
    assert.equal(w.run("hostOk({headers:{host},socket:{remoteAddress:'127.0.0.1'}})"),allowed,host);
  }
});

test('malformed adapter tools fail before opening upstream', async () => {
  for (const route of ['/v1/messages','/v1/responses']) {
    const w = worker();
    w.run("token='local-test';refreshCredential=async()=>{throw Error('must not open upstream')}");
    for (const tools of [{},null,[null],[[]],[{type:'function'}],[{type:'web_search',name:'search'}],[{type:'function',name:'test',parameters:[]}],[{name:'test',input_schema:[]}]] ) {
      const res = await request(w,route,{model:'test',messages:[{role:'user',content:'Hi'}],input:'Hi',tools});
      assert.equal(res.status,400,route + JSON.stringify(tools));
      assert.ok(!res.text.includes('must not open upstream'));
    }
  }
});
