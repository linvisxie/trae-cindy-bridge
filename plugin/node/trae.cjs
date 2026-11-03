// Trae 私有协议层。
//
// 只做四件事：
//   1) 从本机 Trae 客户端的 storage.json 里解出登录态（自有 AES-128-CBC 封装，不是 DPAPI）；
//   2) 把 OpenAI chat 形状的请求翻成 Trae 的 llm_utils_chat 请求体并带上那套身份头；
//   3) 把上游 SSE 解成 OpenAI chat.completion.chunk（worker 只认这一种形状）；
//   4) 模型目录、额度、签到。
//
// 协议出处：dsh-connect-trae@4.6.12（MIT，LaoDing）的 lib/index.js，逆向得到的规格见
// D:\cindy-qoder-dist\_traeref\TRAE-PROTOCOL.md。行号引用都指那个文件。
'use strict';

const { readFileSync, existsSync, statSync } = require('node:fs');
const { join } = require('node:path');
const os = require('node:os');
const {
  createDecipheriv, createHash, randomUUID,
} = require('node:crypto');

// ============================================================
// 常量
// ============================================================

const REGION = 'trae-cn';
const CHAT_BASE = 'https://trae-api-cn.mchost.guru';
const PAY_BASE = 'https://api.trae.cn';
const WEB_ORIGIN = 'https://www.trae.cn';

const CHAT_PATH = '/api/agent/v3/llm_utils_chat';
const MODEL_DIR_PATH = '/api/ide/v1/get_detail_param';
const USAGE_PATH = '/trae/api/v2/pay/web_user_ent_usage';
const CHECKIN_STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status';
const CHECKIN_CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim';

const APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
const VERSION_CODE_FALLBACK = '20260716';
const DEFAULT_FUNCTION = 'solo_work_lite';
const MAX_OUTPUT_TOKENS_HINT = 0;

// cn 区可聊天通道，按优先级从宽到窄（lib/index.js:3987）。
const CHANNEL_PRIORITY = ['solo_work_remote', 'solo_work_lite', 'solo_agent_remote', 'chat_v3', 'solo_coder'];

// Trae 的思考档位（lib/index.js:5025）。
const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// 我们这边的档位名 → Trae 线上的名字（lib/index.js:350 WIRE_EFFORT_MAP）。
// 关键：上游只认 light/medium/high/extra_high/max，把 ours 的 low/xhigh 直接发过去
// 不会报错，但会被静默忽略 —— 表现成「档位调了没反应」。映射不到就不发。
const WIRE_EFFORT_MAP = {
  low: 'light',
  medium: 'medium',
  high: 'high',
  xhigh: 'extra_high',
  max: 'max',
};

// 实测可用输入上限（2026-11-02 真打上游、按 4022/4026 边界扫出来的地板值）。
// 目录里的 context_window_tokens.dev（200000）只是客户端建议值，上游实际按
// 4022 "prompt tokens exceeded" 卡在约 1M；拿 dev 当窗口等于把能力藏掉。
// 值 = 已验证能吃进去的输入 token 数（含安全余量），未列出的模型回落到 dev。
// 依据见 README「上下文窗口」一节的实测表。
const MEASURED_CONTEXT = {
  'glm-5.3': 1000000,
  'glm-5.3-flash': 1000000,
  'glm-5.2': 1000000,
  'glm-5.1': 1000000,
  'glm-5': 1000000,
  'deepseek-v4.1-flash': 1000000,
  'deepseek-v4-pro-official': 1000000,
  'deepseek-v4-pro': 1000000,
  'deepseek-v4-flash': 1000000,
  'kimi-k3': 1000000,
  'kimi-k2.6': 1000000,
  'minimax-m3': 1000000,
  'qwen3.8-max': 1000000,
  'qwen-3.5': 1000000,
  'step-5-preview': 1000000,
  'mimo-v2.6-flash': 1000000,
  'mimo-v2.6-pro': 1000000,
  // Doubao 系列上限明显更小：2.1-Pro / Evolving 600K 实测通过，
  // 2.1-Turbo 只有 262K 能过（400K 就 4026），Code 系 600K 已 4026。
  'doubao-seed-2.1-pro': 600000,
  'doubao-seed-evolving': 600000,
  'doubao-seed-2.1-turbo': 262144,
};

const AUTH_STORAGE_KEY = 'iCubeAuthInfo://icube.cloudide';
const DEVICE_CENTER_PREFIX = 'iCubeAuthInfo://icube-dc:';

