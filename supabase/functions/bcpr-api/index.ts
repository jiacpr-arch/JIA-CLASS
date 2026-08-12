// bcpr-api — backend สำหรับระบบจองคอร์สออนไลน์ของ JIA TRAINER CENTER (หลายคอร์ส)
// public: list_courses, list_classes, create_booking, verify_cert
// admin (header x-admin-key): จัดการคอร์ส/รอบอบรม/การจอง/ใบเซอร์ — เฉพาะคอร์สที่ cert_prefix ไม่เป็น null
//   (courses.cert_prefix is not null = คอร์สที่อยู่ในระบบจองนี้; แถว joincourse/privateclass
//    ของ cpr.morroo.com มี cert_prefix เป็น null เสมอ จึงไม่ถูกดึง/แก้ไขโดยฟังก์ชันนี้เลย)
// แจ้งเตือนการจองใหม่: ทีมงานได้รับผ่าน LINE อยู่แล้วจาก trigger notify_new_booking บนตาราง bookings
//   (ยิงเข้า edge function notify-new-booking ทุก insert) — block "notifications" ด้านล่างเป็นช่องทาง
//   "เสริม" ที่ปิดอยู่โดย default อย่าเปิดถ้าไม่อยากได้ข้อความซ้ำ ดู docs/NOTIFICATIONS.md
// รหัสแอดมินเป็นของระบบนี้โดยเฉพาะ (แยกจาก ADMIN_API_KEY เดิมของ cpr.morroo.com/admin)
// เก็บเป็น SHA-256 hash ในตาราง bcpr_admin_auth (RLS ปิดสนิท เข้าถึงได้เฉพาะ service role)
//
// Log ตรวจสอบย้อนหลัง: admin key ยังใช้ร่วมกันเหมือนเดิม (ไม่ได้แยก login ต่อคน) แต่ทุก action
// ที่แก้ข้อมูลรับ body.actor (ชื่อผู้ใช้งานที่พิมพ์ตอนล็อกอินในหน้าเว็บ) แล้วบันทึกลง bcpr_audit_log
// ไว้เพื่อตรวจสอบว่าใครทำอะไรเมื่อไหร่ — ดูได้ที่ action admin_list_audit_log
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function isValidAdminKey(key: string): Promise<boolean> {
  if (!key) return false;
  const { data, error } = await db.from("bcpr_admin_auth").select("key_hash").eq("id", true).maybeSingle();
  if (error || !data) return false;
  return timingSafeEq(await sha256Hex(key), data.key_hash);
}

// ก่อนหน้านี้ระบบนี้รองรับแค่คอร์สเดียว (B-CPR) — ค่าคงที่ด้านล่างคงไว้เป็นค่า default
// เพื่อให้หน้าเว็บเก่าที่ผู้ใช้ค้าง cache ไว้ในเบราว์เซอร์ (ยังไม่ได้ส่ง course_key มา) ทำงานต่อได้ปกติ
const LEGACY_COURSE_KEY = "B-CPR";
const WEB_CHANNELS = ["bcpr-web", "class-web"]; // ช่องทางเก่า + ใหม่ ที่ลูกค้าจองเองผ่านหน้าเว็บ
const SALES_CHANNELS = ["bcpr-admin", "class-admin"]; // ช่องทางเก่า + ใหม่ ที่แอดมิน/เซลล์ลงจองแทนลูกค้า
const CHANNELS = [...WEB_CHANNELS, ...SALES_CHANNELS]; // ช่องทางทั้งหมดที่ตารางนี้เป็นเจ้าของ
const NEW_CHANNEL = "class-web";
const NEW_SALES_CHANNEL = "class-admin";
const SLIP_BUCKET = "slips";
const SLIP_PREFIXES = ["bcpr/", "class/"]; // path เก่า + ใหม่ ที่อนุญาตให้ sign/upload
const NEW_SLIP_PREFIX = "class/";
const HOLD_STATUSES = ["รอตรวจสอบ", "ชำระแล้ว"];
const CERT_VALID_YEARS = 2;
const CERT_CODE_RE = /^[A-Z]{4}-\d{4}-\d{4}$/;

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

