// 鳥とん LINE自動応答 Webhook
// 役割: お客がトークで送ったメッセージを判定して、自動で返す
//   ・「メニュー」等      → 最新メニューを応答(DBのmenu_itemsから生成=常に最新)
//   ・「定休日/営業」等   → 休みと営業時間を応答(ボード設定と自動同期)
//   ・注文控え(LIFF自動送信) → 無視(二重返信防止)
//   ・その他              → 電話でのご案内を応答
//
// 必要なシークレット(Supabase管理画面で設定):
//   LINE_CHANNEL_ACCESS_TOKEN  Messaging APIのチャネルアクセストークン(長期)
//   LINE_CHANNEL_SECRET        チャネルシークレット(なりすまし防止の検証に使用)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
const CHANNEL_SECRET = Deno.env.get("LINE_CHANNEL_SECRET") ?? "";

const PHONE = "070-8953-7755";
const HOURS = "15:00〜19:00";
const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ── 署名検証(LINEからの正規の送信か確認。他人のいたずらPOSTを弾く) ──
async function verifySignature(req: Request, raw: string): Promise<boolean> {
  if (!CHANNEL_SECRET) {
    console.error("[webhook] LINE_CHANNEL_SECRET 未設定(検証を省略・要設定)");
    return true; // 設定されるまでは動かす(設定後は自動で厳格化)
  }
  const sig = req.headers.get("x-line-signature") ?? "";
  if (!sig) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(CHANNEL_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(raw)
  );
  const expect = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return sig === expect;
}

async function replyMessage(replyToken: string, text: string) {
  const r = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });
  if (!r.ok) {
    console.error("[webhook] reply失敗:", r.status, await r.text());
  }
}

// ── 最新メニューの文章生成(DBのmenu_itemsから) ──
async function menuText(): Promise<string> {
  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const { data } = await db
    .from("menu_items")
    .select("category,name,price,options")
    .eq("available", true)
    .order("sort_no");
  if (!data || data.length === 0) {
    return "ただいまメニューの準備をしております。しばらくお待ちください。";
  }
  const lines: string[] = [];
  let cat = "";
  for (const m of data) {
    if (m.category !== cat) {
      cat = m.category;
      lines.push(`【${cat}】`);
    }
    const opts = Array.isArray(m.options) && m.options.length > 0
      ? "(+" +
        m.options.map((o: any) => `${o.name}¥${Number(o.price)}`).join("/") +
        ")"
      : "";
    lines.push(`・${m.name} ¥${Number(m.price).toLocaleString()}${opts}`);
  }
  return (
    "🍗 鳥とんのメニューです\n" +
    lines.join("\n") +
    `\n\n📷 写真つきメニューはこちら\nhttps://sushihut35-code.github.io/toriton-takeout/menu.html` +
    `\n\nご注文は下の「注文する」からどうぞ♡\n(営業 ${HOURS}・注文は24時間受付)`
  );
}

// ── 定休日・営業時間の文章生成(ボード設定と自動同期) ──
async function holidayText(): Promise<string> {
  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const { data } = await db
    .from("shop_holidays")
    .select("kind,day_of_week,holiday_date");
  const weekly = (data ?? [])
    .filter((r: any) => r.kind === "weekly" && r.day_of_week != null)
    .map((r: any) => WEEKDAY[Number(r.day_of_week)])
    .join("・");
  const dates = (data ?? [])
    .filter((r: any) => r.kind === "date" && r.holiday_date)
    .map((r: any) => String(r.holiday_date))
    .sort();

  let t = `⏰ 営業時間 ${HOURS}\nご注文は24時間いつでも受け付けております`;
  if (weekly) t += `\n🗓 毎週の定休日: ${weekly}曜日`;
  if (dates.length > 0) t += `\n🌪 臨時休業: ${dates.join("・")}`;
  t += `\n\n📅 営業カレンダーはこちら\nhttps://sushihut35-code.github.io/toriton-takeout/calendar.html`;
  return t;
}

const FALLBACK =
  `お言葉ありがとうございます🍚\n` +
  `こちらのトークではご返信いたしかねます。\n` +
  `お問い合わせはお電話にてお願いいたします\n` +
  `☎ ${PHONE} (受付 ${HOURS})\n\n` +
  `ご注文は下の「注文する」からどうぞ♡`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return new Response("ok", { headers: CORS });

  const raw = await req.text();
  if (!(await verifySignature(req, raw))) {
    console.error("[webhook] 署名不一致(不正なPOSTを弾きました)");
    return new Response("ok");
  }

  let parsed: any = null;
  try {
    parsed = JSON.parse(raw);
  } catch (_e) {
    return new Response("ok");
  }

  for (const ev of parsed?.events ?? []) {
    // メッセージ以外(友だち追加・ブロック等)は無視
    if (ev.type !== "message" || ev.message?.type !== "text") continue;
    const text: string = String(ev.message.text ?? "");

    // 注文控え(LIFFが自動で送ったもの)は無視。二重返信の根治
    if (text.startsWith("ご注文ありがとうございます")) continue;

    try {
      if (/メニュー|料理|品物|食べ物|何がある/.test(text)) {
        await replyMessage(ev.replyToken, await menuText());
      } else if (/定休|休み|休業|営業|開いて|何時|close|open/i.test(text)) {
        await replyMessage(ev.replyToken, await holidayText());
      } else {
        await replyMessage(ev.replyToken, FALLBACK);
      }
    } catch (e) {
      console.error("[webhook] 応答エラー:", e);
    }
  }

  return new Response("ok", { headers: CORS });
});
