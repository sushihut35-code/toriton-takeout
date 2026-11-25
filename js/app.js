'use strict';

/* ============================================
   鳥とん 持ち帰り注文 LIFFアプリ
   メニュー表示 → カート → 受取時刻 → 注文確定
   ============================================ */

// ── 状態 ──
const cart = new Map();   // id -> { id, name, price, qty }
let profile = { displayName: '', userId: '' };
let stopMinutes = new Set(); // 店が受付停止した時間帯(分単位epoch)

// ── メニュー索引(カート操作用に id → 品目 を引けるようにする) ──
const ITEM_INDEX = new Map();
MENU.categories.forEach((cat) => {
  cat.items.forEach((it) => {
    if (it.variants) {
      it.variants.forEach((v) => {
        ITEM_INDEX.set(v.id, { name: `${it.name} ${v.label}`, price: v.price });
      });
    } else {
      ITEM_INDEX.set(it.id, { name: it.name, price: it.price });
    }
  });
});

const $ = (id) => document.getElementById(id);

/* ============================================
   LIFF 初期化
   ============================================ */
async function initLiff() {
  try {
    await liff.init({ liffId: CONFIG.LIFF_ID });
    if (liff.isLoggedIn()) {
      profile = await liff.getProfile().catch(() => profile);
    }
  } catch (e) {
    // file:// や未登録のドメインで開いた場合 → 確認用プレビューモード
    showBanner('プレビューモード — LINE内で開くと正式表示になります');
  }
  $('name-input').value = profile.displayName || '';
}

function showBanner(text) {
  const el = document.createElement('div');
  el.className = 'banner';
  el.textContent = text;
  document.body.prepend(el);
}

/* ============================================
   営業時間・受取時刻スロット
   ============================================ */
function hmDate(hm) {
  const [h, m] = hm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

// 受取時刻の選択肢一覧。営業時間外なら 'CLOSED' を返す
// ※stopMinutes(店による受付停止)に含まれる時間は除外
function getSlots() {
  const now = new Date();
  const open = hmDate(CONFIG.OPEN_TIME);
  const close = hmDate(CONFIG.CLOSE_TIME);
  if (now >= close) return 'CLOSED';

  const start = new Date(
    Math.max(now.getTime(), open.getTime()) + CONFIG.PREP_MINUTES * 60000
  );
  const stepMs = CONFIG.SLOT_MINUTES * 60000;
  let t = Math.ceil(start.getTime() / stepMs) * stepMs;
  const limit = Math.min(
    now.getTime() + CONFIG.MAX_HOURS_AHEAD * 3600000,
    close.getTime()
  );
  const out = [];
  while (t <= limit) {
    if (!stopMinutes.has(Math.floor(t / 60000))) out.push(new Date(t));
    t += stepMs;
  }
  return out.length ? out : 'CLOSED';
}

// 店が受付停止した時間帯をSupabaseから読み込む
async function loadStops() {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY || !window.supabase) return;
  try {
    const db = window.supabase.createClient(
      CONFIG.SUPABASE_URL,
      CONFIG.SUPABASE_ANON_KEY
    );
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const { data } = await db
      .from('pickup_slot_stops')
      .select('slot_at')
      .gte('slot_at', start.toISOString());
    (data || []).forEach((r) =>
      stopMinutes.add(Math.floor(new Date(r.slot_at).getTime() / 60000))
    );
  } catch (e) {
    // 読み込めなければ全スロットを出す(店側の故障で客を閉め出さない)
  }
}

