// 鳥とん 受注ボード用 エッジファンクション「board-action」
// 役割:
//   1) 新規注文を店主のLINEへ即プッシュ通知(スマホ完結運用)
//   2) パスワード認証つきで注文の確定・受渡済み・時間帯ストップを処理
//   3) 時間変更を伴う確定の時だけお客のLINEへ調整通知
//
// 必要なシークレット(Supabase管理画面で設定):
//   OWNER_LINE_USER_ID          店主のLINEユーザーID(Ufdeb... 形式)
//   LINE_CHANNEL_ACCESS_TOKEN   LINE Developersのチャネルアクセストークン(長期)
//   BOARD_PASSWORD              ボードを開く時の合言葉(自分で決める)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOARD_URL = "https://sushihut35-code.github.io/toriton-takeout/board.html";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function hmJST(iso: string): string {
  return new Date(iso).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Tokyo",
  });
}

// 受取時刻のラベル(今日なら時刻のみ、それ以外は日付つき)
function pickupLabelJST(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const hm = hmJST(iso);
  const fmt = (x: Date) =>
    x.toLocaleDateString("ja-JP", {
      timeZone: "Asia/Tokyo",
      month: "numeric",
      day: "numeric",
    });
  if (fmt(d) === fmt(now)) return hm;
  const wd = d.toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo",
    weekday: "short",
  });
  return `${fmt(d)}(${wd}) ${hm}`;
}

async function linePush(token: string, to: string, text: string) {
  if (!token || !to) return false;
  try {
    const r = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
    });
    return r.ok;
  } catch (_e) {
    return false; // 通知失敗してもDBの更新は取り消さない
  }
}

// ── Web Push(無料の着信通知) ──
// VAPID鍵。公開鍵はコードに埋め込み、秘密鍵だけSupabaseシークレット(VAPID_PRIVATE_KEY)。
const VAPID_PUBLIC =
  "BETH9QOzSpwX_CvfgpUI04rraZFaa5tEVgjezUOoUEwR7Q7SIeCHEyifjBevruc3JEAUT7TErnbog5_jnRHFrWE";
const VAPID_SUBJECT = "mailto:toriton@sushihut35-code.github.io";

