// Trae 桥 · Node 工作进程（JSON-RPC stdio）
// 拥有宿主机器权限：读 Trae CN 的 storage.json、解它自己的 AES 封装、起本地 HTTP 服务。
// stdout 只能写协议消息，日志一律写 stderr。
//
// 与 trae.cjs 的分工：trae.cjs 只懂「Trae 私有协议」（凭据、身份、请求头、SSE、错误码、
// 模型目录、额度签到），并把上游流翻成 OpenAI chat.chunk 形状；本文件只懂「本地 OpenAI/
// Anthropic 兼容服务」该长什么样。中间那条边界就是 chat.chunk —— 和 trae 上游桥同一套骨架。
'use strict';

const http = require('node:http');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { readFileSync, writeFileSync, mkdirSync, appendFileSync, statSync, renameSync, unlinkSync, existsSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const adapters = require('./adapters.cjs');
const trae = require('./trae.cjs');
const updater = require('./update.cjs');

// ============================================================
// 运行时状态
// ============================================================

const DATA_DIR = process.env.CINDY_TRAE_DATA || join(os.homedir(), 'AppData', 'Roaming', 'CindyGlobal', 'trae-bridge');
const PREFERRED_PORT = Number(process.env.CINDY_TRAE_PORT || 47822);
const STATE_FILE = join(DATA_DIR, 'state.json');
const REGION_ID = 'trae-cn';

let credential;
let identity;
let credentialAt = 0;
let credentialError = '';
let models = [];
let modelsAt = 0;
let server;
let actualPort = 0;
let token = '';
let lastError = '';
let lastQuota;
let bootedAt = 0;
let lastCheckin;
let lastUsage;

const LOG_FILE = join(DATA_DIR, 'bridge.log');
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = 20 * 1024 * 1024;

// Cindy 只把 node worker 的 stderr 挂到自己那儿，重启就没了。这里同时落一份盘，
// 出问题能翻历史；超过 2MB 就轮转成 bridge.log.1，不会无限长。
function writeLogFile(line) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    try {
      const st = statSync(LOG_FILE);
      if (st.size > LOG_MAX_BYTES) {
        try { renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch {}
      }
    } catch {}
    appendFileSync(LOG_FILE, line);
  } catch {}
}

function log(...args) {
  const line = `[${new Date().toISOString()}] [trae-bridge] ${args.join(' ')}\n`;
  process.stderr.write(line);
  writeLogFile(line);
}

function loadState() {
  try { const s = JSON.parse(readFileSync(STATE_FILE, 'utf8')); if (s && typeof s === 'object') return s; } catch {}
  return {};
}

function saveState(patch) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ ...loadState(), ...patch }, null, 1));
  } catch (e) { log('state write failed', e.message); }
}

// Trae 的凭据每次都要重新读 storage.json 再解密（几十毫秒），5 分钟缓存足够，
// 又不会在用户重新登录后迟迟不认。
async function refreshCredential(force) {
  if (!force && credential && Date.now() - credentialAt < 5 * 60 * 1000) return credential;
  try {
    const r = trae.readTraeCredential();
    if (r && r.ok) {
      credential = r.credential;
      identity = r.identity;
      credentialAt = Date.now();
      credentialError = '';
    } else {
      credentialError = (r && r.reason) || 'read-failed';
      if (force) { credential = undefined; identity = undefined; }
    }
  } catch (e) {
    credentialError = e.message;
    log('credential read failed', e.message);
    if (force) { credential = undefined; identity = undefined; }
  }
  // 读到凭据但已经过期（或 5 分钟内到期）就顺手续一次：
  // 用户的 Trae 客户端可能十几天没开，storage.json 里那张票早死了，
  // 不续的话每次对话都要等一次 401 才知道。
  if (credential && credential.refreshToken) {
    const exp = Number(credential.expiresAtMs) || 0;
    if (!exp || exp - Date.now() < 5 * 60 * 1000) await renewCredential('凭据快到期');
  }
  return credential;
}

// 同一次续期只跑一份：并发进来的几个对话请求不应该各自去换票（浪费且会互相顶掉 refreshToken）。
let renewing = null;

/**
 * 用 refreshToken 换一张新的 access token。
 *
 * 换到的票只放内存，**不写回 storage.json** —— 那个文件 Trae 客户端自己也在写，
 * 从外面改会被它下一次 flush 覆盖，属于给自己埋雷。
 * 返回 true 表示内存里的 credential 已经是新的。
 */
async function renewCredential(reason) {
  if (!credential || !credential.refreshToken) return false;
  if (renewing) return renewing;
  renewing = (async () => {
    try {
      const out = await trae.refreshAccessToken(credential, identity);
      credential = {
        ...credential,
        token: out.token,
        expiresAtMs: out.expiresAtMs,
        refreshToken: out.refreshToken || credential.refreshToken,
        refreshExpiresAtMs: out.refreshExpiresAtMs || credential.refreshExpiresAtMs,
      };
      credentialAt = Date.now();
      log(`token 已续期（${reason || '主动'}）`, `新到期 ${new Date(out.expiresAtMs).toISOString()}`);
      return true;
    } catch (e) {
      log('token 续期失败', String(e && e.message ? e.message : e).slice(0, 300));
      return false;
    }
  })();
  try {
    return await renewing;
  } finally {
    renewing = null;
  }
}

// 401/403 或 Trae 的 1001（not able to authenticate you）都算「票过期了，能续一次」。
// 注意不能只看 status：Trae 把鉴权失败塞在 HTTP 200 的 SSE 里，trae.cjs 翻出来时
// 会带上 upstreamCode=1001 而 status 是 401 —— 两个都认。
function isAuthError(e) {
  const status = Number(e && e.status);
  const code = String((e && e.upstreamCode) || '');
  if (status === 401 || status === 403) return true;
  if (code === '1001') return true;
  return /not able to authenticate|1001/.test(String((e && e.message) || ''));
}

// trae.cjs 给的模型形状 {id,name,channel,contextWindow,maxTokens,reasoning,creditMultiplier}
// 转成 worker 内部统一用的形状（key/name/contextWindow/effortLevels/priceFactor）。
function normalizeModel(m) {
  const efforts = m && m.reasoning && Array.isArray(m.reasoning.supported_efforts)
    ? m.reasoning.supported_efforts.filter((x) => typeof x === 'string')
    : [];
  const ctx = Number(m && m.contextWindow) || 0;
  const ctxMax = Number(m && m.contextWindowMax) || 0;
  return {
    key: String(m.id),
    name: typeof m.name === 'string' && m.name ? m.name : String(m.id),
    channel: typeof m.channel === 'string' ? m.channel : 'solo_work_lite',
    contextWindow: ctx || 200000,
    // 上游只有在 max_mode 打开时才给 max；没给就等同于 dev，不虚报更大的窗口。
    contextWindowMax: ctxMax || ctx || 200000,
    maxTokens: Number(m.maxTokens) || undefined,
    isVL: m && m.isVL === true,
    isReasoning: efforts.length > 0,
    alwaysThinking: false,
    effortLevels: efforts,
    priceFactor: typeof m.creditMultiplier === 'number' ? m.creditMultiplier : undefined,
  };
}