// บันทึก log ตรวจสอบย้อนหลัง — await เสมอ (ไม่ fire-and-forget) เพื่อให้มั่นใจว่าบันทึกสำเร็จก่อนตอบกลับ
// ถ้าบันทึก log ไม่สำเร็จ ไม่ทำให้ action หลักล้ม (log เป็นของเสริม ไม่ใช่ path หลัก)
async function logAudit(actor: unknown, action: string, extra: {
  bookingId?: string; classId?: string; certCode?: string; detail?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.from("bcpr_audit_log").insert({
      actor: String(actor ?? "").trim().slice(0, 100) || null,
      action,
      booking_id: extra.bookingId ?? null,
      class_id: extra.classId ?? null,
      cert_code: extra.certCode ?? null,
      detail: extra.detail ?? null,
    });
  } catch (e) {
    console.error("audit log failed", action, e);
  }
}

// ---------- notifications (ช่องทางเสริม — ปิดอยู่โดย default) ----------
// ทีมงานได้รับแจ้งเตือน LINE จาก trigger notify_new_booking อยู่แล้วทุกการจอง
// block นี้จะทำงานก็ต่อเมื่อตั้ง secrets ด้านล่าง ซึ่งจะทำให้ได้ข้อความ "ซ้ำ" กับของ trigger
// ใช้เฉพาะกรณีอยากได้อีเมลเพิ่ม หรืออยากส่งเข้าห้อง LINE อื่นที่ไม่ใช่ jiaroo_team:
//   LINE_CHANNEL_ACCESS_TOKEN + LINE_NOTIFY_TO  → push เข้า userId/groupId ที่ระบุ
//   RESEND_API_KEY + NOTIFY_EMAIL_TO            → อีเมลผ่าน Resend, NOTIFY_EMAIL_FROM (ไม่บังคับ)
const LINE_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
const LINE_TO = Deno.env.get("LINE_NOTIFY_TO") ?? "";
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const EMAIL_TO = Deno.env.get("NOTIFY_EMAIL_TO") ?? "";
const EMAIL_FROM = Deno.env.get("NOTIFY_EMAIL_FROM") || "JIA Booking <onboarding@resend.dev>";
const ADMIN_PAGE_URL = "https://class.morroo.com/bcpr-admin.html";

// TikTok Events API (server-side conversion) — ช่องทางเสริมเหมือน LINE/email ด้านบน: ถ้าไม่ตั้ง
// secret ไว้ก็ข้ามเงียบๆ ไม่กระทบ flow การอนุมัติ booking หลัก
// ต้องตั้งใน Supabase Edge Function secrets: TIKTOK_PIXEL_CODE (=D5TH3UBC77U5QAK8SAJG ตัวเดียวกับ
// tiktok-pixel.js ฝั่งเว็บ) และ TIKTOK_ACCESS_TOKEN (สร้างจาก TikTok Ads Manager > Events > Web Events
// > Pixel นี้ > Generate Access Token)
const TIKTOK_PIXEL_CODE = Deno.env.get("TIKTOK_PIXEL_CODE") ?? "";
const TIKTOK_ACCESS_TOKEN = Deno.env.get("TIKTOK_ACCESS_TOKEN") ?? "";

type BookingNotify = {
  source: "web" | "admin";
  bookingId: string;
  courseName: string;
  name: string;
  tel: string;
  people: number;
  total: number;
  date?: string;
  timeSlot?: string;
  paymentStatus: string;
  note?: string;
};

function notifyText(n: BookingNotify): string {
  const lines = [
    n.source === "web" ? `🔔 มีการจองใหม่จากหน้าเว็บ (${n.courseName})` : `📝 แอดมิน/เซลล์ลงจองใหม่ (${n.courseName})`,
    `ชื่อ: ${n.name}`,
    `โทร: ${n.tel}`,
    `รอบเรียน: ${n.date ?? "-"} ${n.timeSlot ?? ""}`.trim(),
    `จำนวน: ${n.people} คน | ยอด: ${n.total.toLocaleString("th-TH")} บาท`,
    `สถานะ: ${n.paymentStatus}`,
  ];
  if (n.note) lines.push(`หมายเหตุ: ${n.note}`);
  lines.push(`เลขที่จอง: ${n.bookingId}`);
  if (n.source === "web") lines.push(`ตรวจสลิป/อนุมัติได้ที่ ${ADMIN_PAGE_URL}`);
  return lines.join("\n");
}

async function sendLineNotify(text: string): Promise<void> {
  if (!LINE_TOKEN || !LINE_TO) return;
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ to: LINE_TO, messages: [{ type: "text", text }] }),
  });
  if (!res.ok) console.error("LINE notify failed", res.status, await res.text().catch(() => ""));
}

