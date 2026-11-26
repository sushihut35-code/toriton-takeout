# 鳥とん 持ち帰り注文(LIFFアプリ + 受注ボード)

LINE公式アカウントのトーク画面から開く持ち帰り注文フォームと、
店のレジPCで常時表示する受注ボードのセット。ビルド不要の完全静的サイト。

## 仕組み

```
【お客】LINE → リッチメニュー「注文する」
   → LIFF注文フォーム(メニュー・希望受取時間・電話番号)
   → 注文がSupabaseへ(仮受付 / status=new)
        ↓ リアルタイム配信
【お店】board.html(レジPC常時表示)
   ├ 新規注文 → チャイムが確認するまで鳴り続ける
   ├ 時間を選んで「確定」(時間変更時だけお客のLINEへ自動通知)
   ├ 時間帯ストップ → お客の選択肢からその時間が消える
   └ 「受渡済✔」で完了へ
```

## ページ

| URL | 用途 |
|---|---|
| `/` (index.html) | お客用注文フォーム(LIFFで開く) |
| `/board.html` | 店用受注ボード(レジPCのブラウザで常時表示) |

## セットアップ手順(初回)

### 1. Supabase

1. [supabase.com](https://supabase.com) でプロジェクト作成(リージョン asia-pacific / Tokyo)
2. SQLエディタで `supabase.sql` を実行(テーブル・RLS・リアルタイム設定)
3. `js/config.js` に Project URL と anon(publishable)キーを記入

### 2. エッジファンクション(ボードの操作・LINE通知用)

1. Supabase管理画面 →「Edge Functions」→ 新規作成、名前は `board-action`
2. `supabase/functions/board-action/index.ts` の中身を貼り付けてDeploy
3. Project Settings → Edge Functions → Secrets に2つ登録:
   - `BOARD_PASSWORD` … ボードを開く時の合言葉(自分で決める)
   - `LINE_CHANNEL_ACCESS_TOKEN` … LINE Developers のチャネルアクセストークン(長期)

### 3. GitHub Pages

1. このリポジトリをpush → Settings → Pages で `main` / `/ (root)` を有効化
2. LINE Developers のLIFF設定でエンドポイントURLを
   `https://sushihut35-code.github.io/toriton-takeout/` に変更
3. LIFFのスコープに `chat_message.write` を追加(注文控えをトークへ送るため)

### 4. 運用開始

- レジPCのブラウザで `https://sushihut35-code.github.io/toriton-takeout/board.html`
  を開きっぱなしにする(F11で全画面表示がよい)
- 初回のみパスワード入力 → 「受付開始」クリックでチャイムが有効になる

## 日常の変更

- **値段・品揃え・売り切れ** → **受注ボードの「📝 メニュー管理」パネルから**
  (価格変更・項目追加・売り切れ切替。フォームに即反映。`js/menu.js` は予備)
- **営業時間・受取までの最短時間・刻み** → `js/config.js` を編集してpush
- **定休日・臨時休業** → **受注ボードの「📅 定休日・臨時休業」パネルから**
  (カレンダーで日付をタップ。「🌪今日を臨時休業にする」ボタンもあり)
- **忙しい時間帯** → ボードの時間帯チップをタップして受付停止(即フォームへ反映)

## 注文の受付について

- フォームは**24時間いつでも**利用可(閉店後の注文は次の営業日の受取になる)
- 受取時間は営業時間内のみ(既定 15:00〜19:00・config.js)
- 定休日はスキップして次の営業日を案内

## セキュリティメモ

- anon(publishable)キーは公開用。**注文のINSERTのみ**匿名で可能(金銭的リスクなし・支払いは店頭)
- **注文データ(名前・電話番号)の読み取りは外部から不可**:ボードは合言葉認証、
  リピーター自動入力はLINE本人確認つきエッジファンクション経由(v1.10)
- メニュー・定休日・営業時間などの店舗設定は公開情報として匿名読み取り可
- 写真ストレージは公開読み取り・書き込みは合言葉認証経由のみ
- チャネルアクセストークン・VAPID秘密鍵はSupabaseシークレットのみ(リポジトリに置かない)
- 推奨:BOARD_PASSWORDは12文字以上/Supabase・GitHub・LINEアカウントに2段階認証

## 次工程(未実装)

- POS- 連携(受渡済みをPOSの売上へ自動計上)