async function refreshModels(force) {
  if (!force && models.length && Date.now() - modelsAt < 30 * 60 * 1000) return models;
  const cache = join(DATA_DIR, 'models.json');
  const cred = await refreshCredential(force);
  if (!cred) {
    // models.json 里存的已经是 normalizeModel 之后的对象（写盘时就是 models 本身），
    // 这里再 map 一遍就会把 key/effortLevels/priceFactor 全部抹成 undefined。
    try { models = JSON.parse(readFileSync(cache, 'utf8')); } catch {}
    return models;
  }
  try {
    const r = await trae.fetchModels(cred, identity);
    const list = Array.isArray(r && r.models) ? r.models : [];
    if (!list.length) throw new Error('上游没有返回任何模型');
    models = list.map(normalizeModel);
    modelsAt = Date.now();
    if (r.failures && r.failures.length) {
      log('部分 function 目录拉取失败', JSON.stringify(r.failures).slice(0, 300));
    }
    try { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(cache, JSON.stringify(models, null, 1)); } catch {}
    return models;
  } catch (e) {
    // 有些版本的 Trae 目录接口会临时缺口（服务端没发 function config），
    // 这时候既不该让人重登录，也不该把模型列表清空——先退回磁盘缓存。
    lastError = `模型目录刷新失败：${e.message}`;
    log(lastError);
    if (!models.length) {
      try { models = JSON.parse(readFileSync(cache, 'utf8')); } catch {}
    }
    if (!models.length) {
      models = (trae.FALLBACK_MODELS || []).map(normalizeModel);
      log('使用兜底模型清单', models.length);
    }
    return models;
  }
}

// ---------- 额度与签到 ----------

async function refreshUsage(force) {
  if (!force && lastUsage && Date.now() - lastUsage.at < 60 * 1000) return lastUsage;
  const cred = await refreshCredential(false);
  if (!cred) {
    const why = '读不到 Trae 登录态，无法查额度';
    lastUsage = { ...(lastUsage || {}), at: Date.now(), error: why };
    if (lastQuota) lastQuota = { ...lastQuota, stale: true, staleReason: why };
    return lastUsage;
  }
  try {
    const snap = await trae.refreshUsage(cred, identity);
    lastUsage = { at: Date.now(), source: 'web_user_ent_usage', ...snap };
    // 拿不到额度时不能假装没事：保留旧值但打上 stale。
    const q = snap && (snap.total || snap.remaining || snap.packs)
      ? {
        total: snap.total, used: snap.used, remaining: snap.remaining,
        percentage: snap.percentage, unit: snap.unit || 'credits',
        ...(snap.packs ? { addOn: snap.packs } : {}),
        ...(snap.expiresAt ? { expiresAt: snap.expiresAt } : {}),
        ...(snap.resetAt ? { resetAt: snap.resetAt } : {}),
        stale: false,
      }
      : { total: 0, used: 0, remaining: 0, note: '这个账号没有 Work Credit 配额（可能是免费版）' };
    lastQuota = q;
    return lastUsage;
  } catch (e) {
    const why = `额度读取失败：${e.message}`;
    lastError = why;
    log(why);
    lastUsage = { ...(lastUsage || {}), at: Date.now(), error: why };
    if (lastQuota) lastQuota = { ...lastQuota, stale: true, staleReason: why };
    return lastUsage;
  }
}

async function refreshCheckin(force) {
  if (!force && lastCheckin && Date.now() - lastCheckin.at < 5 * 60 * 1000) return lastCheckin;
  const cred = await refreshCredential(false);
  if (!cred) {
    lastCheckin = { at: Date.now(), active: false, error: '读不到 Trae 登录态' };
    return lastCheckin;
  }
  try {
    const s = await trae.refreshCheckin(cred, identity);
    lastCheckin = {
      at: Date.now(),
      active: s.enabled !== false,
      enabled: s.enabled !== false,
      todayCheckedIn: s.checkedIn === true || s.didCheckedIn === true,
      checkedIn: s.checkedIn === true,
      didCheckedIn: s.didCheckedIn === true,
      credits: Number(s.credits) || 0,
      ...(s.extraCredits ? { extraCredits: s.extraCredits } : {}),
      ...(identity && identity.deviceId ? {} : { note: '没读到 device-id，签到可能领不了（上游要它）' }),
    };
    return lastCheckin;
  } catch (e) {
    lastCheckin = { at: Date.now(), active: false, error: e.message };
    return lastCheckin;
  }
}

// Trae 的签到按北京日幂等，重复领上游回 code 0 但不重复发，所以这里不做本地去重。
async function claimCheckin() {
  const cred = await refreshCredential(false);
  if (!cred) throw new Error('读不到 Trae 登录态，先打开 Trae CN 登录一次');
  const r = await trae.claimCheckin(cred, identity);
  lastCheckin = undefined;
  await refreshCheckin(true);
  await refreshUsage(true);
  const ok = r && r.claimed === true;
  return {
    claimed: ok,
    code: r && r.code,
    message: ok ? '签到成功' : (r && r.message) || (r && r.code === 9004 ? '上游要求 x-device-id，但本机没读到设备 id' : '上游没有确认签到成功'),
  };
}

// 签到轮次按 Trae 的规矩每天 0:00(UTC+8) 换新。
function nextCheckinAt(nowMs) {
  const t = nowMs + 8 * 3600 * 1000;
  const d = new Date(t);
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0) - 8 * 3600 * 1000;
  return at > nowMs ? at : at + 24 * 3600 * 1000;
}

function checkinScheduleForCredential() {
  return {
    nextAt: nextCheckinAt(Date.now()),
    ...(credential && credential.expiresAtMs ? { memberExpiresAt: credential.expiresAtMs } : {}),
  };
}

// ---------- 本地用量账本 ----------

const USAGE_FILE = join(DATA_DIR, 'usage.json');

function loadUsageBook() {
  try {
    const s = JSON.parse(readFileSync(USAGE_FILE, 'utf8'));
    if (s && typeof s === 'object' && s.days && typeof s.days === 'object') return s;
  } catch {}
  return { days: {} };
}

function localDayKey(atMs) {
  const d = new Date(atMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 先写临时文件再 rename：rename 在同一分区上是原子的，进程被打断也不会留下
// 半个 JSON 把整本账读废；顺带用 pid+随机后缀避免多个 worker 撞同一个临时名。
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1));
  try { renameSync(tmp, file); }
  catch (e) {
    // Windows 上目标被别的进程短暂占住时 rename 会失败，退回直写再清临时文件
    try { writeFileSync(file, JSON.stringify(value, null, 1)); } finally {
      try { unlinkSync(tmp); } catch {}
    }
    if (e && e.code !== 'EPERM' && e.code !== 'EACCES' && e.code !== 'EBUSY') throw e;
  }
}