// 上游目录全挂时用的兜底清单（lib/index.js:131 的 CN 组）。
// contextWindow 用实测值，别用目录里的 dev —— 见 MEASURED_CONTEXT 的说明。
const FALLBACK_MODELS = [
  // Flash-Official 没排进实测（探测时该通道一直 4008），保守按目录 dev 报。
  { id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek-V4-Flash', channel: 'solo_work_remote', contextWindow: 200000 },
  { id: 'DeepSeek-V4-Pro-Official', name: 'DeepSeek-V4-Pro', channel: 'solo_work_remote', contextWindow: 1000000 },
  { id: 'glm-5.2', name: 'GLM-5.2', channel: 'solo_work_remote', contextWindow: 1000000 },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', channel: 'solo_work_remote', contextWindow: 1000000 },
];

// ============================================================
// 凭据解密
// ============================================================

// 四个 64 字节盐，原样取自 lib/index.js:1718-1981（提取脚本见 _extract-salts.cjs）。
const SALT_A = Uint8Array.from([82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37]);
const SALT_B = Uint8Array.from([31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125]);
const SALT_C = Uint8Array.from([191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176, 135, 99, 96, 18, 127, 101, 203, 104, 211, 102, 191, 125, 37, 72, 150, 156, 51, 229, 121, 35, 17, 153, 141, 177, 110, 131, 150, 128, 172, 255, 254, 6, 18, 140, 55, 62, 236, 249, 135, 64, 135, 12, 117, 4, 89, 149, 168, 209]);
const SALT_D = Uint8Array.from([246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145, 50, 196, 165, 42, 254, 120, 3, 54, 244, 207, 209, 85, 53, 6, 138, 106, 175, 148, 31, 204, 186, 186, 165, 182, 87, 142, 49, 10, 39, 110, 26, 154, 86, 56, 173, 125, 18, 64, 198, 225, 99, 99, 83, 82, 191, 134, 76, 170]);

const HEADER_AES = [116, 99, 5, 16, 0, 0];
const HEADER_AES_PRIVATE = [18, 57, 32, 32, 2, 3];

function xor64(a, b) {
  const out = Buffer.allocUnsafe(64);
  for (let i = 0; i < 64; i++) out[i] = a[i] ^ b[i];
  return out;
}

function headerEquals(buf, want) {
  if (buf.length < want.length) return false;
  for (let i = 0; i < want.length; i++) if (buf[i] !== want[i]) return false;
  return true;
}

// storage.json 里的值：要么直接是明文 JSON（旧形态），要么是 base64 的自有封装。
function decryptTraeStorageValue(encoded) {
  const buf = Buffer.from(String(encoded), 'base64');
  if (buf.length <= 102) throw new Error('Trae auth ciphertext is too short');

  let type;
  if (headerEquals(buf, HEADER_AES)) type = 'aes';
  else if (headerEquals(buf, HEADER_AES_PRIVATE)) type = 'aes-private';
  else throw new Error('unsupported Trae auth encryption header');

  const random = buf.subarray(6, 38);
  const encrypted = buf.subarray(38);
  const salt = type === 'aes-private' ? xor64(SALT_C, SALT_D) : xor64(SALT_A, SALT_B);

  const first = createHash('sha512').update(random).digest();
  const derived = createHash('sha512').update(Buffer.concat([first, salt])).digest();
  const key = derived.subarray(0, 16);
  const iv = derived.subarray(16, 32);

  let plain;
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch (e) {
    throw new Error(`Trae auth decrypt failed: ${e.message}`);
  }
  if (plain.length < 64) throw new Error('Trae auth plaintext is too short');

  const digest = plain.subarray(0, 64);
  const body = plain.subarray(64);
  const want = createHash('sha512').update(body).digest();
  if (!digest.equals(want)) throw new Error('Trae auth integrity check failed');
  return body.toString('utf8');
}

function parseAuthValue(value) {
  const s = String(value || '').trim();
  if (!s) throw new Error('Trae auth value is empty');
  return s.startsWith('{') ? JSON.parse(s) : JSON.parse(decryptTraeStorageValue(s));
}

// ============================================================
// 身份读取
// ============================================================

function timeToMs(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return value > 0xe8d4a51000 ? value : value * 1000;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n > 0xe8d4a51000 ? n : n * 1000;
  const d = Date.parse(String(value));
  return Number.isFinite(d) ? d : 0;
}

function storageCandidates() {
  const out = [];
  const roots = [];
  if (process.env.APPDATA) roots.push(process.env.APPDATA);
  roots.push(join(os.homedir(), 'AppData', 'Roaming'));
  const names = ['Trae CN', 'trae-cn', 'TRAE SOLO CN', 'trae-solo-cn', 'Trae', 'TRAE SOLO'];
  for (const root of [...new Set(roots)]) {
    for (const name of names) {
      out.push({ appName: name, storage: join(root, name, 'User', 'globalStorage', 'storage.json') });
    }
  }
  return out;
}

function productJsonCandidates(appName) {
  const out = [];
  if (process.env.LOCALAPPDATA) {
    out.push(join(process.env.LOCALAPPDATA, 'Programs', appName, 'resources', 'app', 'product.json'));
  }
  out.push(join(os.homedir(), 'AppData', 'Local', 'Programs', appName, 'resources', 'app', 'product.json'));
  return out;
}

function readAppVersion(appName) {
  for (const p of productJsonCandidates(appName)) {
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      if (j && typeof j.appVersion === 'string' && j.appVersion) return j.appVersion;
    } catch {}
  }
  return '';
}

function deviceCenterIdOf(storage) {
  const keys = Object.keys(storage).filter((k) => k.startsWith(DEVICE_CENTER_PREFIX));
  if (keys.length !== 1) return '';
  return keys[0].slice(DEVICE_CENTER_PREFIX.length);
}

function normalizeVersionCode(v) {
  const s = String(v || '').trim();
  return /^\d+$/.test(s) ? s : VERSION_CODE_FALLBACK;
}

function deviceTypeOf() {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'windows';
  return process.platform;
}

