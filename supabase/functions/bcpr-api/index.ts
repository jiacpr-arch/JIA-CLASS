// bcpr-api — backend สำหรับระบบจองคอร์ส B-CPR (JIA-CLASS)
// public: list_classes, create_booking, verify_cert
// admin (header x-admin-key = ADMIN_API_KEY): จัดการรอบอบรม/การจอง/ใบเซอร์ เฉพาะ course_key='B-CPR' / channel='bcpr-web'
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_KEY = Deno.env.get("ADMIN_API_KEY") ?? "";

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const COURSE_KEY = "B-CPR";
const COURSE_NAME = "B-CPR การช่วยชีวิตขั้นพื้นฐานสำหรับประชาชน";
const CHANNEL = "bcpr-web";
const SLIP_BUCKET = "slips";
const SLIP_PREFIX = "bcpr/";
const HOLD_STATUSES = ["รอตรวจสอบ", "ชำระแล้ว"];
const CERT_VALID_YEARS = 2;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function timingSafeEq(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a), bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

function certExpiry(issuedAt: string): string {
  const d = new Date(issuedAt);
  d.setFullYear(d.getFullYear() + CERT_VALID_YEARS);
  return d.toISOString();
}

async function seatsTaken(classIds: string[]): Promise<Record<string, number>> {
  if (classIds.length === 0) return {};
  const { data, error } = await db.from("bookings")
    .select("class_id,total_people,payment_status")
    .in("class_id", classIds)
    .in("payment_status", HOLD_STATUSES);
  if (error) throw error;
  const taken: Record<string, number> = {};
  for (const b of data ?? []) taken[b.class_id] = (taken[b.class_id] ?? 0) + (b.total_people ?? 0);
  return taken;
}

async function getConfig() {
  const [{ data: course }, { data: settings }] = await Promise.all([
    db.from("courses").select("price").eq("key", COURSE_KEY).single(),
    db.from("settings").select("key,value").in("key", ["bcpr_promptpay_id", "bcpr_promptpay_name"]),
  ]);
  const s: Record<string, string> = {};
  for (const row of settings ?? []) s[row.key] = row.value;
  return {
    price: Number(course?.price ?? 600),
    promptpay_id: s["bcpr_promptpay_id"] ?? "PLACEHOLDER",
    promptpay_name: s["bcpr_promptpay_name"] ?? "",
  };
}

// ---------- public actions ----------

async function listClasses() {
  const today = new Date().toISOString().slice(0, 10);
  const { data: classes, error } = await db.from("classes")
    .select("id,date,time_slot,place,max_students,note")
    .eq("course_key", COURSE_KEY).eq("status", "ready").gte("date", today)
    .order("date", { ascending: true });
  if (error) throw error;
  const taken = await seatsTaken((classes ?? []).map((c) => c.id));
  const config = await getConfig();
  return json({
    ok: true,
    config,
    classes: (classes ?? []).map((c) => ({
      id: c.id, date: c.date, time_slot: c.time_slot, place: c.place ?? "",
      max_students: c.max_students,
      seats_left: Math.max((c.max_students ?? 0) - (taken[c.id] ?? 0), 0),
    })),
  });
}