async function sendEmailNotify(subject: string, text: string): Promise<void> {
  if (!RESEND_KEY || !EMAIL_TO) return;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({ from: EMAIL_FROM, to: [EMAIL_TO], subject, text }),
  });
  if (!res.ok) console.error("Email notify failed", res.status, await res.text().catch(() => ""));
}

// ส่งแจ้งเตือนแบบไม่บล็อกการตอบกลับลูกค้า และไม่ทำให้การจองล้มถ้าส่งไม่สำเร็จ
function notifyNewBooking(n: BookingNotify): void {
  const text = notifyText(n);
  const subject = `${n.source === "web" ? "🔔 จองใหม่" : "📝 แอดมินลงจอง"} ${n.courseName}: ${n.name} (${n.people} คน)`;
  const job = Promise.allSettled([sendLineNotify(text), sendEmailNotify(subject, text)]);
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(job);
}

// เบอร์ไทยที่เก็บไว้เป็น "08x-xxx-xxxx"/"08xxxxxxxx" ฯลฯ → E.164 ก่อน hash ส่งให้ TikTok
// (ต้องเป็น E.164 ไม่งั้น TikTok จะ match เบอร์ไม่ได้ ถึงจะ hash ถูกอัลกอริทึมก็ตาม)
function normalizeThaiPhoneE164(tel: string): string | null {
  const digits = tel.replace(/\D/g, "");
  if (digits.startsWith("66") && digits.length === 11) return "+" + digits;
  if (digits.startsWith("0") && digits.length === 10) return "+66" + digits.slice(1);
  return null;
}

// ยิง conversion event ไปหา TikTok ตอนแอดมินอนุมัติสลิป (payment_status -> "ชำระแล้ว") เท่านั้น —
// นี่คือจังหวะที่ใกล้เคียง "ซื้อสำเร็จ" ที่สุดของระบบนี้ เพราะไม่มี payment gateway callback แบบ
// real-time ให้ยิงตอนลูกค้ากดจ่ายจริงบนหน้าเว็บ (ตอนนั้นมีแค่สลิปที่รอตรวจ ยังไม่ใช่เงินที่ยืนยันแล้ว)
// event_id = booking id ให้ TikTok dedupe ได้ถ้าเผลอยิงซ้ำ (retry ฝั่งเรา)
// อ้างอิงโครงสร้าง JSON จาก TikTok Events API v1.3 (business-api.tiktok.com/open_api/v1.3/event/track/)
// — ก่อน deploy จริงควรยืนยัน field ล่าสุดกับ TikTok Events Manager > Test Events อีกรอบ
async function sendTikTokCompletePayment(b: Record<string, unknown>, bookingId: string): Promise<boolean> {
  if (!TIKTOK_PIXEL_CODE || !TIKTOK_ACCESS_TOKEN) return false;
  try {
    const phoneE164 = normalizeThaiPhoneE164(String(b.tel ?? ""));
    const email = String(b.email ?? "").trim().toLowerCase();
    // deno-lint-ignore no-explicit-any
    const user: Record<string, any> = { external_id: [await sha256Hex(bookingId)] };
    if (b.ttclid) user.ttclid = b.ttclid;
    if (b.client_ip) user.ip = b.client_ip;
    if (b.client_user_agent) user.user_agent = b.client_user_agent;
    if (phoneE164) user.phone_number = [await sha256Hex(phoneE164)];
    if (email) user.email = [await sha256Hex(email)];

    const res = await fetch("https://business-api.tiktok.com/open_api/v1.3/event/track/", {
      method: "POST",
      headers: { "Access-Token": TIKTOK_ACCESS_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        event_source: "web",
        event_source_id: TIKTOK_PIXEL_CODE,
        data: [{
          event: "CompletePayment",
          event_time: Math.floor(Date.now() / 1000),
          event_id: bookingId,
          user,
          properties: {
            contents: [{
              content_id: b.course_type, content_name: b.course_name,
              content_type: "product", quantity: 1, price: Number(b.final_price ?? 0),
            }],
            currency: "THB",
            value: Number(b.final_price ?? 0),
          },
          page: { url: "https://class.morroo.com/booking.html" },
        }],
      }),
    });
    if (!res.ok) {
      console.error("TikTok Events API failed", res.status, await res.text().catch(() => ""));
      return false;
    }
    return true;
  } catch (e) {
    console.error("TikTok Events API error", e);
    return false;
  }
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