// 把一份 storage.json 解成 {credential, identity}，解不出来就返回 null。
function parseCredentialAt(cand) {
  let storage;
  let mtimeMs = 0;
  try {
    storage = JSON.parse(readFileSync(cand.storage, 'utf8'));
    mtimeMs = statSync(cand.storage).mtimeMs;
  } catch {
    return null;
  }
  const rawAuth = storage[AUTH_STORAGE_KEY];
  if (typeof rawAuth !== 'string' || !rawAuth) return null;

  let auth;
  try {
    auth = parseAuthValue(rawAuth);
  } catch (e) {
    return { error: 'decrypt-failed', hint: `storage.json 里的登录态解不开：${e.message}`, storagePath: cand.storage };
  }
  const token = auth.token || auth.accessToken;
  if (!token) {
    return { error: 'no-token', hint: 'storage.json 里的登录态没有 token，先在 Trae CN 里重新登录。', storagePath: cand.storage };
  }

  const account = auth.account || {};
  const credential = {
    token: String(token),
    refreshToken: auth.refreshToken ? String(auth.refreshToken) : '',
    userId: auth.userId ? String(auth.userId) : '',
    accountName: account.username ? String(account.username) : '',
    tenantId: account.tenant_id === undefined || account.tenant_id === null ? '' : String(account.tenant_id).trim(),
    host: auth.host ? String(auth.host) : '',
    expiresAtMs: timeToMs(auth.expiredAt ?? auth.expiresAt),
    refreshExpiresAtMs: timeToMs(auth.refreshExpiredAt ?? auth.refreshExpiresAt),
  };

  const machineId = String(storage['telemetry.machineId'] || '');
  const deviceId = deviceCenterIdOf(storage) || String(storage['telemetry.devDeviceId'] || '');
  const buildVersion = String(storage['iCubeLastVersion'] || '');

  const identity = {
    storagePath: cand.storage,
    appName: cand.appName,
    machineId,
    deviceId,
    buildVersion,
    appVersion: readAppVersion(cand.appName),
    deviceType: deviceTypeOf(),
    osVersion: `${os.type()} ${os.release()}`,
  };

  return { credential, identity, mtimeMs };
}

// 本机可能同时装着 Trae CN 与 TRAE SOLO（两份 storage.json 都可能有登录态），
// 谁先谁后不能按目录名硬排：必须挑「没过期的、其中最后登录的那份」，
// 否则会拿一份早就失效的旧 token 去打上游，一路 401，面板还显示「未登录」。
function readTraeCredential() {
  const found = [];
  const tried = [];
  for (const cand of storageCandidates()) {
    if (!existsSync(cand.storage)) continue;
    tried.push(cand.storage);
    const r = parseCredentialAt(cand);
    if (r) found.push(r);
  }

  const usable = found.filter((r) => r.credential);
  if (usable.length) {
    const now = Date.now();
    const alive = usable.filter((r) => !r.credential.expiresAtMs || r.credential.expiresAtMs > now);
    const pool = alive.length ? alive : usable;
    pool.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const best = pool[0];
    return { ok: true, credential: best.credential, identity: best.identity, sourcePath: best.identity.storagePath };
  }

  const broken = found.find((r) => r.error);
  if (broken) return { ok: false, reason: broken.error, hint: broken.hint };

  if (!tried.length) {
    return {
      ok: false,
      reason: 'not-found',
      hint: '没找到 Trae 的 storage.json。先装好并登录 Trae CN（国产版）客户端，再来点「刷新」。',
    };
  }
  return {
    ok: false,
    reason: 'no-auth-key',
    hint: `找到了 storage.json（${tried.join('；')}）但里面都没有登录态，先在 Trae CN 里登录一次。`,
  };
}

// ============================================================
// 请求头
// ============================================================

function identityHeaders(identity) {
  const h = {
    'x-machine-id': identity.machineId || '',
    'x-device-id': identity.deviceId || '',
    'x-device-type': identity.deviceType || deviceTypeOf(),
    'x-ide-version-type': 'stable',
  };
  if (!h['x-machine-id']) delete h['x-machine-id'];
  if (!h['x-device-id']) delete h['x-device-id'];
  if (identity.appVersion) {
    h['x-app-version'] = identity.appVersion;
    h['x-ide-version'] = identity.appVersion;
  }
  if (identity.osVersion) h['x-os-version'] = identity.osVersion;
  return h;
}

// profile: 'chat'（默认，聊天/流式）/ 'model-detail'（JSON 目录）。
function buildHeaders(credential, identity, profile = 'chat') {
  const token = credential.token;
  const requestId = randomUUID();
  const traceId = requestId.replace(/-/g, '');

  const h = {
    Authorization: `Cloud-IDE-JWT ${token}`,
    'X-Ide-Token': token,
    'x-plugin-channel': 'icube-ai',
    'User-Agent': `Trae/${identity.appVersion || identity.buildVersion || 'unknown'}`,
    'x-app-id': APP_ID,
    ...identityHeaders(identity),
    'x-app-version-code': normalizeVersionCode(identity.buildVersion),
    'x-ide-version-code': normalizeVersionCode(identity.buildVersion),
    'x-custom-trace-id': traceId.slice(0, 32),
    'x-flow-traceparent': `04-${traceId}-${traceId.slice(0, 16)}-01`,
    'request-traffic-type': 'prod',
    'Content-Type': 'application/json',
  };

  if (profile === 'chat') {
    h['X-Cloudide-Token'] = token;
    h['x-uid'] = credential.userId || '';
    h['x-request-id'] = requestId;
    h['x-trae-request-id'] = requestId;
    h.Accept = 'text/event-stream';
  } else {
    h.Accept = 'application/json';
  }
  return h;
}