async function createBooking(body: Record<string, unknown>) {
  const name = String(body.name ?? "").trim();
  const tel = String(body.tel ?? "").trim();
  const email = String(body.email ?? "").trim();
  const note = String(body.note ?? "").trim().slice(0, 500);
  const classId = String(body.class_id ?? "");
  const people = Number(body.people ?? 0);
  const pdpa = body.pdpa_consent === true;
  const slipB64 = String(body.slip_base64 ?? "");
  const slipMime = String(body.slip_mime ?? "");

  if (!name || name.length > 200) return json({ ok: false, error: "INVALID_NAME" }, 400);
  if (!/^[0-9+\-() ]{8,20}$/.test(tel)) return json({ ok: false, error: "INVALID_TEL" }, 400);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: "INVALID_EMAIL" }, 400);
  if (!classId) return json({ ok: false, error: "INVALID_CLASS" }, 400);
  if (!Number.isInteger(people) || people < 1 || people > 10) return json({ ok: false, error: "INVALID_PEOPLE" }, 400);
  if (!pdpa) return json({ ok: false, error: "PDPA_REQUIRED" }, 400);

  const extByMime: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  const ext = extByMime[slipMime];
  if (!ext || !slipB64) return json({ ok: false, error: "INVALID_SLIP" }, 400);
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(slipB64), (c) => c.charCodeAt(0));
  } catch {
    return json({ ok: false, error: "INVALID_SLIP" }, 400);
  }
  if (bytes.length < 1024 || bytes.length > 5 * 1024 * 1024) return json({ ok: false, error: "SLIP_SIZE" }, 400);

  const bookingId = genId();
  const slipPath = `${SLIP_PREFIX}${bookingId}.${ext}`;
  const up = await db.storage.from(SLIP_BUCKET).upload(slipPath, bytes, { contentType: slipMime });
  if (up.error) return json({ ok: false, error: "SLIP_UPLOAD_FAILED" }, 500);

  const { data, error } = await db.rpc("bcpr_create_booking", {
    p_id: bookingId, p_class_id: classId, p_name: name, p_tel: tel, p_email: email,
    p_people: people, p_note: note, p_slip_path: slipPath, p_course_name: COURSE_NAME,
  });
  if (error) {
    await db.storage.from(SLIP_BUCKET).remove([slipPath]).catch(() => {});
    return json({ ok: false, error: "BOOKING_FAILED" }, 500);
  }
  if (!data?.ok) {
    await db.storage.from(SLIP_BUCKET).remove([slipPath]).catch(() => {});
    return json({ ok: false, error: data?.error ?? "BOOKING_FAILED", seats_left: data?.seats_left }, 409);
  }
  return json({ ok: true, booking_id: bookingId, status: "รอตรวจสอบ", total: data.total });
}

async function verifyCert(body: Record<string, unknown>) {
  const code = String(body.code ?? "").trim().toUpperCase();
  if (!/^BCPR-\d{4}-\d{4}$/.test(code)) return json({ ok: true, found: false });
  const { data, error } = await db.from("certificates")
    .select("code,learner_name,issued_at,location,revoked_at")
    .eq("code", code).eq("kind", COURSE_KEY).maybeSingle();
  if (error) throw error;
  if (!data) return json({ ok: true, found: false });
  return json({
    ok: true, found: true,
    cert: {
      code: data.code, learner_name: data.learner_name,
      course: `หลักสูตรการกู้ชีพขั้นพื้นฐาน (Basic Cardiopulmonary Resuscitation: B-CPR)`,
      issued_at: data.issued_at, expires_at: certExpiry(data.issued_at),
      location: data.location ?? "", revoked: !!data.revoked_at,
    },
  });
}

// ---------- admin actions ----------

async function adminListClasses() {
  const { data: classes, error } = await db.from("classes")
    .select("id,date,time_slot,place,max_students,status,note,created_at")
    .eq("course_key", COURSE_KEY).order("date", { ascending: false });
  if (error) throw error;
  const taken = await seatsTaken((classes ?? []).map((c) => c.id));
  return json({ ok: true, classes: (classes ?? []).map((c) => ({ ...c, booked: taken[c.id] ?? 0 })) });
}

async function adminCreateClass(body: Record<string, unknown>) {
  const date = String(body.date ?? "");
  const timeSlot = String(body.time_slot ?? "").trim();
  const maxStudents = Number(body.max_students ?? 0);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ ok: false, error: "INVALID_DATE" }, 400);
  if (!timeSlot) return json({ ok: false, error: "INVALID_TIME" }, 400);
  if (!Number.isInteger(maxStudents) || maxStudents < 1 || maxStudents > 200) return json({ ok: false, error: "INVALID_MAX" }, 400);
  const row = {
    id: genId(), course_key: COURSE_KEY, course_name: COURSE_NAME,
    date, time_slot: timeSlot, max_students: maxStudents,
    required_instructors: Math.max(1, Math.ceil(maxStudents / 8)),
    status: "ready", place: String(body.place ?? "").trim(), note: String(body.note ?? "").trim(),
    created_by: "bcpr-admin",
  };
  const { error } = await db.from("classes").insert(row);
  if (error) throw error;
  return json({ ok: true, class: row });
}

