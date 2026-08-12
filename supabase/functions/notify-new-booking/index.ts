// notify-new-booking
// แจ้งเตือนทีมเซลส์ทาง LINE เมื่อมีลูกค้ากดจองคลาส (booking) ใหม่เข้ามา
// ทริกเกอร์ผ่าน trigger notify_new_booking (AFTER INSERT บน public.bookings → net.http_post)
//
// ผู้รับ = ทุกห้องกลุ่มใน jiaroo_notify_groups ที่ active=true (LINE OA ถูกเชิญไว้) — "กลุ่มเท่านั้น"
//   เพื่อประหยัดโควตา LINE (ส่งรายบุคคล 5 คน + 2 กลุ่ม = 7 ข้อความ/จอง เทียบกับกลุ่มอย่างเดียว = 2)
//   fallback: ถ้าไม่มีกลุ่ม active เลย (OA ถูกเตะออกหมด) จะกลับไปส่งรายบุคคล jiaroo_team ที่ active
//   แทน เพื่อไม่ให้การแจ้งเตือนเงียบหายทั้งระบบ
//   จัดการรายชื่อกลุ่มผ่าน jiaroo-line-webhook: เชิญ LINE OA เข้ากลุ่ม → บันทึกอัตโนมัติ
//   (ดู event join/leave ใน jiaroo-line-webhook/index.ts), ดูรายการกลุ่มปัจจุบันได้ที่
//   GET jiaroo-line-webhook?action=list-groups&key=<admin key>
//
// ข้อความปรับตาม channel ของการจอง:
//   class-web / bcpr-web → จองจากเว็บ class.morroo.com พร้อมสลิป รอตรวจสอบ → ชี้ไปหน้าแอดมินของ class
//   class-admin          → แอดมิน/เซลล์ลงจองแทนลูกค้าเอง (ไม่ต้องรีบติดต่อกลับ แค่แจ้งให้ทีมรู้)
//   อื่นๆ                 → ฟอร์มเดิมของ cpr.morroo.com (ยังไม่มีรอบ/ยังไม่ชำระ) → ชี้ไป cpr.morroo.com/admin
// ทั้ง class-web/bcpr-web และ class-admin แสดง "ที่นั่งคงเหลือ" ของรอบนั้นด้วย (คำนวณสดจาก
// classes.max_students ลบยอดจองปัจจุบันในสถานะ รอตรวจสอบ/ชำระแล้ว — รวมแถวที่เพิ่ง insert ไปแล้ว)
// และถ้ารอบใกล้เต็ม (เหลือ ≤ NEAR_FULL_THRESHOLD) หรือเต็มพอดี จะแทรกบรรทัดเตือนในข้อความเดียวกัน
// (ไม่ส่งข้อความแยก = ไม่กินโควตาเพิ่ม)
//
// โหมดงานตั้งเวลา (เรียกโดย pg_cron ด้วย secret เดียวกัน):
//   POST ?job=pending-slips → เช็ค booking จากเว็บที่ค้างสถานะ "รอตรวจสอบ" เกิน STALE_HOURS ชม.
//   ถ้ามี ส่งรายการเตือนเข้าห้องกลุ่ม (ไม่มี = ไม่ส่งอะไรเลย ไม่กินโควตา) — หน้าเว็บสัญญาลูกค้าไว้ว่า
//   จะตรวจสลิปภายใน 24 ชม. และรายการที่ค้างยังกินที่นั่งของรอบอยู่ด้วย
//   ตั้งเวลาไว้ 08:30 และ 17:30 เวลาไทย (cron job: notify-pending-slips-am / -pm)
//
// Secrets ที่ใช้ (ตั้งผ่าน Supabase, ใช้ร่วมกับฟังก์ชันอื่นในโปรเจกต์):
//   LINE_CHANNEL_ACCESS_TOKEN  (มีอยู่แล้ว — fallback อ่านจากตาราง jiaroo_secrets)
//   NOTIFY_WEBHOOK_SECRET      กันยิง endpoint มั่ว — ตรวจกับ header x-webhook-secret
//
// เทสต์แบบไม่ส่งจริง: POST ?dry_run=1 หรือ body { "dry_run": true } (ใช้ได้กับ ?job=pending-slips ด้วย)
//   → คืนจำนวนผู้รับ + ข้อความตัวอย่าง โดยไม่ push LINE

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const TENANT = "jiaroo";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supa = createClient(SUPABASE_URL, SERVICE_KEY);