// 额度/签到走 web 门户那套头，跟聊天完全不同（lib/index.js:7654）。
function webHeaders(credential, extra) {
  return {
    Authorization: `Cloud-IDE-JWT ${credential.token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0',
    Origin: WEB_ORIGIN,
    Referer: `${WEB_ORIGIN}/`,
    ...(extra || {}),
  };
}

// ============================================================
// 请求体翻译
// ============================================================

// draft-3 兼容：DeepSeek 后端会整条拒 `properties.X.required: true`（4027），
// 必须把布尔 required 提成父级数组。规则照 lib/index.js:4805。
function normalizeTraeToolSchema(value) {
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const next = normalizeTraeToolSchema(item);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? items : value;
  }
  if (typeof value !== 'object' || value === null) return value;

  const source = value;
  const result = {};
  for (const [key, entry] of Object.entries(source)) {
    if (key === 'required' && typeof entry === 'boolean') continue;
    result[key] = normalizeTraeToolSchema(entry);
  }
  // 注意：这里看的是 source（归一化前）而不是 result —— result 里的布尔 required 已经被删掉了。
  const properties = source.properties;
  if (typeof properties === 'object' && properties !== null && !Array.isArray(properties)) {
    const promoted = [];
    if (Array.isArray(source.required)) {
      for (const name of source.required) if (typeof name === 'string' && !promoted.includes(name)) promoted.push(name);
    }
    for (const [name, property] of Object.entries(properties)) {
      if (typeof property === 'object' && property !== null && property.required === true && !promoted.includes(name)) {
        promoted.push(name);
      }
    }
    if (promoted.length > 0) result.required = promoted;
  }
  return JSON.stringify(result) === JSON.stringify(value) ? value : result;
}

function toTraeMessages(messages) {
  return (messages || []).map((m) => {
    const out = { ...m };
    if (out.role === 'developer') out.role = 'system';
    if (typeof out.content === 'string') out.content = [{ type: 'text', text: out.content }];
    if (Array.isArray(out.tool_calls)) {
      out.tool_calls = out.tool_calls.map((call) => {
        const next = { ...call };
        if (next.function) {
          next.function_call = next.function;
          delete next.function;
        }
        return next;
      });
    }
    return out;
  });
}

function toTraeTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((t) => {
    const fn = (t && t.function) || {};
    return {
      type: 'function',
      function: {
        name: fn.name,
        ...(fn.description ? { description: fn.description } : {}),
        // 上游要的是字符串，不是对象。
        ...(fn.parameters ? { parameters: JSON.stringify(normalizeTraeToolSchema(fn.parameters)) } : {}),
      },
    };
  });
}

function prepareSoloBody(request) {
  const model = typeof request.model === 'string' && request.model ? request.model : 'glm-5.2';
  const body = {
    messages: toTraeMessages(request.messages),
    model,
    config_name: model,
    function: request.channel || DEFAULT_FUNCTION,
    stream: true,
  };
  const tools = toTraeTools(request.tools);
  if (tools) body.tools = tools;
  const effort = typeof request.reasoningEffort === 'string'
    ? WIRE_EFFORT_MAP[request.reasoningEffort]
    : undefined;
  if (effort) body.reasoning_effort = effort;
  // 注意：不发 max_tokens —— 上游不接受，输出上限由服务端定。
  return body;
}

// ============================================================
// SSE 解码
// ============================================================

class SseDecoder {
  constructor() {
    this.buffer = '';
    this.event = undefined;
    this.id = undefined;
    this.retry = undefined;
    this.data = [];
  }

  push(chunk) {
    this.buffer += chunk;
    const events = [];
    for (;;) {
      const match = /\r?\n/.exec(this.buffer);
      if (match === null || match.index === undefined) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const emitted = this.consumeLine(line);
      if (emitted !== undefined) events.push(emitted);
    }
    return events;
  }

  finish() {
    const events = [];
    if (this.buffer !== '') {
      const e = this.consumeLine(this.buffer);
      this.buffer = '';
      if (e !== undefined) events.push(e);
    }
    const f = this.dispatch();
    if (f !== undefined) events.push(f);
    return events;
  }

  consumeLine(line) {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id' && !value.includes('\0')) this.id = value;
    else if (field === 'retry' && /^\d+$/.test(value)) this.retry = Number(value);
    return undefined;
  }

  dispatch() {
    if (this.data.length === 0) {
      this.event = undefined;
      this.retry = undefined;
      return undefined;
    }
    const result = {
      ...(this.event === undefined || this.event === '' ? {} : { event: this.event }),
      data: this.data.join('\n'),
      ...(this.id === undefined ? {} : { id: this.id }),
      ...(this.retry === undefined ? {} : { retry: this.retry }),
    };
    this.event = undefined;
    this.retry = undefined;
    this.data = [];
    return result;
  }
}

function decodeTraeEvent(raw) {
  const data = raw.data;
  if (data === '[DONE]') return { type: 'done', finishReason: 'stop' };

  let record;
  try {
    record = JSON.parse(data);
  } catch {
    return { type: 'unknown', event: raw.event, data };
  }
  if (!record || typeof record !== 'object') return { type: 'unknown', event: raw.event, data };

  if (raw.event === 'request_wait_in_queue') {
    return { type: 'queue', position: Number(record.position) || 0 };
  }
  if (raw.event === 'progress_notice') return { type: 'progress', notice: record };
  if (raw.event === 'token_usage') {
    return {
      type: 'usage',
      inputTokens: Number(record.prompt_tokens) || 0,
      outputTokens: Number(record.completion_tokens) || 0,
      totalTokens: Number(record.total_tokens) || 0,
      reasoningTokens: Number(record.reasoning_tokens) || 0,
      cacheReadTokens: Number(record.cache_read_input_tokens) || 0,
      cacheWriteTokens: Number(record.cache_creation_input_tokens) || 0,
    };
  }
  if (raw.event === 'metadata' || raw.event === 'timing_cost') {
    return { type: 'diagnostic', promptCachePoolRecord: record.prompt_cache_pool_record, pipeline: record.name, providerModelName: record.provider_model_name };
  }

  const hasResponse = 'response' in record;
  const hasReasoning = 'reasoning_content' in record;
  if (raw.event === 'done' || (typeof record.finish_reason === 'string' && !hasResponse)) {
    return { type: 'done', finishReason: typeof record.finish_reason === 'string' ? record.finish_reason : 'stop' };
  }
  if (raw.event === 'output' || hasResponse || hasReasoning) {
    return {
      type: 'delta',
      text: typeof record.response === 'string' ? record.response : '',
      reasoning: typeof record.reasoning_content === 'string' ? record.reasoning_content : '',
      toolCalls: record.tool_calls,
    };
  }
  return { type: 'unknown', event: raw.event, data };
}

// 只有 unknown 类型 + (event 是 error，或数字 code >= 4000) 才算上游失败。
function traeFailureOf(decoded) {
  if (!decoded || decoded.type !== 'unknown') return undefined;
  let payload;
  try {
    payload = JSON.parse(decoded.data);
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== 'object') return undefined;
  const code = Number(payload.code);
  const isErrorEvent = decoded.event === 'error';
  if (!isErrorEvent && !(Number.isFinite(code) && code >= 4000)) return undefined;
  return {
    code: Number.isFinite(code) ? code : 0,
    message: typeof payload.message === 'string' ? payload.message : '',
    extra: payload.extra,
  };
}

// 上游码 → 本地 HTTP 语义。额度耗尽/会员相关给 402，临时性服务端缺口给 503，
// 这样调用方看到 402 就知道「不是我这边的错，是账号额度」，不会被误导去重试或重登录。
function statusOfTraeCode(code) {
  if (code === 1005) return 402;   // 需要付费套餐
  if (code === 4008) return 402;   // SOLO 额度耗尽
  if (code === 4222) return 402;   // 企业租户额度耗尽
  if (code === 4011) return 429;   // 限流
  if (code === 2001) return 503;   // 服务端没发布该 function config，临时缺口
  return 400;
}

function failureToError(failure) {
  const detail = [failure.message || 'upstream error', `Trae code ${failure.code}`];
  let plan = '';
  if (typeof failure.extra === 'string' && failure.extra) {
    try {
      const e = JSON.parse(failure.extra);
      if (e && e.plan !== undefined) plan = ` · plan ${e.plan}`;
    } catch {}
  }
  const err = new Error(`${detail.join(' · ')}${plan}`);
  err.status = statusOfTraeCode(failure.code);
  err.upstreamCode = String(failure.code);
  return err;
}

// Trae 的 tool_calls 是**分片**的：第一帧带 id+name，后续帧只带 arguments 增量，
// 且后续帧的 name 是空串。所以这里不能要求 name 非空，也不能把空 name 发出去
// （下游按 index 累加 arguments，被空 name 覆盖一次函数名就废了）。
function normalizeToolCalls(list) {
  if (!Array.isArray(list) || !list.length) return undefined;
  const out = [];
  list.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const src = (item.function_call && typeof item.function_call === 'object') ? item.function_call : item.function;
    if (!src || typeof src !== 'object') return;
    const name = typeof src.name === 'string' ? src.name : '';
    const args = typeof src.arguments === 'string' ? src.arguments : '';
    if (!name && !args) return;
    const fn = {};
    if (name) fn.name = name;
    if (args) fn.arguments = args;
    out.push({
      index: Number.isFinite(Number(item.index)) ? Number(item.index) : i,
      ...(item.id ? { id: String(item.id) } : {}),
      ...(item.type === 'function' ? { type: 'function' } : {}),
      function: fn,
    });
  });
  return out.length ? out : undefined;
}

// ============================================================
// 聊天（async generator，yield OpenAI chat.completion.chunk）
// ============================================================

const PEEK_MAX_CHUNKS = 64;
const PEEK_MAX_BYTES = 262144;
// 上游挂了不返回、TCP 半开时，光靠调用方传进来的 signal 是等不到东西的
// （那个 signal 只在客户端断开时才 abort）。这里补一个总超时，与 qoder 桥一致。
const CHAT_TIMEOUT_MS = 180000;

async function* streamChat(credential, identity, request, signal) {
  const model = typeof request.model === 'string' && request.model ? request.model : 'glm-5.2';
  const body = prepareSoloBody(request);
  const timeout = AbortSignal.timeout(CHAT_TIMEOUT_MS);

  const res = await fetch(`${CHAT_BASE}${CHAT_PATH}`, {
    method: 'POST',
    headers: buildHeaders(credential, identity, 'chat'),
    body: JSON.stringify(body),
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Trae returned HTTP ${res.status} ${text.slice(0, 300)}`.trim());
    err.status = res.status;
    throw err;
  }
  if (!res.body) {
    const err = new Error('Trae returned an empty body');
    err.status = 502;
    throw err;
  }

  const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  const chunk = (delta, finishReason, usage) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: delta || {}, finish_reason: finishReason === undefined ? null : finishReason }],
    ...(usage ? { usage } : {}),
  });

  const reader = res.body.getReader();
  const textDecoder = new TextDecoder();
  const sse = new SseDecoder();

  try {
  // Trae 把鉴权/额度/限流失败塞进 HTTP 200 的 SSE 里，直接 200 转发再断流会让客户端
  // 误判成网络故障并重试。所以先偷看头部若干帧，发现早期失败就翻成真错误抛出去。
  let peekChunks = 0;
  let peekBytes = 0;
  let sawDelta = false;
  const early = [];

  while (peekChunks < PEEK_MAX_CHUNKS && peekBytes < PEEK_MAX_BYTES) {
    const { value, done } = await reader.read();
    if (done) break;
    peak: {
      peekChunks += 1;
      peekBytes += value ? value.length : 0;
      const text = textDecoder.decode(value, { stream: true });
      for (const raw of sse.push(text)) {
        const decoded = decodeTraeEvent(raw);
        const failure = traeFailureOf(decoded);
        if (failure) throw failureToError(failure);
        if (decoded.type === 'delta') sawDelta = true;
        early.push(decoded);
      }
    }
    if (sawDelta) break;
  }

  let sawToolCalls = false;
  let usage;
  let finished = false;

  const emit = function* (decoded) {
    if (!decoded) return;
    if (decoded.type === 'delta') {
      const delta = {};
      if (decoded.text) delta.content = decoded.text;
      if (decoded.reasoning) delta.reasoning_content = decoded.reasoning;
      const toolCalls = normalizeToolCalls(decoded.toolCalls);
      if (toolCalls) {
        delta.tool_calls = toolCalls;
        sawToolCalls = true;
      }
      if (Object.keys(delta).length) yield chunk(delta, null);
      return;
    }
    if (decoded.type === 'usage') {
      usage = {
        prompt_tokens: decoded.inputTokens,
        completion_tokens: decoded.outputTokens,
        total_tokens: decoded.totalTokens,
        ...(decoded.cacheReadTokens || decoded.cacheWriteTokens
          ? {
            prompt_tokens_details: {
              ...(decoded.cacheReadTokens ? { cached_tokens: decoded.cacheReadTokens } : {}),
              ...(decoded.cacheWriteTokens ? { cache_write_tokens: decoded.cacheWriteTokens } : {}),
            },
          }
          : {}),
      };
      return;
    }
    if (decoded.type === 'done') {
      if (finished) return;
      finished = true;
      yield chunk({}, sawToolCalls ? 'tool_calls' : (decoded.finishReason || 'stop'), usage);
      return;
    }
  };

  // 先吐出偷看阶段已经解出来的事件。
  for (const decoded of early) {
    if (finished) break;
    yield* emit(decoded);
  }

  // 再继续读剩下的。
  while (!finished) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = textDecoder.decode(value, { stream: true });
    for (const raw of sse.push(text)) {
      const decoded = decodeTraeEvent(raw);
      const failure = traeFailureOf(decoded);
      if (failure) throw failureToError(failure);
      yield* emit(decoded);
      if (finished) break;
    }
  }

  if (!finished) {
    for (const raw of sse.finish()) {
      const decoded = decodeTraeEvent(raw);
      const failure = traeFailureOf(decoded);
      if (failure) throw failureToError(failure);
      yield* emit(decoded);
      if (finished) break;
    }
  }
  // 以前这里自作主张补一帧 stop：上游断流没给 done 也当成正常说完，
  // 半截文本、半截工具参数会被原样交出去。现在改成明确的截断错误，让上层决定怎么报。
  if (!finished) {
    const err = new Error('Trae 在结束信号到达前就断开了连接，这次回答不完整');
    err.status = 502;
    err.upstreamCode = 'upstream_truncated';
    throw err;
  }
  } finally {
    // 客户端中途断开、或提前报错时，这条流还挂在连接上读，必须主动取消，
    // 否则一条泄漏的 reader 会一直占着上游连接直到超时。
    try { await reader.cancel(); } catch {}
  }
}

