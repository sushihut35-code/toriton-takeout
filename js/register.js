'use strict';

/* ============================================
   鳥とん レジ
   商品タップ → 合計 → お釣り計算 → 会計確定(sales_logへ記録)
   ※注文との紐付け・ポイント加算は次工程(v2.1)
   ============================================ */

const $ = (id) => document.getElementById(id);

let db = null;
let boardPassword = localStorage.getItem('toriton_board_pw') || '';
let menuItems = [];
const cart = new Map(); // id -> { name, price, qty }
let lastChange = 0;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

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

/* ── メニュー読み込み・描画 ── */
async function loadMenu() {
  const { data } = await db
    .from('menu_items')
    .select('id,category,name,price')
    .eq('available', true)
    .order('sort_no');
  menuItems = data || [];
  renderMenu();
}

function renderMenu() {
  const area = $('r-menu');
  if (menuItems.length === 0) {
    area.innerHTML = '<div class="r-cat">メニューが未登録です(受注ボードの📝メニュー管理で追加できます)</div>';
    return;
  }
  let html = '';
  let cat = '';
  for (const m of menuItems) {
    if (m.category !== cat) {
      cat = m.category;
      html += `<div class="r-cat">【${esc(cat)}】</div>`;
    }
    const c = cart.get(m.id);
    const badge = c ? `<span class="r-item__badge">×${c.qty}</span>` : '';
    const photo = `${CONFIG.SUPABASE_URL}/storage/v1/object/public/menu-photos/${m.id}.jpg`;
    html += `
    <button class="r-item" data-add="${m.id}">
      <img class="r-item__photo" src="${photo}" alt="" onerror="this.remove()">
      <span class="r-item__body"">
        <span class="r-item__name">${esc(m.name)}</span>
        <span class="r-item__price">¥${Number(m.price).toLocaleString()}</span>
      </span>
      ${badge}
    </button>`;
  }
  area.innerHTML = html;
}

/* ── カート ── */
function addToCart(id) {
  const m = menuItems.find((x) => x.id === id);
  if (!m) return;
  const cur = cart.get(id) || { name: m.name, price: Number(m.price), qty: 0 };
  cur.qty += 1;
  cart.set(id, cur);
  refreshCart();
}

function changeQty(id, delta) {
  const cur = cart.get(id);
  if (!cur) return;
  cur.qty += delta;
  if (cur.qty <= 0) cart.delete(id);
  refreshCart();
}

function cartTotal() {
  let n = 0;
  cart.forEach((i) => (n += i.price * i.qty));
  return n;
}

function refreshCart() {
  const el = $('r-cart');
  if (cart.size === 0) {
    el.innerHTML = '<div class="r-cart__empty">↓ 商品をタップすると入ります</div>';
  } else {
    el.innerHTML = [...cart.entries()]
      .map(([id, i]) => `
      <div class="r-row">
        <div class="r-row__name">${esc(i.name)}</div>
        <div class="r-row__qty">
          <button data-dec="${id}" aria-label="1つ減らす">−</button>
          <span>${i.qty}</span>
          <button data-inc="${id}" aria-label="1つ増やす">＋</button>
        </div>
        <div class="r-row__sum">¥${(i.price * i.qty).toLocaleString()}</div>
      </div>`)
      .join('');
  }
  $('r-total').textContent = `¥${cartTotal().toLocaleString()}`;
  $('checkout-btn').disabled = cart.size === 0;
  renderMenu(); // バッジの個数を更新
}

/* ── お会計 ── */
function openCheckout() {
  if (cart.size === 0) return;
  $('pay-total').textContent = `¥${cartTotal().toLocaleString()}`;
  $('pay-input').value = '';
  updateChange();
  $('pay-overlay').hidden = false;
}

function closeCheckout() {
  $('pay-overlay').hidden = true;
}

function updateChange() {
  const total = cartTotal();
  const raw = $('pay-input').value;
  const got = raw === '' ? null : Number(raw);
  const changeEl = $('pay-change');
  const doneBtn = $('pay-done');
  if (got === null) {
    changeEl.textContent = '¥−';
    changeEl.parentElement.classList.remove('r-change--ok');
    doneBtn.disabled = true;
    return;
  }
  const change = got - total;
  lastChange = change;
  changeEl.textContent = change < 0 ? '不足しています' : `¥${change.toLocaleString()}`;
  doneBtn.disabled = change < 0;
}

async function completeSale() {
  const btn = $('pay-done');
  btn.disabled = true;
  btn.textContent = '記録中…';
  const items = [...cart.values()].map((i) => ({ name: i.name, price: i.price, qty: i.qty }));
  const { ok, data } = await callAction('sale_record', {
    items,
    total: cartTotal(),
    payment: Number($('pay-input').value) || null,
  });
  if (!ok) {
    alert('会計の記録に失敗しました: ' + (data.error || 'エラー'));
    btn.disabled = false;
    btn.textContent = '会計を確定する';
    return;
  }
  closeCheckout();
  $('done-change').textContent = `¥${lastChange.toLocaleString()}`;
  $('done-toast').hidden = false;
  setTimeout(() => { $('done-toast').hidden = true; }, 1800);
  cart.clear();
  refreshCart();
  loadSales();
  btn.textContent = '会計を確定する';
}

/* ── 本日の売上表示 ── */
function startOfToday() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

async function loadSales() {
  const { ok, data } = await callAction('sales_today', {
    today: startOfToday().toISOString(),
  });
  if (!ok) return;
  $('sales-total').textContent = `¥${Number(data.total || 0).toLocaleString()}`;
  $('sales-count').textContent = `(${Number(data.count || 0)}件)`;
}

/* ── イベント配線 ── */
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-add],[data-inc],[data-dec],[data-pay]');
  if (!t) return;
  if (t.dataset.add) addToCart(Number(t.dataset.add));
  if (t.dataset.inc) changeQty(Number(t.dataset.inc), +1);
  if (t.dataset.dec) changeQty(Number(t.dataset.dec), -1);
  if (t.dataset.pay) {
    const v = t.dataset.pay;
    $('pay-input').value = v === 'exact' ? String(cartTotal()) : v;
    updateChange();
  }
});
$('checkout-btn').addEventListener('click', openCheckout);
$('pay-cancel').addEventListener('click', closeCheckout);
$('pay-done').addEventListener('click', completeSale);
$('pay-input').addEventListener('input', updateChange);
$('clear-btn').addEventListener('click', () => {
  if (cart.size === 0) return;
  if (confirm('カートを空にしますか？')) {
    cart.clear();
    refreshCart();
  }
});

/* ── ロック(ボードと同じ合言葉) ── */
async function tryUnlock(pw) {
  const prev = boardPassword;
  boardPassword = pw;
  const { ok } = await callAction('ping');
  if (!ok) {
    boardPassword = prev;
    return false;
  }
  localStorage.setItem('toriton_board_pw', pw);
  return true;
}

$('unlock-btn').addEventListener('click', async () => {
  const pw = $('pw-input').value;
  if (!pw) return;
  if (await tryUnlock(pw)) {
    $('lock').hidden = true;
    loadSales();
  } else {
    alert('パスワードが違います(ボードと同じ合言葉です)');
  }
});

/* ── 起動 ── */
(async function init() {
  db = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  if (boardPassword) {
    const { ok } = await callAction('ping');
    if (ok) {
      loadSales();
    } else {
      $('lock').hidden = false;
    }
  } else {
    $('lock').hidden = false;
  }
  loadMenu();
})();
