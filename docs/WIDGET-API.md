# Widget API — สัญญากลางสำหรับเว็บบริวารในเครือ morroo

เว็บอื่นในเครือ (acls/bls/airway/defib/iv.morroo.com, firstaid.morroo.com,
cpr.morroo.com) แสดง "รอบเรียนที่เปิดจอง" แล้วส่งนักเรียนมาจองที่
**class.morroo.com** ที่เดียว ผ่าน endpoint สาธารณะของ `bcpr-api`

## Endpoint

```
POST https://tpoiyykbgsgnrdwzgzvn.supabase.co/functions/v1/bcpr-api
Headers: Content-Type: application/json
         Authorization: Bearer <ANON_KEY>
         apikey: <ANON_KEY>
```

ANON_KEY เป็น key สาธารณะ (ตัวเดียวกับที่ฝังอยู่ใน booking.html) — hardcode ในเว็บบริวารได้

## Action ที่วิดเจ็ตใช้

### `list_upcoming` — รอบเรียนทุกคอร์สที่เปิดจองออนไลน์ ในคำขอเดียว

```json
{ "action": "list_upcoming" }
```

ตอบ:

```json
{ "ok": true, "classes": [
  { "class_id": "...", "course_key": "B-CPR", "label": "B-CPR ...", "price": 600,
    "date": "2026-08-22", "time_slot": "09:00-12:00", "place": "", "seats_left": 5 }
] }
```

- เรียงตามวันที่ใกล้สุดก่อน, สูงสุด 20 รอบ, เฉพาะรอบ `status=ready` ที่ยังไม่ผ่านมา
- **กติกา:** field เดิมห้ามเปลี่ยนชื่อ/ลบ — เพิ่มได้อย่างเดียว (มี 4 repos ใช้อยู่)
- ฝั่งวิดเจ็ต: cache ในหน่วยความจำต่อการโหลดแอปครั้งเดียวพอ + ตั้ง timeout สั้น (~4s)
  แล้ว fallback เป็นปุ่ม LINE @jiacpr เมื่อ fetch ล้มเหลว
- **ราคาต้อง render จากค่า `price` ใน response เสมอ** ห้าม hardcode ในวิดเจ็ต

รายละเอียดเพิ่มเติมต่อคอร์ส: `list_courses` (รายชื่อคอร์ส) และ
`list_classes` + `course_key` (รอบทั้งหมดของคอร์สเดียว) — ดู bcpr-api/index.ts

## Deep link เข้าหน้าจอง

```
https://class.morroo.com/booking.html?course=<COURSE_KEY>&utm_source=<SOURCE>
https://class.morroo.com/booking.html?course=<COURSE_KEY>&class_id=<CLASS_ID>&utm_source=<SOURCE>
```

booking.html จะ preselect คอร์ส (และรอบ ถ้าส่ง class_id มา) และเก็บ `utm_source`
ลง sessionStorage แล้วส่งเป็น `source` ตอน create_booking → ลงคอลัมน์
`bookings.booking_source` + โชว์ในข้อความ LINE แจ้งทีม + หน้า bcpr-admin

## ทะเบียน utm_source (เพิ่มใหม่ให้จดที่นี่)

| ค่า | ที่มา |
|---|---|
| `acls-app` | acls.morroo.com (repo acls-emr, VITE_COURSE_MODE=acls) |
| `bls-app` | bls.morroo.com |
| `airway-app` | airway.morroo.com |
| `defib-app` | defib.morroo.com |
| `iv-app` | iv.morroo.com |
| `firstaid` | firstaid.morroo.com (วิดเจ็ตหน้าคลาสปฏิบัติ) |
| `firstaid_ad` | firstaid.morroo.com (house ad banner) |
| `cpr-online` | cpr.morroo.com (หน้า Booking ของ jia-online) |
| _(null)_ | เข้ามาจองที่ class.morroo.com ตรงๆ |

รูปแบบค่า: ตัวอักษร a-z, ตัวเลข, `_ - .` ยาวไม่เกิน 100 ตัว (server ตัด/ทิ้งค่าอื่น)

## รายงาน

```sql
select booking_source, count(*), sum(final_price)
from bookings
where channel = 'class-web'
group by 1 order by 2 desc;
```
