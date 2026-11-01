// Trae 桥 · 电子脑（浏览器沙箱）
// 职责：把 AI 工具调用和面板请求转给 Node worker。
// 这一层没有文件系统、没有 Node、没有通用网络直连。
'use strict';

const GHOST_ID = 'trae-bridge';
const CHANNEL = 'trae-bridge-panel';

let lastStatus = null;
const seen = new Set();

/**
 * cindy.node.request 的返回值是**两层**的：
 *   { ok:true, result: { ok:true, result: <worker 真正返回的东西> } }
 * 外层是主机的 invoke 信封，内层是 worker 自己写的 JSON-RPC result。
 * 少解一层，面板拿到的就是信封本身 —— signedIn/modelCount/port 全是 undefined，
 * 于是显示「未登录 / 0 个 / —」。这里统一剥到底。
 */
function unwrap(res) {
  let cur = res;
  for (let depth = 0; depth < 4; depth++) {
    if (!cur || typeof cur !== 'object') return cur;
    if (cur.ok === false) throw new Error(cur.message || 'Node worker 返回失败');
    if (cur.ok === true && Object.prototype.hasOwnProperty.call(cur, 'result')) {
      cur = cur.result;
      continue;
    }
    return cur;
  }
  return cur;
}

async function callWorker(method, callId) {
  const res = await cindy.node.request({
    method,
    params: {},
    // 工具调用内带上 callId，让主机把这次 Node 请求绑定到当前在途调用；
    // 面板触发的请求没有 callId，走独立 RPC 生命周期（文档允许）。
    ...(callId ? { callId, cancelWithCall: true } : {}),
  });
  return unwrap(res);
}

async function getStatus(force, callId) {
  if (!force && lastStatus && Date.now() - lastStatus.at < 5000) return lastStatus.value;
  const value = await callWorker('trae/status', callId);
  lastStatus = { at: Date.now(), value };
  return value;
}

function hintFor(st) {
  if (st && st.hint) return st.hint;
  if (!st || !st.signedIn) return '未登录。请先打开 Trae CN 客户端并登录，再点「刷新」。';
  if (st.expired) return 'Trae CN 的登录凭据已过期，请重新打开 Trae CN 登录一次，再点「刷新」。';
  return '';
}

function accountOf(st) {
  if (!st) return '';
  return st.accountName || st.user || '';
}

