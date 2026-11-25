'use strict';

/* ============================================
   鳥とん 受注ボード
   - リアルタイム受注表示 + チャイム(承認まで鳴り続ける)
   - 時間帯ストップ(お客の選択肢から消す)
   - 個別調整+確定(時間変更時だけLINE通知)
   ============================================ */

let db = null;
let boardPassword = localStorage.getItem('toriton_board_pw') || '';
let audioCtx = null;
let chiming = false;
let chimeTimer = null;
let orders = [];
let stops = new Set(); // 分単位のepochのセット
let refreshTimer = null;

const $ = (id) => document.getElementById(id);

/* ── 小物 ── */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function hmLabel(d) {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}
function hmJST(iso) {
  return new Date(iso).toLocaleTimeString('ja-JP', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tokyo',
  });
}
function hmDate(hm) {
  const [h, m] = hm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function minuteKey(t) {
  return Math.floor(new Date(t).getTime() / 60000);
}

/* ── チャイム(Web Audio・強化版:3連音・大音量) ── */
function beep() {
  const t0 = audioCtx.currentTime;
  const mk = (freq, start, dur, vol, type) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type || 'sine';
    o.frequency.value = freq;
    o.connect(g);
    g.connect(audioCtx.destination);
    g.gain.setValueAtTime(vol, t0 + start);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + start + dur);
    o.start(t0 + start);
    o.stop(t0 + start + dur);
  };
  mk(880, 0, 0.12, 0.9);          // ピッ
  mk(880, 0.18, 0.12, 0.9);       // ピッ
  mk(1175, 0.36, 0.4, 0.9, 'square'); // ピピー(高音・角波で目立たせる)
}
function startChime() {
  if (chiming || !audioCtx) return;
  chiming = true;
  const loop = () => {
    beep(); // 3連音
    chimeTimer = setTimeout(loop, 2000);
  };
  loop();
}
function stopChime() {
  chiming = false;
  clearTimeout(chimeTimer);
  $('chime-banner').hidden = true;
}

