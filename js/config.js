// 鳥とん 持ち帰り注文 設定ファイル
// ★ お店の設定はここを書き換えるだけでOK
const CONFIG = {
  // LIFFアプリID(LINE Developers で発行済み)
  LIFF_ID: '2012786336-l5QRojPO',

  // 店舗名
  STORE_NAME: '鳥とん',

  // ── 受付時間(鳥とんの実営業時間 15:00〜19:00) ──
  OPEN_TIME: '15:00',    // 開店(この時間より前の注文は開店後に受取)
  CLOSE_TIME: '19:00',   // 閉店(この時間を過ぎたら「本日の受付は終了しました」表示)

  // ── 受取時刻のルール ──
  PREP_MINUTES: 30,      // 注文してから受け取れるまでの最短時間(分)
  SLOT_MINUTES: 15,      // 受取時刻の選択肢の刻み(分)
  MAX_HOURS_AHEAD: 3,    // 何時間先まで受け付けるか

  // ── Supabase(プロジェクトを作ったら記入する) ──
  // URL例: https://xxxxxxxx.supabase.co
  // キー : Supabase「Project Settings → API」の anon public キー
  // ※anonキーは公開してよいキー(RLSで書き込みしか許可していない)
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
};
