/*
 * FallGuard เว็บแอป (สำหรับ iPhone - เพิ่มลงหน้าจอโฮม)
 *
 * ทำงานแบบเดียวกับแอป Android:
 *   ข้อความ (แจ้งเตือน, สถานะ, รับทราบ)  ผ่าน ntfy.sh เข้ารหัสด้วยกุญแจที่จับคู่
 *   แจ้งเตือนตอนปิดแอป                 ผ่าน Web Push ของ Apple (คอมส่ง ดูที่ fallguard/webpush.py)
 *   ภาพรวมกล้อง/วิดีโอสด                ต่อตรงถึงคอมผ่านลิงก์ Cloudflare (https) ทุกเฟรมเข้ารหัส
 *
 * หน้าเว็บนี้ไม่มีข้อมูลของบ้านไหนเลย กุญแจอยู่ในเครื่องนี้เท่านั้น (ได้จาก QR)
 */
"use strict";

const $ = (id) => document.getElementById(id);
const FRESH_SEC = 15 * 60;          // แจ้งเตือนที่เก่ากว่านี้ไม่ขึ้นหน้าจอแดง
const MAX_HISTORY = 60;
const POLL_MS = 5000;

// ------------------------------------------------------------------ เก็บข้อมูล
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem("fg." + k);
      return v === null ? d : JSON.parse(v);
    } catch (e) {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem("fg." + k, JSON.stringify(v));
    } catch (e) { /* เต็ม/โหมดส่วนตัว - ใช้งานต่อได้ แค่ไม่จำ */ }
  },
};

// IndexedDB: service worker (ตัวรับแจ้งเตือนเบื้องหลัง) อ่าน localStorage ไม่ได้ จึงเก็บกุญแจไว้ที่นี่ด้วย
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("fallguard", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbSet(key, value) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function idbTake(key) {
  const db = await idb();
  return new Promise((res) => {
    const tx = db.transaction("kv", "readwrite");
    const os = tx.objectStore("kv");
    const g = os.get(key);
    g.onsuccess = () => {
      os.delete(key);
      res(g.result);
    };
    g.onerror = () => res(undefined);
  });
}

// ------------------------------------------------------------------- สถานะ
const S = {
  pair: store.get("pair", null),   // {s,t,k,n,w,a,p}
  dev: store.get("dev", null),
  name: store.get("name", ""),
  proto: null,
  history: store.get("history", []),
  pc: store.get("pc", { state: "", heard: 0, cams: [], tunnel: "", every: 1800, paused: false }),
  lastId: store.get("lastId", ""),
  pushState: store.get("push", ""),   // "" | "asked" | "ok"
  live: null,          // ภาพรวมกล้องสดจากคอม {cams, at, net}
  thumbs: {},          // id -> data URL
  connected: false,
  connState: "กำลังเชื่อมต่อ…",
  snap: null,          // ภาพนิ่งล่าสุดที่ขอผ่านเน็ต {ts, cams:[{id,name,jpeg}]}
  mode: store.get("mode", ""),     // ระดับการเห็นภาพปัจจุบันบนคอม
  modes: store.get("modes", []),
  view: "",
};
if (!S.dev) {
  S.dev = Math.random().toString(36).slice(2, 10);
  store.set("dev", S.dev);
}

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = window.navigator.standalone === true
  || window.matchMedia("(display-mode: standalone)").matches;

function toast(text, ms = 2600) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

function show(view) {
  for (const v of ["install", "pair", "home", "live", "manage", "alert"]) $("v-" + v).hidden = v !== view;
  if (view !== "alert") S.view = view;
  if (view === "home") renderHome();
}

function deviceName() {
  if (S.name) return S.name;
  return /iPad/.test(navigator.userAgent) ? "iPad" : (isIOS ? "iPhone" : "เบราว์เซอร์");
}

// ------------------------------------------------------------------- จับคู่
async function applyPair(link, quiet) {
  const p = FG.parsePairLink(link);
  if (!p) {
    if (!quiet) toast("ไม่ใช่ QR สำหรับจับคู่ FallGuard");
    return false;
  }
  const same = S.pair && S.pair.t === p.t && S.pair.k === p.k;
  S.pair = p;
  store.set("pair", p);
  await idbSet("pair", p);
  if (!same) {
    S.history = [];
    S.lastId = "";
    S.pc = { state: "", heard: 0, cams: [], tunnel: "", every: (+p.h || 30) * 60, paused: false };
    S.pushState = "";
    store.set("history", []);
    store.set("lastId", "");
    store.set("pc", S.pc);
    store.set("push", "");
  }
  S.proto = await FG.Proto.create(p.k, p.t);
  if (!same) {
    toast("จับคู่กับ " + (p.n || "FallGuard") + " แล้ว");
    sendSigned({ type: "hello" });
  }
  return true;
}

async function sendSigned(payload) {
  if (!S.proto) return false;
  const body = await S.proto.seal(Object.assign(
    { v: 1, src: "phone:" + S.dev, by: deviceName(), ts: Date.now() / 1000 }, payload));
  for (const wait of [0, 3000, 10000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      // ?firebase=no แทน header: ส่งแบบไม่มี header พิเศษ เบราว์เซอร์ไม่ต้องขออนุญาตล่วงหน้า (เร็วกว่า)
      const r = await fetch(S.pair.s + "/" + S.pair.t + "?firebase=no", { method: "POST", body });
      if (r.ok) return true;
    } catch (e) { /* ลองใหม่ */ }
  }
  return false;
}

// --------------------------------------------------------- รับข้อความ (ntfy)
let streamCtl = null;

async function connect() {
  if (!S.proto || streamCtl) return;
  streamCtl = new AbortController();
  const ctl = streamCtl;
  let backoff = 2000;
  while (!ctl.signal.aborted) {
    try {
      S.connState = "กำลังเชื่อมต่อ…";
      // ดึงที่พลาดไปก่อน แล้วค่อยฟังสด (แบบเดียวกับแอป Android)
      const since = S.lastId || "12h";
      const pollStart = Math.floor(Date.now() / 1000);
      const r = await fetch(`${S.pair.s}/${S.pair.t}/json?poll=1&since=${encodeURIComponent(since)}`,
        { signal: ctl.signal, cache: "no-store" });
      const batch = [];
      for (const line of (await r.text()).split("\n")) {
        const d = await parseLine(line);
        if (d) batch.push(d);
      }
      for (const d of batch) handle(d, false);
      ringLatest(batch);
      renderAll();
      // ntfy.sh ใช้ราว 2 วินาทีกว่าข้อความใหม่จะดึงย้อนหลังได้ ฟังสดเหลื่อมไว้ 30 วินาที
      const live = await fetch(`${S.pair.s}/${S.pair.t}/json?since=${encodeURIComponent(S.lastId || String(pollStart - 30))}`,
        { signal: ctl.signal, cache: "no-store" });
      S.connected = true;
      S.connState = "เชื่อมต่อแล้ว";
      renderAll();
      backoff = 2000;
      const reader = live.body.getReader();
      const td = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += td.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const d = await parseLine(line);
          if (d) {
            handle(d, true);
            renderAll();
          }
        }
      }
    } catch (e) {
      if (ctl.signal.aborted) break;
      S.connState = "ต่อไม่ได้: " + (e.message || e);
    }
    S.connected = false;
    renderAll();
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 60000);
  }
}

function disconnect() {
  if (streamCtl) streamCtl.abort();
  streamCtl = null;
  S.connected = false;
}

const seen = new Set();
async function parseLine(line) {
  if (!line.trim()) return null;
  let m;
  try {
    m = JSON.parse(line);
  } catch (e) {
    return null;
  }
  if (m.event !== "message") return null;
  S.lastId = m.id;
  store.set("lastId", m.id);
  if (seen.has(m.id)) return null;
  seen.add(m.id);
  const d = await S.proto.open(m.message || "");
  if (!d) return null;
  if (d.src === "phone:" + S.dev) return null;
  if (m.attachment && m.attachment.url) d._att = m.attachment.url;
  return d;
}