// คอร์สที่ "อยู่ในระบบจองนี้" ทั้งหมด (รวมที่ปิดรับจองชั่วคราวด้วย) — ใช้คำนี้ทุกที่ที่ต้องกันไม่ให้
// แตะแถว courses ของ cpr.morroo.com (joincourse/privateclass ซึ่ง cert_prefix เป็น null เสมอ)
async function getManagedCourses() {
  const { data, error } = await db.from("courses")
    .select("key,label,price,online_booking,max_students,time_slots,duration_hours,total_days,description,cert_prefix")
    .not("cert_prefix", "is", null);
  if (error) throw error;
  return data ?? [];
}

async function getPromptpayConfig() {
  const { data: settings } = await db.from("settings").select("key,value").in("key", ["bcpr_promptpay_id", "bcpr_promptpay_name"]);
  const s: Record<string, string> = {};
  for (const row of settings ?? []) s[row.key] = row.value;
  return { promptpay_id: s["bcpr_promptpay_id"] ?? "PLACEHOLDER", promptpay_name: s["bcpr_promptpay_name"] ?? "" };
}

// ---------- public actions ----------

async function listCourses() {
  const courses = await getManagedCourses();
  const bookable = courses.filter((c) => c.online_booking);
  const today = new Date().toISOString().slice(0, 10);
  const keys = bookable.map((c) => c.key);
  let upcomingCounts: Record<string, number> = {};
  if (keys.length) {
    const { data: classes, error } = await db.from("classes")
      .select("course_key").in("course_key", keys).eq("status", "ready").gte("date", today);
    if (error) throw error;
    for (const c of classes ?? []) upcomingCounts[c.course_key] = (upcomingCounts[c.course_key] ?? 0) + 1;
  }
  const promptpay = await getPromptpayConfig();
  return json({
    ok: true,
    ...promptpay,
    courses: bookable.map((c) => ({
      key: c.key, label: c.label, price: Number(c.price ?? 0),
      duration_hours: Number(c.duration_hours ?? 0), total_days: c.total_days ?? 1,
      max_students: c.max_students, description: c.description ?? "",
      upcoming_classes: upcomingCounts[c.key] ?? 0,
    })),
  });
}

async function listClasses(body: Record<string, unknown>) {
  const courseKey = String(body.course_key ?? LEGACY_COURSE_KEY);
  const today = new Date().toISOString().slice(0, 10);
  const { data: classes, error } = await db.from("classes")
    .select("id,date,time_slot,place,max_students,note,course_key")
    .eq("course_key", courseKey).eq("status", "ready").gte("date", today)
    .order("date", { ascending: true });
  if (error) throw error;
  const taken = await seatsTaken((classes ?? []).map((c) => c.id));

  const { data: course } = await db.from("courses")
    .select("price").eq("key", courseKey).not("cert_prefix", "is", null).maybeSingle();
  const promptpay = await getPromptpayConfig();

  return json({
    ok: true,
    config: { price: Number(course?.price ?? 600), ...promptpay },
    classes: (classes ?? []).map((c) => ({
      id: c.id, date: c.date, time_slot: c.time_slot, place: c.place ?? "",
      max_students: c.max_students,
      seats_left: Math.max((c.max_students ?? 0) - (taken[c.id] ?? 0), 0),
    })),
  });
}

