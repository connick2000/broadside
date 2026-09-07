/* ============================================================
   zip.js — minimal store-only ZIP writer.
   No dependencies, no network. Images are already compressed, so
   storing without deflate costs almost nothing and keeps this to
   ~100 lines instead of pulling in a library.
   ============================================================ */
(function (global) {
  "use strict";

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  const enc = new TextEncoder();

  /* DOS date/time. Takes an explicit Date so callers control it. */
  function dosStamp(d) {
    const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
    const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time, date };
  }

  class Writer {
    constructor() { this.parts = []; this.len = 0; }
    push(u8) { this.parts.push(u8); this.len += u8.length; }
    u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this.push(b); }
    u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this.push(b); }
    bytes(b) { this.push(b); }
    blob(type) { return new Blob(this.parts, { type: type || "application/zip" }); }
  }

  /**
   * files: [{ name: "path/in/zip.txt", data: Uint8Array | string }]
   * Returns a Blob.
   */
  function makeZip(files, when) {
    const stamp = dosStamp(when || new Date());
    const w = new Writer();
    const central = [];

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
      const crc = crc32(data);
      const offset = w.len;

      // local file header
      w.u32(0x04034b50);
      w.u16(20);            // version needed
      w.u16(0x0800);        // UTF-8 filename flag
      w.u16(0);             // method 0 = stored
      w.u16(stamp.time); w.u16(stamp.date);
      w.u32(crc);
      w.u32(data.length); w.u32(data.length);
      w.u16(nameBytes.length); w.u16(0);
      w.bytes(nameBytes);
      w.bytes(data);

      central.push({ nameBytes, crc, size: data.length, offset });
    }

    const cdStart = w.len;
    for (const c of central) {
      w.u32(0x02014b50);
      w.u16(20); w.u16(20);
      w.u16(0x0800); w.u16(0);
      w.u16(stamp.time); w.u16(stamp.date);
      w.u32(c.crc);
      w.u32(c.size); w.u32(c.size);
      w.u16(c.nameBytes.length);
      w.u16(0); w.u16(0); w.u16(0); w.u16(0);
      w.u32(0);
      w.u32(c.offset);
      w.bytes(c.nameBytes);
    }
    const cdSize = w.len - cdStart;

    w.u32(0x06054b50);
    w.u16(0); w.u16(0);
    w.u16(central.length); w.u16(central.length);
    w.u32(cdSize); w.u32(cdStart);
    w.u16(0);

    return w.blob();
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  global.CodexZip = { makeZip, download, crc32 };
})(typeof window !== "undefined" ? window : globalThis);
