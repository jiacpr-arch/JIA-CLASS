-- Restore fields that got overwritten by later same-named CREATE OR REPLACE migrations
-- landing from a different branch, so replaying the full migration history in filename
-- order reconstructs the same function bodies the live jia-unified database actually
-- carries today. Both fixes below are no-ops against the live database (idempotent)
-- and only matter for anyone replaying migrations from scratch (fresh dev DB, disaster
-- recovery) — nothing here needs to be (or was) applied to production.
--
-- 1) class_create_booking: 20260813_class_admin_booking_notify.sql added `date`/
--    `time_slot` to the return value; 20260813_multicourse_booking.sql (alphabetically
--    later — 'm' > 'c') then replaced the function again without them.
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

-- 2) class_admin_create_booking: this branch's 20260812_bcpr_audit_log.sql added the
--    p_sales_staff parameter; 20260813_class_admin_booking_notify.sql (landing on main
--    from a different branch) then replaced the function again without it.
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
