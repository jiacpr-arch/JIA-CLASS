-- Add BLS Healthcare Provider and ACLS Team Member (Blue Code) to the online booking
-- system, using the same pattern as 20260813_multicourse_booking.sql — the generic
-- class_create_booking/class_admin_create_booking functions already handle any course
-- row with cert_prefix is not null, so no function changes are needed here.

-- 1) seed the 2 new individually-priced courses
insert into courses (key, label, price, online_booking, max_students, time_slots, duration_hours, total_days, description, cert_prefix)
values
  ('BLS-HCP', 'BLS Healthcare Provider (BLS สำหรับบุคลากรการแพทย์)', 2500, true, 20,
   '["09:00-13:00","13:00-17:00"]'::jsonb, 4, 1,
   'หลักสูตร BLS เฉพาะทางสำหรับบุคลากรการแพทย์ — High Quality CPR, 2-Rescuer CPR, Bag-Mask, Special Situations 4 ชั่วโมง', 'BLSH'),
  ('ACLS-TEAM', 'ACLS Team Member (สมาชิกทีมช่วยชีวิต / Code Blue)', 5900, true, 16,
   '["09:00-17:00"]'::jsonb, 8, 1,
   'หลักสูตรฝึกบทบาท Team Member สำหรับทีม Code Blue/RRT — CPR, Airway, IV, Drug, Monitor, Team Simulation 1 วัน 8 ชั่วโมง', 'ACLT')
on conflict (key) do nothing;

-- 2) widen certificates kind check to cover the new course keys
alter table certificates drop constraint certificates_kind_check;
alter table certificates add constraint certificates_kind_check
  check (kind in ('theory','practical','B-CPR','ACLS-FULL','AIRWAY','DEFIB','VASCULAR','BLS-HCP','ACLS-TEAM'));
