'use strict';

/* 鳥とん メニュー一覧(お客様向け・見る専用)
   Supabaseのメニューをそのまま表示。写真は photos/{品目ID}.jpg を置くと自動で出る */

const LIFF_URL = 'https://liff.line.me/2012786336-l5QRojPO';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function loadMenu() {
  const list = document.getElementById('menu-list');
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY || !window.supabase) {
    list.innerHTML = '<div class="m-loading">メニューを読み込めませんでした。</div>';
    return;
  }
  let rows;
  try {
    const db = window.supabase.createClient(
      CONFIG.SUPABASE_URL,
      CONFIG.SUPABASE_ANON_KEY
    );
    const res = await db.from('menu_items').select('*').order('sort_no');
    rows = res.data || [];
  } catch (e) {
    list.innerHTML = '<div class="m-loading">メニューを読み込めませんでした。</div>';
    return;
  }

  // カテゴリ順に整理(初登場順)
  const cats = [];
  const map = new Map();
  rows.forEach((r) => {
    if (!map.has(r.category)) {
      map.set(r.category, []);
      cats.push(r.category);
    }
    map.get(r.category).push(r);
  });

  list.innerHTML = cats
    .map((c) => {
      const items = map
        .get(c)
        .map((r) => {
          const opts = (Array.isArray(r.options) ? r.options : [])
            .map(
              (o) =>
                `<div class="m-opt">└ ${esc(o.name)} +¥${Number(o.price).toLocaleString()}</div>`
            )
            .join('');
          const soldOut = r.available ? '' : '<span class="m-soldout">売り切れ</span>';
          const sb = `${CONFIG.SUPABASE_URL}/storage/v1/object/public/menu-photos/${r.id}.jpg`;
          return `
      <div class="m-card ${r.available ? '' : 'm-card--off'}">
        <div class="m-photo-slot"><img src="${sb}" alt="${esc(r.name)}" onerror="if(this.dataset.fb!=='1'){this.dataset.fb='1';this.src='photos/${r.id}.jpg';}else{this.parentElement.remove()}"></div>
        <div class="m-body">
          <div class="m-name">${esc(r.name)}${soldOut}</div>
          <div class="m-price">¥${Number(r.price).toLocaleString()}</div>
          ${opts}
        </div>
      </div>`;
        })
        .join('');
      return `<h2 class="m-cat">${esc(c)}</h2>${items}`;
    })
    .join('');
}
loadMenu();

// 写真タップで拡大(もう一度タップで閉じる)
document.addEventListener('click', (ev) => {
  const thumb = ev.target.closest('.m-photo-slot img');
  if (thumb) {
    document.getElementById('lightbox-img').src = thumb.getAttribute('src');
    document.getElementById('lightbox').hidden = false;
    return;
  }
  if (ev.target.closest('#lightbox')) {
    document.getElementById('lightbox').hidden = true;
  }
});