const WEBHOOK_SECRET = Deno.env.get("NOTIFY_WEBHOOK_SECRET") || "";

const CLASS_CHANNELS = ["class-web", "bcpr-web"];
const CLASS_ADMIN_CHANNEL = "class-admin";
const CLASS_ADMIN_URL = "https://class.morroo.com/bcpr-admin.html";
const HOLD_STATUSES = ["รอตรวจสอบ", "ชำระแล้ว"];
const NEAR_FULL_THRESHOLD = 3; // เหลือ ≤ เท่านี้ = แทรกคำเตือนใกล้เต็ม
const STALE_HOURS = 12; // สลิปค้างตรวจนานเกินเท่านี้ = เข้ารายการเตือน
const STALE_LIST_MAX = 10; // แสดงในข้อความสูงสุดกี่รายการ (ที่เหลือสรุปเป็นตัวเลข)

// อ่าน LINE token แบบเดียวกับ notify-new-student (env ก่อน แล้วค่อย fallback ตาราง secrets)
async function loadToken(): Promise<string> {
  const env = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") || "";
  if (env) return env;
  const { data } = await supa.from("jiaroo_secrets").select("value")
    .eq("tenant_slug", TENANT).eq("key", "LINE_CHANNEL_ACCESS_TOKEN").maybeSingle();
  return data?.value || "";
}

// ผู้รับรายบุคคล (ใช้เฉพาะ fallback) = คนในทีมเซลส์ที่ยัง active และมี line_user_id
async function getTeamRecipients(): Promise<string[]> {
  const { data } = await supa.from("jiaroo_team").select("line_user_id").eq("active", true);
  const ids = (data || []).map((r: { line_user_id: string | null }) => r.line_user_id)
    .filter((x: string | null): x is string => !!x);
  return [...new Set(ids)];
}

// ผู้รับกลุ่ม = ทุกห้องที่ LINE OA ถูกเชิญไว้และยังไม่ถูกเตะออก (รองรับหลายกลุ่ม)
async function getGroupRecipients(): Promise<string[]> {
  const { data } = await supa.from("jiaroo_notify_groups").select("group_id")
    .eq("tenant_slug", TENANT).eq("active", true);
  const ids = (data || []).map((r: { group_id: string }) => r.group_id);
  return [...new Set(ids)];
}

// ปลายทางที่ใช้ส่งจริง: กลุ่มก่อน ถ้าไม่มีกลุ่มเลยค่อย fallback รายบุคคล (กันแจ้งเตือนเงียบทั้งระบบ)
async function getRecipients(): Promise<{ recipients: string[]; mode: "groups" | "fallback-individuals" }> {
  const groups = await getGroupRecipients();
  if (groups.length > 0) return { recipients: groups, mode: "groups" };
  return { recipients: await getTeamRecipients(), mode: "fallback-individuals" };
}

async function pushMany(token: string, ids: string[], text: string) {
  if (!token) return { sent: 0, failed: 0, skipped: "no LINE token" };
  let sent = 0, failed = 0;
  const errors: string[] = [];
  for (const to of ids) {
    try {
      const r = await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
      });
      if (r.ok) sent++;
      else { failed++; errors.push(`${to.slice(0, 8)}…: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`); }
    } catch (e) {
      failed++; errors.push(`${to.slice(0, 8)}…: ${String(e).slice(0, 120)}`);
    }
  }
  return { sent, failed, errors };
}

// ที่นั่งคงเหลือของรอบที่เพิ่งจอง — รวมยอดจองปัจจุบัน (รวมแถวที่เพิ่ง insert ไปแล้วด้วย) เทียบกับ max_students
// คืน null ถ้าหารอบไม่เจอ (เช่น booking เก่าที่ยังไม่มี class_id) — buildText จะข้ามบรรทัดนี้ไปเงียบๆ
async function getSeatsLeft(classId: string | null | undefined): Promise<{ left: number; max: number } | null> {
  if (!classId) return null;
  const { data: cls } = await supa.from("classes").select("max_students").eq("id", classId).maybeSingle();
  if (!cls) return null;
  const { data: bks } = await supa.from("bookings").select("total_people")
    .eq("class_id", classId).in("payment_status", HOLD_STATUSES);
  const taken = (bks || []).reduce((sum: number, b: { total_people: number | null }) => sum + (b.total_people || 0), 0);
  return { left: Math.max(cls.max_students - taken, 0), max: cls.max_students };
}

