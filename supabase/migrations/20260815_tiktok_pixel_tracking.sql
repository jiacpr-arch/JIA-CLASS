-- TikTok Ads tracking (additive only) — เก็บ ttclid + ip/user-agent ตอนลูกค้าจองผ่านหน้าเว็บ
-- (channel class-web) แล้วใช้ยิง CompletePayment ไปหา TikTok Events API (server-side) ตอนแอดมิน
-- อนุมัติสลิป (payment_status -> 'ชำระแล้ว') เพราะระบบนี้ไม่มี payment gateway callback แบบ
-- real-time ให้ยิง conversion event ตอนลูกค้ากดจ่ายเงินจริง — "ส่งคำจอง" บนหน้าเว็บเป็นแค่ส่งสลิปรอตรวจ
-- tiktok_sent_at กันยิงซ้ำถ้าแอดมินแก้ไข booking หลังอนุมัติแล้วซ้ำอีกครั้ง

alter table bookings add column if not exists ttclid text;
alter table bookings add column if not exists client_ip text;
alter table bookings add column if not exists client_user_agent text;
alter table bookings add column if not exists tiktok_sent_at timestamptz;

-- ลบ overload พารามิเตอร์เดิม (8 args) ก่อน ไม่งั้น create or replace ด้วย signature ใหม่ (11 args)
-- จะกลายเป็นสร้างฟังก์ชันใหม่เพิ่มขึ้นมาอีกตัว (ตามที่เจอมาแล้วใน 20260814_restore_sales_staff_param.sql)
drop function if exists public.class_create_booking(text,text,text,text,text,int,text,text);

create or replace function public.class_create_booking(
  p_id text, p_class_id text, p_name text, p_tel text, p_email text,
  p_people int, p_note text, p_slip_path text,
  p_ttclid text default null, p_client_ip text default null, p_client_user_agent text default null
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
    start_date, time_slot, total_days, note, pdpa_consent, pdpa_consent_date,
    ttclid, client_ip, client_user_agent)
  values (p_id, p_name, p_tel, coalesce(p_email,''), v_key, v_label, p_class_id, 'class-web',
    p_people, v_price * p_people, 'promptpay', p_slip_path, 'รอตรวจสอบ',
    v_date, v_slot, v_days, coalesce(p_note,''), true, current_date,
    nullif(p_ttclid,''), nullif(p_client_ip,''), nullif(p_client_user_agent,''));
  return jsonb_build_object('ok', true, 'id', p_id, 'total', v_price * p_people,
    'course_key', v_key, 'course_name', v_label, 'date', v_date, 'time_slot', v_slot);
end $$;
revoke all on function public.class_create_booking(text,text,text,text,text,int,text,text,text,text,text) from public, anon, authenticated;
