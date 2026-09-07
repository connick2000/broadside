/* ============================================================
   bulk.js — turning a form export into staged notices.

   Tally (and every other form tool worth using) gives you two things
   on its free plan: a CSV of the responses, and a batch download of
   every uploaded file. This module takes both and works out which
   file belongs to which row, entirely offline — no API keys, no
   tokens, no cross-origin fetching, nothing that can rate-limit or
   expire.

   Everything here is pure: no DOM, no storage. That makes it
   testable without a browser.
   ============================================================ */
(function (global) {
  "use strict";

  /* ---------------- CSV ----------------
     RFC 4180: quoted fields, doubled quotes, commas and newlines
     inside quotes, and a stray UTF-8 BOM from Excel. */
  function parseCSV(text) {
    text = String(text || "").replace(/^﻿/, "");
    const rows = [];
    let row = [], field = "", i = 0, quoted = false, sawAny = false;

    while (i < text.length) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { quoted = true; sawAny = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; sawAny = true; i++; continue; }
      if (c === "\r") { i++; continue; }
      if (c === "\n") { row.push(field); field = ""; rows.push(row); row = []; sawAny = false; i++; continue; }
      field += c; sawAny = true; i++;
    }
    if (sawAny || field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(c => String(c).trim() !== ""));
  }

  /* ---------------- column guessing ----------------
     Ordered: the first pattern that hits wins, and a column is only
     ever claimed once, so "In-world name" takes the author slot
     before "Player name" can. */
  const GUESS = [
    ["image",  [/^upload/i, /image/i, /\bfile\b/i, /scan/i, /photo/i, /attach/i, /picture/i]],
    ["size",   [/size/i, /format/i, /how (big|large)/i]],
    ["kind",   [/\bkind\b/i, /\btype\b/i, /categor/i, /what (sort|kind|type)/i, /sort of/i]],
    ["title",  [/headline/i, /\btitle\b/i, /subject/i, /heading/i]],
    ["body",   [/body/i, /\btext\b/i, /message/i, /content/i, /details/i, /description/i,
                /what does it say/i, /wording/i]],
    ["author", [/in.?world/i, /character/i, /attribut/i, /signed/i, /\bic\b/i, /posted by/i, /\bname\b/i]],
    ["id",     [/submission.?id/i, /response.?id/i, /^id$/i]],
  ];
  /* Never auto-map these to anything player-facing. */
  const NEVER = [/discord/i, /e-?mail/i, /player name/i, /real name/i, /phone/i, /consent/i,
                 /acknowledge/i, /understand/i, /submitted at/i, /^date$/i,
                 /how many/i, /repeat/i, /recur/i, /run it/i];

  function guessMapping(headers) {
    const map = {};
    const taken = new Set();
    for (const [field, pats] of GUESS) {
      for (const pat of pats) {
        let hit = -1;
        for (let i = 0; i < headers.length; i++) {
          if (taken.has(i)) continue;
          const h = String(headers[i] || "");
          if (field !== "id" && NEVER.some(n => n.test(h))) continue;
          if (pat.test(h)) { hit = i; break; }
        }
        if (hit >= 0) { map[field] = hit; taken.add(hit); break; }
      }
    }
    return map;
  }

  function normSize(v) {
    const s = String(v || "").toLowerCase();
    if (/\bfull\b|8\.5\s*[x×]\s*11/.test(s)) return "full";
    if (/\bhalf\b|1\/2/.test(s)) return "half";
    if (/quarter|1\/4/.test(s)) return "quarter";
    if (/eighth|eigth|1\/8/.test(s)) return "eighth";
    return null;
  }

  /* Basenames of any files referenced by a cell. Tally puts a URL there;
     other tools put a bare filename. Both are handled, and a cell may
     hold several. */
  function fileKeys(cell) {
    const raw = String(cell || "").trim();
    if (!raw) return [];
    return raw.split(/[\s,;|]+/).filter(Boolean).map(tok => {
      let s = tok;
      const q = s.indexOf("?"); if (q >= 0) s = s.slice(0, q);
      s = s.split("/").pop();
      try { s = decodeURIComponent(s); } catch (e) { /* leave as-is */ }
      return s;
    }).filter(Boolean);
  }

  function hashRow(cells) {
    let h = 5381;
    const s = cells.join("");
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return "r" + h.toString(36);
  }

  /**
   * rows      : output of parseCSV, including the header row
   * mapping   : { field -> column index }
   * opts.seen : Set of fingerprints already imported (for de-duping)
   */
  function buildRows(rows, mapping, opts) {
    opts = opts || {};
    const seen = opts.seen || new Set();
    const headers = rows[0] || [];
    const out = [], duplicates = [];

    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r];
      const at = f => mapping[f] != null && cells[mapping[f]] != null
                        ? String(cells[mapping[f]]).trim() : "";
      const fp = mapping.id != null && at("id") ? "id:" + at("id") : hashRow(cells);

      const rec = {
        fingerprint: fp,
        rowNumber: r,
        kind: at("kind") || "Notice",
        title: at("title"),
        body: at("body"),
        author: at("author"),
        size: normSize(at("size")),
        fileKeys: fileKeys(at("image")),
        raw: headers.map((h, i) => [h, cells[i] == null ? "" : cells[i]]),
      };
      if (seen.has(fp)) { duplicates.push(rec); continue; }
      out.push(rec);
    }
    return { records: out, duplicates };
  }

  /* Match each record's referenced filenames against the files the keeper
     actually downloaded. Exact first, then case-insensitive, then a
     suffix/contains fallback — batch downloads often prefix or suffix
     names to avoid collisions. Every file is used at most once. */
  function matchImages(records, filenames) {
    const remaining = filenames.slice();
    const norm = s => String(s).toLowerCase().replace(/\s+/g, "");
    const strip = s => norm(s).replace(/\.[a-z0-9]+$/, "");

    const take = pred => {
      const i = remaining.findIndex(pred);
      if (i < 0) return null;
      return remaining.splice(i, 1)[0];
    };

    const result = new Map();
    const passes = [
      (key) => take(f => f === key),
      (key) => take(f => norm(f) === norm(key)),
      (key) => take(f => norm(f).endsWith(norm(key)) || norm(key).endsWith(norm(f))),
      (key) => take(f => strip(f).includes(strip(key)) || strip(key).includes(strip(f))),
    ];

    for (const pass of passes) {
      for (const rec of records) {
        if (result.has(rec.fingerprint)) continue;
        if (!rec.fileKeys.length) continue;
        for (const key of rec.fileKeys) {
          const hit = pass(key);
          if (hit) { result.set(rec.fingerprint, hit); break; }
        }
      }
    }

    const wanted = records.filter(r => r.fileKeys.length).length;
    return { matched: result, unmatchedFiles: remaining, wanted, got: result.size };
  }

  global.CodexBulk = { parseCSV, guessMapping, normSize, fileKeys, hashRow, buildRows, matchImages, GUESS };
})(typeof window !== "undefined" ? window : globalThis);