// วันที่แบบไทยสั้นๆ สำหรับข้อความ LINE (2026-08-22 → 22 ส.ค. 2569)
const TH_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
function thDate(iso: string | null | undefined): string {
  if (!iso) return "(ยังไม่ระบุ)";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) return String(iso);
  return `${Number(m[3])} ${TH_MONTHS[Number(m[2]) - 1]} ${Number(m[1]) + 543}`;
}

// deno-lint-ignore no-explicit-any
function buildText(rec: any, seats: { left: number; max: number } | null): string {
  const name = rec.name || "(ไม่ระบุชื่อ)";
  const tel = rec.tel || "-";
  const courseName = rec.course_name || rec.course_type || "-";
  const people = rec.total_people ?? "-";
  const timeSlot = rec.time_slot || "(ยังไม่ระบุ)";
  const note = rec.note || "-";
  const price = rec.final_price ?? "-";
  const channel = rec.channel || "";
  let seatsLine = "";
  if (seats) {
    seatsLine = `ที่นั่งคงเหลือ: ${seats.left}/${seats.max} ที่\n`;
    if (seats.left === 0) seatsLine += `🔴 รอบนี้เต็มแล้ว — พิจารณาเปิดรอบใหม่\n`;
    else if (seats.left <= NEAR_FULL_THRESHOLD) seatsLine += `⚠️ ใกล้เต็ม เหลือ ${seats.left} ที่สุดท้าย\n`;
  }

  // จองจากเว็บ class.morroo.com — เลือกรอบเรียนและแนบสลิปมาแล้ว ต้องตรวจสลิปเพื่อยืนยัน
  if (CLASS_CHANNELS.includes(channel)) {
    return `🔔 มีการจองใหม่จากเว็บ class.morroo.com\n\n` +
      `ชื่อ: ${name}\nเบอร์: ${tel}\nคอร์ส: ${courseName}\n` +
      `รอบเรียน: ${thDate(rec.start_date)} ${timeSlot}\n` +
      `จำนวนคน: ${people}\nยอด: ${price}\n${seatsLine}สถานะ: ${rec.payment_status || "-"}\n` +
      `โน้ต: ${note}\n\n` +
      `ตรวจสลิปแล้วกดอนุมัติที่ ${CLASS_ADMIN_URL}`;
  }

  // แอดมิน/เซลส์ลงจองแทนลูกค้าเอง — แจ้งให้ทีมรู้ว่าที่นั่งถูกกันไปแล้ว ไม่ต้องติดต่อกลับ
  if (channel === CLASS_ADMIN_CHANNEL) {
    return `📝 แอดมิน/เซลส์ลงจองแทนลูกค้า\n\n` +
      `ชื่อ: ${name}\nเบอร์: ${tel}\nคอร์ส: ${courseName}\n` +
      `รอบเรียน: ${thDate(rec.start_date)} ${timeSlot}\n` +
      `จำนวนคน: ${people}\nยอด: ${price}\n${seatsLine}` +
      `ชำระโดย: ${rec.payment_mode || "-"} (${rec.payment_status || "-"})\n` +
      `โน้ต: ${note}\n\n` +
      `ที่นั่งถูกกันไว้แล้ว ดูรายการที่ ${CLASS_ADMIN_URL}`;
  }

  // ฟอร์มเดิมของ cpr.morroo.com — ยังไม่มีรอบเรียน/ยังไม่ชำระ ต้องโทรกลับไปนัดวัน
  return `🙋 มีคนกดจองคลาสใหม่!\n\n` +
    `ชื่อ: ${name}\nเบอร์: ${tel}\nคอร์ส: ${courseName}\n` +
    `จำนวนคน: ${people}\nเวลาที่สะดวก: ${timeSlot}\nยอด: ${price}\n` +
    `โน้ต: ${note}\n\n` +
    `รีบติดต่อกลับนัดวัน/รับชำระเงินที่ cpr.morroo.com/admin`;
}

