'use strict';

/* 鳥とん 営業カレンダー(お客様向け)
   ボードで設定した定休日・特別営業時間(Supabase)をそのまま表示する */

let calY, calM;
let holidayDates = new Set(); // 'YYYY-MM-DD'
let specialHours = new Map(); // 'YYYY-MM-DD' -> {open, close}
let loadFailed = false;

const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];
const $ = (id) => document.getElementById(id);

function isoOfMid(mid) {
  return (
    mid.getFullYear() + '-' +
    String(mid.getMonth() + 1).padStart(2, '0') + '-' +
    String(mid.getDate()).padStart(2, '0')
  );
}

async function loadData() {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY || !window.supabase) {
    loadFailed = true;
    return;
  }
  try {
    const db = window.supabase.createClient(
      CONFIG.SUPABASE_URL,
      CONFIG.SUPABASE_ANON_KEY
    );
    const [hRes, sRes] = await Promise.all([
      db.from('shop_holidays').select('kind,holiday_date'),
      db.from('special_hours').select('date,open_time,close_time'),
    ]);
    (hRes.data || []).forEach((r) => {
      if (r.kind === 'date' && r.holiday_date) {
        holidayDates.add(String(r.holiday_date));
      }
    });
    (sRes.data || []).forEach((r) => {
      if (r.date) {
        specialHours.set(String(r.date), { open: r.open_time, close: r.close_time });
      }
    });
  } catch (e) {
    loadFailed = true;
  }
}

function render() {
  if (calY === undefined) {
    const n = new Date();
    calY = n.getFullYear();
    calM = n.getMonth();
  }
  $('cal-title').textContent = calY + '年' + (calM + 1) + '月';

  const first = new Date(calY, calM, 1);
  const lastDay = new Date(calY, calM + 1, 0).getDate();
  const todayIso = isoOfMid(new Date());

  let html = DAY_NAMES.map((d) => `<div class="c-wd">${d}</div>`).join('');
  for (let i = 0; i < first.getDay(); i++) html += '<div></div>';
  const notes = [];
  for (let d = 1; d <= lastDay; d++) {
    const dt = new Date(calY, calM, d);
    const iso = isoOfMid(dt);
    const past = iso < todayIso;
    const closed = holidayDates.has(iso);
    const sp = specialHours.get(iso);
    const cls = ['c-day'];
    if (closed) cls.push('c-day--closed');
    else if (sp) cls.push('c-day--special');
    if (iso === todayIso) cls.push('c-day--today');
    if (past) cls.push('c-day--past');
    html += `<div class="${cls.join(' ')}" title="${
      closed ? '休業日' : sp ? `特別営業時間 ${sp.open}〜${sp.close}` : '通常営業 15:00〜19:00'
    }">${d}</div>`;

    if (!past) {
      const wd = DAY_NAMES[dt.getDay()];
      if (closed) notes.push(`🟥 ${calM + 1}/${d}(${wd}) 休業日`);
      else if (sp) notes.push(`🔵 ${calM + 1}/${d}(${wd}) ${sp.open}〜${sp.close} 営業`);
    }
  }
  $('cal-grid').innerHTML = html;

  if (loadFailed) {
    $('month-notes').innerHTML =
      '<div class="note-error">⚠️ 現在の休業情報を取得できませんでした。通常は 15:00〜19:00 の営業です。</div>';
  } else {
    $('month-notes').innerHTML = notes.length
      ? notes.map((t) => `<div class="note-row">${t}</div>`).join('')
      : '<div class="note-row note-none">この月は休業日の予定はありません(通常営業)</div>';
  }
}

$('cal-prev').addEventListener('click', () => {
  calM--;
  if (calM < 0) { calM = 11; calY--; }
  render();
});
$('cal-next').addEventListener('click', () => {
  calM++;
  if (calM > 11) { calM = 0; calY++; }
  render();
});

$('normal-hours').textContent = `${CONFIG.OPEN_TIME}〜${CONFIG.CLOSE_TIME}`;
loadData().then(render);