async function createBooking(body: Record<string, unknown>, req: Request) {
  const name = String(body.name ?? "").trim();
  const tel = String(body.tel ?? "").trim();
  const email = String(body.email ?? "").trim();
  const note = String(body.note ?? "").trim().slice(0, 500);
  const classId = String(body.class_id ?? "");
  const people = Number(body.people ?? 0);
  const pdpa = body.pdpa_consent === true;
  const slipB64 = String(body.slip_base64 ?? "");
  const slipMime = String(body.slip_mime ?? "");
  const ttclid = String(body.ttclid ?? "").trim().slice(0, 200);
  const clientIp = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const clientUserAgent = req.headers.get("user-agent") ?? "";

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
  const slipPath = `${NEW_SLIP_PREFIX}${bookingId}.${ext}`;
  const up = await db.storage.from(SLIP_BUCKET).upload(slipPath, bytes, { contentType: slipMime });
  if (up.error) return json({ ok: false, error: "SLIP_UPLOAD_FAILED" }, 500);

  const { data, error } = await db.rpc("class_create_booking", {
    p_id: bookingId, p_class_id: classId, p_name: name, p_tel: tel, p_email: email,
    p_people: people, p_note: note, p_slip_path: slipPath,
    p_ttclid: ttclid || null, p_client_ip: clientIp || null, p_client_user_agent: clientUserAgent || null,
  });
  if (error) {
    await db.storage.from(SLIP_BUCKET).remove([slipPath]).catch(() => {});
    return json({ ok: false, error: "BOOKING_FAILED" }, 500);
  }
  if (!data?.ok) {
    await db.storage.from(SLIP_BUCKET).remove([slipPath]).catch(() => {});
    return json({ ok: false, error: data?.error ?? "BOOKING_FAILED", seats_left: data?.seats_left }, 409);
  }
  notifyNewBooking({
    source: "web", bookingId, courseName: data.course_name ?? data.course_key ?? "คอร์สอบรม",
    name, tel, people, total: Number(data.total ?? 0),
    date: data.date, timeSlot: data.time_slot, paymentStatus: "รอตรวจสอบสลิป", note,
  });
  return json({ ok: true, booking_id: bookingId, status: "รอตรวจสอบ", total: data.total, course_key: data.course_key });
}

async function verifyCert(body: Record<string, unknown>) {
  const code = String(body.code ?? "").trim().toUpperCase();
  if (!CERT_CODE_RE.test(code)) return json({ ok: true, found: false });
  const { data, error } = await db.from("certificates")
    .select("code,kind,learner_name,issued_at,location,revoked_at")
    .eq("code", code).maybeSingle();
  if (error) throw error;
  if (!data) return json({ ok: true, found: false });

  const { data: course } = await db.from("courses")
    .select("label").eq("key", data.kind).not("cert_prefix", "is", null).maybeSingle();
  if (!course) return json({ ok: true, found: false }); // ไม่ใช่คอร์สของระบบนี้ (เช่น theory/practical เดิม)

  return json({
    ok: true, found: true,
    cert: {
      code: data.code, kind: data.kind, learner_name: data.learner_name,
      course: course.label,
      issued_at: data.issued_at, expires_at: certExpiry(data.issued_at),
      location: data.location ?? "", revoked: !!data.revoked_at,
    },
  });
}

// ---------- admin actions ----------

async function adminListCourses() {
  const courses = await getManagedCourses();
  return json({ ok: true, courses });
}

async function adminUpdateCourse(body: Record<string, unknown>) {
  const key = String(body.key ?? "");
  const patchIn = (body.patch ?? {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (patchIn.price !== undefined) {
    const p = Number(patchIn.price);
    if (!Number.isFinite(p) || p < 0) return json({ ok: false, error: "INVALID_PRICE" }, 400);
    patch.price = p;
  }
  if (patchIn.online_booking !== undefined) patch.online_booking = patchIn.online_booking === true;
  if (patchIn.max_students !== undefined) {
    const m = Number(patchIn.max_students);
    if (!Number.isInteger(m) || m < 1 || m > 200) return json({ ok: false, error: "INVALID_MAX" }, 400);
    patch.max_students = m;
  }
  if (patchIn.description !== undefined) patch.description = String(patchIn.description).trim();
  if (Object.keys(patch).length === 0) return json({ ok: false, error: "EMPTY_PATCH" }, 400);
  const { data, error } = await db.from("courses").update(patch)
    .eq("key", key).not("cert_prefix", "is", null).select("key");
  if (error) throw error;
  if (!data?.length) return json({ ok: false, error: "NOT_FOUND" }, 404);
  return json({ ok: true });
}

async function managedCourseKeys(): Promise<string[]> {
  const { data, error } = await db.from("courses").select("key").not("cert_prefix", "is", null);
  if (error) throw error;
  return (data ?? []).map((c) => c.key);
}

async function adminListClasses(body: Record<string, unknown>) {
  const keys = await managedCourseKeys();
  let q = db.from("classes")
    .select("id,date,time_slot,place,max_students,status,note,created_at,course_key,course_name")
    .in("course_key", keys).order("date", { ascending: false });
  if (body.course_key) q = q.eq("course_key", String(body.course_key));
  const { data: classes, error } = await q;
  if (error) throw error;
  const taken = await seatsTaken((classes ?? []).map((c) => c.id));
  return json({ ok: true, classes: (classes ?? []).map((c) => ({ ...c, booked: taken[c.id] ?? 0 })) });
}

async function adminCreateClass(body: Record<string, unknown>) {
  const courseKey = String(body.course_key ?? LEGACY_COURSE_KEY);
  const date = String(body.date ?? "");
  const timeSlot = String(body.time_slot ?? "").trim();
  const maxStudents = Number(body.max_students ?? 0);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ ok: false, error: "INVALID_DATE" }, 400);
  if (!timeSlot) return json({ ok: false, error: "INVALID_TIME" }, 400);
  if (!Number.isInteger(maxStudents) || maxStudents < 1 || maxStudents > 200) return json({ ok: false, error: "INVALID_MAX" }, 400);

  const { data: course, error: cErr } = await db.from("courses")
    .select("key,label").eq("key", courseKey).not("cert_prefix", "is", null).maybeSingle();
  if (cErr) throw cErr;
  if (!course) return json({ ok: false, error: "INVALID_COURSE" }, 400);

  const row = {
    id: genId(), course_key: course.key, course_name: course.label,
    date, time_slot: timeSlot, max_students: maxStudents,
    required_instructors: Math.max(1, Math.ceil(maxStudents / 8)),
    status: "ready", place: String(body.place ?? "").trim(), note: String(body.note ?? "").trim(),
    created_by: "bcpr-admin",
  };
  const { error } = await db.from("classes").insert(row);
  if (error) throw error;
  await logAudit(body.actor, "create_class", { classId: row.id, detail: { date, time_slot: timeSlot, max_students: maxStudents, course_key: course.key } });
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
  const keys = await managedCourseKeys();
  const { data, error } = await db.from("classes").update(patch)
    .eq("id", id).in("course_key", keys).select("id");
  if (error) throw error;
  if (!data?.length) return json({ ok: false, error: "NOT_FOUND" }, 404);
  await logAudit(body.actor, "update_class", { classId: id, detail: patch });
  return json({ ok: true });
}

