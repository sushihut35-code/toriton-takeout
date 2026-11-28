'use strict';

/* ============================================
   鳥とん 持ち帰り注文 LIFFアプリ
   メニュー表示 → カート → 受取時刻 → 注文確定
   ============================================ */

// ── 状態 ──
const cart = new Map();   // id -> { id, name, price, qty }
let profile = { displayName: '', userId: '' };
let stopMinutes = new Set(); // 店が受付停止した時間帯(分単位epoch)
let holidayWeekly = new Set(); // 毎週の定休(0=日..6=土)
let holidayDates = new Set(); // 臨時休業('YYYY-MM-DD')
let specialHours = new Map(); // 特別営業時間 'YYYY-MM-DD' -> {open, close}
let MENU_ROWS = null; // Supabaseのメニュー管理データ(nullならmenu.jsの予備を使う)

function isoOfMid(mid) {
  return (
    mid.getFullYear() + '-' +
    String(mid.getMonth() + 1).padStart(2, '0') + '-' +
    String(mid.getDate()).padStart(2, '0')
  );
}

// カテゴリー名 → 絵文字(見た目のお楽しみ。無ければ付かないだけ)
const CATEGORY_EMOJI = {
  '炭火焼き': '🔥',
  '手羽先唐揚げ': '🍗',
  'サイドメニュー': '🍟',
};

// 表示用のメニュー構造(DBがあればDBから、無ければmenu.jsから)
function normalizedMenu() {
  if (!MENU_ROWS) return MENU;
  const cats = [];
  const map = new Map();
  MENU_ROWS.forEach((r) => {
    if (!map.has(r.category)) {
      map.set(r.category, []);
      cats.push(r.category);
    }
    map.get(r.category).push({
      id: 'db-' + r.id,
      name: r.name,
      price: r.price,
      options: Array.isArray(r.options) ? r.options : [],
    });
  });
  return {
    categories: cats.map((c) => ({
      id: c,
      name: c,
      emoji: CATEGORY_EMOJI[c] || '',
      items: map.get(c),
    })),
  };
}

// ボードでメニューを読み込む(読めなければmenu.jsの予備へ)
async function loadMenu() {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY || !window.supabase) return;
  try {
    const db = window.supabase.createClient(
      CONFIG.SUPABASE_URL,
      CONFIG.SUPABASE_ANON_KEY
    );
    const { data } = await db
      .from('menu_items')
      .select('*')
      .eq('available', true)
      .order('sort_no');
    if (data && data.length) MENU_ROWS = data;
  } catch (e) {
    // 読み取り失敗時はmenu.jsを使用
  }
}

// ── メニュー索引(カート操作用に id → 品目 を引けるようにする) ──
const ITEM_INDEX = new Map();
function buildItemIndex() {
  ITEM_INDEX.clear();
  normalizedMenu().categories.forEach((cat) => {
    cat.items.forEach((it) => {
      if (it.variants) {
        it.variants.forEach((v) => {
          ITEM_INDEX.set(v.id, { name: `${it.name} ${v.label}`, price: v.price });
        });
      } else {
        ITEM_INDEX.set(it.id, { name: it.name, price: it.price });
        // オプション品(例: 豚もも炭火焼き+柚子胡椒)は別の品目として扱う
        (it.options || []).forEach((o) => {
          ITEM_INDEX.set(`${it.id}|${o.name}`, {
            name: `${it.name}(${o.name})`,
            price: it.price + Number(o.price),
          });
        });
      }
    });
  });
}
buildItemIndex();

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
function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// その日は休みか(ボードで設定した定休・臨時休業を見る)
function isHoliday(dateAtMidnight) {
  const day = dateAtMidnight.getDay();
  if (holidayWeekly.has(day)) return true;
  const iso =
    dateAtMidnight.getFullYear() + '-' +
    String(dateAtMidnight.getMonth() + 1).padStart(2, '0') + '-' +
    String(dateAtMidnight.getDate()).padStart(2, '0');
  return holidayDates.has(iso);
}

function atHM(dateAtMidnight, hm) {
  const [h, m] = hm.split(':').map(Number);
  return new Date(
    dateAtMidnight.getFullYear(),
    dateAtMidnight.getMonth(),
    dateAtMidnight.getDate(),
    h, m, 0, 0
  );
}

// 次の営業日(深夜0時のDate)。30日先まで探して無ければ null
function nextBusinessDay(fromMidnight) {
  let d = new Date(fromMidnight.getTime());
  for (let i = 0; i < 30; i++) {
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    if (!isHoliday(d)) return d;
  }
  return null;
}

