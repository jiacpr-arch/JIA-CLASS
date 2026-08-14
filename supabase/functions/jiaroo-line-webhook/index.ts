import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const TENANT = "jiaroo";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supa = createClient(SUPABASE_URL, SERVICE_KEY);

let cachedSecrets: { secret: string; token: string } | null = null;
async function loadSecrets() {
  if (cachedSecrets) return cachedSecrets;
  const envSecret = Deno.env.get("LINE_CHANNEL_SECRET") || "";
  const envToken = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") || "";
  if (envSecret && envToken) { cachedSecrets = { secret: envSecret, token: envToken }; return cachedSecrets; }
  const { data } = await supa.from("jiaroo_secrets").select("key,value").eq("tenant_slug", TENANT);
  const map: Record<string, string> = {};
  for (const r of data || []) map[r.key] = r.value;
  cachedSecrets = { secret: envSecret || map.LINE_CHANNEL_SECRET || "", token: envToken || map.LINE_CHANNEL_ACCESS_TOKEN || "" };
  return cachedSecrets;
}

async function computeSignature(rawBody: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function fetchProfile(userId: string, token: string) {
  if (!token) return null;
  try {
    const r = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, { headers: { Authorization: `Bearer ${token}` } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// ชื่อกลุ่ม/ห้องสำหรับแสดงในหน้าจัดการ — ใช้ได้กับ group เท่านั้น (room ส่วนตัวไม่มี summary API)
async function fetchGroupName(groupId: string, token: string): Promise<string | null> {
  if (!token) return null;
  try {
    const r = await fetch(`https://api.line.me/v2/bot/group/${groupId}/summary`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const j = await r.json();
    return j.groupName || null;
  } catch { return null; }
}

// รหัสแอดมินของ endpoint จัดการ (import-team / list-groups) — ห้าม hardcode ในไฟล์นี้
// เพราะ repo นี้เป็น public บน GitHub ใครก็อ่านได้ อ่านจาก env ก่อน แล้วค่อย fallback
// ตาราง jiaroo_secrets (แบบเดียวกับ LINE token) ถ้าไม่ตั้งค่าไว้เลย = ปิดใช้งาน (fail closed)
async function isValidAdminKey(provided: string): Promise<boolean> {
  if (!provided) return false;
  const env = Deno.env.get("LINE_WEBHOOK_ADMIN_KEY") || "";
  if (env) return provided === env;
  const { data } = await supa.from("jiaroo_secrets").select("value")
    .eq("tenant_slug", TENANT).eq("key", "LINE_WEBHOOK_ADMIN_KEY").maybeSingle();
  const stored = data?.value || "";
  return !!stored && provided === stored;
}

async function isTeamMember(userId: string): Promise<boolean> {
  const { data } = await supa
    .from("jiaroo_team")
    .select("id")
    .eq("tenant_slug", TENANT)
    .eq("line_user_id", userId)
    .maybeSingle();
  return !!data;
}

async function tryLinkOnlineCustomer(userId: string, text: string, profile: any) {
  // Match "JIA-LINK-XXXXXX" pattern (case-insensitive) used to link online-course customer to LINE OA
  const m = text.match(/JIA-LINK-([A-Z0-9]{6})/i);
  if (!m) return null;
  const code = m[1].toUpperCase();
  const { data: cust } = await supa.from("customers").select("id,name").eq("line_link_code", code).maybeSingle();
  if (!cust) return null;
  await supa.from("customers").update({
    line_user_id: userId,
    line_added: true,
    line_added_at: new Date().toISOString(),
  }).eq("id", cust.id);
  await supa.from("line_inbound_log").insert({
    line_user_id: userId, event_type: "link_code_matched", message_text: text,
    matched_customer_id: cust.id, raw_payload: { code, display_name: profile?.displayName },
  });
  return cust;
}

async function upsertLead(userId: string, profile: any): Promise<string | null> {
  const { data: existing } = await supa.from("jiaroo_leads").select("id").eq("tenant_slug", TENANT).eq("line_user_id", userId).maybeSingle();
  if (existing) {
    if (profile?.displayName || profile?.pictureUrl) {
      await supa.from("jiaroo_leads").update({ display_name: profile.displayName || null, picture_url: profile.pictureUrl || null }).eq("id", existing.id);
    }
    return existing.id;
  }
  const { data, error } = await supa.from("jiaroo_leads").insert({
    tenant_slug: TENANT, line_user_id: userId, display_name: profile?.displayName || null,
    picture_url: profile?.pictureUrl || null, source: "line", stage: "new",
  }).select("id").single();
  if (error) { console.error("insert lead failed:", error); return null; }
  await supa.from("jiaroo_lead_events").insert({ lead_id: data.id, type: "created", data: { source: "line", display_name: profile?.displayName, line_user_id: userId }, created_by: "line-webhook" });
  return data.id;
}

function previewOf(ev: any) {
  const m = ev.message || {};
  switch (m.type) {
    case "text": return { type: "text", text: m.text || "" };
    case "image": return { type: "image", text: "[รูปภาพ]" };
    case "video": return { type: "video", text: "[วิดีโอ]" };
    case "audio": return { type: "audio", text: "[เสียง]" };
    case "sticker": return { type: "sticker", text: "[สติกเกอร์]" };
    case "location": return { type: "location", text: `[ตำแหน่ง] ${m.address || ""}` };
    case "file": return { type: "file", text: `[ไฟล์] ${m.fileName || ""}` };
    default: return { type: m.type || "unknown", text: `[${m.type || "unknown"}]` };
  }
}

async function importTeamFromFollowers(token: string) {
  if (!token) return { ok: false, error: "no token" };
  const userIds: string[] = [];
  let next: string | null = null;
  const max = 5;
  for (let i = 0; i < max; i++) {
    const url = `https://api.line.me/v2/bot/followers/ids?limit=300${next ? `&start=${next}` : ""}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      const txt = await r.text();
      return { ok: false, error: `followers api ${r.status}: ${txt}` };
    }
    const j = await r.json();
    userIds.push(...(j.userIds || []));
    next = j.next || null;
    if (!next) break;
  }

  const imported: any[] = [];
  const skipped: any[] = [];
  for (const uid of userIds) {
    const existingTeam = await supa.from("jiaroo_team").select("id").eq("tenant_slug", TENANT).eq("line_user_id", uid).maybeSingle();
    if (existingTeam.data) { skipped.push({ uid, reason: "already team" }); continue; }

    const profile = await fetchProfile(uid, token);
    const name = profile?.displayName || "(no name)";
    const pic = profile?.pictureUrl || null;

    const { data, error } = await supa.from("jiaroo_team").insert({
      tenant_slug: TENANT, name, picture_url: pic, line_user_id: uid, role: "sales", active: true,
    }).select("id,name").single();
    if (error) { skipped.push({ uid, error: error.message }); continue; }
    imported.push({ uid, name: data.name });

    // Also delete any existing lead row for this userId (they are team, not customers)
    await supa.from("jiaroo_leads").delete().eq("tenant_slug", TENANT).eq("line_user_id", uid);
  }

  return { ok: true, total_followers: userIds.length, imported: imported.length, skipped: skipped.length, details: { imported, skipped } };
}

// เมื่อ LINE OA ถูกเชิญเข้ากลุ่ม/ห้อง — บันทึก groupId ไว้เป็นปลายทางแจ้งเตือนจองใหม่ (รองรับหลายกลุ่ม)
// event join ของกลุ่ม/ห้องไม่มี source.userId มาด้วย จึงต้องดักก่อนจุดที่โค้ดเดิม skip event ที่ไม่มี userId
async function handleGroupJoin(ev: any, token: string) {
  const groupId = ev?.source?.groupId || ev?.source?.roomId;
  if (!groupId) return;
  const name = ev?.source?.groupId ? await fetchGroupName(groupId, token) : null;
  await supa.from("jiaroo_notify_groups").upsert({
    tenant_slug: TENANT, group_id: groupId, group_name: name,
    active: true, joined_at: new Date().toISOString(), left_at: null,
  }, { onConflict: "tenant_slug,group_id" });
}

// เมื่อ LINE OA ถูกลบออกจากกลุ่ม/ห้อง — ปิดการแจ้งเตือนไปกลุ่มนั้น (soft delete เก็บประวัติไว้)
async function handleGroupLeave(ev: any) {
  const groupId = ev?.source?.groupId || ev?.source?.roomId;
  if (!groupId) return;
  await supa.from("jiaroo_notify_groups")
    .update({ active: false, left_at: new Date().toISOString() })
    .eq("tenant_slug", TENANT).eq("group_id", groupId);
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  if (req.method === "GET") {
    const s = await loadSecrets();
    if (action === "import-team") {
      const adminKey = url.searchParams.get("key") || req.headers.get("x-admin-key") || "";
      if (!(await isValidAdminKey(adminKey))) return new Response("unauthorized", { status: 401 });
      const result = await importTeamFromFollowers(s.token);
      return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
    }
    if (action === "list-groups") {
      const adminKey = url.searchParams.get("key") || req.headers.get("x-admin-key") || "";
      if (!(await isValidAdminKey(adminKey))) return new Response("unauthorized", { status: 401 });
      const { data, error } = await supa.from("jiaroo_notify_groups")
        .select("group_id,group_name,active,joined_at,left_at")
        .eq("tenant_slug", TENANT).order("joined_at", { ascending: false });
      if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ ok: true, groups: data ?? [] }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      ok: true, service: "jiaroo-line-webhook",
      secret_loaded: s.secret.length > 0, secret_length: s.secret.length, token_loaded: s.token.length > 0,
    }), { headers: { "Content-Type": "application/json" } });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const signature = req.headers.get("x-line-signature") || "";
  const rawBody = await req.text();
  const { secret, token } = await loadSecrets();
  if (!secret) return new Response("server not configured", { status: 500 });

  const expected = await computeSignature(rawBody, secret);
  if (expected !== signature) {
    console.warn(`signature mismatch. body_len=${rawBody.length}`);
    return new Response("invalid signature", { status: 401 });
  }

  let body: any;
  try { body = JSON.parse(rawBody); } catch { return new Response("bad json", { status: 400 }); }
  const events: any[] = body.events || [];

  for (const ev of events) {
    try {
      // กลุ่ม/ห้อง join-leave ไม่มี source.userId — ต้องจัดการก่อนถูก skip ด้านล่าง
      if (ev.type === "join") { await handleGroupJoin(ev, token); continue; }
      if (ev.type === "leave") { await handleGroupLeave(ev); continue; }

      const userId = ev?.source?.userId;
      if (!userId) continue;

      // Skip lead creation for team members
      if (await isTeamMember(userId)) continue;

      const profile = await fetchProfile(userId, token);
      const leadId = await upsertLead(userId, profile);
      if (!leadId) continue;

      if (ev.type === "message" && ev.message) {
        const { type, text } = previewOf(ev);
        await supa.from("jiaroo_messages").insert({
          lead_id: leadId, tenant_slug: TENANT, direction: "in", text, message_type: type,
          line_message_id: ev.message.id || null, raw: ev,
        });
        await supa.from("jiaroo_leads").update({
          last_message_at: ev.timestamp ? new Date(ev.timestamp).toISOString() : new Date().toISOString(),
          last_message_preview: text.slice(0, 120),
        }).eq("id", leadId);
        // Online-course linking: detect link code in text and bind LINE user_id to customer
        if (type === "text" && text) {
          try { await tryLinkOnlineCustomer(userId, text, profile); }
          catch (e) { console.error("link code match error:", e); }
        }
      } else if (ev.type === "follow") {
        await supa.from("jiaroo_lead_events").insert({ lead_id: leadId, type: "follow", data: {}, created_by: "line-webhook" });
      } else if (ev.type === "unfollow") {
        await supa.from("jiaroo_lead_events").insert({ lead_id: leadId, type: "unfollow", data: {}, created_by: "line-webhook" });
      } else if (ev.type === "postback") {
        await supa.from("jiaroo_lead_events").insert({ lead_id: leadId, type: "postback", data: { data: ev.postback?.data }, created_by: "line-webhook" });
      }
    } catch (e) {
      console.error("event handling error:", e);
    }
  }

  return new Response("ok");
});