async function adminListBookings(body: Record<string, unknown>) {
  let q = db.from("bookings")
    .select("id,name,tel,email,class_id,channel,course_type,course_name,total_people,final_price,payment_mode,payment_slip,payment_status,start_date,time_slot,note,attended_at,created_at,sales_staff")
    .in("channel", CHANNELS).order("created_at", { ascending: false }).limit(500);
  if (body.class_id) q = q.eq("class_id", String(body.class_id));
  if (body.course_key) q = q.eq("course_type", String(body.course_key));
  if (body.payment_status) q = q.eq("payment_status", String(body.payment_status));
  const { data, error } = await q;
  if (error) throw error;
  return json({ ok: true, bookings: data ?? [] });
}

async function adminSignSlip(body: Record<string, unknown>) {
  const path = String(body.path ?? "");
  if (!SLIP_PREFIXES.some((p) => path.startsWith(p))) return json({ ok: false, error: "INVALID_PATH" }, 400);
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
    .eq("id", id).in("channel", CHANNELS)
    .select("id,channel,ttclid,client_ip,client_user_agent,tel,email,course_type,course_name,final_price,tiktok_sent_at");
  if (error) throw error;
  if (!data?.length) return json({ ok: false, error: "NOT_FOUND" }, 404);
  const action = patchIn.payment_status === "ชำระแล้ว" ? "approve_booking"
    : patchIn.payment_status === "ยกเลิก" ? "reject_booking"
    : patchIn.attended !== undefined ? "mark_attended"
    : "update_booking";
  await logAudit(body.actor, action, { bookingId: id, detail: patch });

  // ยิง conversion ไปหา TikTok ตอนอนุมัติสลิปครั้งแรกเท่านั้น (เฉพาะ booking ที่มาจากหน้าเว็บและมี
  // ttclid) — เช็ค tiktok_sent_at กันยิงซ้ำถ้าแอดมินแก้ไข booking ที่อนุมัติไปแล้วอีกครั้ง
  const b = data[0];
  if (patchIn.payment_status === "ชำระแล้ว" && WEB_CHANNELS.includes(b.channel) && b.ttclid && !b.tiktok_sent_at) {
    const sent = await sendTikTokCompletePayment(b, id);
    if (sent) await db.from("bookings").update({ tiktok_sent_at: new Date().toISOString() }).eq("id", id);
  }
  return json({ ok: true });
}

