/*
 * ตัวรับแจ้งเตือนเบื้องหลัง - iPhone ปลุกตัวนี้ขึ้นมาเมื่อคอมส่ง Web Push มา แม้ปิดแอปอยู่
 *
 * ข้อความที่มาเป็นแบบเข้ารหัส (Apple อ่านไม่ได้) ถอดด้วยกุญแจที่เก็บไว้ในเครื่องตอนจับคู่
 * Apple บังคับว่าทุกครั้งที่ได้รับต้องแสดงแจ้งเตือน ถ้าถอดไม่ได้ก็แสดงข้อความกลางๆ แทน
 */
importScripts("crypto.js");

const CACHE = "fallguard-v4";
const SHELL = ["./", "index.html", "app.js", "crypto.js", "vendor/jsQR.js", "manifest.webmanifest",
               "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// โหลดจากเว็บก่อนเสมอ (อัปเดตแอปแล้วเห็นทันทีตั้งแต่เปิดครั้งแรก)
// เน็ตไม่มี/ช้าเกิน 4 วินาที ค่อยใช้ไฟล์ที่เก็บไว้ในเครื่อง แอปจะยังเปิดได้
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(e.request, { cache: "no-store", signal: ctl.signal });
      clearTimeout(timer);
      if (r.ok) cache.put(e.request, r.clone());
      return r;
    } catch (err) {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      return cached || Response.error();
    }
  })());
});

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("fallguard", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((res) => {
    const g = db.transaction("kv").objectStore("kv").get(key);
    g.onsuccess = () => res(g.result);
    g.onerror = () => res(undefined);
  });
}

async function idbAppend(key, item) {
  const db = await idb();
  return new Promise((res) => {
    const tx = db.transaction("kv", "readwrite");
    const os = tx.objectStore("kv");
    const g = os.get(key);
    g.onsuccess = () => {
      const list = (g.result || []).concat([item]).slice(-50);
      os.put(list, key);
    };
    tx.oncomplete = () => res();
    tx.onerror = () => res();
  });
}

self.addEventListener("push", (e) => e.waitUntil(onPush(e)));

async function onPush(e) {
  const text = e.data ? e.data.text() : "";
  let d = null;
  try {
    const pair = await idbGet("pair");
    if (pair) d = await (await FG.Proto.create(pair.k, pair.t)).open(text);
  } catch (err) { /* ถอดไม่ได้ - แสดงข้อความกลางๆ */ }
  if (!d) {
    return self.registration.showNotification("FallGuard", { body: "มีการแจ้งเตือนใหม่ - แตะเพื่อเปิดดู", tag: "fallguard" });
  }
  await idbAppend("inbox", d);
  for (const c of await self.clients.matchAll({ type: "window" })) c.postMessage({ type: "inbox" });

  let title = "FallGuard", body = d.message || "", tag = d.id || d.type;
  if (d.type === "event") {
    title = (d.test ? "[ทดสอบ] " : "") + (d.title || "FallGuard") + (d.repeat ? " (เตือนซ้ำ)" : "");
    if (d.kind === "recovered") title = "ลุกขึ้นได้แล้ว";
    if (d.kind === "near_fall") title = "มีคนทรุดลงแต่ลุกเองได้";
  } else if (d.type === "ack") {
    title = "รับทราบแล้ว" + (d.by ? "โดย " + d.by : "");
    body = "มีคนรับเรื่องแล้ว";
  } else if (d.type === "system") {
    title = "FallGuard หยุดเฝ้าระวังแล้ว";
    body = "ตอนนี้ไม่มีใครเฝ้าบ้านอยู่ จนกว่าจะเปิดโปรแกรมบนคอมอีกครั้ง";
    tag = "system";
  }
  if (self.navigator.setAppBadge && d.type === "event" && d.alert) self.navigator.setAppBadge(1).catch(() => {});
  return self.registration.showNotification(title, {
    body, tag, renotify: true,
    icon: "icons/icon-192.png",
    requireInteraction: !!d.alert,
    data: { id: d.id || "", type: d.type, alert: !!d.alert },
  });
}

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  if (self.navigator.clearAppBadge) self.navigator.clearAppBadge().catch(() => {});
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (wins.length) {
      const w = wins[0];
      await w.focus();
      if (data.alert && data.id) w.postMessage({ type: "open-alert", id: data.id });
      return;
    }
    await self.clients.openWindow(data.alert && data.id ? "./?alert=" + encodeURIComponent(data.id) : "./");
  })());
});
