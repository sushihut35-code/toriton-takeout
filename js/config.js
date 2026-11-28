// 鳥とん 持ち帰り注文 設定ファイル
// ★ お店の設定はここを書き換えるだけでOK
const CONFIG = {
  // LIFFアプリID(LINE Developers で発行済み)
  LIFF_ID: '2012786336-l5QRojPO',

  // 店舗名
  STORE_NAME: '鳥とん',

  // ── 受取時間(鳥とんの営業時間 15:00〜19:00) ──
  // ※注文フォームは24時間いつでも使える。受取時間だけこの範囲になる
  //   (営業時間外の注文は「次の営業日」の受取になる)
  OPEN_TIME: '15:00',
  CLOSE_TIME: '19:00',

  // ── その他の受取ルール ──
  PREP_MINUTES: 10,      // 営業時間中の注文で、受け取れるまでの最短時間(分)
  SLOT_MINUTES: 15,      // 受取時刻の選択肢の刻み(分)

  // ── 定休日 ──
  // 毎週の休み(0=日曜 1=月曜 2=火曜 3=水曜 4=木曜 5=金曜 6=土曜)
  // 例: 毎週月曜が休みなら [1]、火・水休みなら [2,3]
  WEEKLY_HOLIDAYS: [],
  // 臨時休業の特定日(半角で 'YYYY-MM-DD' の形式)
  // 例: ['2026-12-31', '2027-01-01']
  HOLIDAYS: [],

  // ── Web Push通知(ポケットでも無料で鳴る着信) ──
  // 公開鍵(これ自体は公開してよいもの・秘密鍵はSupabaseのシークレット)
  VAPID_PUBLIC_KEY:
    'BETH9QOzSpwX_CvfgpUI04rraZFaa5tEVgjezUOoUEwR7Q7SIeCHEyifjBevruc3JEAUT7TErnbog5_jnRHFrWE',

  // ── Supabase(接続済み・anonキーは公開用なのでこのままでOK) ──
  SUPABASE_URL: 'https://hsjylabnkkmwnsaehbxe.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_mqo8cSYvGcwPVqhgoHRK8w_p-I0bUan',
};