// ลงจองแทนลูกค้า (จองผ่านเซลล์/โทร/หน้างาน) — ไม่บังคับสลิป กำหนดราคา/สถานะ/ช่องทางชำระได้
// ดึงคอร์ส/ราคาจาก class เอง (join classes→courses) แทนที่จะ hardcode คอร์สเดียวเหมือนของเดิม
// บันทึกชื่อผู้ลงจอง (actor) ไว้ในคอลัมน์ sales_staff เพื่อรู้ว่าลูกค้ารายนี้เป็นของเซลล์คนไหน
async function adminCreateBooking(body: Record<string, unknown>) {
  const name = String(body.name ?? "").trim();
  const tel = String(body.tel ?? "").trim();
  const email = String(body.email ?? "").trim();
  const note = String(body.note ?? "").trim().slice(0, 500);
  const classId = String(body.class_id ?? "");
  const people = Number(body.people ?? 0);
  const paymentMode = String(body.payment_mode ?? "").trim().slice(0, 50);
  const paymentStatus = String(body.payment_status ?? "");
  const priceRaw = body.final_price;
  const finalPrice = priceRaw === undefined || priceRaw === null || priceRaw === "" ? null : Number(priceRaw);
  const actor = String(body.actor ?? "").trim().slice(0, 100);

  if (!name || name.length > 200) return json({ ok: false, error: "INVALID_NAME" }, 400);
  if (!/^[0-9+\-() ]{8,20}$/.test(tel)) return json({ ok: false, error: "INVALID_TEL" }, 400);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: "INVALID_EMAIL" }, 400);
  if (!classId) return json({ ok: false, error: "INVALID_CLASS" }, 400);
  if (!Number.isInteger(people) || people < 1 || people > 100) return json({ ok: false, error: "INVALID_PEOPLE" }, 400);
  if (!["รอตรวจสอบ", "ชำระแล้ว"].includes(paymentStatus)) return json({ ok: false, error: "INVALID_STATUS" }, 400);
  if (finalPrice !== null && (!Number.isFinite(finalPrice) || finalPrice < 0 || finalPrice > 1_000_000)) {
    return json({ ok: false, error: "INVALID_PRICE" }, 400);
  }

  const bookingId = genId();
  const { data, error } = await db.rpc("class_admin_create_booking", {
    p_id: bookingId, p_class_id: classId, p_name: name, p_tel: tel, p_email: email,
    p_people: people, p_note: note,
    p_final_price: finalPrice, p_payment_mode: paymentMode, p_payment_status: paymentStatus,
    p_sales_staff: actor || null,
  });
  if (error) return json({ ok: false, error: "BOOKING_FAILED" }, 500);
  if (!data?.ok) return json({ ok: false, error: data?.error ?? "BOOKING_FAILED", seats_left: data?.seats_left }, 409);

  await logAudit(actor, "create_booking", {
    bookingId, classId, detail: { name, tel, people, total: data.total, payment_status: paymentStatus },
  });

  notifyNewBooking({
    source: "admin", bookingId, courseName: data.course_name ?? data.course_key ?? "คอร์สอบรม",
    name, tel, people, total: Number(data.total ?? 0),
    date: data.date, timeSlot: data.time_slot, paymentStatus, note,
  });
  return json({ ok: true, booking_id: bookingId, status: paymentStatus, total: data.total, course_key: data.course_key });
}

async function nextCertCode(prefix: string): Promise<string> {
  const year = new Date().getFullYear();
  const codePrefix = `${prefix}-${year}-`;
  const { data } = await db.from("certificates")
    .select("code").like("code", `${codePrefix}%`)
    .order("code", { ascending: false }).limit(1);
  const last = data?.[0]?.code;
  const n = last ? parseInt(last.slice(codePrefix.length), 10) + 1 : 1;
  return codePrefix + String(n).padStart(4, "0");
}