function recordUsage(entry, wire, tokensIn, tokensOut) {
  try {
    const book = loadUsageBook();
    const day = localDayKey(Date.now());
    const bucket = book.days[day] || (book.days[day] = { requests: 0, models: {}, wires: {} });
    const key = entry?.key || entry?.model || 'unknown';
    const m = bucket.models[key] || (bucket.models[key] = { requests: 0, in: 0, out: 0, factor: entry?.priceFactor ?? null });
    bucket.requests += 1;
    m.requests += 1;
    m.in += Number(tokensIn) || 0;
    m.out += Number(tokensOut) || 0;
    if (m.factor === null && typeof entry?.priceFactor === 'number') m.factor = entry.priceFactor;
    bucket.wires[wire] = (bucket.wires[wire] || 0) + 1;
    book.updatedAt = Date.now();

    const keys = Object.keys(book.days).sort();
    while (keys.length > 60) delete book.days[keys.shift()];

    mkdirSync(DATA_DIR, { recursive: true });
    writeJsonAtomic(USAGE_FILE, book);
  } catch (e) { log('usage write failed', e.message); }
}

function usageSummary() {
  const book = loadUsageBook();
  const today = localDayKey(Date.now());
  const days = Object.keys(book.days).sort().slice(-7);
  const sumOf = (list) => {
    const out = { requests: 0, in: 0, out: 0, weighted: 0, byModel: {} };
    for (const d of list) {
      const b = book.days[d];
      if (!b) continue;
      out.requests += b.requests || 0;
      for (const [k, m] of Object.entries(b.models || {})) {
        out.in += m.in || 0;
        out.out += m.out || 0;
        const f = typeof m.factor === 'number' ? m.factor : 1;
        out.weighted += ((m.in || 0) + (m.out || 0)) * f;
        const t = out.byModel[k] || (out.byModel[k] = { requests: 0, tokens: 0, weighted: 0, factor: m.factor });
        t.requests += m.requests || 0;
        t.tokens += (m.in || 0) + (m.out || 0);
        t.weighted += ((m.in || 0) + (m.out || 0)) * f;
      }
    }
    return out;
  };
  const todayBucket = book.days[today] || { requests: 0, models: {} };
  let todayTokens = 0; let todayWeighted = 0;
  for (const m of Object.values(todayBucket.models || {})) {
    const f = typeof m.factor === 'number' ? m.factor : 1;
    todayTokens += (m.in || 0) + (m.out || 0);
    todayWeighted += ((m.in || 0) + (m.out || 0)) * f;
  }
  return {
    today: { requests: todayBucket.requests || 0, tokens: todayTokens, weighted: Math.round(todayWeighted) },
    week: sumOf(days),
    days,
  };
}

// ---------- 上游流式对话 ----------

// trae.cjs 的 streamChat 已经吐 OpenAI chat.chunk 形状，这里只做一层包装：
// 传进入参、把 signal 接上、把 Trae 的错误码带到 err.status 上。
async function* streamChat(cred, req, signal) {
  const iter = trae.streamChat(cred, identity, req, signal);
  for await (const chunk of iter) yield chunk;
}

// Trae 的限流是 HTTP 200 里的 4011 帧，trae.cjs 已经把它转成带 status=429 的 Error。
function queueWaitMs(err) {
  const status = Number(err?.status);
  const code = String(err?.upstreamCode ?? '');
  if (status !== 429 && code !== '4011') return undefined;
  const s = Number(err?.retryAfterSeconds);
  return (Number.isFinite(s) && s > 0 ? Math.min(s, 120) : 30) * 1000;
}

/**
 * 起一个上游流：拿到第一个 chunk 才算成功。
 *
 * 两种重试叠在一起，顺序不能反：
 *   1) 鉴权失败（401/403/1001）→ 续一次票再来（只续一次，续完还是 401 就是真没权限，
 *      继续续只会刷爆上游；用户十几天没开 Trae 时这条是常态）；
 *   2) 限流（429/4011）→ 按 retryAfterSeconds 等，最多 3 次。
 */
