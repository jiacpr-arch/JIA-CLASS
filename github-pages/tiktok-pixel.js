// TikTok Pixel (client-side) + ttclid capture สำหรับ class.morroo.com
// ใช้ Pixel เดียวกับ jiacpr.com (D5TH3UBC77U5QAK8SAJG) ตามที่เลือกไว้ — signal รวมกันในระบบ TikTok
// แต่วัดผลแยกเว็บยากขึ้น ถ้าต้องการแยก ต้องสร้าง pixel ใหม่ใน Ads Manager แล้วแก้ค่านี้
const TIKTOK_PIXEL_ID = 'D5TH3UBC77U5QAK8SAJG';

!function (w, d, t) {
  w.TiktokAnalyticsObject = t;
  var ttq = w[t] = w[t] || [];
  ttq.methods = ["page", "track", "identify", "instances", "debug", "on", "off", "once", "ready", "alias", "group", "enableCookie", "disableCookie"];
  ttq.setAndDefer = function (t, e) { t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))); }; };
  for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
  ttq.instance = function (t) {
    var e = ttq._i[t] || [];
    for (var n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(e, ttq.methods[n]);
    return e;
  };
  ttq.load = function (e, n) {
    var i = "https://analytics.tiktok.com/i18n/pixel/events.js";
    ttq._i = ttq._i || {}; ttq._i[e] = []; ttq._i[e]._u = i;
    ttq._t = ttq._t || {}; ttq._t[e] = +new Date();
    ttq._o = ttq._o || {}; ttq._o[e] = n || {};
    var o = d.createElement("script"); o.type = "text/javascript"; o.async = true; o.src = i + "?sdkid=" + e + "&lib=" + t;
    var a = d.getElementsByTagName("script")[0]; a.parentNode.insertBefore(o, a);
  };
  ttq.load(TIKTOK_PIXEL_ID);
  ttq.page();
}(window, document, 'ttq');

// เก็บ ttclid ทันทีที่คนคลิกจากโฆษณา TikTok เข้ามา — จุดที่พลาดกับ fbclid ตอนทำ jiacpr.com
// เก็บใน localStorage 28 วัน (เท่า attribution window ของ TikTok) ให้ทุกหน้าที่ include ไฟล์นี้อ่านต่อได้
// แม้ผ่านหน้า redirect (เช่น bcpr-booking.html) ก็ไม่หาย เพราะเซ็ตไว้ก่อน navigate ออกจากหน้าเสมอ
(function () {
  try {
    var fresh = new URLSearchParams(location.search).get('ttclid');
    if (fresh) localStorage.setItem('jia_ttclid', JSON.stringify({ v: fresh, t: Date.now() }));
  } catch (e) { /* localStorage ถูกบล็อก (private mode) — ไม่ทำให้หน้าเว็บพัง */ }
})();

function jiaGetTtclid() {
  try {
    var raw = localStorage.getItem('jia_ttclid');
    if (!raw) return '';
    var data = JSON.parse(raw);
    if (!data || !data.v) return '';
    if (Date.now() - data.t > 28 * 24 * 60 * 60 * 1000) { localStorage.removeItem('jia_ttclid'); return ''; }
    return data.v;
  } catch (e) { return ''; }
}

function jiaTrackViewContent(courseKey, courseName, price) {
  if (window.ttq) window.ttq.track('ViewContent', {
    content_id: courseKey, content_name: courseName, content_type: 'product',
    value: Number(price) || 0, currency: 'THB',
  });
}

function jiaTrackInitiateCheckout(courseKey, courseName, price, quantity) {
  if (window.ttq) window.ttq.track('InitiateCheckout', {
    content_id: courseKey, content_name: courseName, content_type: 'product',
    value: (Number(price) || 0) * (Number(quantity) || 1), currency: 'THB', quantity: Number(quantity) || 1,
  });
}