function hmLabel(d) {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function labelFromIso(iso) {
  return hmLabel(new Date(iso));
}

function renderSlots() {
  const sel = $('pickup-select');
  const slots = getSlots();
  if (slots === 'CLOSED') {
    sel.innerHTML = '<option>本日受付終了</option>';
    return;
  }
  sel.innerHTML = slots
    .map((d) => `<option value="${d.toISOString()}">${hmLabel(d)}</option>`)
    .join('');
}

/* ============================================
   メニュー描画
   ============================================ */
function renderMenu() {
  const area = $('menu-area');
  if (getSlots() === 'CLOSED') {
    area.innerHTML = `
      <div class="closed">
        <div class="closed__emoji">🌙</div>
        <div class="closed__title">本日の注文受付は終了しました</div>
        <p class="closed__sub">受付時間 ${CONFIG.OPEN_TIME} 〜 ${CONFIG.CLOSE_TIME}</p>
      </div>`;
    return;
  }
  area.innerHTML = MENU.categories
    .map(
      (cat) => `
    <section class="category">
      <h2 class="category__name">${cat.emoji || ''}${cat.name}</h2>
      ${cat.items
        .map((item) =>
          item.variants
            ? `
      <div class="item item--variants">
        <div class="item__name">${item.name}</div>
        <div class="variants">
          ${item.variants
            .map(
              (v) => `
          <button class="variants__btn" data-add="${v.id}">
            <b>${v.label}</b><span>¥${v.price.toLocaleString()}</span>
          </button>`
            )
            .join('')}
        </div>
      </div>`
            : `
      <div class="item">
        <div class="item__main">
          <div class="item__name">${item.name}</div>
          <div class="item__price">¥${item.price.toLocaleString()}</div>
        </div>
        <button class="item__add" data-add="${item.id}" aria-label="${item.name}を追加">＋</button>
      </div>`
        )
        .join('')}
    </section>`
    )
    .join('');
}

/* ============================================
   カート
   ============================================ */
const MAX_QTY = 10;

function addToCart(id) {
  const item = ITEM_INDEX.get(id);
  if (!item) return;
  const cur = cart.get(id) || { id, name: item.name, price: item.price, qty: 0 };
  cur.qty = Math.min(cur.qty + 1, MAX_QTY);
  cart.set(id, cur);
  refreshCartUI();
}

function changeQty(id, delta) {
  const cur = cart.get(id);
  if (!cur) return;
  cur.qty += delta;
  if (cur.qty <= 0) cart.delete(id);
  refreshCartUI();
}

function cartCount() {
  let n = 0;
  cart.forEach((i) => (n += i.qty));
  return n;
}

function cartTotal() {
  let n = 0;
  cart.forEach((i) => (n += i.price * i.qty));
  return n;
}

function refreshCartUI() {
  const count = cartCount();
  $('cart-bar').hidden = count === 0;
  $('cart-count').textContent = `カート(${count}点)`;
  $('cart-total').textContent = `¥${cartTotal().toLocaleString()}`;
  renderCartRows();
}

function renderCartRows() {
  const el = $('cart-items');
  if (cart.size === 0) {
    el.innerHTML =
      '<div class="cart-empty">カートは空です</div>';
    $('sheet-total').textContent = '¥0';
    return;
  }
  el.innerHTML = [...cart.values()]
    .map(
      (i) => `
    <div class="cart-row">
      <div class="cart-row__name">${i.name}</div>
      <div class="cart-row__ctrl">
        <button data-dec="${i.id}" aria-label="1つ減らす">−</button>
        <span>${i.qty}</span>
        <button data-inc="${i.id}" aria-label="1つ増やす">＋</button>
      </div>
      <div class="cart-row__price">¥${(i.price * i.qty).toLocaleString()}</div>
    </div>`
    )
    .join('');
  $('sheet-total').textContent = `¥${cartTotal().toLocaleString()}`;
}

/* ============================================
   シート(注文確認・完了)
   ============================================ */
function openCart() {
  if (cart.size === 0) return;
  $('cart-backdrop').hidden = false;
  renderCartRows();
}

function closeCart() {
  $('cart-backdrop').hidden = true;
}

/* ============================================
   注文送信
   ============================================ */
async function submitOrder() {
  if (cart.size === 0) return;

  // 電話番号チェック(ハイフン・空白は除いて9〜15桁)
  const phoneDigits = ($('phone-input').value || '').replace(/[\s\-()]/g, '');
  if (!/^\d{9,15}$/.test(phoneDigits)) {
    alert('電話番号を入力してください(半角数字・ハイフンなしでもOKです)');
    return;
  }

  const btn = $('submit-btn');
  btn.disabled = true;
  btn.textContent = '送信中…';

  try {
    // Supabase設定チェック(未設定=デプロイ前の確認段階)
    if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY || !window.supabase) {
      alert(
        'サーバー設定がまだ完了していません。\n(お店側の準備が整い次第、ご利用いただけます)'
      );
      return;
    }

    const db = window.supabase.createClient(
      CONFIG.SUPABASE_URL,
      CONFIG.SUPABASE_ANON_KEY
    );

    const items = [...cart.values()].map((i) => ({
      name: i.name,
      price: i.price,
      qty: i.qty,
    }));
    const total = cartTotal();
    const pickupLabel = labelFromIso($('pickup-select').value);

    const order = {
      line_user_id: profile.userId || '',
      customer_name: $('name-input').value.trim() || '名前なし',
      phone: $('phone-input').value.trim() || null,
      pickup_at: new Date($('pickup-select').value).toISOString(),
      items,
      total,
      note: $('note-input').value.trim() || null,
    };

    const { data, error } = await db
      .from('takeout_orders')
      .insert(order)
      .select('id')
      .single();
    if (error) throw error;

    // 店主のLINEへ「新規注文」通知を送る(成否は注文自体に影響させない)
    fetch(`${CONFIG.SUPABASE_URL}/functions/v1/board-action`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'notify_owner', payload: { id: data.id } }),
    }).catch(() => {});

    // トーク画面へ控えを送る(chat_message.write スコープがあれば届く)
    try {
      if (typeof liff !== 'undefined' && liff.isInClient()) {
        await liff.sendMessages([
          {
            type: 'text',
            text:
              'ご注文ありがとうございます!\n' +
              `受付番号 #${data.id}\n` +
              `希望受取時間 ${pickupLabel} / 合計 ¥${total.toLocaleString()}\n` +
              '※混雑時は受取時間を調整のうえ、こちらのトークでご連絡いたします。\n' +
              '受取時にお名前をお伝えください。',
          },
        ]);
      }
    } catch (e) {
      /* スコープ未付与でも注文自体は完了している */
    }

    // 完了画面
    $('done-no').textContent = `#${data.id}`;
    $('done-time').textContent = pickupLabel;
    $('done-amount').textContent = `¥${total.toLocaleString()}`;
    cart.clear();
    refreshCartUI();
    closeCart();
    $('done-backdrop').hidden = false;
  } catch (e) {
    console.error(e);
    alert('注文の送信に失敗しました。電波の良い場所でもう一度お試しください。');
  } finally {
    btn.disabled = false;
    btn.textContent = '注文を確定する';
  }
}

/* ============================================
   イベント配線・起動
   ============================================ */
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-add],[data-inc],[data-dec]');
  if (!t) return;
  if (t.dataset.add) addToCart(t.dataset.add);
  if (t.dataset.inc) changeQty(t.dataset.inc, +1);
  if (t.dataset.dec) changeQty(t.dataset.dec, -1);
});

$('cart-bar-btn').addEventListener('click', openCart);
$('close-cart').addEventListener('click', closeCart);
$('submit-btn').addEventListener('click', submitOrder);
$('done-close').addEventListener('click', () => {
  $('done-backdrop').hidden = true;
});
// 背景タップで閉じる(注文確認シートのみ)
$('cart-backdrop').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeCart();
});

(async function init() {
  await initLiff();
  await loadStops();
  renderMenu();
  renderSlots();
  refreshCartUI();
})();
