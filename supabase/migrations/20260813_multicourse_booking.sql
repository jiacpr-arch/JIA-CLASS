-- Multi-course online booking (additive only) — applied to jia-unified as migration "multicourse_booking"
-- Extends the B-CPR booking system to cover the other individually-priced courses,
-- reusing the same courses/classes/bookings/certificates tables.
--
-- cert_prefix does double duty: (a) the 4-letter certificate code prefix, and
-- (b) the membership marker for "this course belongs to the class.morroo.com booking
-- system" — `cert_prefix is not null` is the universal filter used everywhere to
-- guarantee zero interaction with cpr.morroo.com's `joincourse`/`privateclass` rows,
-- which always keep `cert_prefix = null`.

-- 1) cert_prefix column + backfill for the existing B-CPR row
alter table courses add column if not exists cert_prefix text;
create unique index if not exists courses_cert_prefix_key on courses (cert_prefix);
update courses set cert_prefix = 'BCPR' where key = 'B-CPR' and cert_prefix is null;

-- 2) seed the 4 individually-priced courses agreed with the owner
insert into courses (key, label, price, online_booking, max_students, time_slots, duration_hours, total_days, description, cert_prefix)
values
  ('ACLS-FULL', 'ACLS Full Course (การช่วยฟื้นคืนชีพขั้นสูง)', 9900, true, 8,
   '["09:00-17:00"]'::jsonb, 16, 2,
   'หลักสูตรการช่วยฟื้นคืนชีพขั้นสูงสำหรับบุคลากรทางการแพทย์ (Advanced Cardiovascular Life Support) 2 วัน 16 ชั่วโมง', 'ACLS'),
  ('AIRWAY', 'Emergency Airway Management Workshop (การจัดการทางเดินหายใจฉุกเฉิน)', 2900, true, 12,
   '["09:00-13:00","13:00-17:00"]'::jsonb, 4, 1,
   'เวิร์กช็อปการจัดการทางเดินหายใจฉุกเฉิน 4 ชั่วโมง', 'AIRW'),
  ('DEFIB', 'Emergency Defibrillation & AED Workshop (ใช้เครื่องกระตุกหัวใจ)', 3500, true, 12,
   '["09:00-13:00","13:00-17:00"]'::jsonb, 4, 1,
   'เวิร์กช็อปการใช้เครื่องกระตุกหัวใจไฟฟ้าชนิดอัตโนมัติ (AED) 4 ชั่วโมง', 'DEFB'),
  ('VASCULAR', 'Emergency Vascular Access Workshop (เปิดเส้นเลือดฉุกเฉิน)', 2500, true, 12,
   '["09:00-12:00","13:00-16:00"]'::jsonb, 3, 1,
   'เวิร์กช็อปการเปิดเส้นเลือดฉุกเฉิน 3 ชั่วโมง', 'VASC')
on conflict (key) do nothing;

-- 3) widen certificates kind check to cover the new course keys
alter table certificates drop constraint certificates_kind_check;
alter table certificates add constraint certificates_kind_check
  check (kind in ('theory','practical','B-CPR','ACLS-FULL','AIRWAY','DEFIB','VASCULAR'));

-- 4) atomic booking creation for any managed course (capacity-safe)
-- bcpr_create_booking is left in place (not dropped) so any browser tab still
-- caching the old single-course booking page keeps working during rollout.
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
    start_date, time_slot, total_days, note, pdpa_consent, pdpa_consent_date)
  values (p_id, p_name, p_tel, coalesce(p_email,''), v_key, v_label, p_class_id, 'class-web',
    p_people, v_price * p_people, 'promptpay', p_slip_path, 'รอตรวจสอบ',
    v_date, v_slot, v_days, coalesce(p_note,''), true, current_date);
  return jsonb_build_object('ok', true, 'id', p_id, 'total', v_price * p_people, 'course_key', v_key, 'course_name', v_label);
end $$;
revoke all on function public.class_create_booking(text,text,text,text,text,int,text,text) from public, anon, authenticated;

-- 5) indexes for hot paths
create index if not exists idx_classes_course_key_date on classes (course_key, date);
create index if not exists idx_courses_cert_prefix on courses (cert_prefix) where cert_prefix is not null;