function fmtTime(ms) {
  if (!ms || !Number.isFinite(Number(ms))) return '';
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// quota 是 worker 给的额度/积分快照，形状随上游而定：
// 有 total/used/remaining 就报用量，有 credits/balance 就报余额，只有 note 就照抄 note。
function quotaText(q) {
  if (!q || typeof q !== 'object') return '';
  if (typeof q.total === 'number' && q.total > 0) {
    const used = typeof q.used === 'number' ? q.used : 0;
    const left = typeof q.remaining === 'number' ? q.remaining : (q.total - used);
    return `已用 ${used} / ${q.total}，剩余 ${left}`;
  }
  if (typeof q.credits === 'number') return `${q.credits} 积分`;
  if (typeof q.balance === 'number') return `余额 ${q.balance}`;
  if (typeof q.remaining === 'number') return `剩余 ${q.remaining}`;
  if (typeof q.note === 'string' && q.note) return q.note;
  return '';
}

function checkinText(ck, withNext) {
  if (!ck || typeof ck !== 'object') return '';
  if (ck.enabled === false) return '暂时没有签到活动';
  if (ck.checkedIn === true) {
    const c = typeof ck.credits === 'number' ? `，本轮 ${ck.credits} 积分` : '';
    return `今天已签${c}`;
  }
  if (ck.checkedIn === false) return '今天还没签，可以领';
  return '';
}

function statusLines(st) {
  const lines = [];
  if (st.signedIn) {
    lines.push(`Trae 桥：正常运行（127.0.0.1:${st.port}）`);
    lines.push(`账号：${accountOf(st) || '(未知)'}${st.region ? `（${st.region}）` : ''}`);
    lines.push(`模型：${st.modelCount} 个`);
    const qt = quotaText(st.quota);
    if (qt) lines.push(`额度：${qt}`);
    const ct = checkinText(st.checkin);
    if (ct) lines.push(`签到：${ct}`);
    const lu = st.localUsage && st.localUsage.today;
    if (lu && lu.requests > 0) {
      lines.push(`今日用量：${lu.requests} 次请求，${lu.tokens} tokens${typeof lu.weighted === 'number' ? `（折算 ${Math.round(lu.weighted)}）` : ''}`);
    }
    if (typeof st.uptimeSeconds === 'number') lines.push(`已运行：${Math.round(st.uptimeSeconds / 60)} 分钟`);
    if (st.logFile) lines.push(`日志：${st.logFile}`);
    if (st.lastError) lines.push(`注意：${st.lastError}`);
    if (st.expired) lines.push(hintFor(st));
  } else {
    lines.push('Trae 桥：未登录。');
    lines.push(hintFor(st));
  }
  return lines;
}

// ---------- AI 工具调用 ----------

cindy.onHostMessage(async function (msg) {
  if (msg.type !== 'tool-call') return;
  const ok = (result) => cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result });
  const fail = (message, errorCode) => cindy.send({
    type: 'tool-result', callId: msg.callId, ok: false,
    ...(errorCode ? { errorCode } : {}), message,
  });

  try {
    if (msg.tool === 'trae_status') {
      const st = await getStatus(true, msg.callId);
      ok({ text: statusLines(st).join('\n') });
      return;
    }

    if (msg.tool === 'trae_endpoint') {
      const ep = await callWorker('trae/endpoint', msg.callId);
      if (!ep || ep.ok === false) { fail((ep && ep.message) || '读不到端点信息'); return; }
      const text = [
        '在 Cindy 里配置一次就能长期使用：',
        '',
        '设置 → 模型 → 添加自定义供应商',
        '  显示名：Trae',
        '  协议：OpenAI Compatible / Chat Completions',
        `  Base URL：${ep.baseUrl}`,
        `  API Key：${ep.token}`,
        '',
        ep.modelHint ? `${ep.modelHint}` : '然后在供应商下逐个「添加模型 ID」。',
      ].join('\n');
      ok({ text });
      return;
    }

    if (msg.tool === 'trae_refresh') {
      const st = await callWorker('trae/refresh', msg.callId);
      lastStatus = null;
      ok({
        text: st.signedIn
          ? `已刷新：${accountOf(st) || '(已登录)'}，${st.modelCount} 个模型可用，端口 ${st.port}。${st.expired ? '（凭据已过期，需重开 Trae CN 登录）' : ''}`
          : `刷新后仍未读到登录态。${hintFor(st)}`,
      });
      return;
    }

    if (msg.tool === 'trae_checkin') {
      const r = await callWorker('trae/checkin', msg.callId);
      lastStatus = null;
      const st = r.status || {};
      const ck = st.checkin || {};
      const lines = [r.message || (r.claimed ? '签到成功' : '没有领到积分')];
      if (r.code && !r.claimed) lines.push(`结果码：${r.code}`);
      if (typeof ck.credits === 'number') lines.push(`当前积分：${ck.credits}`);
      const qt = quotaText(st.quota);
      if (qt) lines.push(`额度：${qt}`);
      ok({ text: lines.join('\n') });
      return;
    }

    fail(`未知工具：${msg.tool}`);
  } catch (e) {
    fail(`Trae 桥内部错误：${e && e.message ? e.message : String(e)}。可在插件面板查看状态。`);
  }
});

// ---------- 面板请求（BroadcastChannel） ----------

let channel;
try { channel = new BroadcastChannel(CHANNEL); } catch { channel = null; }

if (channel) {
  channel.onmessage = async (event) => {
    const data = event && event.data;
    if (!data || data.__panel !== true || typeof data.reqId !== 'string') return;
    if (seen.has(data.reqId)) return;          // 面板会重发，按 reqId 去重
    seen.add(data.reqId);
    // 只淘汰最早的那条，别一次清空：清空后旧 reqId 再重发会被当成新请求，
    // 对签到这种有副作用的动作就是重复提交（靠上游幂等兜着，但没必要赌）。
    while (seen.size > 200) {
      const oldest = seen.values().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }

    const send = (value) => {
      try { channel.postMessage({ __brain: true, reqId: data.reqId, value }); } catch {}
    };

    // 面板按 {__panel:true, reqId, action} 发；action 与旧键 type 都认，避免一边改了另一边没跟上。
    const action = typeof data.action === 'string' ? data.action : data.type;

    try {
      if (action === 'status') {
        send(await getStatus(false));
      } else if (action === 'refresh') {
        const st = await callWorker('trae/refresh');
        lastStatus = null;
        send(st);
      } else if (action === 'endpoint') {
        send(await callWorker('trae/endpoint'));
      } else if (action === 'checkin') {
        const r = await callWorker('trae/checkin');
        lastStatus = null;
        send(r);
      } else {
        send(null);
      }
    } catch (e) {
      send({ error: e && e.message ? e.message : String(e) });
    }
  };
}