// 特別営業時間をSupabaseから読み込む(読めなければ通常時間のまま)
async function loadSpecialHours() {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY || !window.supabase) return;
  try {
    const db = window.supabase.createClient(
      CONFIG.SUPABASE_URL,
      CONFIG.SUPABASE_ANON_KEY
    );
    const { data } = await db.from('special_hours').select('date,open_time,close_time');
    (data || []).forEach((r) => {
      if (r.date) {
        specialHours.set(String(r.date), { open: r.open_time, close: r.close_time });
      }
    });
  } catch (e) {
    // 読み取り失敗時は config.js の通常時間を使用
  }
}

// ある日の営業時間(特別営業時間があればそれ、無ければ通常)
function hoursFor(mid) {
  const s = specialHours.get(isoOfMid(mid));
  if (s) return { open: s.open, close: s.close };
  return { open: CONFIG.OPEN_TIME, close: CONFIG.CLOSE_TIME };
}

// 受取可能なスロット一覧(注文は24時間OK・受取は営業時間内・定休日はスキップ)
function getSlots() {
  const now = new Date();
  const stepMs = CONFIG.SLOT_MINUTES * 60000;
  const out = [];

  // 今日:営業日でまだ閉店前なら、これからの分だけ
  const todayMid = startOfDay(now);
  if (!isHoliday(todayMid)) {
    const h = hoursFor(todayMid);
    const open = atHM(todayMid, h.open);
    const close = atHM(todayMid, h.close);
    if (now.getTime() < close.getTime()) {
      const start = new Date(
        Math.max(now.getTime(), open.getTime()) + CONFIG.PREP_MINUTES * 60000
      );
      let t = Math.ceil(start.getTime() / stepMs) * stepMs;
      while (t <= close.getTime()) {
        out.push(new Date(t));
        t += stepMs;
      }
    }
  }

  // 今日の受取がもう無理(夜間・休み)→ 次の営業日まるごと
  if (out.length === 0) {
    const next = nextBusinessDay(todayMid);
    if (next) {
      const h = hoursFor(next);
      const open = atHM(next, h.open);
      const close = atHM(next, h.close);
      let t = open.getTime();
      while (t <= close.getTime()) {
        out.push(new Date(t));
        t += stepMs;
      }
    }
  }

  // 店が受付停止した時間帯は除く
  return out.filter((d) => !stopMinutes.has(Math.floor(d.getTime() / 60000)));
}

// 選択肢のラベル(今日は時刻のみ、それ以外は日付つき)
function slotLabel(d) {
  const hm = hmLabel(d);
  const todayMid = startOfDay(new Date());
  const diff = Math.round((startOfDay(d) - todayMid) / 86400000);
  if (diff === 0) return hm;
  if (diff === 1) return '明日 ' + hm;
  if (diff === 2) return '明後日 ' + hm;
  const wd = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return (d.getMonth() + 1) + '/' + d.getDate() + '(' + wd + ') ' + hm;
}

// 定休日・臨時休業をSupabaseから読み込む(読めなければconfig.jsの値を予備に使う)
async function loadHolidays() {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_ANON_KEY || !window.supabase) {
    holidayWeekly = new Set(CONFIG.WEEKLY_HOLIDAYS || []);
    holidayDates = new Set(CONFIG.HOLIDAYS || []);
    return;
  }
  try {
    const db = window.supabase.createClient(
      CONFIG.SUPABASE_URL,
      CONFIG.SUPABASE_ANON_KEY
    );
    const { data } = await db.from('shop_holidays').select('kind,day_of_week,holiday_date');
    (data || []).forEach((r) => {
      if (r.kind === 'weekly' && r.day_of_week != null) {
        holidayWeekly.add(Number(r.day_of_week));
      }
      if (r.kind === 'date' && r.holiday_date) {
        holidayDates.add(String(r.holiday_date));
      }
    });
  } catch (e) {
    holidayWeekly = new Set(CONFIG.WEEKLY_HOLIDAYS || []);
    holidayDates = new Set(CONFIG.HOLIDAYS || []);
  }
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
  return slotLabel(new Date(iso));
}

function renderSlots() {
  const sel = $('pickup-select');
  sel.innerHTML = getSlots()
    .map((d) => `<option value="${d.toISOString()}">${slotLabel(d)}</option>`)
    .join('');
}

/* ============================================
   メニュー描画(24時間いつでも注文可)
   ============================================ */

// 品目カードの写真スロット
// ①Supabaseストレージ(ボード📷で差し替えた最新)→ ②photos/{ID}.jpg(予備)→ ③非表示
function photoTag(id) {
  if (!id || !id.startsWith('db-')) return '';
  const num = id.slice(3);
  const sb = `${CONFIG.SUPABASE_URL}/storage/v1/object/public/menu-photos/${num}.jpg`;
  return `<img class="item__photo" src="${sb}" alt="" onerror="if(this.dataset.fb!=='1'){this.dataset.fb='1';this.src='photos/${num}.jpg';}else{this.remove()}">`;
}