function handle(d, live) {
  if (d.src === "pc" && d.ts) S.pc.heard = Math.max(S.pc.heard || 0, d.ts);
  switch (d.type) {
    case "event":
      onEvent(d, live);
      break;
    case "ack":
      markAcked(d.id, d.by || "");
      if (S.alertId === d.id) closeAlert(`รับทราบแล้วโดย ${d.by || "คนอื่น"}`);
      break;
    case "hb":
      S.pc.state = "started";
      S.pc.cams = d.cameras || [];
      S.pc.paused = !!d.paused;
      S.pc.every = d.every || S.pc.every;
      if (d.tunnel !== undefined) S.pc.tunnel = validTunnel(d.tunnel);
      break;
    case "tunnel":
      S.pc.tunnel = validTunnel(d.url);
      break;
    case "system":
      S.pc.state = d.state;
      break;
    case "snap":
      if (d._att) loadSnapshot(d);
      break;
    case "wp-ok":
      if (d.dev === S.dev) {
        S.pushState = "ok";
        store.set("push", "ok");
        if (live) toast("✓ แจ้งเตือนเข้าเครื่องนี้พร้อมแล้ว");
      }
      break;
  }
  store.set("pc", S.pc);
}

function validTunnel(url) {
  return typeof url === "string" && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(url) ? url
    : (typeof url === "string" && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url) && location.protocol === "http:" ? url : "");
}

function onEvent(d, live) {
  if (!d.id) return;
  const old = S.history.find((e) => e.id === d.id);
  if (old && old.acked) {
    d.acked = true;
    d.acked_by = old.acked_by;
  }
  if (old && old._img) d._img = old._img;
  S.history = [d].concat(S.history.filter((e) => e.id !== d.id)).slice(0, MAX_HISTORY);
  saveHistory();
  if (live && d.alert && !d.acked && fresh(d) && (d.kind === "fall" || d.kind === "immobile")) openAlert(d.id);
  if (live && d.notice && !d.acked && noticeOpen(d)) {
    // เตือนสีเหลือง: สั่น + ข้อความสั้น การ์ดเหลืองบนหน้าแรกพร้อมปุ่มรับทราบ (ไม่ปลุกเต็มจอแบบคนล้ม)
    if (navigator.vibrate) navigator.vibrate([400, 250, 400]);
    toast("🟡 " + (d.title || "กำลังลุกจากเตียง") + " · " + (d.camera || ""));
  }
}

// เตือนสีเหลืองค้างบนหน้าแรก 5 นาที (ลุกแล้วเรื่องก็จบไปแล้ว) หรือจนกว่าจะมีคนรับทราบ
function noticeOpen(e) {
  return Date.now() / 1000 - (e.ts || 0) < 300;
}

function ringLatest(batch) {
  // เปิดแอปหลังพลาดไป: ขึ้นหน้าจอแดงเฉพาะเรื่องล่าสุดที่ยังสดและยังไม่มีใครรับทราบ
  let ring = null;
  for (const d of batch) {
    if (d.type === "event" && d.alert && fresh(d) && (d.kind === "fall" || d.kind === "immobile")) {
      const e = S.history.find((x) => x.id === d.id);
      if (e && !e.acked) ring = e;
    }
  }
  if (ring) openAlert(ring.id);
}

function fresh(d) {
  return Date.now() / 1000 - (d.ts || 0) < FRESH_SEC;
}

function markAcked(id, by) {
  const e = S.history.find((x) => x.id === id);
  if (!e || e.acked) return;
  e.acked = true;
  e.acked_by = by;
  saveHistory();
}

function saveHistory() {
  // ภาพไม่เก็บลง localStorage (ใหญ่เกิน) โหลดใหม่จาก ntfy ได้ภายใน 3 ชั่วโมง
  store.set("history", S.history.map((e) => Object.assign({}, e, { _img: undefined })));
}