/* ── エッジファンクション呼び出し ── */
async function callAction(action, payload) {
  const r = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/board-action`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password: boardPassword, action, payload }),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, data };
}

/* ── データ取得 ── */
async function loadAll() {
  const today = startOfToday().toISOString();
  const [oRes, sRes] = await Promise.all([
    db.from('takeout_orders').select('*').gte('created_at', today).order('id'),
    db.from('pickup_slot_stops').select('slot_at').gte('slot_at', today),
  ]);
  orders = oRes.data || [];
  stops = new Set((sRes.data || []).map((r) => minuteKey(r.slot_at)));
  renderSlots();
  renderOrders();
  checkNewArrivals();
}

let refreshPending = false;
function refresh() {
  if (refreshPending) return; // 短時間に何回来ても1回にまとめる
  refreshPending = true;
  setTimeout(() => {
    refreshPending = false;
    loadAll().catch(() => {});
  }, 400);
}

/* ── 新規注文検知(見てないnewがあれば鳴る) ── */
let seenIds = new Set(JSON.parse(localStorage.getItem('toriton_seen') || '[]'));
function checkNewArrivals() {
  const unseen = orders.filter((o) => o.status === 'new' && !seenIds.has(o.id));
  if (unseen.length > 0) {
    $('chime-banner').hidden = false;
    startChime();
  }
}
function markSeen(ids) {
  ids.forEach((id) => seenIds.add(id));
  localStorage.setItem('toriton_seen', JSON.stringify([...seenIds]));
}

/* ── 時間帯チップ ── */
function todaySlots() {
  const out = [];
  const open = hmDate(CONFIG.OPEN_TIME);
  const close = hmDate(CONFIG.CLOSE_TIME);
  const stepMs = CONFIG.SLOT_MINUTES * 60000;
  let t = Math.ceil(open.getTime() / stepMs) * stepMs;
  while (t <= close.getTime()) {
    out.push(new Date(t));
    t += stepMs;
  }
  return out;
}
function renderSlots() {
  const now = Date.now();
  $('slot-chips').innerHTML = todaySlots()
    .map((d) => {
      const past = d.getTime() < now;
      const stopped = stops.has(minuteKey(d));
      const cls = [
        'chip',
        past ? 'chip--past' : '',
        stopped ? 'chip--stop' : '',
      ].join(' ');
      return `<button class="${cls}" data-slot="${d.toISOString()}" ${past ? 'disabled' : ''}>${hmLabel(d)}</button>`;
    })
    .join('');
}

/* ── 注文カード描画 ── */
function itemsHtml(o) {
  try {
    const arr = typeof o.items === 'string' ? JSON.parse(o.items) : o.items;
    return arr
      .map((i) => `<div class="oi">${i.qty}× ${esc(i.name)}</div>`)
      .join('');
  } catch (e) {
    return '';
  }
}
function totalLabel(o) {
  return `¥${Number(o.total || 0).toLocaleString()}`;
}

function timeOptions(currentIso) {
  // 現在〜閉店のスロット + 注文の現在時刻(含まれていなければ)
  const close = hmDate(CONFIG.CLOSE_TIME);
  const stepMs = CONFIG.SLOT_MINUTES * 60000;
  const from = Date.now() - 90 * 60000; // 少し前から(調整中の注文のため)
  const out = [];
  let t = Math.ceil(from / stepMs) * stepMs;
  while (t <= close.getTime()) {
    out.push(new Date(t));
    t += stepMs;
  }
  const cur = new Date(currentIso);
  if (!out.some((d) => minuteKey(d) === minuteKey(cur))) out.unshift(cur);
  out.sort((a, b) => a - b);
  return out;
}

function cardHtml(o) {
  const opts = timeOptions(o.pickup_at)
    .map((d) => {
      const sel = minuteKey(d) === minuteKey(o.pickup_at) ? ' selected' : '';
      return `<option value="${d.toISOString()}"${sel}>${hmLabel(d)}</option>`;
    })
    .join('');
  const note = o.note ? `<div class="c-note">📝 ${esc(o.note)}</div>` : '';
  const tel = o.phone
    ? `<a class="c-tel" href="tel:${esc(o.phone)}">📞${esc(o.phone)}</a>`
    : '';

  if (o.status === 'new') {
    return `
    <div class="card card--new">
      <div class="c-head"><span class="c-no">#${o.id}</span><span class="c-time-now">希望 ${hmJST(o.pickup_at)}</span></div>
      <div class="c-name">${esc(o.customer_name)}${tel}</div>
      <div class="c-items">${itemsHtml(o)}</div>
      <div class="c-total">${totalLabel(o)}</div>
      ${note}
      <div class="c-act">
        <select class="c-time" data-time="${o.id}">${opts}</select>
        <button class="c-btn c-btn--ok" data-confirm="${o.id}">この時間で確定</button>
      </div>
    </div>`;
  }
  // accepted
  return `
    <div class="card card--ok">
      <div class="c-head"><span class="c-no">#${o.id}</span><span class="c-time-now">受取 ${hmJST(o.pickup_at)}</span></div>
      <div class="c-name">${esc(o.customer_name)}${tel}</div>
      <div class="c-items">${itemsHtml(o)}</div>
      <div class="c-total">${totalLabel(o)}</div>
      ${note}
      <div class="c-act">
        <select class="c-time" data-time="${o.id}">${opts}</select>
        <button class="c-btn c-btn--ok" data-confirm="${o.id}">変更確定</button>
        <button class="c-btn c-btn--done" data-done="${o.id}">受渡済✔</button>
      </div>
    </div>`;
}

function renderOrders() {
  const groups = { new: [], accepted: [], done: [] };
  orders.forEach((o) => {
    (groups[o.status] || groups.done).push(o);
  });
  groups.accepted.sort((a, b) => new Date(a.pickup_at) - new Date(b.pickup_at));
  groups.done.sort((a, b) => new Date(a.pickup_at) - new Date(b.pickup_at));

  $('orders-new').innerHTML = groups.new.map(cardHtml).join('');
  $('orders-new-empty').hidden = groups.new.length > 0;
  $('orders-accepted').innerHTML = groups.accepted.map(cardHtml).join('');
  $('orders-accepted-empty').hidden = groups.accepted.length > 0;
  $('orders-done').innerHTML = groups.done
    .map(
      (o) =>
        `<div class="done-row"><b>#${o.id}</b> ${hmJST(o.pickup_at)} ${esc(o.customer_name)} ${totalLabel(o)}</div>`
    )
    .join('');
  $('orders-done-empty').hidden = groups.done.length > 0;
}

