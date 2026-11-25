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
      const sent = await linePush(
        token,
        Deno.env.get("OWNER_LINE_USER_ID") ?? "",
        "🍳新規注文 #" + o.id + "\n" +
          `⏰希望 ${pickupLabelJST(o.pickup_at)} ・ ${o.customer_name}様 ・ ¥${Number(
            o.total
          ).toLocaleString()}\n` +
          lines + "\n" +
          note +
          "↓タップして受注ボードで確定\n" +
          BOARD_URL
      );
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
        const ok = await linePush(
          token,
          ownerId,
          `⚠️まだ未確認の注文があります #${o.id}\n` +
            `希望 ${pickupLabelJST(o.pickup_at)} ・ ${o.customer_name}様\n` +
            `↓タップして受注ボードで確定\n` +
            BOARD_URL
        );
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
