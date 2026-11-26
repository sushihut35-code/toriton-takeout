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
let holidayWeekly = new Set(); // 毎週の定休(0=日..6=土)
let holidayDates = new Set(); // 臨時休業('YYYY-MM-DD')
let specialHours = new Map(); // 特別営業時間 'YYYY-MM-DD' -> {open, close}
let menuItems = [];           // メニュー一覧(Supabase)
let menuEditingId = null;     // 編集中のメニューID(null=新規追加)
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
function startOfDayLocal(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// ── 営業日判定(Supabaseの定休日設定を見る) ──
function isHoliday(mid) {
  const day = mid.getDay();
  if (holidayWeekly.has(day)) return true;
  const iso =
    mid.getFullYear() + '-' +
    String(mid.getMonth() + 1).padStart(2, '0') + '-' +
    String(mid.getDate()).padStart(2, '0');
  return holidayDates.has(iso);
}
function isoOfMid(mid) {
  return (
    mid.getFullYear() + '-' +
    String(mid.getMonth() + 1).padStart(2, '0') + '-' +
    String(mid.getDate()).padStart(2, '0')
  );
}
function atHM(mid, hm) {
  const [h, m] = hm.split(':').map(Number);
  return new Date(mid.getFullYear(), mid.getMonth(), mid.getDate(), h, m, 0, 0);
}
function nextBusinessDay(fromMid) {
  let d = new Date(fromMid.getTime());
  for (let i = 0; i < 30; i++) {
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    if (!isHoliday(d)) return d;
  }
  return null;
}
function dayLabel(mid) {
  const wd = ['日', '月', '火', '水', '木', '金', '土'][mid.getDay()];
  return (mid.getMonth() + 1) + '/' + mid.getDate() + '(' + wd + ')';
}

// 受取時刻のラベル(今日なら時刻のみ、それ以外は日付つき)
function dateSlotLabel(iso) {
  const hm = hmJST(iso);
  const d = startOfDayLocal(new Date(iso));
  const diff = Math.round((d - startOfToday()) / 86400000);
  if (diff === 0) return hm;
  if (diff === 1) return '明日 ' + hm;
  return dayLabel(d) + ' ' + hm;
}

// ある日の営業時間(特別営業時間があればそれ、無ければ通常)
function hoursFor(mid) {
  const s = specialHours.get(isoOfMid(mid));
  if (s) return { open: s.open, close: s.close };
  return { open: CONFIG.OPEN_TIME, close: CONFIG.CLOSE_TIME };
}

// チップを出す日(今日が営業日でまだ営業中なら今日、そうでなければ次の営業日)
function chipsDay() {
  const todayMid = startOfToday();
  if (
    !isHoliday(todayMid) &&
    Date.now() < atHM(todayMid, hoursFor(todayMid).close).getTime()
  ) {
    return todayMid;
  }
  return nextBusinessDay(todayMid) || todayMid;
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
  const [oRes, sRes, hRes, mRes, spRes] = await Promise.all([
    db.from('takeout_orders').select('*').gte('pickup_at', today).order('pickup_at'),
    db.from('pickup_slot_stops').select('slot_at').gte('slot_at', today),
    db.from('shop_holidays').select('kind,day_of_week,holiday_date'),
    db.from('menu_items').select('*').order('sort_no'),
    db.from('special_hours').select('*'),
  ]);
  orders = oRes.data || [];
  stops = new Set((sRes.data || []).map((r) => minuteKey(r.slot_at)));
  menuItems = mRes.data || [];
  specialHours = new Map();
  (spRes.data || []).forEach((r) => {
    if (r.date) {
      specialHours.set(String(r.date), { open: r.open_time, close: r.close_time });
    }
  });
  holidayWeekly = new Set();
  holidayDates = new Set();
  (hRes.data || []).forEach((r) => {
    if (r.kind === 'weekly' && r.day_of_week != null) {
      holidayWeekly.add(Number(r.day_of_week));
    }
    if (r.kind === 'date' && r.holiday_date) {
      holidayDates.add(String(r.holiday_date));
    }
  });
  renderSlots();
  renderHolidays();
  renderMenuPanel();
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

/* ── 時間帯チップ(今日、営業終了後は次の営業日) ── */
function daySlots(mid) {
  const out = [];
  const h = hoursFor(mid);
  const open = atHM(mid, h.open);
  const close = atHM(mid, h.close);
  const stepMs = CONFIG.SLOT_MINUTES * 60000;
  let t = open.getTime();
  while (t <= close.getTime()) {
    out.push(new Date(t));
    t += stepMs;
  }
  return out;
}
function renderSlots() {
  const day = chipsDay();
  const now = Date.now();
  // 見出しには日付と、停止中の時間帯があればその数を出す
  const stoppedCount = daySlots(day).filter(
    (d) => d.getTime() >= now && stops.has(minuteKey(d))
  ).length;
  $('chips-date').textContent =
    `受付時間帯 ${dayLabel(day)}` +
    (stoppedCount > 0 ? ` ─ 🛑${stoppedCount}コマ停止中` : '');
  $('slot-chips').innerHTML = daySlots(day)
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

/* ── 定休日・臨時休業パネル(カレンダー) ── */
let calY; // カレンダー表示中の年
let calM; // カレンダー表示中の月(0-11)

function renderHolidays() {
  renderCalendar();
  renderSpecialHours();

  // 「今日」の状態を専用ボタンとバナーに反映
  const todayIso = isoOfMid(startOfToday());
  const todayClosed = holidayDates.has(todayIso);
  const btn = $('today-holiday-btn');
  btn.textContent = todayClosed
    ? '✅ 今日の臨時休業を解除する'
    : '🌪 今日を臨時休業にする';
  btn.classList.toggle('btn-today-closure--on', todayClosed);
  $('closed-today-banner').hidden = !todayClosed;

  // 閉じたままでも分かるよう、見出しに現状の要約を表示
  const upcoming = [...holidayDates].filter((d) => d >= todayIso).sort();
  const parts = [];
  if (todayClosed) parts.push('⛔本日休業');
  if (upcoming.length > 0) parts.push(`休業 ${upcoming.length}日`);
  $('holiday-summary').textContent = parts.length
    ? '📅 定休日・臨時休業 ─ ' + parts.join(' / ')
    : '📅 定休日・臨時休業(未設定)';
}

function renderCalendar() {
  if (calY === undefined) {
    const n = new Date();
    calY = n.getFullYear();
    calM = n.getMonth();
  }
  $('cal-title').textContent = calY + '年' + (calM + 1) + '月';

  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  const first = new Date(calY, calM, 1);
  const lastDay = new Date(calY, calM + 1, 0).getDate();
  const todayIso = isoOfMid(startOfToday());

  let html = dayNames.map((d) => `<div class="cal-wd">${d}</div>`).join('');
  for (let i = 0; i < first.getDay(); i++) html += '<div></div>';
  for (let d = 1; d <= lastDay; d++) {
    const dt = new Date(calY, calM, d);
    const iso = isoOfMid(dt);
    const past = iso < todayIso;
    const isDate = holidayDates.has(iso);
    const isWk = holidayWeekly.has(dt.getDay());
    const cls = ['cal-day'];
    if (isDate) cls.push('cal-day--closed');
    else if (specialHours.has(iso)) cls.push('cal-day--special');
    else if (isWk) cls.push('cal-day--weekly');
    if (iso === todayIso) cls.push('cal-day--today');
    if (past) cls.push('cal-day--past');
    html +=
      `<div class="${cls.join(' ')}"` +
      (past ? '' : ` data-cal="${iso}"`) +
      `>${d}</div>`;
  }
  $('cal-grid').innerHTML = html;
}

// カレンダーの日付をタップ → 休業日ON/OFF
async function toggleDateHoliday(iso) {
  const action = holidayDates.has(iso)
    ? 'holiday_remove_date'
    : 'holiday_add_date';
  const { ok, data } = await callAction(action, { date: iso });
  if (!ok) {
    alert('休業日の変更に失敗しました: ' + (data.error || 'エラー'));
    return;
  }
  refresh();
}

/* ── 特別営業時間(年末年始など) ── */
function renderSpecialHours() {
  const todayIso = isoOfMid(startOfToday());
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  const rows = [...specialHours.entries()]
    .filter(([d]) => d >= todayIso)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  $('sh-list').innerHTML = rows.length
    ? rows
        .map(([d, h]) => {
          const dt = new Date(d + 'T00:00:00');
          const wd = dayNames[dt.getDay()];
          const label =
            `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}(${wd}) ` +
            `${h.open}〜${h.close}`;
          return `<span class="holiday-pill holiday-pill--blue">${label}<button data-shdel="${d}" aria-label="削除">×</button></span>`;
        })
        .join('')
    : '<span class="holiday-empty">特別営業時間の設定はありません(通常 15:00〜19:00)</span>';
}

async function saveSpecialHours() {
  const date = $('sh-date').value;
  const open = $('sh-open').value;
  const close = $('sh-close').value;
  if (!date || !open || !close) {
    alert('日付と開店・閉店の時刻をすべて入力してください');
    return;
  }
  if (open >= close) {
    alert('閉店時刻は開店時刻より後にしてください');
    return;
  }
  const { ok, data } = await callAction('special_hours_save', {
    date,
    open_time: open,
    close_time: close,
  });
  if (!ok) {
    alert('保存に失敗しました: ' + (data.error || 'エラー'));
    return;
  }
  $('sh-date').value = '';
  $('sh-open').value = '';
  $('sh-close').value = '';
  refresh();
}

async function deleteSpecialHours(dateIso) {
  const { ok, data } = await callAction('special_hours_delete', { date: dateIso });
  if (!ok) {
    alert('削除に失敗しました: ' + (data.error || 'エラー'));
    return;
  }
  refresh();
}

/* ── メニュー管理パネル ── */
function renderMenuPanel() {
  const cats = [];
  const map = new Map();
  menuItems.forEach((r) => {
    if (!map.has(r.category)) {
      map.set(r.category, []);
      cats.push(r.category);
    }
    map.get(r.category).push(r);
  });
  $('menu-panel').innerHTML = cats.length
    ? cats
        .map(
          (c) => `
      <div class="menu-cat">${esc(c)}</div>
      ${map
        .get(c)
        .map(
          (r) => `
      <div class="menu-row ${r.available ? '' : 'menu-row--off'}">
        <span class="menu-row__name">${esc(r.name)}</span>
        <span class="menu-row__price">¥${Number(r.price).toLocaleString()}</span>
        <button class="menu-chip ${r.available ? 'menu-chip--on' : 'menu-chip--off'}" data-mtoggle="${r.id}">${r.available ? '販売中' : '売り切れ'}</button>
        <button class="menu-chip" data-medit="${r.id}" title="編集">✏️</button>
        <button class="menu-chip" data-mdel="${r.id}" title="削除">🗑</button>
      </div>`
        )
        .join('')}`
        )
        .join('')
    : '<span class="holiday-empty">メニューがまだありません</span>';

  $('cat-list').innerHTML = cats
    .map((c) => `<option value="${esc(c)}"></option>`)
    .join('');
  $('menu-summary').textContent = `─ ${menuItems.length}品目`;
}

async function menuToggle(id) {
  const item = menuItems.find((m) => m.id === id);
  if (!item) return;
  const { ok, data } = await callAction('menu_toggle', {
    id,
    available: !item.available,
  });
  if (!ok) {
    alert('変更に失敗しました: ' + (data.error || 'エラー'));
    return;
  }
  refresh();
}

async function menuDelete(id) {
  const item = menuItems.find((m) => m.id === id);
  if (!item) return;
  if (!confirm(`「${item.name}」をメニューから削除します。よろしいですか?`)) return;
  const { ok, data } = await callAction('menu_delete', { id });
  if (!ok) {
    alert('削除に失敗しました: ' + (data.error || 'エラー'));
    return;
  }
  refresh();
}

function menuEdit(id) {
  const item = menuItems.find((m) => m.id === id);
  if (!item) return;
  menuEditingId = id;
  $('menu-cat').value = item.category;
  $('menu-name').value = item.name;
  $('menu-price').value = item.price;
  $('menu-save-btn').textContent = '更新';
  $('menu-cancel-btn').hidden = false;
  $('menu-details').open = true;
}

function menuEditReset() {
  menuEditingId = null;
  $('menu-cat').value = '';
  $('menu-name').value = '';
  $('menu-price').value = '';
  $('menu-save-btn').textContent = '追加';
  $('menu-cancel-btn').hidden = true;
}

async function menuSave() {
  const category = $('menu-cat').value.trim();
  const name = $('menu-name').value.trim();
  const price = Number($('menu-price').value);
  if (!category || !name || !Number.isInteger(price) || price <= 0) {
    alert('カテゴリ・品名・価格(半角数字)を入力してください');
    return;
  }
  const sortNo = menuItems.length
    ? Math.max(...menuItems.map((m) => Number(m.sort_no) || 0)) + 1
    : 1;
  const payload = menuEditingId
    ? { id: menuEditingId, category, name, price }
    : { category, name, price, sort_no: sortNo };
  const { ok, data } = await callAction('menu_save', payload);
  if (!ok) {
    alert('保存に失敗しました: ' + (data.error || 'エラー'));
    return;
  }
  menuEditReset();
  refresh();
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
  // 今日の残り + 次の営業日 + 注文の現在時刻(含まれていなければ)
  const stepMs = CONFIG.SLOT_MINUTES * 60000;
  const now = Date.now();
  const out = [];
  const pushDay = (mid) => {
    const h = hoursFor(mid);
    const open = atHM(mid, h.open);
    const close = atHM(mid, h.close);
    let t = open.getTime();
    while (t <= close.getTime()) {
      if (t >= now - 90 * 60000) out.push(new Date(t));
      t += stepMs;
    }
  };
  const todayMid = startOfToday();
  if (!isHoliday(todayMid)) pushDay(todayMid);
  const next = nextBusinessDay(todayMid);
  if (next) pushDay(next);

  const cur = new Date(currentIso);
  if (!out.some((d) => minuteKey(d) === minuteKey(cur))) out.unshift(cur);
  out.sort((a, b) => a - b);
  return out;
}

function cardHtml(o) {
  const opts = timeOptions(o.pickup_at)
    .map((d) => {
      const sel = minuteKey(d) === minuteKey(o.pickup_at) ? ' selected' : '';
      return `<option value="${d.toISOString()}"${sel}>${dateSlotLabel(d.toISOString())}</option>`;
    })
    .join('');
  const note = o.note ? `<div class="c-note">📝 ${esc(o.note)}</div>` : '';
  const tel = o.phone
    ? `<a class="c-tel" href="tel:${esc(o.phone)}">📞${esc(o.phone)}</a>`
    : '';

  if (o.status === 'new') {
    return `
    <div class="card card--new">
      <div class="c-head"><span class="c-no">#${o.id}</span><span class="c-time-now">希望 ${dateSlotLabel(o.pickup_at)}</span></div>
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
      <div class="c-head"><span class="c-no">#${o.id}</span><span class="c-time-now">受取 ${dateSlotLabel(o.pickup_at)}</span></div>
      <div class="c-name">${esc(o.customer_name)}${tel}</div>
      <div class="c-items">${itemsHtml(o)}</div>
      <div class="c-total">${totalLabel(o)}</div>
      ${note}
      <div class="c-act">
        <select class="c-time" data-time="${o.id}">${opts}</select>
        <button class="c-btn c-btn--ok" data-confirm="${o.id}">変更確定</button>
      </div>
    </div>`;
}

function renderOrders() {
  const groups = { new: [], accepted: [] };
  orders.forEach((o) => {
    if (o.status === 'new') groups.new.push(o);
    else if (o.status === 'accepted') groups.accepted.push(o);
  });
  groups.accepted.sort((a, b) => new Date(a.pickup_at) - new Date(b.pickup_at));

  $('orders-new').innerHTML = groups.new.map(cardHtml).join('');
  $('orders-new-empty').hidden = groups.new.length > 0;

  // 仮受付がある時は赤バナー+点滅、無い時は静かな小見出し
  $('new-banner').hidden = groups.new.length === 0;
  $('new-h2').hidden = groups.new.length > 0;
  $('new-count').textContent = `${groups.new.length}件`;

  $('orders-accepted').innerHTML = groups.accepted.map(cardHtml).join('');
  $('orders-accepted-empty').hidden = groups.accepted.length > 0;
  $('accepted-summary').textContent = groups.accepted.length
    ? `─ ${groups.accepted.length}件(受取時刻順)`
    : '';
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
  const t = ev.target.closest(
    '[data-confirm],[data-slot],[data-cal],[data-calnav],[data-mtoggle],[data-medit],[data-mdel],[data-shdel]'
  );
  if (!t) return;
  if (t.dataset.confirm) confirmOrder(Number(t.dataset.confirm));
  if (t.dataset.slot) toggleSlot(t.dataset.slot);
  if (t.dataset.cal) toggleDateHoliday(t.dataset.cal);
  if (t.dataset.calnav) {
    calM += Number(t.dataset.calnav);
    if (calM < 0) { calM = 11; calY--; }
    if (calM > 11) { calM = 0; calY++; }
    renderCalendar();
  }
  if (t.dataset.mtoggle) menuToggle(Number(t.dataset.mtoggle));
  if (t.dataset.medit) menuEdit(Number(t.dataset.medit));
  if (t.dataset.mdel) menuDelete(Number(t.dataset.mdel));
  if (t.dataset.shdel) deleteSpecialHours(t.dataset.shdel);
});
$('sh-save-btn').addEventListener('click', saveSpecialHours);
$('menu-save-btn').addEventListener('click', menuSave);
$('menu-cancel-btn').addEventListener('click', menuEditReset);

$('today-holiday-btn').addEventListener('click', () => {
  toggleDateHoliday(isoOfMid(startOfToday()));
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
