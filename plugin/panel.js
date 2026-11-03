// Trae 桥 · 面板脚本
// 必须是外挂文件：Cindy 的 CSP 同源但不放行内联 <script>，写在 panel.html 里不会执行。
// 面板无 preload 桥，只有同源 fetch + BroadcastChannel 两条通路。
(() => {
  const $ = (id) => document.getElementById(id);
  const GHOST_ID = 'trae-bridge';
  const CHANNEL = 'trae-bridge-panel';
  // 唤醒地址必须用协议头 cindy-ghost://，不是 /wake 路径
  const WAKE_URL = 'cindy-ghost://' + GHOST_ID + '/wake';

  const pad = (n) => String(n).padStart(2, '0');
  function fmtTime(ms) {
    const n = Number(ms);
    if (!ms || !Number.isFinite(n)) return '—';
    const d = new Date(n);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtDuration(sec) {
    const n = Number(sec);
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n < 60) return `${Math.round(n)} 秒`;
    const m = Math.floor(n / 60);
    if (m < 60) return `${m} 分钟`;
    return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Token 打码：只露前 6 位与后 4 位，中间固定长度，别让长度也变成信息。
  function mask(t) {
    const s = String(t || '');
    if (s.length <= 12) return '••••••••';
    return s.slice(0, 6) + '••••••••' + s.slice(-4);
  }
  function copy(text) {
    return navigator.clipboard.writeText(String(text));
  }

  let channel = null;
  try { channel = new BroadcastChannel(CHANNEL); } catch { channel = null; }

  const pending = new Map();
  let lastStatus = null;
  let tokenShown = false;

  if (channel) {
    channel.onmessage = (event) => {
      const d = event && event.data;
      if (!d || d.__brain !== true) return;
      const resolve = pending.get(d.reqId);
      if (!resolve) return;
      pending.delete(d.reqId);
      resolve(d.value);
    };
  }

  /**
   * 递活给电子脑：先 /wake 叫醒，再按 reqId 每 400ms 重发，直到收到回执。
   * 电子脑侧按 reqId 去重，重复投递无害。
   */
  async function ask(action, timeoutMs = 12000) {
    if (!channel) return { error: '面板不支持 BroadcastChannel' };
    const reqId = action + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const p = new Promise((resolve) => pending.set(reqId, resolve));
    try { await fetch(WAKE_URL); } catch {}
    const payload = { __panel: true, reqId, action };
    const resend = setInterval(() => { try { channel.postMessage(payload); } catch {} }, 400);
    try { channel.postMessage(payload); } catch {}
    const timeout = new Promise((r) => setTimeout(() => r(null), timeoutMs));
    const value = await Promise.race([p, timeout]);
    clearInterval(resend);
    pending.delete(reqId);
    return value;
  }

  function quotaText(q) {
    if (!q || typeof q !== 'object') return '—';
    if (typeof q.total === 'number' && q.total > 0) {
      const used = typeof q.used === 'number' ? q.used : 0;
      const left = typeof q.remaining === 'number' ? q.remaining : (q.total - used);
      return `已用 ${used} / ${q.total}（剩余 ${left}）`;
    }
    if (typeof q.credits === 'number') return `${q.credits} 积分`;
    if (typeof q.balance === 'number') return `余额 ${q.balance}`;
    if (typeof q.remaining === 'number') return `剩余 ${q.remaining}`;
    if (typeof q.note === 'string' && q.note) return q.note;
    return '—';
  }

  function renderCheckin(ck) {
    const chip = $('ckState');
    if (!ck || typeof ck !== 'object') {
      chip.className = 'chip'; chip.textContent = '—'; return;
    }
    if (ck.enabled === false) {
      chip.className = 'chip'; chip.textContent = '暂无活动'; return;
    }
    if (ck.checkedIn === true) {
      chip.className = 'chip ok';
      chip.textContent = typeof ck.credits === 'number' ? `今天已签 · ${ck.credits} 积分` : '今天已签';
      return;
    }
    if (ck.checkedIn === false) {
      chip.className = 'chip warn';
      chip.textContent = typeof ck.credits === 'number' ? `可领 ${ck.credits} 积分` : '还没签，可以领';
      return;
    }
    chip.className = 'chip'; chip.textContent = '—';
  }

  function renderToken() {
    const t = lastStatus && lastStatus.token;
    $('token').textContent = t ? (tokenShown ? t : mask(t)) : '—';
    $('showToken').textContent = tokenShown ? '隐藏' : '显示';
  }

  function render(st) {
    if (!st || st.error) {
      $('dot').className = 'dot err';
      $('title').textContent = 'Trae 桥 · 连接失败';
      if (st && st.error) { $('err').hidden = false; $('err').textContent = st.error; }
      return;
    }
    lastStatus = st;

    const signedIn = st.signedIn === true;
    const expired = st.expired === true;
    $('dot').className = 'dot ' + (signedIn && !expired ? 'ok' : (signedIn ? 'warn' : 'err'));
    $('title').textContent = 'Trae 桥';

    const sign = $('signState');
    if (signedIn && !expired) { sign.className = 'chip ok'; sign.textContent = '已登录'; }
    else if (signedIn && expired) { sign.className = 'chip warn'; sign.textContent = '凭据已过期'; }
    else { sign.className = 'chip err'; sign.textContent = '未登录'; }

    // accountName 是 worker 的标准字段，user 是旧骨架留下的别名，两个都认。
    $('accountName').textContent = st.accountName || st.user || (signedIn ? '(已登录)' : '—');
    $('region').textContent = st.region ? String(st.region).toUpperCase() : '—';
    $('port').textContent = st.port || '—';
    $('modelCount').textContent = (st.modelCount || 0) + ' 个';
    // 额度是旧值时明确标出来，别让「上一次的数字」冒充「现在的数字」。
    $('quota').textContent = quotaText(st.quota) + (st.quota && st.quota.stale ? '（旧值）' : '');
    renderCheckin(st.checkin);
    $('uptime').textContent = st.ok === false ? '服务未起' : fmtDuration(st.uptimeSeconds);
    $('logFile').textContent = st.logFile || '—';

    const today = st.localUsage && st.localUsage.today;
    $('localUsage').textContent = today && today.requests > 0
      ? `今日 ${today.requests} 次 · ${today.tokens} tokens${typeof today.weighted === 'number' ? ` · 折算 ${Math.round(today.weighted)}` : ''}`
      : '今天还没用过';

    // hint 只在读不到凭据/过期时出现，别把正常状态也糊上一层提示。
    if (st.hint && (!signedIn || expired)) { $('hint').hidden = false; $('hint').textContent = st.hint; }
    else $('hint').hidden = true;

    if (st.lastError) { $('err').hidden = false; $('err').textContent = st.lastError; }
    else $('err').hidden = true;

    if (st.baseUrl) $('baseUrl').textContent = st.baseUrl;
    renderToken();

    const list = st.models || [];
    $('mcount').textContent = list.length ? `（${list.length}）` : '';
    $('models').innerHTML = list.length
      ? list.map((m) => `<div class="m"><span class="id">${esc(m.id)}</span>
          <span class="meta">${esc(m.name || '')} <span class="lab">${Math.round((m.contextWindow || 128000) / 1000)}K</span></span></div>`).join('')
      : '<div class="hint">还没有模型。确认已登录 Trae CN，然后点上面的「刷新」。</div>';
  }

  async function load() {
    const st = await ask('status');
    if (st === null) {
      $('dot').className = 'dot warn';
      $('title').textContent = 'Trae 桥 · 未响应';
      $('models').innerHTML = '<div class="hint">插件还没起来。稍等几秒会自动重试，或点「刷新」。</div>';
      return;
    }
    render(st);
  }

  $('refresh').addEventListener('click', async () => {
    const btn = $('refresh');
    btn.disabled = true; btn.textContent = '刷新中…';
    render(await ask('refresh', 30000));
    btn.disabled = false; btn.textContent = '刷新';
  });

  $('copyBase').addEventListener('click', async () => {
    const btn = $('copyBase');
    const url = lastStatus && lastStatus.baseUrl;
    if (!url) { btn.textContent = '读不到地址'; setTimeout(() => { btn.textContent = '复制 Base URL'; }, 1500); return; }
    try { await copy(url); btn.textContent = '已复制'; } catch { btn.textContent = '复制失败'; }
    setTimeout(() => { btn.textContent = '复制 Base URL'; }, 1500);
  });

  $('copyToken').addEventListener('click', async () => {
    const btn = $('copyToken');
    const t = lastStatus && lastStatus.token;
    if (!t) { btn.textContent = '读不到 Token'; setTimeout(() => { btn.textContent = '复制 Token'; }, 1500); return; }
    try { await copy(t); btn.textContent = '已复制'; } catch { btn.textContent = '复制失败'; }
    setTimeout(() => { btn.textContent = '复制 Token'; }, 1500);
  });

  $('showToken').addEventListener('click', () => {
    tokenShown = !tokenShown;
    renderToken();
  });

  $('checkin').addEventListener('click', async () => {
    const btn = $('checkin');
    btn.disabled = true; btn.textContent = '签到中…';
    const r = await ask('checkin', 30000);
    if (r && r.status) render(r.status);
    btn.textContent = r && r.message ? r.message : (r && r.error) ? ('失败：' + r.error) : '看不到结果';
    btn.disabled = false;
    setTimeout(() => { btn.textContent = '签到'; load(); }, 2500);
  });

  // 更新按钮只有一个处理器、按 updateMode 分支：以前在处理器里再赋 btn.onclick，
  // 两个处理器不会互相注销，「安装」态点一次会把检查和安装同时发出去并发跑。
  let updateMode = 'check';
  $('checkUpdate').addEventListener('click', async () => {
    const btn = $('checkUpdate');
    const msg = $('updateMsg');
    if (updateMode === 'install') {
      btn.disabled = true; btn.textContent = '安装中…';
      const a = await ask('applyUpdate', 120000);
      msg.textContent = (a && (a.message || a.error)) || '没拿到结果';
      btn.disabled = false; btn.textContent = '检查更新';
      updateMode = 'check';
      return;
    }
    btn.disabled = true; btn.textContent = '检查中…';
    const r = await ask('checkUpdate', 30000);
    btn.disabled = false; btn.textContent = '检查更新';
    if (!r || r.error) {
      msg.hidden = false;
      msg.textContent = `检查失败：${(r && r.error) || '没响应'}`;
      return;
    }
    msg.hidden = false;
    if (!r.hasUpdate) {
      msg.textContent = `已是最新版本（${r.current || '当前'}）。`;
      return;
    }
    // 有新版本就把按钮变成「安装」，点第二次才真的下 —— 装完进程会退出重启，不该被误触。
    msg.textContent = `发现新版本 ${r.latest}（当前 ${r.current}）。点「安装」由后台脚本替换，约 30 秒后生效。`;
    btn.textContent = '安装';
    updateMode = 'install';
  });

  load();
  setInterval(load, 15000);
})();
