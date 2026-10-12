/*
 * รูปแบบข้อความระหว่างคอมกับมือถือ - ต้องตรงกับ fallguard/mobile.py และ Proto.java ทุกไบต์
 *
 *   ข้อความ: "FG1." + base64url(nonce 12 ไบต์ + ciphertext + tag)   AAD = "FG1|" + topic
 *   ไฟล์/เฟรม: "FG1B" + nonce + ciphertext + tag                     AAD = "FG1-bin|" + topic
 *   ลายเซ็น: base64url(HMAC-SHA256(HMAC(key, "FG1-auth"), text))[:32]
 *
 * ใช้ได้ทั้งในหน้าเว็บและใน service worker (ใช้แค่ WebCrypto ที่มีในทุกเบราว์เซอร์)
 */
(function (root) {
  "use strict";
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const BIN_MAGIC = [0x46, 0x47, 0x31, 0x42]; // "FG1B"

  function b64urlToBytes(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64url(b) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < b.length; i += chunk) bin += String.fromCharCode.apply(null, b.subarray(i, i + chunk));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  class Proto {
    /** สร้างด้วย Proto.create(keyB64, topic) เพราะการเตรียมกุญแจใน WebCrypto เป็นแบบ async */
    static async create(keyB64, topic) {
      const raw = b64urlToBytes(keyB64);
      if (raw.length !== 32) throw new Error("กุญแจต้องยาว 32 ไบต์");
      const p = new Proto();
      p.aesKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
      const hk = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const authRaw = new Uint8Array(await crypto.subtle.sign("HMAC", hk, enc.encode("FG1-auth")));
      p.authKey = await crypto.subtle.importKey("raw", authRaw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      p.aad = enc.encode("FG1|" + topic);
      p.binAad = enc.encode("FG1-bin|" + topic);
      return p;
    }

    async seal(obj) {
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const body = enc.encode(typeof obj === "string" ? obj : JSON.stringify(obj));
      const ct = new Uint8Array(await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: this.aad }, this.aesKey, body));
      return "FG1." + bytesToB64url(concat(nonce, ct));
    }

    /** คืน object หรือ null ถ้าไม่ใช่ข้อความของบ้านนี้ / ถูกแก้ระหว่างทาง */
    async open(text) {
      if (!text || !text.startsWith("FG1.")) return null;
      try {
        const raw = b64urlToBytes(text.slice(4));
        if (raw.length < 28) return null;
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: raw.subarray(0, 12), additionalData: this.aad }, this.aesKey, raw.subarray(12));
        const obj = JSON.parse(dec.decode(plain));
        return obj && typeof obj === "object" ? obj : null;
      } catch (e) {
        return null;
      }
    }

    /** ถอดไฟล์แนบ/เฟรมวิดีโอ (Uint8Array) คืน Uint8Array หรือ null */
    async openBytes(blob) {
      if (!blob || blob.length < 32) return null;
      for (let i = 0; i < 4; i++) if (blob[i] !== BIN_MAGIC[i]) return null;
      try {
        return new Uint8Array(await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: blob.subarray(4, 16), additionalData: this.binAad }, this.aesKey, blob.subarray(16)));
      } catch (e) {
        return null;
      }
    }

    async sealBytes(data) {
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: this.binAad }, this.aesKey, data));
      return concat(concat(new Uint8Array(BIN_MAGIC), nonce), ct);
    }

    async sign(text) {
      const mac = new Uint8Array(await crypto.subtle.sign("HMAC", this.authKey, enc.encode(text)));
      return bytesToB64url(mac).slice(0, 32);
    }
  }

  /** แยกลิงก์จับคู่ (fallguard://pair?... หรือ https://.../#pair?...) คืน object หรือ null */
  function parsePairLink(link) {
    if (!link) return null;
    link = String(link).trim();
    let query = null;
    if (/^fallguard:\/\/pair\?/i.test(link)) query = link.slice(link.indexOf("?") + 1);
    else {
      const h = link.indexOf("#pair?");
      if (h >= 0) query = link.slice(h + 6);
    }
    if (query === null) return null;
    const out = {};
    for (const part of query.split("&")) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      try {
        out[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, " "));
      } catch (e) {
        return null;
      }
    }
    if (!out.s) out.s = "https://ntfy.sh";
    if (!out.t || !out.k) return null;
    if (!/^https?:\/\//.test(out.s)) return null;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(out.t)) return null;
    try {
      if (b64urlToBytes(out.k).length !== 32) return null;
    } catch (e) {
      return null;
    }
    return out;
  }

  root.FG = { Proto, parsePairLink, b64urlToBytes, bytesToB64url };
})(typeof self !== "undefined" ? self : globalThis);
