-- B-CPR: admin booking + notification support (additive only) — jia-unified migration "bcpr_admin_booking_notify"
-- 1) bcpr_create_booking คืนค่า date/time_slot เพิ่ม (สำหรับข้อความแจ้งเตือน) — signature เดิม ไม่กระทบผู้เรียกเดิม
-- 2) bcpr_admin_create_booking สำหรับแอดมิน/เซลล์ลงจองแทนลูกค้า (ไม่บังคับสลิป กำหนดราคา/สถานะ/ช่องทางชำระได้)

-- 1) atomic booking creation (capacity-safe) — now also returns class date/time_slot
create or replace function public.bcpr_create_booking(
  p_id text, p_class_id text, p_name text, p_tel text, p_email text,
  p_people int, p_note text, p_slip_path text, p_course_name text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_max int; v_taken int; v_date date; v_slot text; v_price numeric;
begin
  perform pg_advisory_xact_lock(hashtext('bcpr_class_' || p_class_id));
  select c.max_students, c.date, c.time_slot into v_max, v_date, v_slot
    from classes c where c.id = p_class_id and c.course_key = 'B-CPR' and c.status = 'ready';
  if not found then
    return jsonb_build_object('ok', false, 'error', 'CLASS_NOT_OPEN');
  end if;
  select coalesce(price, 600) into v_price from courses where key = 'B-CPR';
  select coalesce(sum(total_people),0) into v_taken from bookings
    where class_id = p_class_id and payment_status in ('รอตรวจสอบ','ชำระแล้ว');
  if v_taken + p_people > v_max then
    return jsonb_build_object('ok', false, 'error', 'FULL', 'seats_left', greatest(v_max - v_taken, 0));
  end if;
  insert into bookings (id, name, tel, email, course_type, course_name, class_id, channel,
    total_people, final_price, payment_mode, payment_slip, payment_status,
    start_date, time_slot, total_days, note, pdpa_consent, pdpa_consent_date)
  values (p_id, p_name, p_tel, coalesce(p_email,''), 'B-CPR', p_course_name, p_class_id, 'bcpr-web',
    p_people, v_price * p_people, 'promptpay', p_slip_path, 'รอตรวจสอบ',
    v_date, v_slot, 1, coalesce(p_note,''), true, current_date);
  return jsonb_build_object('ok', true, 'id', p_id, 'total', v_price * p_people,
    'date', v_date, 'time_slot', v_slot);
end $$;

revoke all on function public.bcpr_create_booking(text,text,text,text,text,int,text,text,text) from public, anon, authenticated;

-- 2) admin/sales booking on behalf of a customer (channel='bcpr-admin', no slip required)
create or replace function public.bcpr_admin_create_booking(
  p_id text, p_class_id text, p_name text, p_tel text, p_email text,
  p_people int, p_note text, p_course_name text,
  p_final_price numeric, p_payment_mode text, p_payment_status text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_max int; v_taken int; v_date date; v_slot text; v_price numeric;
begin
  if p_payment_status not in ('รอตรวจสอบ','ชำระแล้ว') then
    return jsonb_build_object('ok', false, 'error', 'INVALID_STATUS');
  end if;
  perform pg_advisory_xact_lock(hashtext('bcpr_class_' || p_class_id));
  select c.max_students, c.date, c.time_slot into v_max, v_date, v_slot
    from classes c where c.id = p_class_id and c.course_key = 'B-CPR' and c.status = 'ready';
  if not found then
    return jsonb_build_object('ok', false, 'error', 'CLASS_NOT_OPEN');
  end if;
  select coalesce(sum(total_people),0) into v_taken from bookings
    where class_id = p_class_id and payment_status in ('รอตรวจสอบ','ชำระแล้ว');
  if v_taken + p_people > v_max then
    return jsonb_build_object('ok', false, 'error', 'FULL', 'seats_left', greatest(v_max - v_taken, 0));
  end if;
  if p_final_price is null or p_final_price < 0 then
    select coalesce(price, 600) * p_people into v_price from courses where key = 'B-CPR';
  else
    v_price := p_final_price;
  end if;
  insert into bookings (id, name, tel, email, course_type, course_name, class_id, channel,
    total_people, final_price, payment_mode, payment_slip, payment_status,
    start_date, time_slot, total_days, note, pdpa_consent, pdpa_consent_date)
  values (p_id, p_name, p_tel, coalesce(p_email,''), 'B-CPR', p_course_name, p_class_id, 'bcpr-admin',
    p_people, v_price, coalesce(nullif(p_payment_mode,''), 'โอนเงิน'), '', p_payment_status,
    v_date, v_slot, 1, coalesce(p_note,''), true, current_date);
  return jsonb_build_object('ok', true, 'id', p_id, 'total', v_price,
    'date', v_date, 'time_slot', v_slot);
end $$;

revoke all on function public.bcpr_admin_create_booking(text,text,text,text,text,int,text,text,numeric,text,text) from public, anon, authenticated;