// ============================================================
// 模型目录
// ============================================================

// Trae 线上的档位名 → 我们这边的名字（lib/index.js:6184 EFFORT_MAP）。
// 映射不到的档位直接丢掉，绝不编一个上游没说的名字。
const EFFORT_MAP = {
  light: 'low',
  medium: 'medium',
  high: 'high',
  extra_high: 'xhigh',
  max: 'max',
};

// 档位分两种情况：
//   1) 行级 reasoning_effort_config 明说了 options（support_thinking === true）
//      → 只报它明说的那几个，一个不多（lib/index.js:6211-6219 的读法）。
//   2) 明说 support_thinking: false / 干脆没这块，但 display_config 标了
//      model_capability: 'reasoning_model' 或 reasoning.enable
//      → 报全套五档。依据是实测（2026-11-02，见 README「推理档位」）：
//        这些模型对 low/high/xhigh 都不报 4001/4027，且 deepseek-v4.1-flash
//        的思考长度随档位单调上升。上游收了却不报出，用户就永远调不到。
// 两种情况都不满足（纯 chat 模型、custom_model_* 之类）→ 空，不给假档位。
const ALL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function isReasoningCapable(config, display, contact) {
  if (display && display.model_capability === 'reasoning_model') return true;
  if (contact && contact.reasoning && contact.reasoning.enable === true) return true;
  return false;
}