/* ── アクション ── */
async function confirmOrder(id) {
  const sel = document.querySelector(`select[data-time="${id}"]`);
  if (!sel) return;
  const btn = document.querySelector(`button[data-confirm="${id}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '送信中…'; }
  const { ok, data } = await callAction('confirm_order', {
    id,
    pickup_at: sel.value,
  });
  if (!ok) {
    alert('確定に失敗しました: ' + (data.error || 'エラー'));
    if (btn) { btn.disabled = false; btn.textContent = '確定'; }
    return;
  }
  markSeen([id]);
  refresh();
}

async function setDone(id) {
  const { ok, data } = await callAction('set_done', { id });
  if (!ok) {
    alert('更新に失敗しました: ' + (data.error || 'エラー'));
    return;
  }
  refresh();
}

async function toggleSlot(iso) {
  const stopped = stops.has(minuteKey(iso));
  const { ok, data } = await callAction(
    stopped ? 'slot_resume' : 'slot_stop',
    { slot_at: iso }
  );
  if (!ok) {
    alert('時間帯の変更に失敗しました: ' + (data.error || 'エラー'));
    return;
  }
  refresh();
}

/* ── イベント ── */
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-confirm],[data-done],[data-slot]');
  if (!t) return;
  if (t.dataset.confirm) confirmOrder(Number(t.dataset.confirm));
  if (t.dataset.done) setDone(Number(t.dataset.done));
  if (t.dataset.slot) toggleSlot(t.dataset.slot);
});

$('silence-btn').addEventListener('click', () => {
  stopChime();
  markSeen(orders.filter((o) => o.status === 'new').map((o) => o.id));
});

$('unlock-btn').addEventListener('click', async () => {
  const pw = $('pw-input').value;
  if (!pw) return;
  const prev = boardPassword;
  boardPassword = pw;
  const { ok, data } = await callAction('ping');
  if (!ok) {
    boardPassword = prev;
    alert('パスワードが違います(エッジファンクション未デプロイの場合も出ます)');
    return;
  }
  localStorage.setItem('toriton_board_pw', pw);
  $('lock').hidden = true;
  $('arm').hidden = false;
});

$('arm-btn').addEventListener('click', () => {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  $('arm').hidden = true;
  startBoard();
});

/* ── 起動 ── */
function startBoard() {
  db = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  loadAll().catch(() => {});

  // リアルタイム購読(変更があれば即リロード)
  db.channel('toriton-board')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'takeout_orders' },
      refresh
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'pickup_slot_stops' },
      refresh
    )
    .subscribe((status) => {
      const el = $('conn-status');
      if (status === 'SUBSCRIBED') {
        el.textContent = '● ライブ受信中';
        el.className = 'b-status b-status--live';
      } else {
        el.textContent = '○ 再接続中…';
        el.className = 'b-status';
      }
    });

  // 通信が切れた時の保険(20秒ポーリング)
  refreshTimer = setInterval(() => loadAll().catch(() => {}), 20000);
}

// 最初の入り口:パスワードがあるか?
if (!boardPassword) {
  $('lock').hidden = false;
} else {
  // パスワード保存済みでも、チャイムのためにクリックが必要
  $('arm').hidden = false;
}