async function openUpstreamStream(cred, request, signal, displayModel) {
  let renewed = false;
  let attempt = 0;
  let current = cred;
  for (;;) {
    try {
      const iterator = streamChat(current, request, signal);
      const first = await iterator.next();
      return { iterator, first };
    } catch (e) {
      if (!renewed && isAuthError(e)) {
        renewed = true;
        log('对话鉴权失败，续期后重试', displayModel);
        if (await renewCredential('对话鉴权失败')) { current = credential; attempt = 0; continue; }
      }
      attempt += 1;
      const wait = queueWaitMs(e);
      if (wait === undefined || attempt >= 3) throw e;
      log(`排队等待 ${wait}ms（第 ${attempt} 次）`, displayModel);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// 把 Trae 的错误码翻成人话。Trae 的失败基本都藏在 HTTP 200 的 SSE 里，
// trae.cjs 会先把它们 peek 出来、翻成带 status/upstreamCode 的 Error。
function humanizeUpstreamError(err) {
  const raw = String(err?.message ?? '');
  const code = String(err?.upstreamCode ?? '');
  const status = Number(err?.status);
  const detail = raw.slice(0, 500);
  const pick = (msg, extra) => ({ message: msg, detail, ...(extra || {}) });

  // 先按上游码判，再按 status 兜底：4008/4222 现在都映射成 402，
  // 若先判 status===402 就会被「需要付费套餐（1005）」的文案吞掉，说错原因。
  if (code === '1005') {
    return pick('Trae 要求付费套餐才能用这个模型（1005）。在 Trae 里升级套餐，或者换一个免费模型。', { type: 'hard_credit' });
  }
  if (code === '2001') {
    return pick('Trae 服务端这会儿没发布这个函数通道的配置（2001），过几分钟再试，不用重新登录。', { type: 'upstream_error' });
  }
  if (code === '4001') {
    return pick('这个模型不在当前函数通道里（4001）。在面板上点「刷新」重新拉模型列表，然后重新选一次模型。', { type: 'client' });
  }
  if (code === '4008') {
    return pick('Trae 的 SOLO 额度用完了（4008）。等额度刷新或者升级套餐。', { type: 'hard_credit' });
  }
  if (code === '4011' || status === 429) {
    return pick('Trae 限流了（4011），等半分钟再发一次。', { type: 'rate_limit' });
  }
  if (code === '4023') {
    return pick('Trae 这个路由不认这个模型名（4023）。面板上刷新模型列表后重新选。', { type: 'client' });
  }
  if (code === '4222') {
    return pick('企业租户额度用完（4222）。个人余额不受影响，换个人账号或等额度刷新。', { type: 'hard_credit' });
  }
  if (code === '4022') {
    return pick('这次带上去的内容超出了 Trae 的输入上限（4022）。清掉一些历史对话、或者少贴点长文件再发。', { type: 'context_length' });
  }
  if (code === '4026') {
    return pick('这个模型的上下文窗口放不下这次的对话（4026）。换一个窗口更大的模型，或者清掉历史再发。', { type: 'context_length' });
  }
  if (code === '3003') {
    return pick('这个模型当前账号没有可用通道（3003 = all models failed）。不是网络问题、不用挂代理，换个模型就行。', { type: 'client' });
  }
  if (code === 'upstream_truncated') {
    return pick('Trae 在说完之前就断流了，这次回答不完整。直接重发一次通常就好。', { type: 'upstream_error' });
  }
  if (status === 401 || status === 403) {
    return pick('Trae 不认当前凭证了：打开 Trae CN 客户端重新登录，然后回来点面板上的「刷新」。', { type: 'auth_expired' });
  }
  if (/ciphertext is too short|unsupported Trae auth encryption header|integrity check failed|plaintext is too short/i.test(raw)) {
    return pick('解密 Trae 的登录态失败：Trae 可能改过加密格式，或者 storage.json 正在被写。重启 Trae 后再点「刷新」。', { type: 'auth_expired' });
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|AbortError|socket hang up/i.test(raw)) {
    return pick('连不上 Trae 服务器：检查一下网络和代理，然后重试。', { type: 'upstream_error' });
  }
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return pick(`Trae 服务器出错了（${status}），过一会儿再试。`, { type: 'upstream_error' });
  }
  return pick(`Trae 返回错误：${raw.slice(0, 200)}`, { type: 'upstream_error' });
}

// ---------- 请求翻译与校验 ----------

// 顺序很重要：畸形 tool 必须在查凭证之前就 400，否则「Trae 未登录」会盖住「你的
// JSON Schema 写错了」，用户会去折腾登录。
function toChatMessages(list) {
  if (!Array.isArray(list) || list.length === 0) throw new Error('messages 不能为空');
  return list.map((m, i) => {
    if (!m || typeof m !== 'object') throw new Error(`第 ${i} 条消息不是对象`);
    const role = typeof m.role === 'string' ? m.role : '';
    if (!role) throw new Error(`第 ${i} 条消息缺 role`);
    if (role === 'tool' && !(typeof m.tool_call_id === 'string' && m.tool_call_id)) {
      throw new Error(`第 ${i} 条 tool 消息缺 tool_call_id`);
    }
    return m;
  });
}

function toChatTools(tools) {
  if (tools === undefined || tools === null) return [];
  if (!Array.isArray(tools)) throw new Error('tools 必须是数组');
  return tools.map((t, i) => {
    if (!t || typeof t !== 'object') throw new Error(`第 ${i} 个工具不是对象`);
    const fn = t.type === 'function' && t.function ? t.function : t;
    if (!fn || typeof fn.name !== 'string' || !fn.name) throw new Error(`第 ${i} 个工具缺 name`);
    return {
      type: 'function',
      function: {
        name: fn.name,
        description: fn.description ?? '',
        parameters: fn.parameters ?? { type: 'object', properties: {} },
      },
    };
  });
}

// ---------- 本地 HTTP ----------

function sendJson(res, status, v) {
  const b = Buffer.from(JSON.stringify(v), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}

function writeSse(res, v) { res.write(`data: ${JSON.stringify(v)}\n\n`); }

async function readBody(req) {
  const chunks = []; let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > MAX_BODY_BYTES) {
      const e = new Error('请求体过大（上限 20MB）');
      e.httpStatus = 413;
      throw e;
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req, res) {
  try {
    return { ok: true, value: JSON.parse(await readBody(req)) };
  } catch (e) {
    const status = e && e.httpStatus === 413 ? 413 : 400;
    sendJson(res, status, { error: { message: e && e.httpStatus === 413 ? e.message : `请求体不是 JSON：${e.message}` } });
    return { ok: false };
  }
}

function isLoopbackAddr(a) {
  if (!a) return false;
  const s = String(a).toLowerCase();
  return s === '::1' || s === '127.0.0.1' || s.startsWith('127.') || s === '::ffff:127.0.0.1';
}

// 只放行 loopback。按 hostname 判，端口可有可无，[::1] 与 ::1 都认——带端口的前缀匹配
// 会把不带默认端口的 Host（部分 SDK / 代理会去掉）误判成 403。
function hostOk(req) {
  const raw = String(req.headers.host || '').toLowerCase().trim();
  if (!raw) return isLoopbackAddr(req.socket && req.socket.remoteAddress);
  let hostname = raw;
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']');
    hostname = end !== -1 ? hostname.slice(0, end + 1) : hostname;
  } else {
    const colon = hostname.lastIndexOf(':');
    if (colon !== -1 && hostname.indexOf(':') === colon) hostname = hostname.slice(0, colon);
  }
  if (!hostname) return false;
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function authOk(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return false;
  const a = Buffer.from(h.slice(7).trim());
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 面板与 /v1/models 共用的模型标题：倍率必须一眼看见，Cindy 的自定义供应商不解析
// cost / displayPricing，只能塞名字里。
// 档位不进名字——Cindy 的模型选择器是按名字宽度撑开的，名字一长整排控件就被推离麦克风。
// 档位本来就由 reasoning.supported_efforts 交给 Cindy 渲染成独立的下拉，面板里也有单独一列。
function modelLabel(m) {
  const f = m.priceFactor;
  const tag = f === 0 ? ' · 免费' : typeof f === 'number' ? ` · x${f}` : '';
  return `${m.name}${tag}`;
}

const AUTH_HINT = '本地 API Key 不对：面板上那串 Token 要一字不差地填进 Cindy 的 API Key 栏。';

async function handle(req, res) {
  if (!hostOk(req)) { sendJson(res, 403, { error: { message: 'Host 必须是 loopback' } }); return; }
  const rawUrl = (req.url || '/').split('?')[0];
  // Cindy 的供应商 Base URL 约定带 /v1，而 claude-code 走 anthropic-compat-proxy 时会把
  // basePath 拼在 SDK 的 /v1/messages 前面，于是上游收到 /v1/v1/messages → 404。
  let url = rawUrl;
  while (/^\/v1\/v1(\/|$)/.test(url)) url = url.slice(3);
  // /healthz 是端口探测和 Host 守卫的探活口，不鉴权，所以只能回最小集（不能把 token 吐出去）。
  if (url === '/healthz' && req.method === 'GET') {
    sendJson(res, 200, { ok: actualPort !== 0, port: actualPort, modelCount: models.length });
    return;
  }
  if ((url === '/status' || url === '/v1/status') && req.method === 'GET') {
    if (!authOk(req)) { sendJson(res, 401, { error: { message: AUTH_HINT } }); return; }
    sendJson(res, 200, await buildStatus());
    return;
  }
  if ((url === '/v1/models' || url === '/v1/models/') && req.method === 'GET') {
    if (!authOk(req)) { sendJson(res, 401, { error: { message: AUTH_HINT } }); return; }
    sendJson(res, 200, {
      object: 'list',
      data: models.map((m) => ({
        id: m.key, object: 'model', created: 0, owned_by: REGION_ID,
        name: modelLabel(m),
        context_window: m.contextWindow || 200000,
        max_context_window: m.contextWindowMax || m.contextWindow || 200000,
        // Cindy 只认 MODEL_METADATA_FIELDS 白名单字段，推理档位必须挂在 reasoning 下
        reasoning: m.effortLevels && m.effortLevels.length
          ? {
            supported_efforts: m.effortLevels,
            default_effort: m.effortLevels.includes('low') ? 'low' : m.effortLevels[m.effortLevels.length - 1],
          }
          : { supported_efforts: [] },
        supports_image_input: m.isVL,
        reasoning_efforts: m.effortLevels,
        price_factor: m.priceFactor,
      })),
    });
    return;
  }
  if ((url === '/v1/chat/completions' || url === '/v1/chat/completions/') && req.method === 'POST') {
    if (!authOk(req)) { sendJson(res, 401, { error: { message: AUTH_HINT } }); return; }
    await chatCompletions(req, res);
    return;
  }
  // Cindy 的 acceptsWireProtocol：claude-code 只接 anthropic-messages，codex 只接
  // openai-responses，pi 接任意。只给 chat/completions 时只剩 pi 能选。
  if ((url === '/v1/messages' || url === '/v1/messages/') && req.method === 'POST') {
    if (!authOk(req)) { sendJson(res, 401, { error: { message: AUTH_HINT } }); return; }
    await anthropicMessages(req, res);
    return;
  }
  if ((url === '/v1/messages/count_tokens' || url === '/v1/messages/count_tokens/') && req.method === 'POST') {
    if (!authOk(req)) { sendJson(res, 401, { error: { message: AUTH_HINT } }); return; }
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return;
    let chat;
    try {
      chat = adapters.anthropicRequestToChat(parsed.value);
    } catch (e) {
      sendJson(res, 400, { error: { message: `请求格式不对：${e.message}`, type: 'invalid_request_error' } });
      return;
    }
    sendJson(res, 200, { input_tokens: adapters.estimateTokens(chat.messages) });
    return;
  }
  if ((url === '/v1/responses' || url === '/v1/responses/') && req.method === 'POST') {
    if (!authOk(req)) { sendJson(res, 401, { error: { message: AUTH_HINT } }); return; }
    await openaiResponses(req, res);
    return;
  }
  sendJson(res, 404, { error: { message: `没有这个路由：${req.method} ${url}` } });
}

// Cindy 把「上下文窗口 ≥ 1M」编码成模型 id 后缀 [1m]，原样转发会被上游拒。这里剥掉再匹配。
function normalizeModelKey(id) {
  if (typeof id !== 'string') return '';
  const s = id.trim();
  return /\[1m\]$/i.test(s) ? s.slice(0, -4) : s;
}

function resolveEntry(displayModel) {
  return models.find((m) => m.key === displayModel)
    || models.find((m) => m.key.toLowerCase() === String(displayModel).toLowerCase());
}

// 下游挂断要能中断上游。只管 req 的 'close' 是不够的：Node 里 req 是请求流，
// 客户端断开时它常已读完并 end，'close' 早发过了；真正可靠的是 res 的 'close'。
// 同时正常结束时必须把监听摘掉，否则连接复用时会被上一次的监听误伤。
function bindAbort(req, res, controller) {
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.on('close', onClose);
  res.on('close', onClose);
  let done = false;
  return {
    done() {
      if (done) return;
      done = true;
      req.removeListener('close', onClose);
      res.removeListener('close', onClose);
    },
  };
}

// 上游已经把错误分好类了，别再用一个 502 把它抹平：
// 401/403 该让客户端重新登录，402 该提示付费/额度，429 该退避重试。
// 只有确实无从判断的才退回 502，排队没等到位置的仍是 503。
function errorStatusOf(e) {
  const queued = queueWaitMs(e);
  if (queued !== undefined) return 503;
  const s = Number(e?.status);
  if (Number.isInteger(s) && s >= 400 && s <= 599) return s;
  return 502;
}

function errorBodyOf(e) {
  const queued = queueWaitMs(e);
  const nice = humanizeUpstreamError(e);
  return {
    error: {
      message: nice.message,
      type: nice.type ?? (queued === undefined ? 'upstream_error' : 'rate_limit'),
      detail: nice.detail,
      ...(queued === undefined ? {} : { retry_after_seconds: Math.ceil(queued / 1000) }),
    },
  };
}

async function chatCompletions(req, res) {
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return;
  const payload = parsed.value;

  const displayModel = normalizeModelKey(payload.model);
  const entry = resolveEntry(displayModel);

  const enableThinking = typeof payload.reasoning_effort === 'string' && payload.reasoning_effort
    ? payload.reasoning_effort !== 'off' && payload.reasoning_effort !== 'none'
    : entry?.isReasoning === true;

  let request;
  try {
    request = {
      model: displayModel,
      channel: entry?.channel,
      messages: toChatMessages(payload.messages || []),
      tools: toChatTools(payload.tools),
      maxTokens: typeof payload.max_tokens === 'number' ? payload.max_tokens : undefined,
      enableThinking,
      alwaysThinking: entry?.alwaysThinking === true,
      reasoningEffort: enableThinking
        ? (typeof payload.reasoning_effort === 'string' && payload.reasoning_effort ? payload.reasoning_effort
          : (entry?.effortLevels && entry.effortLevels.length ? entry.effortLevels[Math.min(2, entry.effortLevels.length - 1)] : undefined))
        : undefined,
      sessionId: typeof payload.user === 'string' ? payload.user : undefined,
    };
  } catch (e) {
    sendJson(res, 400, { error: { message: `请求格式不对：${e.message}`, type: 'invalid_request_error' } });
    return;
  }

  const cred = await refreshCredential(false);
  if (!cred) { sendJson(res, 401, { error: { message: notSignedInMessage() } }); return; }

  const wantStream = payload.stream !== false;
  const controller = new AbortController();
  const cancelOnClose = bindAbort(req, res, controller);

  let iterator, first;
  try {
    ({ iterator, first } = await openUpstreamStream(cred, request, controller.signal, displayModel));
  } catch (e) {
    cancelOnClose.done();
    log('对话失败', displayModel, e.message.slice(0, 200));
    sendJson(res, errorStatusOf(e), errorBodyOf(e));
    return;
  }

  if (!wantStream) {
    const content = []; const calls = new Map(); let finish = 'stop'; let usage;
    for (let s = first; !s.done; s = await iterator.next()) {
      const c = s.value;
      if (c?.usage != null) usage = c.usage;
      const ch = c?.choices?.[0];
      if (!ch) continue;
      const d = ch.delta || ch.message || {};
      if (typeof d.content === 'string') content.push(d.content);
      if (Array.isArray(d.tool_calls)) for (const t of d.tool_calls) {
        const i = t.index ?? 0;
        const cur = calls.get(i) || { id: t.id || '', type: 'function', function: { name: '', arguments: '' } };
        if (t.id) cur.id = t.id;
        if (t.function && t.function.name) cur.function.name = t.function.name;
        if (t.function && t.function.arguments) cur.function.arguments += t.function.arguments;
        calls.set(i, cur);
      }
      if (typeof ch.finish_reason === 'string') finish = ch.finish_reason;
    }
    for (const cur of calls.values()) if (!cur.id) cur.id = `call_${crypto.randomBytes(6).toString('hex')}`;
    const message = { role: 'assistant', content: content.join('') };
    if (calls.size) message.tool_calls = [...calls.values()];
    recordUsage(entry || { model: displayModel }, 'chat', usage?.prompt_tokens, usage?.completion_tokens);
    sendJson(res, 200, {
      id: `chatcmpl-${crypto.randomBytes(8).toString('hex')}`,
      object: 'chat.completion', created: Math.floor(Date.now() / 1e3),
      model: displayModel,
      choices: [{ index: 0, message, finish_reason: finish }],
      ...(usage !== undefined ? { usage } : {}),
    });
    cancelOnClose.done();
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  const id = `chatcmpl-${crypto.randomBytes(8).toString('hex')}`;
  const created = Math.floor(Date.now() / 1e3);
  let sentRole = false;
  let streamUsage;
  try {
    for (let s = first; !s.done; s = await iterator.next()) {
      const c = s.value;
      if (c?.usage != null) {
        streamUsage = c.usage;
        writeSse(res, { id, object: 'chat.completion.chunk', created, model: displayModel, choices: [], usage: c.usage });
      }
      const ch = c?.choices?.[0];
      if (!ch) continue;
      const d = ch.delta || ch.message || {};
      const out = { role: 'assistant' };
      if (typeof d.content === 'string' && d.content) out.content = d.content;
      const r = d.reasoning_content ?? d.reasoning;
      if (typeof r === 'string' && r) out.reasoning_content = r;
      if (Array.isArray(d.tool_calls) && d.tool_calls.length) out.tool_calls = d.tool_calls;
      const finish = ch.finish_reason;
      if (!sentRole) sentRole = true;
      else if (Object.keys(out).length === 1 && finish === undefined) continue;
      writeSse(res, { id, object: 'chat.completion.chunk', created, model: displayModel,
        choices: [{ index: 0, delta: out, finish_reason: finish ?? null }] });
    }
  } catch (e) {
    log('流中断', displayModel, e.message.slice(0, 200));
    const nice = humanizeUpstreamError(e);
    res.write(`data: ${JSON.stringify({ error: { message: nice.message, type: nice.type ?? 'upstream_error', detail: nice.detail } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    recordUsage(entry || { model: displayModel }, 'chat', streamUsage?.prompt_tokens, streamUsage?.completion_tokens);
    cancelOnClose.done();
    return;
  }
  res.write('data: [DONE]\n\n');
  res.end();
  recordUsage(entry || { model: displayModel }, 'chat', streamUsage?.prompt_tokens, streamUsage?.completion_tokens);
  cancelOnClose.done();
}

function notSignedInMessage() {
  const why = credentialError ? `（${credentialError}）` : '';
  return `读不到 Trae CN 的登录态${why}：先打开 Trae CN 客户端登录一次，然后回来点面板上的「刷新」。`;
}

// 两种新协议共用的上游开启逻辑：凭证、重试排队、错误落盘。
async function openUpstream(req, res, request, displayModel) {
  const cred = await refreshCredential(false);
  if (!cred) { sendJson(res, 401, { error: { message: notSignedInMessage() } }); return { ok: false }; }

  const controller = new AbortController();
  const cancelOnClose = bindAbort(req, res, controller);

  let iterator, first;
  try {
    ({ iterator, first } = await openUpstreamStream(cred, request, controller.signal, displayModel));
  } catch (e) {
    cancelOnClose.done();
    log('对话失败', displayModel, e.message.slice(0, 200));
    sendJson(res, errorStatusOf(e), errorBodyOf(e));
    return { ok: false };
  }
  return { ok: true, iterator, first, cancelOnClose };
}

async function anthropicMessages(req, res) {
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return;

  let chat;
  try {
    chat = adapters.anthropicRequestToChat(parsed.value);
  } catch (e) {
    sendJson(res, 400, { error: { message: `请求格式不对：${e.message}`, type: 'invalid_request_error' } });
    return;
  }
  const displayModel = normalizeModelKey(chat.model);
  const entry = resolveEntry(displayModel);

  const reasoningEffort = chat.thinking || entry?.isReasoning === true
    ? (entry?.effortLevels && entry.effortLevels.length ? entry.effortLevels[Math.min(2, entry.effortLevels.length - 1)] : undefined)
    : undefined;

  let request;
  try {
    request = {
      model: displayModel,
      channel: entry?.channel,
      messages: toChatMessages(chat.messages),
      tools: toChatTools(chat.tools),
      maxTokens: chat.maxTokens,
      enableThinking: chat.thinking || entry?.isReasoning === true,
      alwaysThinking: entry?.alwaysThinking === true,
      reasoningEffort,
    };
  } catch (e) {
    sendJson(res, 400, { error: { message: `请求格式不对：${e.message}`, type: 'invalid_request_error' } });
    return;
  }

  const up = await openUpstream(req, res, request, displayModel);
  if (!up.ok) return;

  const opts = { model: displayModel, inputTokens: adapters.estimateTokens(chat.messages) };
  try {
    if (chat.stream) await adapters.writeAnthropicStream(res, up.first, up.iterator, opts);
    else sendJson(res, 200, await adapters.anthropicMessage(up.first, up.iterator, opts));
  } finally {
    up.cancelOnClose.done();
    // 上游给了真实 usage 就用真实的，没给才退回估算；输出侧以前写死 0，账本里永远是 0 token。
    const out = opts.usage && typeof opts.usage.completion_tokens === 'number' ? opts.usage.completion_tokens : 0;
    recordUsage(entry || { model: displayModel }, 'anthropic', opts.inputTokens, out);
  }
}

async function openaiResponses(req, res) {
  const parsed = await readJsonBody(req, res);
  if (!parsed.ok) return;

  let chat;
  try {
    chat = adapters.responsesRequestToChat(parsed.value);
  } catch (e) {
    sendJson(res, 400, { error: { message: `请求格式不对：${e.message}`, type: 'invalid_request_error' } });
    return;
  }
  const displayModel = normalizeModelKey(chat.model);
  const entry = resolveEntry(displayModel);

  const asked = chat.reasoningEffort;
  const enableThinking = asked ? asked !== 'off' && asked !== 'none' : entry?.isReasoning === true;

  let request;
  try {
    request = {
      model: displayModel,
      channel: entry?.channel,
      messages: toChatMessages(chat.messages),
      tools: toChatTools(chat.tools),
      maxTokens: chat.maxTokens,
      enableThinking,
      alwaysThinking: entry?.alwaysThinking === true,
      reasoningEffort: enableThinking
        ? (asked || (entry?.effortLevels && entry.effortLevels.length ? entry.effortLevels[Math.min(2, entry.effortLevels.length - 1)] : undefined))
        : undefined,
    };
  } catch (e) {
    sendJson(res, 400, { error: { message: `请求格式不对：${e.message}`, type: 'invalid_request_error' } });
    return;
  }

  const up = await openUpstream(req, res, request, displayModel);
  if (!up.ok) return;

  const opts = { model: displayModel, inputTokens: adapters.estimateTokens(chat.messages) };
  try {
    if (chat.stream) await adapters.writeResponsesStream(res, up.first, up.iterator, opts);
    else sendJson(res, 200, await adapters.responsesMessage(up.first, up.iterator, opts));
  } finally {
    up.cancelOnClose.done();
    const out = opts.usage && typeof opts.usage.completion_tokens === 'number' ? opts.usage.completion_tokens : 0;
    recordUsage(entry || { model: displayModel }, 'responses', opts.inputTokens, out);
  }
}

function listenOn(port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => { server.removeListener('listening', onOk); reject(e); };
    const onOk = () => { server.removeListener('error', onError); resolve(port); };
    server.once('error', onError);
    server.once('listening', onOk);
    server.listen(port, '127.0.0.1');
  });
}

// 探测该端口上跑的是不是另一个「还算正常」的 Trae 桥
function portIsOurs(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 2000 }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; if (buf.length > 8192) res.destroy(); });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          resolve(Boolean(j && j.ok === true && typeof j.port === 'number' && 'modelCount' in j));
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function startServer() {
  if (server) return;
  server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log('handler error', e.message);
      if (!res.headersSent) sendJson(res, 500, { error: { message: e.message } });
      else res.end();
    });
  });

  // 端口必须咬死：Cindy 里的自定义供应商 Base URL 是手填一次的，端口一漂就变成
  // 「网络一直连接不上」。所以占用了就等（多半是上一个 worker 还没退干净），不顺延。
  let bound = 0;
  const tryListen = async (p) => {
    try { bound = await listenOn(p); return true; }
    catch (e) {
      if (e.code !== 'EADDRINUSE') { log('listen failed', e.message); throw e; }
      return false;
    }
  };

  if (!(await tryListen(PREFERRED_PORT))) {
    for (let waited = 1; waited <= 30 && !bound; waited++) {
      log(`端口 ${PREFERRED_PORT} 被占用，等 ${waited}s 再看`);
      await new Promise((r) => setTimeout(r, 1000));
      if (await tryListen(PREFERRED_PORT)) break;
    }
  }

  if (!bound) {
    if (await portIsOurs(PREFERRED_PORT)) {
      log(`127.0.0.1:${PREFERRED_PORT} 上已有一个正常的 Trae 桥，本进程退出`);
      process.exit(0);
    }
    for (let i = 1; i < 20 && !bound; i++) {
      const p = PREFERRED_PORT + i;
      if (!(await tryListen(p))) log(`端口 ${p} 被占用，试下一个`);
    }
  }

  if (!bound) {
    // 一个端口都没抢到：必须把 server 放回 null，否则下一次 RPC 的 `if (!server) await boot()`
    // 看到的是废掉的 http.Server 实例，永远不再重试，进程变僵尸。
    server = null;
    throw new Error(`端口 ${PREFERRED_PORT}..${PREFERRED_PORT + 19} 都被占用`);
  }
  actualPort = bound;
  saveState({ port: actualPort, token });
  log(`已在 127.0.0.1:${actualPort} 监听`);
}

async function boot() {
  bootedAt = Date.now();
  mkdirSync(DATA_DIR, { recursive: true });
  const st = loadState();
  token = typeof st.token === 'string' && st.token.length >= 16 ? st.token : crypto.randomBytes(24).toString('base64url');
  await refreshCredential(true);
  await refreshModels(true);
  await startServer();
  // 额度与签到要打 Trae 的 pay 接口，慢的时候十几秒；不挡端口起来，放后台补。
  refreshUsage(true).then(() => refreshCheckin(true)).catch((e) => log('refresh usage failed', e.message));
}

async function buildStatus() {
  const cred = await refreshCredential(false);
  if (!lastUsage || !lastCheckin) {
    const first = (async () => {
      if (!lastUsage) await refreshUsage(false);
      if (!lastCheckin) await refreshCheckin(false);
    })();
    await Promise.race([first, new Promise((r) => setTimeout(r, 4000))]);
  }
  const scheduled = checkinScheduleForCredential();
  return {
    ok: actualPort !== 0,
    // 有凭据就算登录；只有「明确带着过期时间且已经过了」才算掉线。
    // 之前写成三元表达式，expiresAtMs 缺失时会落到 cred.expiresAtMs > Date.now() = false，面板永远显示未登录。
    signedIn: Boolean(cred && (!cred.expiresAtMs || cred.expiresAtMs > Date.now())),
    expired: Boolean(cred && cred.expiresAtMs && cred.expiresAtMs <= Date.now()),
    accountName: (cred && (cred.accountName || cred.userId)) || '',
    region: REGION_ID,
    port: actualPort,
    baseUrl: `http://127.0.0.1:${actualPort}/v1`,
    token,
    modelCount: models.length,
    models: models.map((m) => ({
      id: m.key, name: m.name, label: modelLabel(m), channel: m.channel,
      contextWindow: m.contextWindow || 200000,
      priceFactor: m.priceFactor, isVL: m.isVL,
      effortLevels: m.effortLevels,
    })),
    quota: lastQuota,
    usage: lastUsage,
    checkin: { ...(lastCheckin || { active: false }), ...scheduled },
    localUsage: usageSummary(),
    logFile: LOG_FILE,
    sourcePath: identity && identity.storagePath ? identity.storagePath : undefined,
    uptimeSeconds: Math.floor((Date.now() - bootedAt) / 1000),
    lastError,
    ...(cred ? {} : { hint: notSignedInMessage() }),
  };
}

// ============================================================
// 自查更新（GitHub Releases）
// ============================================================
//
// 为什么走 GitHub API 而不是 gh CLI：gh 要登录态、要看代理配没配对，
// 而 release 的 REST 接口匿名就能读（公开仓库），node 自带 fetch 直接打就行。
// 这里只做「检查 + 下载 + 交给一个独立脚本去替换」，不在本进程里改自己的文件 ——
// Windows 上正在运行的文件会被锁，硬覆盖一定失败。

const UPDATE_REPO = process.env.TRAE_BRIDGE_REPO || 'linvisxie/trae-cindy-bridge';
const UPDATE_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
const UPDATE_DIR = join(DATA_DIR, 'update');
const INSTALL_DIR = join(__dirname, '..');

// 版本比较、digest 校验、zip 解包、脚本生成都在 node/update.cjs ——
// 那一份是纯函数、可以离线跑回归测试；这里只留需要 IO 的部分。
const versionParts = updater.versionParts;
const compareVersion = updater.compareVersion;
const readZipEntries = updater.readZipEntries;
const extractZipTo = updater.extractZipTo;

function currentVersion() {
  try {
    return String(JSON.parse(readFileSync(join(INSTALL_DIR, 'ghost.json'), 'utf8')).version || '');
  } catch {
    return '';
  }
}

async function checkUpdate() {
  const mine = currentVersion();
  const res = await fetch(UPDATE_API, {
    headers: { 'User-Agent': 'trae-bridge', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`查更新失败：GitHub 返回 HTTP ${res.status}`);
  const j = await res.json();
  const latest = String(j.tag_name || '').replace(/^v/i, '');
  const asset = (Array.isArray(j.assets) ? j.assets : []).find((a) => typeof a.name === 'string' && a.name.endsWith('.cindy'));
  return {
    current: mine,
    latest,
    hasUpdate: Boolean(latest) && compareVersion(latest, mine) > 0,
    htmlUrl: typeof j.html_url === 'string' ? j.html_url : '',
    notes: typeof j.body === 'string' ? j.body.slice(0, 2000) : '',
    asset: asset ? {
      name: asset.name,
      size: asset.size,
      url: asset.browser_download_url,
      // GitHub 从 2025 年起在 asset 上给 digest（"sha256:…"），它就是完整性根锚，
      // 与本机 dist 包、以及 Cindy 记的 packageSha256 三方一致。旧版本没有就退化成按 size 校验。
      digest: typeof asset.digest === 'string' ? asset.digest : undefined,
    } : undefined,
  };
}

/**
 * 下载新版本、解到暂存目录，然后交给一个独立的 PowerShell 脚本去替换安装目录。
 *
 * 为什么必须交给独立脚本：Windows 上正在运行的 .js 文件被进程锁着，本进程覆盖自己
 * 一定会 EBUSY／EPERM。那个脚本等本进程退出后再动文件，Cindy 随后会把 worker 重新
 * 拉起来（实测约 24 秒），起来时读到的就是新文件。
 * 替换前先整目录备份成 `<安装目录>.bak-<旧版本>`，拷坏了还能手工还原。
 */
async function applyUpdate() {
  const info = await checkUpdate();
  if (!info.hasUpdate) return { ...info, applied: false };
  if (!info.asset) throw new Error('最新 release 里没有 .cindy 包，无法更新');

  mkdirSync(UPDATE_DIR, { recursive: true });
  const pkgPath = join(UPDATE_DIR, `${info.asset.name}`);
  const res = await fetch(info.asset.url, {
    headers: { 'User-Agent': 'trae-bridge' },
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`下载新版本失败：HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());

  // 先验再落盘：校验不过就一个字节都不写进安装目录，当前版本继续跑。
  const check = updater.verifyDigest(bytes, info.asset.digest, info.asset.size);
  if (!check.ok) throw new Error(check.reason);
  if (check.skipped) log('发布记录没给 digest 也没给 size，跳过完整性校验');

  writeFileSync(pkgPath, bytes);

  const stageDir = join(UPDATE_DIR, `stage-${info.latest}`);
  extractZipTo(bytes, stageDir);
  if (!existsSync(join(stageDir, 'ghost.json'))) throw new Error('新包解出来没有 ghost.json，放弃更新');

  const scriptPath = join(UPDATE_DIR, 'apply-update.ps1');
  const syncScriptPath = join(UPDATE_DIR, 'sync-snapshot.cjs');
  const backup = `${INSTALL_DIR}.bak-${info.current}`;
  writeFileSync(syncScriptPath, updater.buildSnapshotSyncScript({ installDir: INSTALL_DIR, pkgPath }), 'utf8');
  writeFileSync(scriptPath, updater.buildApplyScript({
    root: INSTALL_DIR,
    stage: stageDir,
    backup,
    pkg: pkgPath,
    syncScript: syncScriptPath,
    nodeExe: process.execPath,
    oldPid: process.pid,
  }), 'utf8');

  const child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  child.unref();

  // 光交给脚本还不够：脚本里的 Wait-Process 得等到本进程真的退出才动文件。
  // 这里主动退，让 Cindy 在 ~24 秒后把新文件拉起来；留 800ms 是给上面那条 RPC 回包写完 stdout。
  // 如果哪天这条路径没退成功，脚本的 -Timeout 60 会兜底（虽然那时文件还锁着，替换会失败并在备份后报错）。
  setTimeout(() => process.exit(0), 800);

  return {
    ...info,
    applied: true,
    backup,
    scriptPath,
    message: `已下载 ${info.latest} 并交给后台脚本替换；worker 正在退出，Cindy 大约 20~30 秒后用新版本重新拉起。`,
  };
}

// ============================================================
// 文生图：字节落盘
// ============================================================
//
// Cindy 的工具返回是纯文本，塞不进 Buffer，所以生成完先写到磁盘再把路径交回去。
// 文件放 DATA_DIR/images 下（不放进安装目录，重装覆盖不会丢图，也不会把包撑大）。

const IMAGE_DIR = join(DATA_DIR, 'images');

function imageExtOf(mimeType) {
  const m = String(mimeType || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'png';
}

function imageStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function drawImageToFile(prompt, size, signal) {
  const cred = await refreshCredential(false);
  if (!cred) {
    const e = new Error(notSignedInMessage());
    e.status = 401;
    throw e;
  }
  if (!identity) {
    const r = await refreshCredential(true);
    if (!r) {
      const e = new Error(notSignedInMessage());
      e.status = 401;
      throw e;
    }
  }
  const out = await trae.drawImage(cred, identity, { prompt, size }, signal);
  mkdirSync(IMAGE_DIR, { recursive: true });
  const file = join(IMAGE_DIR, `trae-${imageStamp()}-${crypto.randomBytes(3).toString('hex')}.${imageExtOf(out.mimeType)}`);
  writeFileSync(file, out.bytes);
  return { file, bytes: out.bytes.length, mimeType: out.mimeType, model: out.model, uri: out.uri };
}

// JSON-RPC over stdio
// ============================================================

function reply(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (!req || req.type === 'notification') return;
  const id = req.id;
  const method = req.method;

  try {
    let result;
    if (method === 'trae/status') {
      if (!server) await boot();
      result = await buildStatus();
    } else if (method === 'trae/endpoint') {
      if (!server) await boot();
      if (!models.length) await refreshModels(true);
      result = {
        ok: models.length > 0,
        ...(models.length === 0 ? { message: '还没有可用模型，请确认 Trae CN 已登录后点「刷新」' } : {}),
        baseUrl: `http://127.0.0.1:${actualPort}/v1`,
        token,
        models: models.map((m) => ({ id: m.key, name: m.name, contextWindow: m.contextWindow || 200000 })),
      };
    } else if (method === 'trae/refresh') {
      if (!server) await boot();
      await refreshCredential(true);
      await refreshModels(true);
      await refreshUsage(true);
      await refreshCheckin(true);
      result = await buildStatus();
    } else if (method === 'trae/checkin') {
      if (!server) await boot();
      await refreshCredential(false);
      const claimed = await claimCheckin();
      await refreshUsage(true);
      result = { ...claimed, status: await buildStatus() };
    } else if (method === 'trae/boot') {
      if (!server) await boot();
      result = await buildStatus();
    } else if (method === 'trae/checkUpdate') {
      result = await checkUpdate();
    } else if (method === 'trae/applyUpdate') {
      result = await applyUpdate();
    } else if (method === 'trae/drawImage') {
      const params = req.params && typeof req.params === 'object' ? req.params : {};
      const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : '';
      if (!prompt) throw new Error('prompt 不能为空');
      const size = typeof params.size === 'string' && params.size.trim() ? params.size.trim() : undefined;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 190000);
      let drawn;
      try {
        drawn = await drawImageToFile(prompt, size, controller.signal);
      } finally {
        clearTimeout(timer);
      }
      result = drawn;
    } else {
      reply({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
      return;
    }
    // 双层信封：main.js 的 unwrap 要剥两次才拿到 result
    reply({ jsonrpc: '2.0', id, result: { ok: true, result } });
  } catch (e) {
    log('rpc error', method, e.message);
    reply({ jsonrpc: '2.0', id, result: { ok: false, message: e.message } });
  }
});

// resident：进程一起来就把服务拉好，不等第一次工具调用
boot().catch((e) => log('boot failed', e.stack || e.message));

process.on('uncaughtException', (e) => log('uncaught', e.stack || e.message));
process.on('unhandledRejection', (e) => log('unhandled', String(e)));