function pickReasoningEfforts(config, display, contact) {
  const rec = config && config.reasoning_effort_config;
  const opts = rec && typeof rec === 'object' && rec.support_thinking === true && Array.isArray(rec.options)
    ? rec.options
    : [];
  if (opts.length) {
    const out = [];
    for (const o of opts) {
      if (typeof o !== 'string') continue;
      const effort = EFFORT_MAP[o];
      if (effort && !out.includes(effort)) out.push(effort);
    }
    if (out.length) return out;
  }
  return isReasoningCapable(config, display, contact) ? ALL_EFFORTS.slice() : [];
}

// 上游数字字段一律过这一层：非正数/NaN 当没有，别把 0 当窗口。
function positive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// display_contact_config 是「字符串化的第二层 JSON」，解出来复用。
function parseContact(config) {
  const raw = config && config.display_contact_config;
  if (typeof raw !== 'string' || !raw.trim().startsWith('{')) return {};
  try {
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function parseConsumptionRate(contact) {
  const cr = contact && contact.consumption_rate;
  if (cr && cr.enable === true && cr.data && Number.isFinite(Number(cr.data.rate))) {
    return Number(cr.data.rate);
  }
  return undefined;
}

// 每个通道各给一份目录，同一模型可能在多个通道里各有一行，且可见位是行级
// 的（lib/index.js:4589-4597）。这里只负责把行摊平收集，挑选交给 resolveModels。
function collectModels(payload, channel, out) {
  const rows = (payload && payload.document && Array.isArray(payload.document.config_info_list))
    ? payload.document.config_info_list
    : (payload && Array.isArray(payload.config_info_list) ? payload.config_info_list : []);

  for (const config of rows) {
    if (!config || typeof config !== 'object') continue;
    const id = typeof config.config_name === 'string' ? config.config_name : '';
    if (!id) continue;
    // 只留真正给用户聊天的模型：上游 usage=chat_completion（lib/index.js:311-319 同判据）。
    // custom_model_* 是「用户自建模型槽」——本机 14 个里 12 个打过去是 3003 all models
    // failed（该账号没开通道），1 个 4023，只有 gpt-5/gpt-6 能聊，留着只会让人点到死模型。
    // summary/title_generation/input_optimization/fast_apply* 是 IDE 内部工具模型，
    // 上游注释原话「none of those belong in a model picker」。usage 字段缺失时保留。
    if (typeof config.usage === 'string' && config.usage !== 'chat_completion') continue;
    const display = (config.display_config && typeof config.display_config === 'object') ? config.display_config : {};
    const detail = Array.isArray(config.model_detail_list) && config.model_detail_list[0]
      ? config.model_detail_list[0]
      : {};
    let name = typeof display.display_name === 'string' ? display.display_name : '';
    if (!name || name === '-') name = id;
    // 上下文窗口按上游语义取 context_window_tokens.dev（lib/index.js:6201-6205），
    // 不是 detail.prompt_max_tokens —— 后者是「可用输入还留多少」的保守值
    // （168000 vs 200000），拿它当窗口会把 glm-5.3 / deepseek-v4.1-flash 这类
    // 从 200K 报成 168K。max 只在 max_mode 打开时才代表真实窗口。
    const ctxTok = (config.context_window_tokens && typeof config.context_window_tokens === 'object')
      ? config.context_window_tokens
      : {};
    const dev = positive(ctxTok.dev) || positive(detail.prompt_max_tokens) || 0;
    // 实测地板值优先：dev 只是客户端建议值（200000），上游实际按 4022 卡在约 1M。
    const measured = MEASURED_CONTEXT[id.toLowerCase()];
    const contextWindow = measured || dev;
    const declaredMax = display.max_mode === true ? positive(ctxTok.max) : undefined;
    const contextWindowMax = Math.max(measured || 0, declaredMax || 0) || undefined;
    const maxTokens = Number(detail.max_tokens) || 0;
    const contact = parseContact(config);

    out.push({
      id,
      name,
      channel,
      contextWindow,
      ...(contextWindowMax ? { contextWindowMax } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      efforts: pickReasoningEfforts(config, display, contact),
      rate: parseConsumptionRate(contact),
      invisible: config.is_invisible_to_user === true,
    });
  }
}

// 可见性裁决（照 lib/index.js:4627-4648 的语义）：
//   - 该模型在任何通道都没有可见行 ⇒ 不列（hide）；
//   - 有可见行，但当前通道那行不可见 ⇒ 换到最优先的可见通道（repin）；
//   - 已经是可见行 ⇒ 保持。
// 关键：不能因为某一行不可见就把整个模型删掉——那是 45 个可见 id 里的一大半。
function resolveModels(rows) {
  const byId = new Map();
  for (const row of rows) {
    const key = row.id.toLowerCase();
    if (!byId.has(key)) byId.set(key, []);
    byId.get(key).push(row);
  }

  const models = [];
  for (const group of byId.values()) {
    const shown = group.filter((r) => !r.invisible);
    if (!shown.length) continue;

    const ordered = CHANNEL_PRIORITY.flatMap((ch) => shown.filter((r) => r.channel === ch))
      .concat(shown.filter((r) => !CHANNEL_PRIORITY.includes(r.channel)));
    const pick = ordered[0];

    // 同一模型在多通道里可能只有一行带倍率/档位，缺的从其它可见行补，
    // 但绝不凭空造一个上游没给的倍率（lib/index.js:5214-5216）。
    const rate = pick.rate !== undefined
      ? pick.rate
      : ordered.map((r) => r.rate).find((v) => v !== undefined);
    const efforts = pick.efforts.length
      ? pick.efforts
      : (ordered.map((r) => r.efforts).find((v) => v.length) || []);
    // 从别的通道借 max 时必须比当前窗口大才有意义 —— 同一模型在不同通道的
    // 窗口可以不一样（solo_coder 那档常是 128k），借过来比 pick 的 dev 还小
    // 就会报出「最大窗口 < 窗口」，Cindy 那边直接算错预算。
    const borrowedMax = pick.contextWindowMax !== undefined
      ? pick.contextWindowMax
      : ordered.map((r) => r.contextWindowMax).find((v) => v !== undefined);
    const contextWindowMax = borrowedMax && borrowedMax >= pick.contextWindow ? borrowedMax : undefined;

    models.push({
      id: pick.id,
      name: pick.name,
      channel: pick.channel,
      contextWindow: pick.contextWindow,
      ...(contextWindowMax !== undefined ? { contextWindowMax } : {}),
      ...(pick.maxTokens ? { maxTokens: pick.maxTokens } : {}),
      reasoning: { supported_efforts: efforts },
      ...(rate !== undefined ? { creditMultiplier: rate } : {}),
    });
  }
  return models;
}

async function fetchModels(credential, identity) {
  const rows = [];
  const failures = [];

  for (const channel of CHANNEL_PRIORITY) {
    try {
      const res = await fetch(`${CHAT_BASE}${MODEL_DIR_PATH}`, {
        method: 'POST',
        headers: buildHeaders(credential, identity, 'model-detail'),
        body: JSON.stringify({
          function: channel,
          config_names: null,
          need_prompt: false,
          current_config_info: null,
          poly_prompt: true,
          mode_type: null,
          agent_type: null,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        failures.push(`${channel}: HTTP ${res.status}`);
        continue;
      }
      const payload = await res.json().catch(() => null);
      const before = rows.length;
      collectModels(payload, channel, rows);
      if (rows.length === before) failures.push(`${channel}: 空目录`);
    } catch (e) {
      failures.push(`${channel}: ${String(e && e.message ? e.message : e).slice(0, 80)}`);
    }
  }

  return { models: resolveModels(rows), failures };
}

// ============================================================
// 额度与签到
// ============================================================

async function postWeb(path, credential, body, extraHeaders) {
  const res = await fetch(`${PAY_BASE}${path}`, {
    method: 'POST',
    headers: webHeaders(credential, extraHeaders),
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    throw new Error(`Trae usage endpoint ${path} returned HTTP ${res.status}`);
  }
  return res.json().catch(() => ({}));
}

async function refreshUsage(credential) {
  const payload = await postWeb(USAGE_PATH, credential, { require_usage: true });
  const summary = (payload && payload.usage_summary) || {};
  const total = Number(summary.total_amount);
  const used = Number(summary.consumed_amount);
  const ratio = Number(summary.consumption_ratio);

  const packs = [];
  const list = Array.isArray(payload.user_entitlement_pack_list) ? payload.user_entitlement_pack_list : [];
  for (const item of list) {
    const base = (item && item.entitlement_base_info) || {};
    const packageExtra = base.product_extra && base.product_extra.package_extra;
    const limit = Number((packageExtra && packageExtra.quota && packageExtra.quota.credits_limit)
      ?? (base.quota && base.quota.credits_limit));
    packs.push({
      id: base.entitlement_id,
      desc: item && item.display_desc,
      credits: Number.isFinite(limit) ? limit : 0,
      ...(base.end_time ? { expiresAt: timeToMs(base.end_time) } : {}),
    });
  }

  const creditsAmount = Number(payload.usage && payload.usage.credits_amount);
  const out = {
    total: Number.isFinite(total) ? total : undefined,
    used: Number.isFinite(used) ? used : undefined,
    remaining: Number.isFinite(total) && Number.isFinite(used) ? Math.max(0, total - used) : undefined,
    percentage: Number.isFinite(ratio) ? Math.round(ratio * 10000) / 100 : undefined,
    unit: 'credits',
    ...(packs.length ? { packs } : {}),
    ...(Number.isFinite(creditsAmount) ? { credits: creditsAmount } : {}),
  };
  const trial = payload && payload.trial_status;
  if (trial && trial.is_in_trial === true && trial.trial_end_time) {
    out.expiresAt = timeToMs(trial.trial_end_time);
  }
  // 上游没有「额度重置时间」这个概念（实测 web_user_ent_usage 里只有
  // usage_summary.consumption_ratio，没有任何 reset/period 字段）。能给的只有
  // 各额度包的到期时间，取最晚那个当 expiresAt —— 这是事实，不是推测。
  if (out.expiresAt === undefined) {
    const latest = packs
      .map((p) => p.expiresAt)
      .filter((v) => Number.isFinite(v) && v > Date.now())
      .sort((a, b) => b - a)[0];
    if (latest !== undefined) out.expiresAt = latest;
  }
  return out;
}

async function refreshCheckin(credential, identity) {
  const extra = identity && identity.deviceId ? { 'x-device-id': identity.deviceId } : undefined;
  const payload = await postWeb(CHECKIN_STATUS_PATH, credential, {}, extra);
  return {
    checkedIn: payload.checked_in === true,
    credits: Number(payload.credits) || 0,
    enabled: payload.enable !== false,
    didCheckedIn: payload.did_checked_in === true,
    ...(payload.extra_credits !== undefined ? { extraCredits: payload.extra_credits } : {}),
  };
}

async function claimCheckin(credential, identity) {
  if (!identity || !identity.deviceId) {
    return { claimed: false, code: 9004, message: '上游要 x-device-id，但本机 storage.json 里没读到设备 id，签到领不了' };
  }
  const payload = await postWeb(CHECKIN_CLAIM_PATH, credential, {}, { 'x-device-id': identity.deviceId });
  const code = Number(payload.code);
  return {
    claimed: code === 0,
    code: Number.isFinite(code) ? code : -1,
    message: typeof payload.message === 'string' ? payload.message : '',
  };
}

module.exports = {
  REGION,
  REASONING_EFFORTS,
  FALLBACK_MODELS,
  readTraeCredential,
  fetchModels,
  streamChat,
  refreshUsage,
  refreshCheckin,
  claimCheckin,
  // 下面几个导出给自测/排查用，worker 不依赖。
  buildHeaders,
  decryptTraeStorageValue,
  normalizeTraeToolSchema,
  prepareSoloBody,
  SseDecoder,
  decodeTraeEvent,
};
