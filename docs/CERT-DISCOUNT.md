# ส่วนลดด้วยเลขใบประกาศนียบัตร

ผู้จองกรอกเลขใบ (เช่น ใบ ACLS ออนไลน์) ในหน้า `booking.html` เพื่อหักราคา — ตอนนี้ตั้งไว้: **ACLS-FULL ลด 1,000 ฿ ด้วยใบ kind `ACLS-ONLINE`**

## กติกา
- โค้ด = `certificates.code` ที่ไม่ถูกเพิกถอน และออกไม่เกิน 2 ปี (เท่า `CERT_VALID_YEARS`)
- kind ของใบต้องอยู่ใน `course_cert_discounts` ของคอร์สที่จอง
- ใช้ได้ครั้งเดียวต่อโค้ด: นับการจองสถานะ `รอตรวจสอบ`/`ชำระแล้ว` — จองที่ยกเลิก/ปฏิเสธคืนสิทธิ์
- ลดครั้งเดียวต่อการจอง (ไม่คูณตามจำนวนคน); ตรวจและหักราคาที่ server (`class_create_booking`) เสมอ — หน้าเว็บแค่แสดงผล
- `bookings.final_price` = ยอดหลังหัก; `discount_cert_code` / `discount_amount` เก็บไว้ตรวจสอบ

## ปรับแต่ง (SQL Editor — ไม่ต้อง deploy)
```sql
-- เปลี่ยนจำนวนส่วนลด
update course_cert_discounts set amount = 1500 where course_key = 'ACLS-FULL' and cert_kind = 'ACLS-ONLINE';
-- ปิดชั่วคราว
update course_cert_discounts set active = false where course_key = 'ACLS-FULL';
-- ให้คอร์สอื่นรับใบอื่น
insert into course_cert_discounts (course_key, cert_kind, amount) values ('AIRWAY', 'ACLS-ONLINE', 500);
```

## ออกใบ ACLS ออนไลน์
ระบบนี้ยังไม่มีผู้ออกใบ kind `ACLS-ONLINE` (ใบ `theory` เดิมเป็นของคอร์สปฐมพยาบาลออนไลน์) ส่วนลดจึงยังไม่มีผลจนกว่าจะออกใบ — รหัสต้องเข้ารูปแบบ `AAAA-YYYY-NNNN` (เช่น `ACLO-2026-0001`) ให้ตรง `CERT_CODE_RE`

## ลำดับ deploy
1. รัน `supabase/migrations/20260815_cert_discount.sql`
2. Deploy edge function `bcpr-api`
3. Publish `booking.html`

(การจองปกติไม่พึ่ง migration นี้ — edge function ส่ง `p_discount_code` เฉพาะเมื่อมีโค้ด)
