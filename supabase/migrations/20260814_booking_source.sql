-- Booking source attribution (additive) — apply to jia-unified as migration "booking_source"
-- เก็บ "ที่มา" ของการจองจากหน้าเว็บ (utm_source ของเว็บบริวารในเครือ morroo ที่ deep-link
-- เข้ามาที่ booking.html เช่น acls-app, bls-app, firstaid, cpr-online) เพื่อใช้ดูรายงานว่า
-- แต่ละเว็บส่งลูกค้ามาจองเท่าไหร่ — null = เข้ามาจองที่ class.morroo.com ตรงๆ

alter table bookings add column if not exists booking_source text;

-- แทนที่ class_create_booking ด้วยเวอร์ชัน 9 พารามิเตอร์ (เพิ่ม p_source)
-- ต้อง drop เวอร์ชัน 8 พารามิเตอร์ก่อนใน migration เดียวกัน: ถ้าใช้ create or replace
-- เฉยๆ จะได้ function overload ตัวที่สอง แล้ว PostgREST .rpc() แบบ named params จะ
-- เจอความกำกวม (PGRST203) ทันที — p_source มี default จึง backward-compatible:
-- edge function ตัวเดิมที่ยังส่ง 8 ตัวทำงานต่อได้ระหว่างรอ deploy ตัวใหม่
drop function if exists public.class_create_booking(text,text,text,text,text,int,text,text);

create function public.class_create_booking(
  p_id text, p_class_id text, p_name text, p_tel text, p_email text,
  p_people int, p_note text, p_slip_path text, p_source text default null
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
   where cl.id = p_class_id and cl.status = 'ready'
     and co.online_booking = true and co.cert_prefix is not null;
  if not found then return jsonb_build_object('ok', false, 'error', 'CLASS_NOT_OPEN'); end if;
  select coalesce(sum(total_people),0) into v_taken from bookings
    where class_id = p_class_id and payment_status in ('รอตรวจสอบ','ชำระแล้ว');
  if v_taken + p_people > v_max then
    return jsonb_build_object('ok', false, 'error', 'FULL', 'seats_left', greatest(v_max - v_taken, 0));
  end if;
  insert into bookings (id, name, tel, email, course_type, course_name, class_id, channel,
    total_people, final_price, payment_mode, payment_slip, payment_status,
    start_date, time_slot, total_days, note, pdpa_consent, pdpa_consent_date, booking_source)
  values (p_id, p_name, p_tel, coalesce(p_email,''), v_key, v_label, p_class_id, 'class-web',
    p_people, v_price * p_people, 'promptpay', p_slip_path, 'รอตรวจสอบ',
    v_date, v_slot, v_days, coalesce(p_note,''), true, current_date,
    nullif(trim(coalesce(p_source,'')), ''));
  return jsonb_build_object('ok', true, 'id', p_id, 'total', v_price * p_people, 'course_key', v_key, 'course_name', v_label);
end $$;
revoke all on function public.class_create_booking(text,text,text,text,text,int,text,text,text) from public, anon, authenticated;