// ------------------------------------------------- ต่อตรงถึงคอม (Cloudflare)
async function pcGet(what, extra) {
  const base = S.pc.tunnel;
  if (!base) return null;
  const t = Math.floor(Date.now() / 1000);
  const url = `${base}/m/${what}?t=${t}&s=${await S.proto.sign(what + "|" + t)}${extra ? "&" + extra : ""}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
    if (!r.ok) return null;
    const plain = await S.proto.openBytes(new Uint8Array(await r.arrayBuffer()));
    return plain ? JSON.parse(new TextDecoder().decode(plain)) : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let pollRound = 0;
async function pollOverview() {
  if (document.hidden || S.view !== "home" || !S.proto) return;
  const wantThumbs = pollRound % 3 === 0 || !Object.keys(S.thumbs).length;
  pollRound++;
  const o = await pcGet("overview", "thumbs=" + (wantThumbs ? 1 : 0));
  if (o && o.cams) {
    for (const c of o.cams) {
      if (c.thumb) S.thumbs[c.id] = "data:image/jpeg;base64," + c.thumb;
      delete c.thumb;
    }
    S.live = { cams: o.cams, at: Date.now() };
    noteMode(o);
  }
  renderCameras();
}

// ------------------------------------------------------------- หน้าแรก
function renderAll() {
  if (S.view === "home") renderHome();
  if (S.view === "live") renderChips();
}

function stateLabel(s) {
  return { fallen: "ตรวจพบคนล้ม!", watching: "กำลังตรวจสอบ", upright: "ปกติ", partial: "เห็นไม่ครบตัว", no_person: "ไม่พบคน" }[s] || "เฝ้าระวังอยู่";
}
function stateColor(s) {
  return { fallen: "var(--alert)", watching: "var(--warn)", upright: "var(--ok)", partial: "var(--accent)" }[s] || "var(--muted)";
}

function silentTooLong() {
  return S.pc.state === "started" && S.pc.heard > 0 && Date.now() / 1000 - S.pc.heard > 2 * (S.pc.every || 1800) + 600;
}

function renderHome() {
  $("home-name").textContent = (S.pair && S.pair.n) || "แจ้งเตือนคนล้ม";
  let title, color = "var(--ok)";
  if (!S.connected) { title = "ยังต่อเน็ตไม่ได้ - อาจพลาดแจ้งเตือน"; color = "var(--trouble)"; }
  else if (!S.pc.state) { title = "รอสัญญาณจากคอม"; color = "var(--warn)"; }
  else if (S.pc.state === "stopped") { title = "คอมหยุดเฝ้าระวังอยู่"; color = "var(--warn)"; }
  else if (silentTooLong()) { title = "ไม่ได้ยินจากคอมนานผิดปกติ"; color = "var(--trouble)"; }
  else if (S.pc.paused) { title = "หยุดตรวจจับชั่วคราว"; color = "var(--warn)"; }
  else title = "กำลังเฝ้าระวัง";
  $("st-title").textContent = title;
  $("st-dot").style.background = color;
  let detail = "ได้ยินจากคอมล่าสุด: " + (S.pc.heard ? ago(S.pc.heard) : "ยังไม่เคย");
  if (!S.connected) detail += "\nมือถือ: " + S.connState;
  $("st-detail").textContent = detail;
  $("st-detail").style.whiteSpace = "pre-line";
  renderChecks();
  renderCameras();
  renderHistory();
  $("btn-rename").textContent = "ชื่อเครื่องนี้: " + deviceName();
}

function renderChecks() {
  const box = $("checks");
  box.innerHTML = "";
  for (const e of S.history) {
    if (!e.notice || e.acked || !noticeOpen(e)) continue;
    const c = el("div", "card notice");
    c.append(el("b", "", "🟡 " + (e.test ? "[ทดสอบ] " : "") + (e.title || "กำลังลุกจากเตียง")));
    c.append(el("div", "", e.message || ""));
    c.append(el("div", "small", ago(e.ts) + "  ·  ยังไม่มีใครรับทราบ"));
    const b = el("button", "", "รับทราบ - กำลังไป");
    b.onclick = () => ack(e.id);
    c.append(b);
    box.append(c);
  }
  const add = (title, why, label, fn) => {
    const c = el("div", "card");
    c.append(el("b", "", "⚠ " + title));
    c.firstChild.style.color = "var(--warn)";
    c.append(el("div", "muted small", why));
    if (label) {
      const b = el("button", "warn", label);
      b.style.marginTop = "8px";
      b.onclick = fn;
      c.append(b);
    }
    box.append(c);
  };
  if (isIOS && !standalone) {
    add("เปิดจากเบราว์เซอร์อยู่", "จะไม่ได้รับแจ้งเตือนตอนปิดหน้านี้ ให้เพิ่มลงหน้าจอโฮมแล้วเปิดจากไอคอน", "ดูวิธีเพิ่ม", () => show("install"));
    return;
  }
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    add("เครื่องนี้รับแจ้งเตือนไม่ได้", "ต้องใช้ iOS 16.4 ขึ้นไป และเปิดจากไอคอนบนหน้าจอโฮม", null);
    return;
  }
  if (!S.pair.w) {
    add("QR นี้ยังไม่รองรับแจ้งเตือน iPhone", "บนคอมกด \"เชื่อมมือถือ\" เลือก iPhone แล้วสแกน QR ใหม่", null);
    return;
  }
  if (Notification.permission !== "granted") {
    add("ยังไม่ได้เปิดการแจ้งเตือน", "ถ้าไม่เปิด จะไม่รู้เลยตอนมีคนล้ม", "เปิดการแจ้งเตือน", enablePush);
  } else if (S.pushState !== "ok") {
    add("รอคอมยืนยันการแจ้งเตือน…", "เปิดโปรแกรม FallGuard บนคอมไว้ (กำลังเฝ้าระวัง หรือหน้าต่างเชื่อมมือถือ)", "ส่งคำขออีกครั้ง", enablePush);
  }
}

function renderCameras() {
  const grid = $("cam-grid");
  const liveOk = S.live && Date.now() - S.live.at < 15000;
  let cams = S.live ? S.live.cams : (S.pc.cams || []).map((c, i) => Object.assign({ id: i }, c));
  const singles = cams.filter((c) => c.id !== -1);
  const all = cams.find((c) => c.id === -1);
  $("cam-title").textContent = singles.length ? `กล้อง · ${singles.length} ตัว` : "กล้อง";
  const upd = $("cam-updated");
  if (liveOk) { upd.textContent = "● อัปเดตสด"; upd.style.color = "var(--ok)"; }
  else if (S.live) { upd.textContent = "ข้อมูลเมื่อ " + hhmm(S.live.at); upd.style.color = ""; }
  else { upd.textContent = singles.length ? "ข้อมูลล่าสุดจากคอม" : ""; upd.style.color = ""; }
  const search = $("cam-search");
  const q = search.value.trim().toLowerCase();
  search.hidden = singles.length < 2 && !q;

  grid.innerHTML = "";
  if (!singles.length) {
    const c = el("div", "card cam-empty");
    c.style.gridColumn = "1 / -1";
    c.append(el("b", "", "ยังไม่ได้ข้อมูลกล้องจากคอม"));
    c.append(el("div", "muted small", "เปิด FallGuard บนคอมแล้วกด \"เริ่มเฝ้าระวัง\" รายชื่อกล้องจะขึ้นที่นี่"));
    grid.append(c);
    return;
  }
  if (!q) {
    if (all) grid.append(camCard(all, true, singles.length, singles));
    else if (singles.length === 1) {
      grid.append(camCard(singles[0], true, 1));
      return;
    }
  }
  const shown = singles.filter((c) => !q || String(c.name).toLowerCase().includes(q));
  if (!shown.length) {
    const n = el("div", "muted", `ไม่พบกล้องที่ชื่อมีคำว่า "${search.value}"`);
    n.style.gridColumn = "1 / -1";
    grid.append(n);
    return;
  }
  for (const c of shown) grid.append(camCard(c, false, 1));
}

function camCard(cam, wide, count, singles) {
  const ok = cam.ok !== false;
  const fallen = cam.state === "fallen";
  const card = el("div", "cam" + (wide ? " wide" : "") + (cam.id === -1 ? " all" : "")
    + (cam.id === -1 && count === 2 ? " tall" : "") + (fallen ? " fallen" : "") + (ok ? "" : " offline"));
  const media = el("div", "media");
  const thumb = S.thumbs[cam.id] || (S.snap && snapUrl(cam.id));
  if (cam.id === -1 && singles) {
    // "ทุกกล้อง": ภาพย่อของแต่ละกล้องเรียงข้างกันเต็มกรอบ (ภาพรวมจากคอมเป็นแนวตั้ง วางในกรอบกว้างแล้วเล็กไป)
    const tiles = el("div", "tiles");
    tiles.style.gridTemplateColumns = `repeat(${Math.min(singles.length, 2)}, 1fr)`;
    for (const c of singles.slice(0, 4)) {
      const src = S.thumbs[c.id] || (S.snap && snapUrl(c.id));
      const t = el("div", "tile" + (c.ok === false ? " off" : ""));
      if (src) {
        const img = el("img");
        img.src = src;
        img.alt = "";
        t.append(img);
      }
      tiles.append(t);
    }
    media.append(tiles);
  } else if (thumb) {
    const img = el("img");
    img.src = thumb;
    img.alt = "";
    media.append(img);
  } else if (ok) media.append(el("span", "ph", "📷"));
  if (!ok) media.append(el("div", "off", "ขาดการเชื่อมต่อ"));
  if (cam.people !== undefined) media.append(el("span", "pill people", "👤 " + cam.people));
  if (fallen) media.append(el("span", "pill alarm", "ตรวจพบคนล้ม!"));
  card.append(media);
  const info = el("div", "info");
  info.append(el("div", "name", cam.id === -1 ? "ทุกกล้อง" : cam.name));
  const row = el("div", "row");
  row.style.gap = "6px";
  const dot = el("span", "dot s");
  dot.style.background = ok ? stateColor(cam.state) : "var(--trouble)";
  let sub = ok ? stateLabel(cam.state) : "ขาดการเชื่อมต่อ";
  if (cam.people !== undefined) {
    const n = cam.people === 0 ? "ไม่มีคน" : cam.people + " คน";
    sub = cam.id === -1 ? `รวม ${n} · ${count} กล้อง` : sub + " · " + n;
  } else if (cam.id === -1) sub = count + " กล้อง";
  row.append(dot, el("span", "st", sub));
  info.append(row);
  card.append(info);
  card.onclick = () => openLive(cam.id);
  return card;
}

function renderHistory() {
  const box = $("history");
  box.innerHTML = "";
  if (!S.history.length) {
    box.append(el("div", "muted", "ยังไม่มีเหตุการณ์"));
    return;
  }
  for (const e of S.history.slice(0, 20)) {
    const c = el("div", "card ev");
    let t = e.title || "FallGuard";
    let color = "var(--alert)";
    if (e.kind === "recovered") { t = "ลุกขึ้นได้แล้ว"; color = "var(--ok)"; }
    if (e.kind === "near_fall") { t = "ทรุดแต่ลุกเองได้"; color = "var(--warn)"; }
    if (e.kind === "bed_exit") { t = "🟡 " + (e.title || "กำลังลุกจากเตียง"); color = "var(--warn)"; }
    if (e.kind === "power_lost" || e.kind === "camera_lost") color = "var(--trouble)";
    if (e.kind === "power_back") color = "var(--ok)";
    if (e.test) t = "[ทดสอบ] " + t;
    const tt = el("div", "t", t);
    tt.style.color = color;
    c.append(tt, el("div", "", e.message || ""));
    if (e._img) {
      const img = el("img");
      img.src = e._img;
      c.append(img);
    } else if (e.image && e._att) loadEventImage(e);
    let meta = ago(e.ts) + "  ·  " + thaiDateTime(e.ts, false);
    if (e.acked) meta += "  ·  รับทราบแล้ว" + (e.acked_by ? "โดย " + e.acked_by : "");
    else if (e.alert || (e.notice && noticeOpen(e))) meta += "  ·  ยังไม่มีใครรับทราบ";
    c.append(el("div", "muted small", meta));
    if (e.alert && !e.acked) {
      const b = el("button", "danger", "รับทราบ");
      b.style.marginTop = "8px";
      b.onclick = () => ack(e.id);
      c.append(b);
    }
    box.append(c);
  }
}

const imgLoading = new Set();
async function loadEventImage(e) {
  if (imgLoading.has(e.id)) return;
  imgLoading.add(e.id);
  const bytes = await fetchAttachment(e._att);
  if (bytes) {
    e._img = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    if (S.view === "home") renderHistory();
    if (S.alertId === e.id) showAlertImage(e);
  }
}

async function fetchAttachment(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return await S.proto.openBytes(new Uint8Array(await r.arrayBuffer()));
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------- รับทราบ
async function ack(id) {
  markAcked(id, "เครื่องนี้");
  if (S.alertId === id) closeAlert();
  renderAll();
  if (String(id).startsWith("local-")) return;
  if (await sendSigned({ type: "ack", id })) toast("ส่งการรับทราบแล้ว");
  else toast("ส่งการรับทราบไม่สำเร็จ - ตรวจเน็ต");
}

// ------------------------------------------------------- หน้าจอแดง
function openAlert(id) {
  const e = S.history.find((x) => x.id === id);
  if (!e || e.acked) return;
  S.alertId = id;
  $("al-title").textContent = (e.test ? "[ทดสอบ] " : "") + (e.title || "ตรวจพบคนล้ม") + (e.repeat ? " (เตือนซ้ำ)" : "");
  $("al-msg").textContent = e.message || "";
  $("al-meta").textContent = thaiDateTime(e.ts || 0, true);
  $("al-img").hidden = true;
  $("al-img-hint").textContent = e.image ? "กำลังโหลดภาพตอนเกิดเหตุ…" : "";
  if (e._img) showAlertImage(e);
  else if (e.image && e._att) loadEventImage(e);
  $("v-alert").hidden = false;
  if (navigator.vibrate) navigator.vibrate([600, 300, 600]);
}

function showAlertImage(e) {
  $("al-img").src = e._img;
  $("al-img").hidden = false;
  $("al-img-hint").textContent = "ภาพตอนเกิดเหตุ";
}

function closeAlert(msg) {
  S.alertId = null;
  $("v-alert").hidden = true;
  if (msg) toast(msg);
}

// --------------------------------------------------------- ดูกล้อง
const V = { cam: 0, ctl: null, h264Broken: store.get("h264Broken", false), pickAll: false };

function openLive(cam) {
  V.cam = cam;
  show("live");
  renderChips();
  renderModeButton();
  startLive();
  pcGet("info").then((o) => {
    if (o) noteMode(o);
  });
}

// ---------------------------------------------------- ระดับการเห็นภาพ
function noteMode(o) {
  if (o.mode) {
    S.mode = o.mode;
    store.set("mode", o.mode);
  }
  if (o.modes && o.modes.length) {
    S.modes = o.modes;
    store.set("modes", o.modes);
  }
  renderModeButton();
}

function modeLabel(value) {
  const m = S.modes.find((x) => x.value === value);
  return m ? m.label : "…";
}

/** ระดับภาพของกล้องที่กำลังดู ("mixed" = ทุกกล้องตั้งไม่เหมือนกัน) */
function camLevel(id) {
  const c = liveCams().find((x) => x.id === id);
  return (c && c.privacy) || S.mode;
}

function renderModeButton() {
  const level = camLevel(V.cam);
  $("live-mode").textContent = "👁 ระดับภาพ: " + (level === "mixed" ? "แยกตามกล้อง" : level ? modeLabel(level) : "…");
}

/** ขอรายชื่อกล้อง (พร้อมระดับภาพของแต่ละกล้อง) ใหม่จากคอม */
async function refreshCams() {
  const o = await pcGet("info");
  if (o && o.cams) {
    S.live = { cams: o.cams, at: Date.now() };
    noteMode(o);
    if (S.view === "live") renderChips();
  }
}

/**
 * เปลี่ยนระดับการเห็นภาพของกล้องหนึ่ง (camId = -1 คือทุกกล้อง) - ระดับที่เห็นภาพจริงต้องยืนยันก่อน
 * แต่ละกล้องตั้งต่างกันได้ เช่น หน้าบ้าน = กล้องวงจรปิด, ห้องนอน = โครงกระดูก
 */
async function setMode(m, camId) {
  const where = camId === -1 ? "ทุกกล้อง" : (liveCams().find((x) => x.id === camId) || {}).name || "กล้องนี้";
  if (camId !== -1 && m.value === camLevel(camId)) return true;
  if (m.value === "cctv" && !confirm(`ให้ "${where}" เป็นกล้องวงจรปิด?\n\nภาพจริงทั้งหมด เห็นหน้าคนชัดเจน `
      + "ทั้งในมือถือทุกเครื่องที่จับคู่ จอคอม และภาพตอนเกิดเหตุ (ภาพยังเข้ารหัสระหว่างทาง คนนอกดูไม่ได้)")) return false;
  if (m.value === "raw" && !confirm(`ให้ "${where}" เป็นภาพจริง ปิดหน้า?\n\nเห็นภาพห้องจริงทั้งหมด แต่ใบหน้าถูกปิดไว้`)) return false;
  toast("กำลังเปลี่ยน " + where + " เป็น " + m.label + "…");
  const res = await pcCommand({ cmd: "mode", mode: m.value, id: camId });
  if (!res || res.ok === false) {
    toast(res && res.error ? res.error : "เปลี่ยนไม่ได้ - ต่อคอมไม่ได้", 4000);
    return false;
  }
  noteMode(res);
  if (res.cameras) {
    M.state = res;
    if (S.view === "manage") renderManage();
  }
  await refreshCams();
  renderModeButton();
  toast("✓ " + where + " เป็น " + m.label + " แล้ว");
  return true;
}

function chooseMode() {
  if (!S.modes.length) {
    toast("ยังไม่ได้ข้อมูลจากคอม - ลองอีกครั้ง");
    pcGet("info").then((o) => o && noteMode(o));
    return;
  }
  const sheet = $("sheet");
  sheet.innerHTML = "";
  const cam = liveCams().find((x) => x.id === V.cam);
  const current = camLevel(V.cam);
  sheet.append(el("h2", "", V.cam === -1 ? "ระดับภาพของทุกกล้อง" : "ระดับภาพของ " + (cam ? cam.name : "กล้องนี้")));
  sheet.append(el("div", "muted small", V.cam === -1
    ? "เลือกแล้วทุกกล้องจะใช้ระดับนี้เหมือนกัน (ตั้งแยกแต่ละกล้องได้ โดยเลือกกล้องด้านบนก่อน)"
    : "ใช้กับกล้องนี้เท่านั้น ทั้งในมือถือทุกเครื่อง จอคอม และภาพตอนเกิดเหตุ"));
  sheet.lastChild.style.marginBottom = "10px";
  for (const m of S.modes) {
    const row = el("div", "opt" + (m.value === current ? " on" : ""));
    if (m.value === "cctv") row.append(el("span", "tag", "เห็นหน้า"));
    row.append(el("b", "", (m.value === current ? "✓  " : "") + m.label));
    row.append(el("div", "muted small", m.desc));
    row.onclick = async () => {
      closeSheet();
      await setMode(m, V.cam);
    };
    sheet.append(row);
  }
  const cancel = el("button", "", "ปิด");
  cancel.onclick = closeSheet;
  sheet.append(cancel);
  $("sheet-bg").hidden = false;
}

function liveCams() {
  if (S.live && S.live.cams) return S.live.cams;
  if (S.snap) return S.snap.cams;
  return (S.pc.cams || []).map((c, i) => Object.assign({ id: i }, c));
}

function renderChips() {
  const box = $("live-chips");
  box.innerHTML = "";
  for (const c of liveCams()) {
    let label = c.id === -1 ? "ทุกกล้อง" : c.name;
    if (c.ok === false) label += " (หลุด)";
    else if (c.people !== undefined) label += "  👤 " + c.people;
    const b = el("button", "chip" + (c.id === V.cam ? " on" : ""), label);
    b.onclick = () => {
      if (c.id === V.cam) return;
      V.cam = c.id;
      renderChips();
      renderModeButton();
      startLive();
    };
    box.append(b);
  }
}

function stopLive() {
  if (V.ctl) V.ctl.abort();
  V.ctl = null;
  if (V.decoder) {
    try { V.decoder.close(); } catch (e) { /* ปิดไปแล้ว */ }
    V.decoder = null;
  }
}

function liveStatus(text, color) {
  $("live-status").textContent = text;
  $("live-status").style.color = color || "";
}

async function startLive() {
  stopLive();
  const ctl = new AbortController();
  V.ctl = ctl;
  $("live-snap").hidden = true;
  $("live-detail").textContent = "";
  if (!S.pc.tunnel) {
    liveStatus("ยังไม่มีช่องภาพสดจากคอม (ต้องเปิดเฝ้าระวังบนคอมอยู่)", "var(--warn)");
    return snapshotMode();
  }
  liveStatus("กำลังต่อภาพสด…");
  let failures = 0;
  while (!ctl.signal.aborted) {
    try {
      await streamOnce(ctl);
    } catch (e) {
      if (ctl.signal.aborted) return;
      $("live-detail").textContent = "ล่าสุด: " + (e.message || e);
      if (e.h264) {
        V.h264Broken = true;
        store.set("h264Broken", true);
      }
      if (++failures >= 3) {
        liveStatus("ต่อภาพสดไม่ได้ตอนนี้ ใช้ภาพนิ่งแทน", "var(--warn)");
        return snapshotMode();
      }
      liveStatus("ภาพสดสะดุด กำลังต่อใหม่…", "var(--warn)");
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

// ภาพผ่านอินเทอร์เน็ตใช้ WebSocket: สายแบบ fetch ถูก Cloudflare กักไว้เป็นก้อน ~100 KB
// (วัดจริง: ภาพมาทีละ 1.5 วินาทีแล้วเงียบ 1.5 วินาที) WebSocket ส่งต่อทันทีทีละข้อความ ภาพเดินสม่ำเสมอ
// คอมรุ่นเก่าที่ยังไม่มีช่องนี้ = ต่อไม่ติดตั้งแต่แรก -> กลับไปใช้แบบเดิมเอง
async function* wsBlobs(url, ctl) {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const q = [];
  let wake = null, err = null, closed = false, opened = false;
  const poke = () => { if (wake) { const w = wake; wake = null; w(); } };
  ws.onopen = () => { opened = true; poke(); };
  ws.onmessage = (e) => { q.push(new Uint8Array(e.data)); poke(); };
  ws.onerror = () => { err = err || new Error(opened ? "สายหลุด" : "ws-open"); poke(); };
  ws.onclose = () => { closed = true; poke(); };
  const stop = () => ws.close();
  ctl.signal.addEventListener("abort", stop);
  try {
    for (;;) {
      if (q.length) { yield q.shift(); continue; }
      if (err) throw err;
      if (closed) throw new Error(opened ? "สายหลุด" : "ws-open");
      await new Promise((r) => (wake = r));
    }
  } finally {
    ctl.signal.removeEventListener("abort", stop);
    ws.close();
  }
}

async function* fetchBlobs(r) {
  const reader = r.body.getReader();
  let buf = new Uint8Array(0);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("สายหลุด");
    buf = concatBytes(buf, value);
    while (buf.length >= 4) {
      const len = (buf[0] << 24 | buf[1] << 16 | buf[2] << 8 | buf[3]) >>> 0;
      if (len <= 0 || len > 4 * 1048576) throw new Error("ข้อมูลผิดรูปแบบ");
      if (buf.length < 4 + len) break;
      const blob = buf.subarray(4, 4 + len);
      buf = buf.slice(4 + len);
      yield blob;
    }
  }
}

// คุณภาพภาพสด: ชัด (800 จุด ~1.5 Mbps) หรือประหยัดเน็ต (480 จุด ~0.45 Mbps) จำไว้ในเครื่องนี้
function liveQuality() {
  return store.get("liveQ", "hd") === "low" ? "low" : "hd";
}

async function streamOnce(ctl) {
  const cam = V.cam;
  const t = Math.floor(Date.now() / 1000);
  const wantH264 = !V.h264Broken && "VideoDecoder" in window;
  const query = `cam=${cam}&t=${t}&s=${await S.proto.sign("live|" + cam + "|" + t)}`
    + (liveQuality() === "low" ? "&q=low" : "") + (wantH264 ? "&fmt=h264&v=2" : "");
  let blobs = null, video = null;
  if (!V.wsBroken && "WebSocket" in window) {
    const ws = wsBlobs(`${S.pc.tunnel.replace(/^http/, "ws")}/m/ws?${query}`, ctl);
    try {
      const first = await ws.next();             // ต่อติดและได้ข้อความแรก = ใช้ช่องนี้
      blobs = (async function* () { yield first.value; yield* ws; })();
    } catch (e) {
      if (ctl.signal.aborted) throw e;
      if (e.message !== "ws-open") throw e;
      V.wsBroken = true;                          // คอมรุ่นเก่า: ใช้แบบเดิมไปจนปิดหน้านี้
      blobs = null;
    }
  }
  if (!blobs) {
    const r = await fetch(`${S.pc.tunnel}/m/live?${query}`, { signal: ctl.signal, cache: "no-store" });
    if (!r.ok) throw new Error("คอมตอบ " + r.status);
    video = r.headers.get("X-Format") === "h264";
    blobs = fetchBlobs(r);
  }
  const meter = { since: Date.now(), frames: 0, bytes: 0 };
  const canvas = $("live-canvas");
  const ctx = canvas.getContext("2d");
  let firstKey = 0, rendered = false;

  const draw = (src, w, h) => {
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      $("live-screen").style.aspectRatio = `${w} / ${Math.min(h, w * 1.6)}`;
    }
    ctx.drawImage(src, 0, 0, w, h);
    rendered = true;
    meter.frames++;
    // คำนวณจากช่วงเวลาที่ครบแล้วเท่านั้น (ช่วงสั้นๆ หลังเริ่มนับใหม่หารด้วยเวลาเกือบศูนย์ ตัวเลขพุ่งเป็นพัน)
    const secs = (Date.now() - meter.since) / 1000;
    if (secs >= 2) {
      meter.text = `● ${video ? "วิดีโอสด" : "ภาพสด"} · ${(meter.frames / secs).toFixed(0)}\u00a0ภาพ/วินาที`;
      meter.detail = `ผ่านอินเทอร์เน็ต · ใช้เน็ตราว ${(meter.bytes / secs * 3600 / 1048576).toFixed(0)}\u00a0MB/ชั่วโมง`;
      Object.assign(meter, { since: Date.now(), frames: 0, bytes: 0 });
      $("live-detail").textContent = meter.detail;
    }
    liveStatus(meter.text || `● ${video ? "วิดีโอสด" : "ภาพสด"}`, "var(--ok)");
  };

  const makeDecoder = () => new VideoDecoder({
    output: (frame) => {
      draw(frame, frame.displayWidth, frame.displayHeight);
      frame.close();
    },
    error: (e) => { V.decodeError = e; },
  });
  if (video) V.decoder = makeDecoder();
  let configured = false, ts = 0, stamped = false, timer = null;
  // ภาพที่รอถึงเวลาแสดง: เน็ตมือถือส่งมาเป็นพักๆ (บางทีห่าง 100 ms แล้วมาติดกัน 3 ภาพ)
  // ถ้าแสดงทันทีที่มาถึง ภาพจะเดินกระตุกตามเน็ต - รอนิดหนึ่งแล้วปล่อยตามจังหวะที่กล้องถ่ายจริง
  const queue = [];
  const play = V.play = new Playout();
  let decoder = V.decoder;
  const feed = () => {
    timer = null;
    if (V.decoder !== decoder) return;     // สายนี้จบแล้ว (เปลี่ยนกล้อง/ต่อใหม่) ภาพที่ค้างทิ้งไป
    while (queue.length && queue[0].due <= performance.now() + 3) {
      const p = queue.shift();
      try {
        decoder.decode(new EncodedVideoChunk({ type: p.key ? "key" : "delta", timestamp: p.ts, data: p.data }));
      } catch (e) {
        V.decodeError = e;        // ตัวถอดถูกปิดไปแล้ว (เปลี่ยนกล้อง) หรือเสีย - ลูปอ่านจะจัดการต่อ
        return;
      }
    }
    if (queue.length) timer = setTimeout(feed, Math.max(0, queue[0].due - performance.now()));
  };
  for await (const blob of blobs) {
    {
      meter.bytes += blob.length + 4;
      const msg = await S.proto.openBytes(blob);
      if (!msg) continue;
      if (video === null) {
        // WebSocket ไม่มีหัว X-Format: ดูจากข้อความแรก - วิดีโอขึ้นต้นด้วย "C" ภาพนิ่งเป็น JPEG (FF D8)
        video = !(msg[0] === 0xff && msg[1] === 0xd8);
        if (video) { V.decoder = makeDecoder(); decoder = V.decoder; }
      }
      if (!video) {
        const bmp = await createImageBitmap(new Blob([msg], { type: "image/jpeg" }));
        draw(bmp, bmp.width, bmp.height);
        bmp.close && bmp.close();
        continue;
      }
      const kind = String.fromCharCode(msg[0]);
      if (kind === "C") {
        try { stamped = !!JSON.parse(new TextDecoder().decode(msg.subarray(1))).ts; } catch (e) { stamped = false; }
        continue;
      }
      // คอมรุ่นใหม่แนบเวลาที่กล้องถ่าย (มิลลิวินาที 4 ไบต์) ไว้หน้าข้อมูลวิดีโอ
      const shot = stamped ? new DataView(msg.buffer, msg.byteOffset + 1, 4).getUint32(0) : null;
      const body = msg.subarray(stamped ? 5 : 1);
      if (!configured) {
        if (kind !== "K") continue;
        const codec = avcCodec(body);
        if (!codec) continue;
        try {
          const sup = await VideoDecoder.isConfigSupported({ codec, optimizeForLatency: true });
          if (!sup.supported) throw new Error("ไม่รองรับ " + codec);
          V.decoder.configure({ codec, optimizeForLatency: true });
        } catch (e) {
          const err = new Error("เล่นวิดีโอไม่ได้: " + (e.message || e));
          err.h264 = true;
          throw err;
        }
        configured = true;
        firstKey = Date.now();
      }
      if (V.decodeError) {
        const err = new Error("ถอดวิดีโอไม่ได้: " + V.decodeError.message);
        err.h264 = true;
        throw err;
      }
      ts = shot === null ? ts + 33333 : shot * 1000;
      const now = performance.now();
      queue.push({ key: kind === "K", ts, data: body, due: shot === null ? now : play.due(shot, now) });
      if (!timer) feed();
      if (!rendered && Date.now() - firstKey > 4000) {
        const err = new Error("วิดีโอไม่ขึ้นภาพ");
        err.h264 = true;
        throw err;
      }
    }
  }
}

/**
 * จัดจังหวะแสดงภาพ (jitter buffer แบบเดียวกับแอปกล้องทั่วไป)
 *
 * ภาพแต่ละภาพมีเวลาที่กล้องถ่าย เราแสดงมันที่ "เวลาถ่าย + ระยะรอคงที่" ภาพจึงห่างกันเท่าตอนถ่าย
 * ระยะรอปรับเอง: เน็ตนิ่ง = รอน้อย (ภาพสดแทบทันที), เน็ตแกว่ง = รอมากขึ้นพอให้ภาพไม่สะดุด
 *   base  = (เวลาที่มาถึง - เวลาถ่าย) ที่น้อยที่สุดที่เคยเห็น = ภาพที่มาเร็วที่สุด
 *   late  = ภาพนี้มาช้ากว่าภาพที่เร็วที่สุดเท่าไร - เก็บไว้ 3 วินาทีล่าสุด
 *   delay = ช้าสุดใน 3 วินาทีนั้น + เผื่อ 25 ms (ขึ้นทันที ลงช้าๆ ไม่ให้ภาพกระโดด)
 */
class Playout {
  constructor() {
    this.base = null;
    this.delay = 60;
    this.late = [];
  }

  due(shot, now) {
    const off = now - shot;
    if (this.base === null || off < this.base) this.base = off;
    this.late.push(off - this.base);
    if (this.late.length > 90) this.late.shift();
    const target = Math.min(700, Math.max(40, Math.max(...this.late) + 25));
    this.delay = target > this.delay ? target : this.delay + (target - this.delay) * 0.01;
    return this.base + shot + this.delay;
  }
}

/** ชื่อรูปแบบวิดีโอที่เบราว์เซอร์ต้องการ (เช่น avc1.42c01e) อ่านจาก SPS ใน keyframe */
function avcCodec(annexb) {
  for (let i = 0; i + 4 < annexb.length; i++) {
    if (annexb[i] === 0 && annexb[i + 1] === 0 && annexb[i + 2] === 1 && (annexb[i + 3] & 0x1f) === 7) {
      const hex = (b) => b.toString(16).padStart(2, "0");
      return "avc1." + hex(annexb[i + 4]) + hex(annexb[i + 5]) + hex(annexb[i + 6]);
    }
  }
  return null;
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ภาพนิ่งผ่าน ntfy (ใช้ได้ทุกที่ แม้ไม่มีช่องภาพสด)
function snapshotMode() {
  $("live-snap").hidden = false;
  showSnapshot();
  if (!S.snap || Date.now() / 1000 - S.snap.ts > 60) requestSnapshot();
}

async function requestSnapshot() {
  liveStatus("ขอภาพล่าสุดจากคอมแล้ว รอสักครู่…", "var(--warn)");
  await sendSigned({ type: "snap", id: Date.now().toString(36) });
}

async function loadSnapshot(d) {
  if (S.snap && S.snap.ts >= d.ts) return;
  const bytes = await fetchAttachment(d._att);
  if (!bytes) return;
  try {
    const b = JSON.parse(new TextDecoder().decode(bytes));
    S.snap = { ts: b.ts, cams: b.cams };
    renderAll();
    if (S.view === "live" && $("live-snap").hidden === false) showSnapshot();
  } catch (e) { /* ไฟล์เสีย */ }
}

function snapUrl(id) {
  const c = S.snap && S.snap.cams.find((x) => x.id === id);
  return c && c.jpeg ? "data:image/jpeg;base64," + c.jpeg : null;
}

function showSnapshot() {
  const src = snapUrl(V.cam);
  if (!src) return;
  const img = new Image();
  img.onload = () => {
    const canvas = $("live-canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    $("live-screen").style.aspectRatio = `${img.width} / ${img.height}`;
    canvas.getContext("2d").drawImage(img, 0, 0);
    const mins = Math.floor((Date.now() / 1000 - S.snap.ts) / 60);
    liveStatus(`ภาพนิ่ง เมื่อ ${hhmm(S.snap.ts * 1000)}${mins >= 1 ? ` (${mins} นาทีก่อน)` : ""}`, mins >= 5 ? "var(--warn)" : "");
  };
  img.src = src;
}

// ----------------------------------------------------- จัดการกล้อง
/** ส่งคำสั่งถึงคอม (เข้ารหัส มีเวลา+เลขสุ่ม กันส่งซ้ำ) ส่งเป็นข้อความธรรมดา ไม่ต้องขออนุญาตล่วงหน้า */
async function pcCommand(cmd) {
  const base = S.pc.tunnel;
  if (!base || !S.proto) return null;
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
  const body = await S.proto.seal(Object.assign({ ts: Date.now() / 1000, nonce, by: deviceName() }, cmd));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);   // ค้นหาเว็บแคมใช้เวลาหลายวินาที
  try {
    const r = await fetch(base + "/m/cmd", { method: "POST", body, signal: ctl.signal, cache: "no-store" });
    if (!r.ok) return null;
    return await S.proto.open((await r.text()).trim());
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const M = { state: null };

function manageStatus(text, color) {
  $("manage-status").textContent = text;
  $("manage-status").style.color = color || "";
}

async function manageRun(cmd, busy) {
  manageStatus(busy, "var(--warn)");
  const res = await pcCommand(cmd);
  if (!res) return manageStatus("ต่อคอมไม่ได้ - ต้องเปิดเฝ้าระวังบนคอมไว้ (และเปิดภาพสดนอกบ้าน)", "var(--trouble)"), null;
  if (res.ok === false) return manageStatus(res.error || "คอมทำคำสั่งนี้ไม่สำเร็จ", "var(--trouble)"), res;
  manageStatus("เชื่อมต่อคอมแล้ว · เปลี่ยนแล้วมีผลทันที", "var(--ok)");
  if (res.cameras) {
    M.state = res;
    noteMode(res);
    renderManage();
    S.live = null;            // ให้หน้าแรกดึงรายการกล้องใหม่
    S.thumbs = {};
  }
  return res;
}

function openManage() {
  show("manage");
  manageRun({ cmd: "cameras" }, "กำลังต่อคอม…");
}

function renderManage() {
  const st = M.state;
  const modes = $("manage-modes");
  modes.innerHTML = "";
  const levels = new Set((st.cameras || []).map((c) => c.privacy));
  const same = levels.size === 1 ? [...levels][0] : null;
  for (const m of st.modes || []) {
    const row = el("div", "opt" + (m.value === same ? " on" : ""));
    if (m.value === "cctv") row.append(el("span", "tag", "เห็นหน้า"));
    row.append(el("b", "", (m.value === same ? "✓  " : "") + m.label));
    row.append(el("div", "muted small", m.desc));
    row.onclick = () => pickMode(m);
    modes.append(row);
  }
  const cams = $("manage-cams");
  cams.innerHTML = "";
  for (const c of st.cameras || []) {
    const row = el("div", "camrow");
    row.append(el("b", "", c.name));
    row.append(el("div", "muted small", sourceText(c)));
    row.append(el("div", "small", "👁 " + modeLabel(c.privacy) + (c.privacy_own ? "" : " (ค่าเริ่มต้น)")));
    let text = "● เฝ้าอยู่", color = "var(--ok)";
    if (!c.ok && c.connecting) { text = "● กำลังเชื่อมต่อ…"; color = "var(--warn)"; }
    else if (!c.ok) { text = "● ใช้ไม่ได้" + (c.error ? ": " + c.error : ""); color = "var(--trouble)"; }
    const s = el("div", "small", text);
    s.style.color = color;
    row.append(s);
    row.onclick = () => editSheet(c);
    cams.append(row);
  }
}

function pickMode(m) {
  setMode(m, -1);         // หัวข้อ "ใช้ระดับเดียวกันทุกกล้อง"
}

/** แหล่งภาพเป็นคำที่อ่านเข้าใจ: เว็บแคม ตัวที่ 1 / กล้อง Wi-Fi 192.168.1.20 (ไม่โชว์รหัสผ่าน) */
function sourceText(c) {
  const label = String(c.label || "");
  const n = label.match(/^webcam (\d+)$/);
  if (n) return "เว็บแคม ตัวที่ " + (Number(n[1]) + 1);
  const net = label.match(/^([a-z][\w+.-]*):\/\/(?:[^/@]*@)?\[?([^/\]:]+)/i);
  if (net) return (/^(rtsps?|rtmp)$/i.test(net[1]) ? "กล้อง Wi-Fi " : "กล้องออนไลน์ ") + net[2];
  if (label === "จำลอง") return "ฉากจำลอง";
  if (c.kind === "webcam") return "เว็บแคม";
  return label || "ไฟล์";
}

function closeSheet() {
  $("sheet-bg").hidden = true;
  $("sheet").innerHTML = "";
}

/** cam = null คือเพิ่มกล้องใหม่ */
function editSheet(cam) {
  const adding = !cam;
  const sheet = $("sheet");
  sheet.innerHTML = "";
  sheet.append(el("h2", "", adding ? "เพิ่มกล้อง" : "แก้ไขกล้อง"));

  sheet.append(el("label", "", "ชื่อห้อง/กล้อง (ขึ้นในแจ้งเตือน)"));
  const name = el("input");
  name.placeholder = "เช่น ห้องนอนคุณแม่";
  name.value = adding ? "" : cam.name.replace(" (จำลอง)", "");
  sheet.append(name);

  // แหล่งภาพ: แตะเว็บแคมที่ค้นเจอ หรือใส่ลิงก์กล้อง Wi-Fi (ค่าที่ส่งไปคอมยังเป็นเลขเว็บแคมแบบเดิม)
  sheet.append(el("label", "", "กล้อง"));
  if (!adding) sheet.append(el("div", "hint", "ตอนนี้: " + sourceText(cam) + " · ไม่เปลี่ยนก็ไม่ต้องแตะ"));
  let webcam = null;
  const picked = el("div", "hint");
  const source = el("input");
  source.placeholder = "ลิงก์กล้อง Wi-Fi เช่น rtsp://…";
  source.autocapitalize = "off";
  source.autocomplete = "off";
  source.spellcheck = false;
  source.oninput = () => { webcam = null; picked.textContent = ""; };
  const found = el("div");
  const find = el("button", "", "ค้นหาเว็บแคมที่เสียบกับคอม");
  find.onclick = async () => {
    find.textContent = "กำลังค้นหา (ราว 10 วินาที)…";
    const res = await pcCommand({ cmd: "probe" });
    find.textContent = "ค้นหาเว็บแคมที่เสียบกับคอม";
    found.innerHTML = "";
    if (!res || !res.found) return found.append(el("div", "hint", "ค้นหาไม่ได้ - ต่อคอมไม่ได้"));
    if (!res.found.length) return found.append(el("div", "hint", "ไม่พบเว็บแคมเพิ่ม (ที่เสียบอยู่ถูกใช้หมดแล้ว หรือยังไม่ได้เสียบ)"));
    for (const f of res.found) {
      const row = el("div", "found", `เว็บแคม ตัวที่ ${f.index + 1}  (${f.size})` + (f.black ? "  - ภาพดำ อาจไม่ใช่กล้องจริง" : "  - มีภาพ"));
      row.onclick = () => {
        webcam = f.index;
        source.value = "";
        found.innerHTML = "";
        picked.textContent = `✓ เลือกเว็บแคม ตัวที่ ${f.index + 1} แล้ว`;
      };
      found.append(row);
    }
  };
  find.style.marginTop = "0";
  sheet.append(find, found, picked, source);
  sheet.append(el("div", "hint", "ลิงก์ดูได้จากแอปของกล้อง เช่น Tapo: ตั้งค่ากล้อง → บัญชีกล้อง\n"
    + "รูปแบบ rtsp://ชื่อผู้ใช้:รหัสผ่าน@ไอพีกล้อง:554/stream1"));
  sheet.lastChild.style.whiteSpace = "pre-line";

  // ระดับภาพของกล้องนี้: ปุ่มเลือกแบบเดียวกับทั้งแอป (ช่องเลือกของเบราว์เซอร์เป็นกล่องขาวหลุดธีม)
  sheet.append(el("label", "", "ระดับภาพ"));
  let level = cam && cam.privacy_own ? cam.privacy : "default";
  const levels = el("div", "levels");
  levels.id = "edit-levels";
  const opts = [["default", "ตามค่าเริ่มต้น (" + modeLabel(S.mode) + ")"]].concat(S.modes.map((m) => [m.value, m.label]));
  for (const [v, t] of opts) {
    const b = el("button", "chip" + (v === level ? " on" : ""), t);
    b.onclick = () => {
      level = v;
      for (const x of levels.children) x.classList.toggle("on", x === b);
    };
    levels.append(b);
  }
  sheet.append(levels);

  const save = el("button", "primary", adding ? "เพิ่มกล้อง" : "บันทึก");
  save.style.marginTop = "18px";
  save.onclick = async () => {
    const src = webcam !== null ? String(webcam) : source.value.trim();
    if (!name.value.trim()) return toast("ใส่ชื่อห้องก่อน");
    if (adding && !src) return toast("แตะเว็บแคมที่ค้นเจอ หรือใส่ลิงก์กล้องก่อน");
    if (level === "cctv" && !confirm("ให้กล้องนี้เป็นกล้องวงจรปิด (เห็นหน้าคน)?")) return;
    closeSheet();
    await manageRun(Object.assign({ cmd: adding ? "add" : "edit", name: name.value.trim(), source: src,
      privacy: level }, adding ? {} : { id: cam.id }), adding ? "กำลังเพิ่มกล้อง…" : "กำลังบันทึก…");
  };
  const cancel = el("button", "", "ยกเลิก");
  cancel.onclick = closeSheet;
  sheet.append(save, cancel);
  if (!adding) {
    // ลบอยู่ล่างสุด แยกจากบันทึก/ยกเลิก กันนิ้วพลาด และยังต้องยืนยันอีกครั้ง
    const del = el("button", "link-danger", "ลบกล้องนี้…");
    del.onclick = async () => {
      if (!confirm(`ลบ "${cam.name}"? บริเวณนี้จะไม่ถูกเฝ้าระวังอีก`)) return;
      closeSheet();
      await manageRun({ cmd: "remove", id: cam.id }, "กำลังลบกล้อง…");
    };
    sheet.append(del);
  }
  $("sheet-bg").hidden = false;
}

// ------------------------------------------------------------ Web Push
async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      toast("ไม่ได้อนุญาตการแจ้งเตือน - เปิดได้ที่ ตั้งค่า → การแจ้งเตือน → FallGuard");
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: FG.b64urlToBytes(S.pair.w),
      });
    }
    S.pushState = "asked";
    store.set("push", "asked");
    await sendSigned({ type: "wp-sub", sub: sub.toJSON() });
    toast("ส่งคำขอไปที่คอมแล้ว รอยืนยันไม่กี่วินาที");
    renderAll();
  } catch (e) {
    toast("เปิดการแจ้งเตือนไม่สำเร็จ: " + (e.message || e), 5000);
  }
}

/** เปิดแอปทุกครั้ง ส่งการสมัครซ้ำ (คอมอาจปิดอยู่ตอนสมัครครั้งแรก) - ซ้ำได้ ไม่มีผลเสีย */
async function refreshPush() {
  if (!S.pair || !S.pair.w || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sendSigned({ type: "wp-sub", sub: sub.toJSON() });
    else if (S.pushState) enablePush();
  } catch (e) { /* ลองใหม่ครั้งหน้า */ }
}

// ---------------------------------------------------------- เครื่องมือ
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function hhmm(ms) {
  return new Date(ms).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
}

/** วันที่และเวลาแบบไทย เช่น "15 ต.ค. 2569 14:32:07" (ภาษาไทยใช้ปี พ.ศ. ให้เอง) */
function thaiDateTime(ts, seconds) {
  return new Date(ts * 1000).toLocaleString("th-TH", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: seconds ? "2-digit" : undefined,
  });
}

function ago(ts) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "เมื่อสักครู่";
  if (s < 3600) return Math.floor(s / 60) + " นาทีที่แล้ว";
  if (s < 86400) return Math.floor(s / 3600) + " ชั่วโมงที่แล้ว";
  return new Date(ts * 1000).toLocaleDateString("th-TH");
}

// ---------------------------------------------------------- สแกน QR
let scanStream = null;
async function startScan() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("เครื่องนี้เปิดกล้องจากเว็บไม่ได้ ใช้ \"วางลิงก์แทน\"");
    return;
  }
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
  } catch (e) {
    toast("ต้องอนุญาตให้ใช้กล้องถึงจะสแกนได้");
    return;
  }
  $("scan-box").hidden = false;
  const video = $("scan-video");
  video.srcObject = scanStream;
  await video.play();
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const tick = async () => {
    if (!scanStream) return;
    if (video.readyState >= 2 && window.jsQR) {
      const w = Math.min(640, video.videoWidth), h = Math.round(video.videoHeight * w / video.videoWidth);
      c.width = w;
      c.height = h;
      ctx.drawImage(video, 0, 0, w, h);
      const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" });
      if (code && code.data) {
        if (FG.parsePairLink(code.data)) {
          stopScan();
          if (await applyPair(code.data)) boot();
          return;
        }
        $("scan-hint").textContent = "QR นี้ไม่ใช่ของ FallGuard";
      }
    }
    requestAnimationFrame(tick);
  };
  tick();
}

function stopScan() {
  if (scanStream) scanStream.getTracks().forEach((t) => t.stop());
  scanStream = null;
  $("scan-box").hidden = true;
}

// ------------------------------------------------------------ เริ่มแอป
async function boot() {
  // ลิงก์จับคู่ที่มาทาง URL (สแกน QR ด้วยกล้อง iPhone) - กุญแจอยู่หลัง # ไม่ถูกส่งไปที่เว็บ
  if (location.hash.startsWith("#pair?") && !S.pair) await applyPair(location.href, true);
  if (S.pair && !S.proto) S.proto = await FG.Proto.create(S.pair.k, S.pair.t);

  if (isIOS && !standalone && !store.get("browserOk", false)) {
    $("install-paired").hidden = !S.pair;
    show("install");
    return;
  }
  if (!S.pair) {
    show("pair");
    return;
  }
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  await mergeInbox();
  show("home");
  connect();
  refreshPush();
  const alertId = new URLSearchParams(location.search).get("alert");
  if (alertId) openAlert(alertId);
}

/** แจ้งเตือนที่เข้ามาตอนแอปปิดอยู่ (service worker เก็บไว้ให้) */
async function mergeInbox() {
  const inbox = (await idbTake("inbox")) || [];
  for (const d of inbox) {
    if (d.type === "event") onEvent(d, false);
    if (d.type === "ack") markAcked(d.id, d.by || "");
  }
}

$("install-continue").onclick = () => {
  store.set("browserOk", true);
  boot();
};
$("pair-scan").onclick = startScan;
$("scan-cancel").onclick = stopScan;
$("pair-paste").onclick = async () => {
  const link = prompt("วางลิงก์จับคู่ (คัดลอกจากหน้าต่าง \"เชื่อมมือถือ\" บนคอม)");
  if (link && await applyPair(link)) boot();
};
$("cam-search").oninput = renderCameras;
$("live-back").onclick = () => {
  stopLive();
  show("home");
};
$("live-snap").onclick = requestSnapshot;
$("btn-manage").onclick = openManage;
$("live-mode").onclick = chooseMode;
function renderQuality() {
  $("live-q-hd").classList.toggle("on", liveQuality() === "hd");
  $("live-q-low").classList.toggle("on", liveQuality() === "low");
}
for (const [id, q] of [["live-q-hd", "hd"], ["live-q-low", "low"]]) {
  $(id).onclick = () => {
    if (liveQuality() === q) return;
    store.set("liveQ", q);
    renderQuality();
    toast(q === "hd" ? "ภาพชัด (ใช้เน็ตมากขึ้น)" : "ประหยัดเน็ต (ภาพเล็กลง)");
    startLive();                       // ต่อใหม่ด้วยคุณภาพที่เลือก
  };
}
renderQuality();
$("live-manage").onclick = () => {
  stopLive();
  openManage();
};
$("manage-back").onclick = () => show("home");
$("manage-add").onclick = () => editSheet(null);
$("sheet-bg").onclick = (e) => { if (e.target === $("sheet-bg")) closeSheet(); };
$("al-ack").onclick = () => S.alertId && ack(S.alertId);
$("al-live").onclick = () => {
  const e = S.history.find((x) => x.id === S.alertId);
  closeAlert();
  const cams = liveCams();
  const cam = e && cams.find((c) => c.name && e.camera && e.camera.startsWith(c.name) && c.id !== -1);
  openLive(cam ? cam.id : (cams.some((c) => c.id === -1) ? -1 : 0));
};
$("al-close").onclick = () => closeAlert();
$("btn-test").onclick = async () => {
  if (Notification && Notification.permission === "granted" && S.pushState === "ok") {
    await sendSigned({ type: "wp-test" });
    toast("ขอให้คอมส่งแจ้งเตือนทดสอบแล้ว - ปิดแอปไว้แล้วรอดู");
  } else toast("เปิดการแจ้งเตือนก่อน (กล่องสีเหลืองด้านบน)");
};
$("btn-rename").onclick = () => {
  const n = prompt("ชื่อเครื่องนี้ (แสดงให้คนอื่นเห็นตอนกดรับทราบ เช่น \"iPhone แม่\")", deviceName());
  if (n !== null) {
    S.name = n.trim();
    store.set("name", S.name);
    renderHome();
  }
};
// หน้าตาแอป: ตามมือถือ -> สว่าง -> มืด (จำไว้ในเครื่องนี้ ยกเลิกจับคู่แล้วก็ยังจำ)
const THEMES = { auto: "ตามมือถือ", light: "สว่าง", dark: "มืด" };
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  let t = store.get("theme", "auto");
  if (!THEMES[t]) t = "auto";
  if (t === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const dark = t === "dark" || (t === "auto" && darkQuery.matches);
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = dark ? "#252932" : "#e5eaf1";
  $("btn-theme").textContent = "🌓 หน้าตาแอป: " + THEMES[t];
}
$("btn-theme").onclick = () => {
  const order = ["auto", "light", "dark"];
  const next = order[(order.indexOf(store.get("theme", "auto")) + 1) % order.length];
  store.set("theme", next);
  applyTheme();
  toast(next === "auto" ? "หน้าตาแอปเปลี่ยนตามโหมดมืดของมือถือ" : `ใช้หน้าตาแบบ${THEMES[next]}เสมอ`);
};
if (darkQuery.addEventListener) darkQuery.addEventListener("change", applyTheme);
applyTheme();

$("btn-unpair").onclick = async () => {
  if (!confirm("ยกเลิกการจับคู่? เครื่องนี้จะไม่ได้รับแจ้งเตือนอีก จนกว่าจะสแกน QR ใหม่")) return;
  await sendSigned({ type: "wp-unsub" });
  disconnect();
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch (e) { /* ไม่มีการสมัคร */ }
  for (const k of ["pair", "history", "pc", "lastId", "push"]) localStorage.removeItem("fg." + k);
  await idbSet("pair", null);
  S.pair = null;
  S.proto = null;
  show("pair");
};

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    disconnect();
    stopLive();
  } else if (S.pair) {
    mergeInbox().then(renderAll);
    connect();
    if (S.view === "live") startLive();
  }
});
setInterval(pollOverview, POLL_MS);
setInterval(() => S.view === "home" && renderHome(), 30000);   // "x นาทีที่แล้ว"

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("message", (ev) => {
    const d = ev.data || {};
    if (d.type === "open-alert" && d.id) {
      mergeInbox().then(() => {
        renderAll();
        openAlert(d.id);
      });
    }
    if (d.type === "inbox") mergeInbox().then(renderAll);
  });
}
boot();
setTimeout(pollOverview, 800);