// งานตั้งเวลา: เตือนสลิปจากเว็บที่ค้างสถานะ "รอตรวจสอบ" เกิน STALE_HOURS ชม. — ไม่มีรายการ = ไม่ส่งอะไรเลย
async function runPendingSlipsJob(dryRun: boolean): Promise<Response> {
  const cutoff = new Date(Date.now() - STALE_HOURS * 3600 * 1000).toISOString();
  const { data, error } = await supa.from("bookings")
    .select("id,name,course_name,course_type,start_date,time_slot,total_people,created_at")
    .in("channel", CLASS_CHANNELS).eq("payment_status", "รอตรวจสอบ")
    .lt("created_at", cutoff).order("created_at", { ascending: true }).limit(100);
  if (error) {
    return new Response(JSON.stringify({ ok: false, error: String(error.message) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
  const rows = data || [];
  if (rows.length === 0) {
    return new Response(JSON.stringify({ ok: true, job: "pending-slips", pending: 0, sent: 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // deno-lint-ignore no-explicit-any
  const lines = rows.slice(0, STALE_LIST_MAX).map((b: any, i: number) => {
    const hours = Math.floor((Date.now() - new Date(b.created_at).getTime()) / 3600000);
    const course = b.course_name || b.course_type || "-";
    return `${i + 1}. ${b.name} — ${course} ${thDate(b.start_date)} (ค้าง ${hours} ชม.)`;
  });
  if (rows.length > STALE_LIST_MAX) lines.push(`…และอีก ${rows.length - STALE_LIST_MAX} รายการ`);

  const text = `⏰ มีสลิปรอตรวจสอบค้างเกิน ${STALE_HOURS} ชม. (${rows.length} รายการ)\n\n` +
    lines.join("\n") + `\n\n` +
    `รีบตรวจสลิปแล้วกดอนุมัติ/ปฏิเสธที่ ${CLASS_ADMIN_URL}\n` +
    `(แจ้งลูกค้าไว้ว่าจะตรวจภายใน 24 ชม. และรายการที่ค้างยังกินที่นั่งของรอบอยู่)`;

  const { recipients, mode } = await getRecipients();
  if (dryRun) {
    return new Response(JSON.stringify({ ok: true, dry_run: true, job: "pending-slips", pending: rows.length, mode, recipients: recipients.length, preview: text }), {
      headers: { "Content-Type": "application/json" },
    });
  }
  const token = await loadToken();
  const line = await pushMany(token, recipients, text);
  return new Response(JSON.stringify({ ok: true, job: "pending-slips", pending: rows.length, mode, recipients: recipients.length, line, ran_at: new Date().toISOString() }), {
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // กัน endpoint ถูกยิงมั่ว — fail closed: ต้องตั้ง NOTIFY_WEBHOOK_SECRET เสมอ
  // (trigger notify_new_booking_fn และ cron job แนบ header x-webhook-secret จาก jiaroo_secrets ให้เอง)
  if (!WEBHOOK_SECRET) return new Response("server missing NOTIFY_WEBHOOK_SECRET", { status: 503 });
  {
    const got = req.headers.get("x-webhook-secret") || url.searchParams.get("secret") || "";
    if (got !== WEBHOOK_SECRET) return new Response("unauthorized", { status: 401 });
  }

  // deno-lint-ignore no-explicit-any
  let payload: any = {};
  try { payload = await req.json(); } catch { /* ignore */ }

  const dryRun = payload?.dry_run === true || url.searchParams.get("dry_run") === "1";

  // โหมดงานตั้งเวลา (pg_cron) — แยกจาก flow แจ้งเตือนจองใหม่
  if (url.searchParams.get("job") === "pending-slips") return await runPendingSlipsJob(dryRun);

  // รองรับทั้ง payload ของ Database Webhook ({ type, table, record }) และเรียกทดสอบตรงๆ
  const rec = payload?.record || payload || {};
  if (payload?.type && payload.type !== "INSERT") {
    return new Response(JSON.stringify({ ignored: payload.type }), { headers: { "Content-Type": "application/json" } });
  }

  const seats = await getSeatsLeft(rec.class_id);
  const text = buildText(rec, seats);
  const { recipients, mode } = await getRecipients();

  if (dryRun) {
    return new Response(JSON.stringify({
      ok: true, dry_run: true, mode, recipients: recipients.length, preview: text,
    }), { headers: { "Content-Type": "application/json" } });
  }

  const token = await loadToken();
  const line = await pushMany(token, recipients, text);

  return new Response(JSON.stringify({
    ok: true, mode, recipients: recipients.length,
    line, ran_at: new Date().toISOString(),
  }), { headers: { "Content-Type": "application/json" } });
});
