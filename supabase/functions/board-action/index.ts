// 鳥とん 受注ボード用 エッジファンクション「board-action」
// 役割: パスワード認証つきで注文の確定・受渡済み・時間帯ストップを処理し、
//       時間変更があった時だけお客のLINEへプッシュ通知する
//
// 必要なシークレット(Supabase管理画面で設定):
//   BOARD_PASSWORD             ボードを開く時の合言葉(自分で決める)
//   LINE_CHANNEL_ACCESS_TOKEN  LINE Developersのチャネルアクセストークン(長期)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

async function linePush(token: string, to: string, text: string) {
  if (!token || !to) return;
  try {
    await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
    });
  } catch (_e) {
    // 通知失敗してもDBの更新は取り消さない(ボードに結果が載るため)
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const body = await req.json().catch(() => ({}));
  const password = String(body.password ?? "");
  const action = String(body.action ?? "");
  const payload = body.payload ?? {};

  const boardPassword = Deno.env.get("BOARD_PASSWORD") ?? "";
  if (!boardPassword || password !== boardPassword) {
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

    // 注文確定(時間変更があればLINE通知)
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
          Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "",
          before.line_user_id,
          "いつもありがとうございます、鳥とんです。\n" +
            `大変申し訳ございませんが、混雑のため受取時間を ${hmJST(
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
