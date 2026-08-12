# การแจ้งเตือนเมื่อมีการจองใหม่ (B-CPR)

เมื่อลูกค้าจองคลาสผ่านหน้าเว็บ (หรือแอดมินลงจองแทนลูกค้า) ระบบจะส่งข้อความแจ้งทีมงานอัตโนมัติทันที
เลือกเปิดได้ 2 ช่องทาง (เปิดช่องทางเดียวหรือทั้งสองก็ได้ — ถ้าไม่ตั้งค่าเลย ระบบจะไม่ส่งอะไร และการจองยังทำงานตามปกติ)

ตัวอย่างข้อความที่ทีมงานจะได้รับ:

```
🔔 มีการจองใหม่จากหน้าเว็บ (B-CPR)
ชื่อ: สมชาย ใจดี
โทร: 081-234-5678
รอบเรียน: 2026-08-20 09:00-12:00
จำนวน: 2 คน | ยอด: 1,200 บาท
สถานะ: รอตรวจสอบสลิป
เลขที่จอง: mabc123xyz
ตรวจสลิป/อนุมัติได้ที่ https://class.morroo.com/bcpr-admin.html
```

## ช่องทางที่ 1 — LINE (แนะนำ)

ส่งข้อความผ่าน LINE Official Account (@jiacpr) ไปยังแชทของทีมงานโดยตรง

1. เข้า [LINE Developers Console](https://developers.line.biz/console/) ด้วยบัญชีที่ดูแล LINE OA @jiacpr
   - ถ้ายังไม่มี Messaging API channel ให้สร้างจาก LINE Official Account Manager → Settings → Messaging API
2. ในหน้า channel → แท็บ **Messaging API** → กด Issue **Channel access token (long-lived)** แล้วคัดลอกเก็บไว้
3. หา **รหัสผู้รับข้อความ** (เลือกอย่างใดอย่างหนึ่ง):
   - ส่งเข้าแชทส่วนตัวของเจ้าของ: ใช้ **Your user ID** (ขึ้นต้นด้วย `U`) ในแท็บ Basic settings ของ channel
     และเจ้าของต้องกด "เพิ่มเพื่อน" LINE OA ไว้ก่อน
   - ส่งเข้ากลุ่มทีมงาน: เชิญ LINE OA เข้ากลุ่มแล้วหา groupId (ขึ้นต้นด้วย `C`) ผ่าน webhook event
4. ตั้งค่า secrets ใน Supabase — Dashboard โปรเจกต์ `jia-unified` → **Edge Functions → Secrets** (หรือใช้ CLI):

   ```bash
   supabase secrets set LINE_CHANNEL_ACCESS_TOKEN="<token จากข้อ 2>"
   supabase secrets set LINE_NOTIFY_TO="<userId หรือ groupId จากข้อ 3>"
   ```

หมายเหตุ: LINE Messaging API แบบ push มีโควตาข้อความฟรีต่อเดือนตามแพ็กเกจ LINE OA (แพ็กเกจฟรีปัจจุบัน 300 ข้อความ/เดือน ซึ่งเพียงพอสำหรับแจ้งเตือนการจองภายในทีม)

## ช่องทางที่ 2 — อีเมล (ผ่าน Resend)

1. สมัคร [Resend](https://resend.com) (แพ็กเกจฟรี 3,000 อีเมล/เดือน) แล้วสร้าง API key
2. ตั้งค่า secrets:

   ```bash
   supabase secrets set RESEND_API_KEY="re_xxxxxxxx"
   supabase secrets set NOTIFY_EMAIL_TO="jiacpr@gmail.com"
   # (ไม่บังคับ) ตั้งชื่อผู้ส่งเอง — ต้อง verify โดเมนกับ Resend ก่อน
   supabase secrets set NOTIFY_EMAIL_FROM="B-CPR Booking <booking@morroo.com>"
   ```

   ถ้าไม่ตั้ง `NOTIFY_EMAIL_FROM` ระบบใช้ `onboarding@resend.dev` ซึ่ง Resend อนุญาตให้ส่งถึงอีเมลเจ้าของบัญชี Resend เท่านั้น — ใช้ทดสอบได้ แต่ระยะยาวแนะนำ verify โดเมน `morroo.com` แล้วตั้งค่านี้

## ขั้นตอน deploy (ทำครั้งเดียวหลัง merge)

การเปลี่ยนแปลงนี้มี 2 ส่วนที่ต้อง deploy ไปยัง Supabase (หน้าเว็บบน GitHub Pages อัปเดตเองเมื่อ merge เข้า main):

```bash
# 1) รัน migration เพิ่มฟังก์ชันฐานข้อมูล (bcpr_admin_create_booking + ปรับ bcpr_create_booking)
#    รันไฟล์ supabase/migrations/20260812_bcpr_admin_booking_notify.sql ใน SQL Editor
#    ของโปรเจกต์ jia-unified หรือใช้ CLI: supabase db push

# 2) deploy edge function เวอร์ชันใหม่
supabase functions deploy bcpr-api
```

จากนั้นตั้งค่า secrets ตามช่องทางที่เลือกด้านบน แล้วทดสอบโดยลองจองผ่านหน้าเว็บ 1 รายการ

## การลงจองแทนลูกค้า (จองผ่านเซลล์)

ไม่ต้องตั้งค่าอะไรเพิ่ม — เปิดหน้า [แอดมิน](https://class.morroo.com/bcpr-admin.html) → แท็บ 🎟️ การจอง →
ฟอร์ม "ลงจองแทนลูกค้า" ด้านบนสุด ใช้กับการจองที่มาทางเซลล์ โทรศัพท์ หรือหน้างาน:

- ไม่บังคับแนบสลิป
- ปรับยอดเงินได้ (กรณีราคาพิเศษ/ส่วนลด/เหมาองค์กร)
- เลือกสถานะได้: **ชำระแล้ว** (รับเงินแล้ว) หรือ **รอตรวจสอบ** (ยังไม่ได้เงิน แต่กันที่นั่งไว้ก่อน)
- รายการจะติดป้าย "แอดมิน/เซลล์" ในตาราง และตัดจำนวนที่นั่งร่วมกับการจองหน้าเว็บอัตโนมัติ
