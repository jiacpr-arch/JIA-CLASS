-- Class booking: admin/sales booking + notification support (additive only) — jia-unified migration "class_admin_booking_notify"
-- แทนที่ migration ก่อนหน้า (20260812_bcpr_admin_booking_notify.sql) ซึ่งเขียนอิงระบบ B-CPR คอร์สเดียว
-- ระบบจริงเป็นแบบหลายคอร์สแล้ว (class_create_booking / channel class-web)
-- 1) class_create_booking คืนค่า date/time_slot เพิ่ม (สำหรับข้อความแจ้งเตือน) — signature เดิม ไม่กระทบผู้เรียกเดิม
-- 2) class_admin_create_booking สำหรับแอดมิน/เซลล์ลงจองแทนลูกค้า (ไม่บังคับสลิป กำหนดราคา/สถานะ/ช่องทางชำระได้)
-- 3) ลบ bcpr_admin_create_booking ที่ถูกแทนที่

-- 1) atomic booking creation (multi-course, capacity-safe) — now also returns class date/time_slot
create or replace function public.class_create_booking(
  p_id text, p_class_id text, p_name text, p_tel text, p_email text,
  p_people int, p_note text, p_slip_path text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_max int; v_taken int; v_date date; v_slot text;
  v_key text; v_label text; v_price numeric; v_days int;
begin
  perform pg_advisory_xact_lock(hashtext('class_' || p_class_id));
  select cl.max_students, cl.date, cl.time_slot, co.key, co.label, co.price, coalesce(co.total_days,1)
    into v_max, v_date, v_slot, v_key, v_label, v_price, v_days
    from classes cl
    join courses co on co.key = cl.course_key
   where cl.id = p_class_id
     and cl.status = 'ready'
     and co.online_booking = true
     and co.cert_prefix is not null;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'CLASS_NOT_OPEN');
  end if;
  select coalesce(sum(total_people),0) into v_taken from bookings
    where class_id = p_class_id and payment_status in ('รอตรวจสอบ','ชำระแล้ว');
  if v_taken + p_people > v_max then
    return jsonb_build_object('ok', false, 'error', 'FULL', 'seats_left', greatest(v_max - v_taken, 0));
  end if;
  insert into bookings (id, name, tel, email, course_type, course_name, class_id, channel,
    total_people, final_price, payment_mode, payment_slip, payment_status,
    start_date, time_slot, total_days, note, pdpa_consent, pdpa_consent_date)
  values (p_id, p_name, p_tel, coalesce(p_email,''), v_key, v_label, p_class_id, 'class-web',
    p_people, v_price * p_people, 'promptpay', p_slip_path, 'รอตรวจสอบ',
    v_date, v_slot, v_days, coalesce(p_note,''), true, current_date);
  return jsonb_build_object('ok', true, 'id', p_id, 'total', v_price * p_people,
    'course_key', v_key, 'course_name', v_label, 'date', v_date, 'time_slot', v_slot);
end $$;

revoke all on function public.class_create_booking(text,text,text,text,text,int,text,text) from public, anon, authenticated;

-- 2) admin/sales booking on behalf of a customer (channel='class-admin', no slip required)
--    ไม่บังคับ online_booking = true — แอดมินลงจองได้แม้คอร์สปิดรับจองออนไลน์ชั่วคราว
create or replace function public.class_admin_create_booking(
  p_id text, p_class_id text, p_name text, p_tel text, p_email text,
  p_people int, p_note text,
  p_final_price numeric, p_payment_mode text, p_payment_status text
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
    start_date, time_slot, total_days, note, pdpa_consent, pdpa_consent_date)
  values (p_id, p_name, p_tel, coalesce(p_email,''), v_key, v_label, p_class_id, 'class-admin',
    p_people, v_total, coalesce(nullif(p_payment_mode,''), 'โอนเงิน'), '', p_payment_status,
    v_date, v_slot, v_days, coalesce(p_note,''), true, current_date);
  return jsonb_build_object('ok', true, 'id', p_id, 'total', v_total,
    'course_key', v_key, 'course_name', v_label, 'date', v_date, 'time_slot', v_slot);
end $$;

revoke all on function public.class_admin_create_booking(text,text,text,text,text,int,text,numeric,text,text) from public, anon, authenticated;

-- 3) superseded by class_admin_create_booking
drop function if exists public.bcpr_admin_create_booking(text,text,text,text,text,int,text,text,numeric,text,text);
