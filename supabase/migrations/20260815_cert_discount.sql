-- ส่วนลดคอร์สด้วยเลขใบประกาศนียบัตร (เช่น ใบ ACLS ออนไลน์ -> ลด 1,000 ฿ ใน ACLS Full Course)
-- additive: ไม่แตะแถวเดิม; class_create_booking เวอร์ชันใหม่มี p_discount_code default null
-- (edge function ตัวเก่าที่ยังส่ง 9 พารามิเตอร์ทำงานต่อได้ระหว่างรอ deploy ตัวใหม่)
--
-- กติกา: โค้ด = certificates.code ที่ยังไม่ถูกเพิกถอน/หมดอายุ (CERT_VALID_YEARS = 2), kind ของใบต้องอยู่ใน
-- course_cert_discounts ของคอร์สที่จอง, ใช้ได้ครั้งเดียวต่อโค้ด (นับการจองสถานะ รอตรวจสอบ/ชำระแล้ว —
-- จองที่ถูกยกเลิก/ปฏิเสธคืนสิทธิ์), ลดครั้งเดียวต่อการจอง (ไม่คูณตามจำนวนคน)
--
-- ใบ kind 'ACLS-ONLINE' ยังไม่มีผู้ออกในระบบนี้ (ใบ theory เดิมเป็นของคอร์สปฐมพยาบาลออนไลน์) —
-- ส่วนลดจึงยังไม่มีผลจนกว่าจะออกใบ kind นี้ (prefix ที่เข้ากับ CERT_CODE_RE เช่น ACLO-2026-0001)

-- 1) อนุญาต kind ใหม่
alter table certificates drop constraint certificates_kind_check;
alter table certificates add constraint certificates_kind_check
  check (kind in ('theory','practical','B-CPR','ACLS-FULL','AIRWAY','DEFIB','VASCULAR','ACLS-ONLINE'));

-- 2) ตารางกติกา: คอร์สไหน รับใบ kind ไหน ลดเท่าไร (แก้ราคา/ปิดส่วนลดได้ด้วย update — ไม่ต้อง deploy)
create table if not exists course_cert_discounts (
  course_key text not null,
  cert_kind  text not null,
  amount     integer not null check (amount > 0),
  active     boolean not null default true,
  primary key (course_key, cert_kind)
);
alter table course_cert_discounts enable row level security; -- ไม่มี policy: เข้าถึงได้เฉพาะ service role
insert into course_cert_discounts (course_key, cert_kind, amount)
values ('ACLS-FULL', 'ACLS-ONLINE', 1000)
on conflict do nothing;

-- 3) บันทึกส่วนลดที่ใช้ในการจอง (final_price เป็นยอดหลังหักแล้ว)
alter table bookings add column if not exists discount_cert_code text;
alter table bookings add column if not exists discount_amount integer not null default 0;
create index if not exists idx_bookings_discount_code on bookings (discount_cert_code) where discount_cert_code is not null;

-- 4) ตรวจโค้ด (ใช้ทั้งตอนกด "ใช้โค้ด" และตอนจองจริง)
create or replace function public.class_check_discount(p_course_key text, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_code text := upper(trim(coalesce(p_code, '')));
  v_cert record;
  v_amount int;
begin
  if v_code = '' then return jsonb_build_object('ok', false, 'error', 'NO_CODE'); end if;
  select kind, issued_at, revoked_at into v_cert from certificates where code = v_code;
  if not found then return jsonb_build_object('ok', false, 'error', 'CERT_NOT_FOUND'); end if;
  if v_cert.revoked_at is not null then return jsonb_build_object('ok', false, 'error', 'CERT_REVOKED'); end if;
  if v_cert.issued_at + interval '2 years' < now() then
    return jsonb_build_object('ok', false, 'error', 'CERT_EXPIRED');
  end if;
  select amount into v_amount from course_cert_discounts
   where course_key = p_course_key and cert_kind = v_cert.kind and active;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_ELIGIBLE'); end if;
  if exists (select 1 from bookings where discount_cert_code = v_code
               and payment_status in ('รอตรวจสอบ','ชำระแล้ว')) then
    return jsonb_build_object('ok', false, 'error', 'ALREADY_USED');
  end if;
  return jsonb_build_object('ok', true, 'amount', v_amount, 'code', v_code);
end $$;
revoke all on function public.class_check_discount(text, text) from public, anon, authenticated;

-- 5) class_create_booking + p_discount_code (drop 9 พารามิเตอร์ก่อน กัน overload ซ้ำ -> PGRST203)
drop function if exists public.class_create_booking(text,text,text,text,text,int,text,text,text);

create function public.class_create_booking(
  p_id text, p_class_id text, p_name text, p_tel text, p_email text,
  p_people int, p_note text, p_slip_path text, p_source text default null,
  p_discount_code text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_max int; v_taken int; v_date date; v_slot text;
  v_key text; v_label text; v_price numeric; v_days int;
  v_code text := nullif(upper(trim(coalesce(p_discount_code, ''))), '');
  v_disc int := 0; v_chk jsonb; v_total numeric;
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

  if v_code is not null then
    -- กันสองคำขอใช้โค้ดเดียวกันพร้อมกัน
    perform pg_advisory_xact_lock(hashtext('discount_' || v_code));
    v_chk := public.class_check_discount(v_key, v_code);
    if not (v_chk->>'ok')::boolean then
      return jsonb_build_object('ok', false, 'error', 'DISCOUNT_' || (v_chk->>'error'));
    end if;
    v_disc := (v_chk->>'amount')::int;
  end if;
  v_total := greatest(v_price * p_people - v_disc, 0);

  insert into bookings (id, name, tel, email, course_type, course_name, class_id, channel,
    total_people, final_price, payment_mode, payment_slip, payment_status,
    start_date, time_slot, total_days, note, pdpa_consent, pdpa_consent_date, booking_source,
    discount_cert_code, discount_amount)
  values (p_id, p_name, p_tel, coalesce(p_email,''), v_key, v_label, p_class_id, 'class-web',
    p_people, v_total, 'promptpay', p_slip_path, 'รอตรวจสอบ',
    v_date, v_slot, v_days, coalesce(p_note,''), true, current_date,
    nullif(trim(coalesce(p_source,'')), ''),
    v_code, v_disc);
  return jsonb_build_object('ok', true, 'id', p_id, 'total', v_total, 'discount', v_disc,
    'course_key', v_key, 'course_name', v_label);
end $$;
revoke all on function public.class_create_booking(text,text,text,text,text,int,text,text,text,text) from public, anon, authenticated;