// 品目カードの右側:入ってなければ＋ボタン、入ってれば [− 数 ＋] カウンター
function qtyControl(id) {
  const cur = cart.get(id);
  if (!cur) {
    return `<button class="item__add" data-add="${id}" aria-label="1つ追加">＋</button>`;
  }
  return `
    <div class="stepper">
      <button class="stepper__btn" data-dec="${id}" aria-label="1つ減らす">−</button>
      <span class="stepper__num">${cur.qty}</span>
      <button class="stepper__btn" data-inc="${id}" aria-label="1つ増やす">＋</button>
    </div>`;
}

function renderMenu() {
  const area = $('menu-area');
  const menu = normalizedMenu();
  area.innerHTML = menu.categories
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
            .map((v) => {
              const c = cart.get(v.id);
              return `
          <button class="variants__btn" data-add="${v.id}">
            <b>${v.label}</b><span>¥${v.price.toLocaleString()}${c ? ` ×${c.qty}` : ''}</span>
          </button>`;
            })
            .join('')}
        </div>
      </div>`
            : `
      <div class="item">
        ${photoTag(item.id)}
        <div class="item__main">
          <div class="item__name">${item.name}</div>
          <div class="item__price">¥${item.price.toLocaleString()}</div>
        </div>
        ${qtyControl(item.id)}
      </div>
      ${(item.options || [])
        .map(
          (opt) => `
      <div class="item item--option">
        <div class="item__main">
          <div class="item__name">└ ${opt.name}付き <span class="option-price">+¥${Number(opt.price).toLocaleString()}</span></div>
        </div>
        ${qtyControl(item.id + '|' + opt.name)}
      </div>`
        )
        .join('')}`
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
  renderMenu(); // カード上の個数カウンターも更新
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

  // 混雑時の時間調整へのお同意確認
  if (!$('agree-time') || !$('agree-time').checked) {
    alert(
      'ご注文の前に、受取時間が前後する場合がある旨の同意チェックをお願いいたします'
    );
    return;
  }

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
    };

    // 注文を預ける(v1.10で匿名selectを閉じたため受領書は返らない。成否だけ見る)
    const { error } = await db.from('takeout_orders').insert(order);
    if (error) throw error;

    // 店主のLINEへ「新規注文」通知を送る(成否は注文自体に影響させない)
    // ※idが返らないため、LINEユーザーIDで最新注文を探してもらう
    fetch(`${CONFIG.SUPABASE_URL}/functions/v1/board-action`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'notify_owner',
        payload: { line_user_id: order.line_user_id },
      }),
    }).catch(() => {});

    // トーク画面へ控えを送る(chat_message.write スコープがあれば届く)
    try {
      if (typeof liff !== 'undefined' && liff.isInClient()) {
        await liff.sendMessages([
          {
            type: 'text',
            text:
              'ご注文ありがとうございます!\n' +
              `希望受取時間 ${pickupLabel} / 合計 ¥${total.toLocaleString()}\n` +
              '※混雑時は受取時間を調整のうえ、こちらのトークでご連絡いたします。\n' +
              '受取時にお名前をお伝えください。',
          },
        ]);
      }
    } catch (e) {
      /* スコープ未付与でも注文自体は完了している */
    }

    // 次回のためにこの端末へお名前・電話を覚えさせておく
    try {
      localStorage.setItem(
        'toriton_customer',
        JSON.stringify({
          name: $('name-input').value.trim(),
          phone: $('phone-input').value.trim(),
        })
      );
    } catch (e) { /* 保存できなくても注文には影響なし */ }

    // 完了画面
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

// ── リピーター対策:お名前・電話番号の自動入力 ──
// ①この端末で前回使った情報(端末内メモ)
// ②LINE本人確認つきの裏口から自分の前回注文(端末が変わっても効く)
async function prefillCustomerInfo() {
  try {
    const saved = JSON.parse(localStorage.getItem('toriton_customer') || 'null');
    if (saved) {
      if (saved.name) $('name-input').value = saved.name;
      if (saved.phone) $('phone-input').value = saved.phone;
    }
  } catch (e) { /* メモが壊れていれば無視 */ }

  if (!profile.userId || !CONFIG.SUPABASE_URL || !window.supabase) return;
  try {
    let accessToken = null;
    try {
      if (typeof liff !== 'undefined' && liff.isLoggedIn()) {
        accessToken = liff.getAccessToken();
      }
    } catch (e) { /* トークンが取れなければ端末内メモのみ */ }
    if (!accessToken) return;

    const r = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/board-action`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'my_last_order',
        payload: { access_token: accessToken },
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (data && data.name) $('name-input').value = data.name;
    if (data && data.phone) $('phone-input').value = data.phone;
  } catch (e) {
    // 取れなければ今入っている値のまま
  }
}

(async function init() {
  await initLiff();
  await Promise.all([
    loadStops(),
    loadHolidays(),
    loadSpecialHours(),
    loadMenu(),
    prefillCustomerInfo(),
  ]);
  buildItemIndex();
  renderMenu();
  renderSlots();
  refreshCartUI();
})();
