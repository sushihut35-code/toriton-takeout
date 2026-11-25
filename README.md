# 鳥とん 持ち帰り注文(LIFFアプリ)

LINE公式アカウントのトーク画面から開く、持ち帰り注文フォーム。
ビルド不要の完全静的サイト(GitHub Pages で運用)。

## 仕組み

```
客のLINE → リッチメニュー「注文する」
   → LIFF(このサイト)でメニュー選択・受取時刻を指定
   → 注文を Supabase の takeout_orders テーブルに書き込み
   → トークに控えメッセージを自動送信(liff.sendMessages / 無料)
   → 店は Supabase(将来:受注ボード)で注文を確認
```

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | 画面の骨組み |
| `js/config.js` | **お店の設定**(営業時間・LIFF ID・Supabase接続情報) |
| `js/menu.js` | **メニューデータ**(品揃え・値段) |
| `js/app.js` | 動き(LIFF初期化・カート・注文送信) |
| `css/style.css` | 見た目 |
| `supabase.sql` | Supabase 側のテーブル作成SQL |
| `.nojekyll` | GitHub Pages のおまじない(必須・触らない) |

## セットアップ手順(初回のみ)

1. **Supabaseプロジェクト作成** → SQLエディタで `supabase.sql` を実行
2. `js/config.js` に `SUPABASE_URL` / `SUPABASE_ANON_KEY` を記入
   (Project Settings → API の「Project URL」と「anon public」)
3. このリポジトリを GitHub へ push し、**Settings → Pages** で
   ブランチ `main` / フォルダ `/ (root)` から Pages を有効化
4. LINE Developers の LIFFアプリ設定で **エンドポイントURL** を
   `https://sushihut35-code.github.io/toriton-takeout/` に変更
5. スマホでLIFF URLを開いてテスト注文

### ついでに確認(LINE Developers)

- LIFFアプリの **スコープ** に `chat_message.write` を追加すると、
  注文後にトークへ控えが自動で届くようになる(任意だが推奨)
- LIFFの**サイズ**は「フル」推奨

## 日常の変更

- **値段・品揃えの変更** → `js/menu.js` を編集して push するだけ
- **営業時間・受取までの時間** → `js/config.js` を編集して push するだけ

## 次工程(未実装)

- `board.html` 受注ボード:Supabase をポーリング/Realtime購読し、
  新規注文が来たら**チャイムが承認まで鳴り続ける**画面。
  レジPCのブラウザで常時表示して使う
- POS- 連携(受渡済みをPOSの売上へ自動計上)はさらに先