/* eslint-ignore deno-lint */
let webpushLib: any = null;
let webpushTried = false;
async function getWebPush(): Promise<any> {
  if (webpushTried) return webpushLib;
  webpushTried = true;
  try {
    // 貼り付け事故対策:空白・改行・引用符・"Value:"等の前置き・末尾の=を掃除
    const privRaw = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
    const priv = privRaw
      .replace(/[\s"'`]/g, "")
      .replace(/^(Value:|VAPID_PRIVATE_KEY[=:]?)/i, "")
      .replace(/=+$/, "");
    if (!priv) {
      console.error("[push] VAPID_PRIVATE_KEY が未設定(LINE予備のみで動作)");
      return null;
    }
    const mod: any = await import("npm:web-push@3.6.7");
    const wp = mod.default ?? mod;
    wp.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, priv);
    webpushLib = wp;
    console.log("[push] web-pushライブラリの読み込みOK");
  } catch (e) {
    console.error("[push] web-pushの初期化に失敗:", e);
    webpushLib = null; // ライブラリが動かない環境でもLINEで凌ぐ
  }
  return webpushLib;
}

// 登録済みの全端末へWeb Push。送れた通数を返す(0=届く端末なし)
async function webPushAll(
  db: any,
  title: string,
  body: string,
  tag: string
): Promise<number> {
  const wp = await getWebPush();
  if (!wp) return 0;
  const { data: subs, error: subsErr } = await db
    .from("push_subs")
    .select("endpoint,p256dh,auth");
  if (subsErr) {
    console.error("[push] push_subsの読み取り失敗:", subsErr.message);
    return 0;
  }
  console.log(`[push] 登録端末=${(subs ?? []).length}件`);
  let sent = 0;
  for (const s of subs ?? []) {
    try {
      await wp.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title, body, tag, url: BOARD_URL }),
        { TTL: 300 }
      );
      sent++;
    } catch (e: any) {
      console.error(
        "[push] 送信失敗:",
        (e && e.statusCode) || "",
        (e && (e.body || e.message)) || e
      );
      const code = e && e.statusCode;
      if (code === 404 || code === 410) {
        // 通知登録が古い端末は自動掃除
        await db.from("push_subs").delete().eq("endpoint", s.endpoint);
      }
    }
  }
  console.log(`[push] 送信OK=${sent}件 / ${title}`);
  return sent;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const body = await req.json().catch(() => ({}));
  const password = String(body.password ?? "");
  const action = String(body.action ?? "");
  const payload = body.payload ?? {};

  const token = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";

  // notify_owner / nag_unconfirmed は注文フォームやcronから呼ぶためパスワード不要。
  // いたずら対策は action 側で行う(新規注文のみ・再通知は間隔を空ける)
  const isPublicAction =
    action === "notify_owner" || action === "nag_unconfirmed";
  const boardPassword = Deno.env.get("BOARD_PASSWORD") ?? "";
  if (!isPublicAction && (!boardPassword || password !== boardPassword)) {
    return json({ error: "unauthorized" }, 401);
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  switch (action) {
    // パスワード確認用
    case "ping":
      return json({ ok: true });

    // ── 新規注文を店主のLINEへ即通知(注文フォームから呼ばれる) ──
    case "notify_owner": {
      const id = Number(payload.id);
      if (!id) return json({ error: "bad payload" }, 400);

      const { data: o } = await db
        .from("takeout_orders")
        .select(
          "id,status,customer_name,items,total,note,pickup_at,line_user_id,created_at,owner_notified_at"
        )
        .eq("id", id)
        .single();
      if (!o) return json({ ok: true, skipped: "not found" });
      if (o.status !== "new") return json({ ok: true, skipped: "not new" });

      const ageMs = Date.now() - new Date(o.created_at).getTime();
      if (ageMs > 15 * 60000) return json({ ok: true, skipped: "too old" });
      if (
        o.owner_notified_at &&
        Date.now() - new Date(o.owner_notified_at).getTime() < 4 * 60000
      ) {
        return json({ ok: true, skipped: "recently notified" });
      }

      const items = Array.isArray(o.items)
        ? o.items
        : (() => {
            try {
              return JSON.parse(String(o.items));
            } catch (_e) {
              return [];
            }
          })();
      const lines = (items as { name: string; qty: number }[])
        .map((i) => `・${i.name} ×${i.qty}`)
        .join("\n");
      const note = o.note ? `📝${o.note}\n` : "";
      const title = "🍳新規注文 #" + o.id;
      const body =
        `⏰希望 ${pickupLabelJST(o.pickup_at)} ・ ${o.customer_name}様 ・ ¥${Number(
          o.total
        ).toLocaleString()}\n` +
        lines + "\n" +
        note +
        "↓タップして受注ボードで確定";
      // まずWeb Push(無料)→届く端末がなければLINEへ(予備)
      const pushed = await webPushAll(db, title, body, "toriton-new");
      console.log(`[notify] #${id} web=${pushed} ${pushed ? "(LINE不使用)" : "→LINE予備へ"}`);
      const sent =
        pushed > 0 ||
        (await linePush(
          token,
          Deno.env.get("OWNER_LINE_USER_ID") ?? "",
          title + "\n" + body
        ));
      if (sent) {
        await db
          .from("takeout_orders")
          .update({ owner_notified_at: new Date().toISOString() })
          .eq("id", id);
      }
      return json({ ok: true, sent });
    }

    // ── 未確認注文の再通知(電話の着信のように、確定するまで訴え続ける) ──
    // pg_cron から毎分呼ばれる。前回通知から1分以上経った「new」の注文に
    // ⚠️再通知を送る(実質1〜2分間隔)。注文発生から60分で打ち切り。
    case "nag_unconfirmed": {
      const ownerId = Deno.env.get("OWNER_LINE_USER_ID") ?? "";
      const { data: stale } = await db
        .from("takeout_orders")
        .select("id,customer_name,pickup_at,owner_notified_at")
        .eq("status", "new")
        .gte("created_at", new Date(Date.now() - 60 * 60000).toISOString())
        .order("id")
        .limit(5);
      let sent = 0;
      for (const o of stale ?? []) {
        const last = o.owner_notified_at
          ? new Date(o.owner_notified_at).getTime()
          : 0;
        if (Date.now() - last < 60 * 1000) continue;
        const title = `⚠️まだ未確認の注文があります #${o.id}`;
        const body =
          `希望 ${pickupLabelJST(o.pickup_at)} ・ ${o.customer_name}様\n` +
          "↓タップして受注ボードで確定";
        // Web Pushが無料で鳴り続ける。端末未登録時のみLINEへ(予備)
        const ok =
          (await webPushAll(db, title, body, "toriton-nag")) > 0 ||
          (await linePush(token, ownerId, title + "\n" + body));
        if (ok) {
          sent++;
          await db
            .from("takeout_orders")
            .update({ owner_notified_at: new Date().toISOString() })
            .eq("id", o.id);
        }
      }
      return json({ ok: true, sent });
    }

    // 注文確定(時間変更があればお客のLINEへ調整通知)
    case "confirm_order": {
      const id = Number(payload.id);
      const pickupAt = new Date(payload.pickup_at);
      if (!id || isNaN(pickupAt.getTime())) {
        return json({ error: "bad payload" }, 400);
      }

      const { data: before, error: e1 } = await db
        .from("takeout_orders")
        .select("id,pickup_at,line_user_id")
        .eq("id", id)
        .single();
      if (e1 || !before) return json({ error: "order not found" }, 404);

      const { error } = await db
        .from("takeout_orders")
        .update({ pickup_at: pickupAt.toISOString(), status: "accepted" })
        .eq("id", id);
      if (error) return json({ error: error.message }, 500);

      const timeChanged =
        new Date(before.pickup_at).getTime() !== pickupAt.getTime();
      const notified = timeChanged && !!before.line_user_id;
      if (notified) {
        await linePush(
          token,
          before.line_user_id,
          "いつもありがとうございます、鳥とんです。\n" +
            `大変申し訳ございませんが、混雑のため受取時間を ${pickupLabelJST(
              pickupAt.toISOString()
            )} に調整いたしました。\n` +
            "ご不便をおかけいたしますが、よろしくお願いいたします。"
        );
      }
      return json({ ok: true, notified });
    }

    // 受渡済み
    case "set_done": {
      const id = Number(payload.id);
      const { error } = await db
        .from("takeout_orders")
        .update({ status: "done" })
        .eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // ── 定休日・臨時休業の管理(ボードから) ──
    case "holiday_set_weekly": {
      // 毎週の定休を丸ごと同期する(送られた配列が正)
      const days = Array.isArray(payload.days)
        ? [...new Set(payload.days.map(Number))]
            .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
        : [];
      await db.from("shop_holidays").delete().eq("kind", "weekly");
      if (days.length > 0) {
        const { error } = await db
          .from("shop_holidays")
          .insert(days.map((d) => ({ kind: "weekly", day_of_week: d })));
        if (error) return json({ error: error.message }, 500);
      }
      return json({ ok: true });
    }

    case "holiday_add_date": {
      const date = String(payload.date ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return json({ error: "bad date" }, 400);
      }
      await db
        .from("shop_holidays")
        .delete()
        .eq("kind", "date")
        .eq("holiday_date", date);
      const { error } = await db
        .from("shop_holidays")
        .insert({ kind: "date", holiday_date: date });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    case "holiday_remove_date": {
      const date = String(payload.date ?? "");
      const { error } = await db
        .from("shop_holidays")
        .delete()
        .eq("kind", "date")
        .eq("holiday_date", date);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // ── メニュー管理(ボードから) ──
    case "menu_save": {
      const category = String(payload.category ?? "").trim();
      const name = String(payload.name ?? "").trim();
      const price = Number(payload.price);
      const sortNo = Number(payload.sort_no) || 999;
      if (!category || !name || !Number.isInteger(price) || price < 0) {
        return json({ error: "bad payload" }, 400);
      }
      // オプション(例: 柚子胡椒=50)。配列で受け取り、壊れた物は捨てる
      let options: unknown = null;
      if (Array.isArray(payload.options)) {
        const opts = (payload.options as { name?: unknown; price?: unknown }[])
          .map((o) => ({
            name: String(o.name ?? "").trim(),
            price: Number(o.price),
          }))
          .filter(
            (o) => o.name !== "" && Number.isInteger(o.price) && o.price >= 0
          );
        options = opts.length > 0 ? opts : null;
      }
      if (payload.id) {
        const { error } = await db
          .from("menu_items")
          .update({ category, name, price, options })
          .eq("id", Number(payload.id));
        if (error) return json({ error: error.message }, 500);
      } else {
        const { error } = await db
          .from("menu_items")
          .insert({ category, name, price, sort_no: sortNo, options });
        if (error) return json({ error: error.message }, 500);
      }
      return json({ ok: true });
    }

    case "menu_toggle": {
      const id = Number(payload.id);
      const { error } = await db
        .from("menu_items")
        .update({ available: !!payload.available })
        .eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    case "menu_delete": {
      const id = Number(payload.id);
      const { error } = await db
        .from("menu_items")
        .delete()
        .eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // ── 特別営業時間(年末年始など) ──
    case "special_hours_save": {
      const date = String(payload.date ?? "");
      const open = String(payload.open_time ?? "");
      const close = String(payload.close_time ?? "");
      const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !hm.test(open) || !hm.test(close)) {
        return json({ error: "bad payload" }, 400);
      }
      if (open >= close) return json({ error: "開店より閉店が早いです" }, 400);
      await db.from("special_hours").delete().eq("date", date);
      const { error } = await db
        .from("special_hours")
        .insert({ date, open_time: open, close_time: close });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    case "special_hours_delete": {
      const date = String(payload.date ?? "");
      const { error } = await db
        .from("special_hours")
        .delete()
        .eq("date", date);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // ── Web Push端末の登録(ボードから) ──
    case "push_subscribe": {
      const endpoint = String(payload.endpoint ?? "");
      const p256dh = String(payload.keys?.p256dh ?? "");
      const auth = String(payload.keys?.auth ?? "");
      if (!endpoint || !p256dh || !auth) {
        return json({ error: "bad payload" }, 400);
      }
      const { error } = await db
        .from("push_subs")
        .upsert({ endpoint, p256dh, auth }, { onConflict: "endpoint" });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    case "push_unsubscribe": {
      const endpoint = String(payload.endpoint ?? "");
      const { error } = await db
        .from("push_subs")
        .delete()
        .eq("endpoint", endpoint);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // 時間帯ストップ(お客の選択肢から消す)
    case "slot_stop": {
      const slotAt = new Date(payload.slot_at);
      if (isNaN(slotAt.getTime())) return json({ error: "bad payload" }, 400);
      const { error } = await db
        .from("pickup_slot_stops")
        .upsert({ slot_at: slotAt.toISOString() }, { onConflict: "slot_at" });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // 時間帯ストップ解除
    case "slot_resume": {
      const slotAt = new Date(payload.slot_at);
      const { error } = await db
        .from("pickup_slot_stops")
        .delete()
        .gte("slot_at", slotAt.toISOString())
        .lt("slot_at", new Date(slotAt.getTime() + 60000).toISOString());
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    default:
      return json({ error: "unknown action" }, 400);
  }
});