async function adminUpdateClass(body: Record<string, unknown>) {
  const id = String(body.id ?? "");
  const patchIn = (body.patch ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (patchIn.date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(patchIn.date))) return json({ ok: false, error: "INVALID_DATE" }, 400);
    patch.date = patchIn.date;
  }
  if (patchIn.time_slot !== undefined) patch.time_slot = String(patchIn.time_slot).trim();
  if (patchIn.place !== undefined) patch.place = String(patchIn.place).trim();
  if (patchIn.note !== undefined) patch.note = String(patchIn.note).trim();
  if (patchIn.max_students !== undefined) {
    const m = Number(patchIn.max_students);
    if (!Number.isInteger(m) || m < 1 || m > 200) return json({ ok: false, error: "INVALID_MAX" }, 400);
    patch.max_students = m;
  }
  if (patchIn.status !== undefined) {
    if (!["ready", "full", "completed", "cancelled"].includes(String(patchIn.status))) {
      return json({ ok: false, error: "INVALID_STATUS" }, 400);
    }
    patch.status = patchIn.status;
  }
  if (Object.keys(patch).length === 0) return json({ ok: false, error: "EMPTY_PATCH" }, 400);
  const { data, error } = await db.from("classes").update(patch)
    .eq("id", id).eq("course_key", COURSE_KEY).select("id");
  if (error) throw error;
  if (!data?.length) return json({ ok: false, error: "NOT_FOUND" }, 404);
  return json({ ok: true });
}

async function adminListBookings(body: Record<string, unknown>) {
  let q = db.from("bookings")
    .select("id,name,tel,email,class_id,total_people,final_price,payment_slip,payment_status,start_date,time_slot,note,attended_at,created_at")
    .eq("channel", CHANNEL).order("created_at", { ascending: false }).limit(500);
  if (body.class_id) q = q.eq("class_id", String(body.class_id));
  if (body.payment_status) q = q.eq("payment_status", String(body.payment_status));
  const { data, error } = await q;
  if (error) throw error;
  return json({ ok: true, bookings: data ?? [] });
}

async function adminSignSlip(body: Record<string, unknown>) {
  const path = String(body.path ?? "");
  if (!path.startsWith(SLIP_PREFIX)) return json({ ok: false, error: "INVALID_PATH" }, 400);
  const { data, error } = await db.storage.from(SLIP_BUCKET).createSignedUrl(path, 600);
  if (error) return json({ ok: false, error: "SIGN_FAILED" }, 500);
  return json({ ok: true, url: data.signedUrl });
}

