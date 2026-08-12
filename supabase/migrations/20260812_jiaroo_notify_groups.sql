-- ตารางเก็บรายชื่อห้องกลุ่ม LINE ที่ให้ส่งแจ้งเตือนจองใหม่เข้าไป (รองรับได้หลายกลุ่ม)
-- แถวถูกเพิ่ม/ปิดอัตโนมัติจาก event join/leave ของ jiaroo-line-webhook เมื่อ LINE OA
-- ถูกเชิญเข้า/ออกจากกลุ่ม — ไม่มีการแก้ไขผ่าน UI จึงล็อก RLS ไว้เฉพาะ service role เหมือน jiaroo_secrets
create table if not exists public.jiaroo_notify_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_slug text not null references public.jiaroo_tenants(slug),
  group_id text not null,
  group_name text,
  active boolean not null default true,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  unique (tenant_slug, group_id)
);

alter table public.jiaroo_notify_groups enable row level security;

create index if not exists idx_jiaroo_notify_groups_active
  on public.jiaroo_notify_groups (tenant_slug) where active;
