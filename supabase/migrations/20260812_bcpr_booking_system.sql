-- B-CPR booking system (additive only) — applied to jia-unified as migration "bcpr_booking_system"

-- 1) course row
insert into courses (key, label, price, online_booking, max_students, time_slots, duration_hours, total_days, description)
values ('B-CPR', 'B-CPR การช่วยชีวิตขั้นพื้นฐานสำหรับประชาชน', 600, true, 20,
        '["09:00-12:00","13:00-16:00"]'::jsonb, 3, 1,
        'หลักสูตรการกู้ชีพขั้นพื้นฐาน (Basic Cardiopulmonary Resuscitation: B-CPR) ตามประกาศ สพฉ. — CPR, AED, การช่วยผู้สำลัก 3 ชั่วโมง 600 บาท/ท่าน')
on conflict (key) do nothing;

-- 2) extend certificates kind check (widen allowed values; existing rows unaffected)
alter table certificates drop constraint certificates_kind_check;
alter table certificates add constraint certificates_kind_check
  check (kind in ('theory','practical','B-CPR'));

-- 3) additive booking columns
alter table bookings add column if not exists email text default '';
alter table bookings add column if not exists attended_at timestamptz;

-- 4) PromptPay config (placeholder until real QR provided)
insert into settings (key, value) values
  ('bcpr_promptpay_id',   'PLACEHOLDER'),
  ('bcpr_promptpay_name', 'บริษัท เจี่ยรักษา จำกัด')
on conflict (key) do nothing;

-- 5) indexes for hot paths
create index if not exists idx_classes_course_date on classes (course_key, date);
create index if not exists idx_bookings_class_status on bookings (class_id, payment_status);

-- 6) atomic booking creation (capacity-safe)
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
  return jsonb_build_object('ok', true, 'id', p_id, 'total', v_price * p_people);
end $$;

revoke all on function public.bcpr_create_booking(text,text,text,text,text,int,text,text,text) from public, anon, authenticated;