async function adminIssueCert(body: Record<string, unknown>) {
  const bookingId = String(body.booking_id ?? "");
  const attendees = Array.isArray(body.attendees) ? body.attendees : [];
  if (!attendees.length || attendees.length > 20) return json({ ok: false, error: "INVALID_ATTENDEES" }, 400);

  const { data: booking, error: bErr } = await db.from("bookings")
    .select("id,payment_status,course_type").eq("id", bookingId).in("channel", CHANNELS).maybeSingle();
  if (bErr) throw bErr;
  if (!booking) return json({ ok: false, error: "BOOKING_NOT_FOUND" }, 404);
  if (booking.payment_status !== "ชำระแล้ว") return json({ ok: false, error: "NOT_PAID" }, 400);

  const { data: course, error: courseErr } = await db.from("courses")
    .select("key,cert_prefix").eq("key", booking.course_type).not("cert_prefix", "is", null).maybeSingle();
  if (courseErr) throw courseErr;
  if (!course) return json({ ok: false, error: "INVALID_COURSE" }, 400);

  const issued: Array<{ name: string; code: string; expires_at: string }> = [];
  for (const a of attendees) {
    const name = String((a as Record<string, unknown>).name ?? "").trim();
    if (!name) return json({ ok: false, error: "INVALID_ATTENDEE_NAME" }, 400);
    const email = String((a as Record<string, unknown>).email ?? "").trim();
    const phone = String((a as Record<string, unknown>).phone ?? "").trim();
    let inserted = false;
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      const code = await nextCertCode(course.cert_prefix as string);
      const issuedAt = new Date().toISOString();
      const { error } = await db.from("certificates").insert({
        learner_id: crypto.randomUUID(), kind: course.key, code,
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
  for (const c of issued) {
    await logAudit(body.actor, "issue_cert", { bookingId, certCode: c.code, detail: { name: c.name } });
  }
  return json({ ok: true, certificates: issued });
}

async function adminRevokeCert(body: Record<string, unknown>) {
  const code = String(body.code ?? "").trim().toUpperCase();
  if (!CERT_CODE_RE.test(code)) return json({ ok: false, error: "INVALID_CODE" }, 400);
  const keys = await managedCourseKeys();
  const { data, error } = await db.from("certificates")
    .update({ revoked_at: new Date().toISOString() })
    .eq("code", code).in("kind", keys).select("code");
  if (error) throw error;
  if (!data?.length) return json({ ok: false, error: "NOT_FOUND" }, 404);
  await logAudit(body.actor, "revoke_cert", { certCode: code });
  return json({ ok: true });
}

async function adminListCerts(body: Record<string, unknown>) {
  const keys = await managedCourseKeys();
  let q = db.from("certificates")
    .select("code,kind,learner_name,issued_at,revoked_at")
    .in("kind", keys).order("issued_at", { ascending: false }).limit(500);
  if (body.course_key) q = q.eq("kind", String(body.course_key));
  const { data, error } = await q;
  if (error) throw error;
  return json({
    ok: true,
    certificates: (data ?? []).map((c) => ({ ...c, expires_at: certExpiry(c.issued_at) })),
  });
}

async function adminListAuditLog(body: Record<string, unknown>) {
  let q = db.from("bcpr_audit_log")
    .select("id,created_at,actor,action,booking_id,class_id,cert_code,detail")
    .order("created_at", { ascending: false }).limit(500);
  if (body.booking_id) q = q.eq("booking_id", String(body.booking_id));
  if (body.action) q = q.eq("action", String(body.action));
  const { data, error } = await q;
  if (error) throw error;
  return json({ ok: true, entries: data ?? [] });
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
    if (action === "list_courses") return await listCourses();
    if (action === "list_classes") return await listClasses(body);
    if (action === "create_booking") return await createBooking(body, req);
    if (action === "verify_cert") return await verifyCert(body);

    // admin
    if (action.startsWith("admin_")) {
      const key = req.headers.get("x-admin-key") ?? "";
      if (!(await isValidAdminKey(key))) return json({ ok: false, error: "UNAUTHORIZED" }, 401);
      switch (action) {
        case "admin_ping": return json({ ok: true });
        case "admin_list_courses": return await adminListCourses();
        case "admin_update_course": return await adminUpdateCourse(body);
        case "admin_list_classes": return await adminListClasses(body);
        case "admin_create_class": return await adminCreateClass(body);
        case "admin_update_class": return await adminUpdateClass(body);
        case "admin_list_bookings": return await adminListBookings(body);
        case "admin_create_booking": return await adminCreateBooking(body);
        case "admin_sign_slip": return await adminSignSlip(body);
        case "admin_update_booking": return await adminUpdateBooking(body);
        case "admin_issue_cert": return await adminIssueCert(body);
        case "admin_revoke_cert": return await adminRevokeCert(body);
        case "admin_list_certs": return await adminListCerts(body);
        case "admin_list_audit_log": return await adminListAuditLog(body);
      }
    }
    return json({ ok: false, error: "UNKNOWN_ACTION" }, 400);
  } catch (e) {
    console.error("bcpr-api error", action, e);
    return json({ ok: false, error: "SERVER_ERROR" }, 500);
  }
});
