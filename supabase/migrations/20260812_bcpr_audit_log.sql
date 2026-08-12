-- ระบบ log ตรวจสอบย้อนหลังสำหรับหน้าแอดมิน (bcpr-admin.html) — ไม่แตะ auth เดิม (ยังใช้ admin key เดียวร่วมกัน)
-- แค่ให้ผู้ใช้งานพิมพ์ "ชื่อผู้ใช้งาน" ตอนล็อกอิน แล้วแนบชื่อนั้นมากับทุก action ที่แก้ข้อมูล
-- เพื่อบันทึกไว้ว่า "ใคร" ทำอะไร เมื่อไหร่ — ใช้ตอบคำถาม "เป็นลูกค้าของเซลล์คนไหน" และตรวจสอบย้อนหลังได้

create table if not exists public.bcpr_audit_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  actor text,                 -- ชื่อผู้ทำรายการ (พิมพ์เองตอนล็อกอิน ไม่ได้ verify เข้มงวด — ใช้เพื่อบันทึกไว้ตรวจสอบ)
  action text not null,       -- เช่น create_booking, update_booking, create_class, update_class, issue_cert, revoke_cert
  booking_id text,
  class_id text,
  cert_code text,
  detail jsonb                -- รายละเอียดเพิ่มเติม เช่น patch ที่แก้ / ชื่อลูกค้า / คอร์ส
);

alter table public.bcpr_audit_log enable row level security;
-- ไม่มี policy ใดๆ → เข้าถึงได้เฉพาะ service role (เหมือน bcpr_admin_auth, jiaroo_secrets, jiaroo_notify_groups)

create index if not exists idx_bcpr_audit_log_created_at on public.bcpr_audit_log (created_at desc);
create index if not exists idx_bcpr_audit_log_booking_id on public.bcpr_audit_log (booking_id) where booking_id is not null;

-- เพิ่มพารามิเตอร์ p_sales_staff (default null = ไม่ระบุ) เพื่อบันทึกชื่อผู้ลงจองแทนลูกค้า
-- ไว้ในคอลัมน์ sales_staff ที่มีอยู่แล้วในตาราง bookings
-- ต้อง drop ของเดิม (10 พารามิเตอร์) ก่อน เพราะเพิ่มพารามิเตอร์ = คนละ overload ใน Postgres
-- (ถ้าใช้ create or replace เฉยๆ จะเหลือทั้ง 2 signature ค้างอยู่ ทำให้ PostgREST เลือกฟังก์ชันกำกวม)
drop function if exists public.class_admin_create_booking(text,text,text,text,text,int,text,numeric,text,text);

create or replace function public.class_admin_create_booking(
  p_id text, p_class_id text, p_name text, p_tel text, p_email text,
  p_people int, p_note text,
  p_final_price numeric, p_payment_mode text, p_payment_status text,
  p_sales_staff text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_max int; v_taken int; v_date date; v_slot text;
  v_key text; v_label text; v_price numeric; v_days int; v_total numeric;
begin
  if p_payment_status not in ('รอตรวจสอบ','ชำระแล้ว') then
    return jsonb_build_object('ok', false, 'error', 'INVALID_STATUS');
  end if;
  perform pg_advisory_xact_lock(hashtext('class_' || p_class_id));
  select cl.max_students, cl.date, cl.time_slot, co.key, co.label, co.price, coalesce(co.total_days,1)
    into v_max, v_date, v_slot, v_key, v_label, v_price, v_days
    from classes cl
    join courses co on co.key = cl.course_key
   where cl.id = p_class_id
     and cl.status = 'ready'
     and co.cert_prefix is not null;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'CLASS_NOT_OPEN');
  end if;
  select coalesce(sum(total_people),0) into v_taken from bookings
    where class_id = p_class_id and payment_status in ('รอตรวจสอบ','ชำระแล้ว');
  if v_taken + p_people > v_max then
    return jsonb_build_object('ok', false, 'error', 'FULL', 'seats_left', greatest(v_max - v_taken, 0));
  end if;
  if p_final_price is null or p_final_price < 0 then
    v_total := coalesce(v_price, 0) * p_people;
  else
    v_total := p_final_price;
  end if;
  insert into bookings (id, name, tel, email, course_type, course_name, class_id, channel,
    total_people, final_price, payment_mode, payment_slip, payment_status,
    start_date, time_slot, total_days, note, pdpa_consent, pdpa_consent_date, sales_staff)
  values (p_id, p_name, p_tel, coalesce(p_email,''), v_key, v_label, p_class_id, 'class-admin',
    p_people, v_total, coalesce(nullif(p_payment_mode,''), 'โอนเงิน'), '', p_payment_status,
    v_date, v_slot, v_days, coalesce(p_note,''), true, current_date, coalesce(nullif(p_sales_staff,''), ''));
  return jsonb_build_object('ok', true, 'id', p_id, 'total', v_total,
    'course_key', v_key, 'course_name', v_label, 'date', v_date, 'time_slot', v_slot);
end $$;

revoke all on function public.class_admin_create_booking(text,text,text,text,text,int,text,numeric,text,text,text) from public, anon, authenticated;