async function adminUpdateBooking(body: Record<string, unknown>) {
  const id = String(body.id ?? "");
  const patchIn = (body.patch ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (patchIn.payment_status !== undefined) {
    if (!["รอตรวจสอบ", "ชำระแล้ว", "ยกเลิก"].includes(String(patchIn.payment_status))) {
      return json({ ok: false, error: "INVALID_STATUS" }, 400);
    }
    patch.payment_status = patchIn.payment_status;
  }
  if (patchIn.attended !== undefined) patch.attended_at = patchIn.attended ? new Date().toISOString() : null;
  if (patchIn.note !== undefined) patch.note = String(patchIn.note).trim();
  if (Object.keys(patch).length === 0) return json({ ok: false, error: "EMPTY_PATCH" }, 400);
  const { data, error } = await db.from("bookings").update(patch)
    .eq("id", id).eq("channel", CHANNEL).select("id");
  if (error) throw error;
  if (!data?.length) return json({ ok: false, error: "NOT_FOUND" }, 404);
  return json({ ok: true });
}

async function nextCertCode(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `BCPR-${year}-`;
  const { data } = await db.from("certificates")
    .select("code").like("code", `${prefix}%`)
    .order("code", { ascending: false }).limit(1);
  const last = data?.[0]?.code;
  const n = last ? parseInt(last.slice(prefix.length), 10) + 1 : 1;
  return prefix + String(n).padStart(4, "0");
}

async function adminIssueCert(body: Record<string, unknown>) {
  const bookingId = String(body.booking_id ?? "");
  const attendees = Array.isArray(body.attendees) ? body.attendees : [];
  if (!attendees.length || attendees.length > 20) return json({ ok: false, error: "INVALID_ATTENDEES" }, 400);

  const { data: booking, error: bErr } = await db.from("bookings")
    .select("id,payment_status").eq("id", bookingId).eq("channel", CHANNEL).maybeSingle();
  if (bErr) throw bErr;
  if (!booking) return json({ ok: false, error: "BOOKING_NOT_FOUND" }, 404);
  if (booking.payment_status !== "ชำระแล้ว") return json({ ok: false, error: "NOT_PAID" }, 400);

  const issued: Array<{ name: string; code: string; expires_at: string }> = [];
  for (const a of attendees) {
    const name = String((a as Record<string, unknown>).name ?? "").trim();
    if (!name) return json({ ok: false, error: "INVALID_ATTENDEE_NAME" }, 400);
    const email = String((a as Record<string, unknown>).email ?? "").trim();
    const phone = String((a as Record<string, unknown>).phone ?? "").trim();
    let inserted = false;
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      const code = await nextCertCode();
      const issuedAt = new Date().toISOString();
      const { error } = await db.from("certificates").insert({
        learner_id: crypto.randomUUID(), kind: COURSE_KEY, code,
        learner_name: name, learner_email: email, learner_phone: phone,
        issued_at: issuedAt, location: "JIA TRAINER CENTER",
      });
      if (!error) {
        issued.push({ name, code, expires_at: certExpiry(issuedAt) });
        inserted = true;
      } else if (!String(error.message).includes("duplicate")) {
        throw error;
      }
    }
    if (!inserted) return json({ ok: false, error: "CODE_CONFLICT" }, 500);
  }
  return json({ ok: true, certificates: issued });
}

async function adminRevokeCert(body: Record<string, unknown>) {
  const code = String(body.code ?? "").trim().toUpperCase();
  if (!code.startsWith("BCPR-")) return json({ ok: false, error: "INVALID_CODE" }, 400);
  const { data, error } = await db.from("certificates")
    .update({ revoked_at: new Date().toISOString() })
    .eq("code", code).eq("kind", COURSE_KEY).select("code");
  if (error) throw error;
  if (!data?.length) return json({ ok: false, error: "NOT_FOUND" }, 404);
  return json({ ok: true });
}

async function adminListCerts() {
  const { data, error } = await db.from("certificates")
    .select("code,learner_name,issued_at,revoked_at")
    .eq("kind", COURSE_KEY).order("issued_at", { ascending: false }).limit(500);
  if (error) throw error;
  return json({
    ok: true,
    certificates: (data ?? []).map((c) => ({ ...c, expires_at: certExpiry(c.issued_at) })),
  });
}

// ---------- router ----------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "METHOD" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "BAD_JSON" }, 400);
  }
  const action = String(body.action ?? "");

  try {
    // public
    if (action === "list_classes") return await listClasses();
    if (action === "create_booking") return await createBooking(body);
    if (action === "verify_cert") return await verifyCert(body);

    // admin
    if (action.startsWith("admin_")) {
      const key = req.headers.get("x-admin-key") ?? "";
      if (!ADMIN_KEY || !timingSafeEq(key, ADMIN_KEY)) return json({ ok: false, error: "UNAUTHORIZED" }, 401);
      switch (action) {
        case "admin_ping": return json({ ok: true });
        case "admin_list_classes": return await adminListClasses();
        case "admin_create_class": return await adminCreateClass(body);
        case "admin_update_class": return await adminUpdateClass(body);
        case "admin_list_bookings": return await adminListBookings(body);
        case "admin_sign_slip": return await adminSignSlip(body);
        case "admin_update_booking": return await adminUpdateBooking(body);
        case "admin_issue_cert": return await adminIssueCert(body);
        case "admin_revoke_cert": return await adminRevokeCert(body);
        case "admin_list_certs": return await adminListCerts();
      }
    }
    return json({ ok: false, error: "UNKNOWN_ACTION" }, 400);
  } catch (e) {
    console.error("bcpr-api error", action, e);
    return json({ ok: false, error: "SERVER_ERROR" }, 500);
  }
});
