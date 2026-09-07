/* ============================================================
   keeper.js — the Keeper's Desk.

   Runs entirely in the browser. No server, no account, no network.
   Work is held in IndexedDB so a half-finished cycle survives a
   closed tab; the finished site leaves as a .zip you drag onto your
   host. Images are downscaled on import so the site stays small.

   A cycle stores BOTH its ordered source items and the packed slats.
   The slats are what gets displayed; the items are what you edit.
   Keeping the packed result means a future change to the placement
   rules can never retroactively rearrange history.
   ============================================================ */
(function () {
  "use strict";
  const L = window.CodexLayout;
  const S = window.CodexSlip;
  const Z = window.CodexZip;
  const BK = window.CodexBulk;
  const FL = window.CodexFilters;
  const GM = window.CodexGeom;
  const TN = window.CodexTone;
  const $  = s => document.querySelector(s);
  const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };

  const MAX_EDGE = 1400;      // px, longest side of a stored slip image
  const JPEG_Q   = 0.82;
  const PBKDF2_ROUNDS = 200000;

  /* ---------------- storage ---------------- */
  const DB_NAME = "codex-keeper", STORE = "kv";
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function dbGet(k) {
    const db = await idb();
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, "readonly").objectStore(STORE).get(k);
      t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error);
    });
  }
  async function dbSet(k, v) {
    const db = await idb();
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, "readwrite").objectStore(STORE).put(v, k);
      t.onsuccess = () => res(); t.onerror = () => rej(t.error);
    });
  }

  /* ---------------- state ---------------- */
  let site = null, images = {}, queue = [], sources = [];
  /* The untouched picture behind every styled one. Kept locally so a style is
     always reversible; deliberately NOT published, because visitors have no
     use for it and it would double the size of the site. */
  let origins = {};
  let cropTarget = null;
  let editing = null;          // null, or { index, items } while editing a posted cycle
  let lastSize = "half";       // the add buttons remember what you used last
  let imp = null;              // in-flight bulk import: { rows, mapping, files, built }

  const blankSite = () => ({
    config: {
      titleLines: S.DEFAULT_TITLE_LINES.slice(),
      submitUrl: "",
      submitLabel: "Post a notice",
    },
    cycles: [],
    archive: [],
    keeperLock: null,
    importMap: null,        // remembered column mapping, so setup is a one-off
    importedKeys: [],       // fingerprints already brought in, for de-duping
  });

  /* ---- size icons: the same sheet, with that fraction inked ---- */
  const SIZE_ICON = {
    full:    `<rect class="ink" x="3" y="2" width="18" height="24"/>`,
    half:    `<rect class="ink" x="3" y="2" width="18" height="12"/>`,
    quarter: `<rect class="ink" x="3" y="2" width="9"  height="12"/>`,
    eighth:  `<rect class="ink" x="3" y="2" width="9"  height="6"/>`,
  };
  const sizeIcon = size => `<svg width="24" height="30" viewBox="0 0 24 30" aria-hidden="true">
      ${SIZE_ICON[size]}<rect class="sheet" x="3" y="2" width="18" height="24"/></svg>`;

  async function save() {
    await dbSet("site", site);
    await dbSet("images", images);
    await dbSet("queue", queue);
    await dbSet("sources", sources);
    await dbSet("origins", origins);
  }
  async function load() {
    site    = (await dbGet("site"))    || blankSite();
    images  = (await dbGet("images"))  || {};
    queue   = (await dbGet("queue"))   || [];
    sources = (await dbGet("sources")) || [];
    origins = (await dbGet("origins")) || {};
    if (!site.config) site.config = blankSite().config;
    // older saves kept a single-line title; split it onto its own lines
    if (!site.config.titleLines) {
      site.config.titleLines = S.titleLines(site.config);
      delete site.config.title; delete site.config.subtitle;
    }
    // older saves had no source items on their cycles — recover them from
    // the packed slats so those cycles are still editable
    for (const c of site.cycles) if (!c.items) c.items = itemsFromSlats(c.slats);
    if (!Array.isArray(site.importedKeys)) site.importedKeys = [];
  }
  function itemsFromSlats(slats) {
    const flat = [];
    for (const slat of slats || []) for (const p of slat) flat.push(p);
    flat.sort((a, b) => L.ORDER.indexOf(a.size) - L.ORDER.indexOf(b.size));
    return flat.map(p => ({
      uid: p.uid || ("r" + Math.random().toString(36).slice(2, 9)),
      size: p.size, kind: p.kind || "", title: p.title || "", body: p.body || "",
      author: p.author || "", image: p.image, rot: p.rot,
      cutout: !!p.cutout, paper: p.paper || null,
      margin: p.margin == null ? 100 : p.margin,
      style: p.style || "none", styleAmt: p.styleAmt,
      mime: p.image && /\.png$/i.test(p.image) ? "image/png" : "image/jpeg",
      origBytes: p.image ? origins[p.image] : null,
      hidden: false,
    }));
  }

  /* ---------------- image helpers ---------------- */
  function fileToImage(file) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("Not a readable image: " + file.name)); };
      img.src = url;
    });
  }
  function canvasToBytes(cv, mime) {
    return new Promise(res => cv.toBlob(b => {
      const fr = new FileReader();
      fr.onload = () => res(new Uint8Array(fr.result));
      fr.readAsArrayBuffer(b);
    }, mime || "image/jpeg", JPEG_Q));
  }
  const mimeForName = n => /\.png$/i.test(n || "") ? "image/png" : "image/jpeg";
  function drawScaled(img, sx, sy, sw, sh) {
    const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(sw * scale));
    cv.height = Math.max(1, Math.round(sh * scale));
    const cx = cv.getContext("2d");
    cx.imageSmoothingQuality = "high";
    cx.drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
    return cv;
  }
  const urlCache = new WeakMap();
  function bytesToUrl(bytes, mime) {
    if (!bytes) return "";
    let u = urlCache.get(bytes);
    if (!u) {
      u = URL.createObjectURL(new Blob([bytes], { type: mime || "image/jpeg" }));
      urlCache.set(bytes, u);
    }
    return u;
  }
  function slipImageUrl(p) {
    if (p.bytes) return bytesToUrl(p.bytes, p.mime || "image/jpeg");
    if (p.image && images[p.image]) return bytesToUrl(images[p.image], mimeForName(p.image));
    return p.image || "";
  }
  /* A picture goes through three stages:
       origBytes  what was imported, never touched
       baseBytes  after the keeper has trimmed it to the shape of the paper
       bytes      after a style; this is what gets published
     Styles always re-derive from baseBytes, tidying always re-derives from
     origBytes, so neither can pile up on top of itself. */
  function originalBytes(q) {
    if (q.origBytes) return q.origBytes;
    if (q.bytes) return q.bytes;
    if (q.image) return origins[q.image] || images[q.image] || null;
    return null;
  }
  const baseBytesOf = q => q.baseBytes || originalBytes(q);
  const baseMimeOf  = q => q.baseMime || "image/jpeg";

  /* How far this notice is turned: whole quarter turns plus a fine tilt.
     Held as a property and re-applied from the base picture every time rather
     than baked in on each press — turning something eight times should not
     leave it eight generations of resampling worse than it started. */
  const turnOf = q => ((q.quarter || 0) * 90 + (q.tilt || 0));

  /* How a stored turn is actually applied.

     Quarter turns are exact — a sideways phone photo costs nothing to put
     right. A fine tilt is rotate-AND-CROP, not rotate-and-grow: growing the
     canvas pads the sheet with blank paper on every side, and since the slot
     on the board is a fixed shape the notice itself then shrinks into the
     middle of it. Cropping back to the same proportions keeps the sheet
     filling its place, which is what straightening a crooked scan should do. */
  function turnedCanvas(cv, q) {
    const quarter = (((q.quarter || 0) % 4) + 4) % 4;
    const tilt = q.tilt || 0;
    if (!quarter && !tilt) return cv;
    let out = cv;

    if (quarter) {
      const swap = quarter % 2 === 1;
      const c = document.createElement("canvas");
      c.width = swap ? out.height : out.width;
      c.height = swap ? out.width : out.height;
      const cx = c.getContext("2d", { willReadFrequently: true });
      cx.translate(c.width / 2, c.height / 2);
      cx.rotate(quarter * Math.PI / 2);
      cx.drawImage(out, -out.width / 2, -out.height / 2);
      out = c;
    }

    if (tilt) {
      const px = out.getContext("2d", { willReadFrequently: true })
                    .getImageData(0, 0, out.width, out.height);
      const img = { data: px.data, width: px.width, height: px.height };
      // a picture already brushed through keeps its transparency; anything
      // else gets its own paper colour behind, in case rounding at the very
      // edge would otherwise leave a hairline of nothing
      let fill = null;
      if (!GM.hasAlpha(img)) {
        const m = TN.measurePaper(img);
        fill = m ? TN.toHex(m.paper.map(Math.round)) : null;
      }
      const fit = GM.rotateFit(out.width, out.height, tilt);
      const c = document.createElement("canvas");
      c.width = fit.w; c.height = fit.h;
      const cx = c.getContext("2d", { willReadFrequently: true });
      if (fill) { cx.fillStyle = fill; cx.fillRect(0, 0, fit.w, fit.h); }
      cx.imageSmoothingQuality = "high";
      cx.translate(fit.w / 2, fit.h / 2);
      cx.rotate(tilt * Math.PI / 180);
      cx.drawImage(out, -out.width / 2, -out.height / 2);
      out = c;
    }
    return out;
  }

  /* ---------------- import sources ---------------- */
  async function addFiles(fileList) {
    const files = Array.from(fileList).filter(f => /^image\//.test(f.type));
    if (!files.length) { toast("Those weren't images.", true); return; }
    const staged = [];
    for (const f of files) {
      try {
        const img = await fileToImage(f);
        const cv = drawScaled(img, 0, 0, img.naturalWidth, img.naturalHeight);
        const bytes = await canvasToBytes(cv);
        sources.push({
          id: "src" + Date.now() + Math.random().toString(36).slice(2, 7),
          name: f.name, bytes, w: cv.width, h: cv.height,
        });
        // the source is kept too, so a sheet holding several notices can
        // still be split up afterwards
        staged.push(await pushSlip(bytes, cv.width > cv.height ? "half" : "quarter"));
      } catch (err) { toast(err.message, true); }
    }
    await save(); renderSources(); renderQueue();
    if (!staged.length) return;
    // Straight into preparing them. Every one can be skipped and the whole
    // run stopped, so importing thirty is never thirty forced dialogs.
    openPrep(staged[0], staged);
  }

  function renderSources() {
    const box = $("#sources");
    box.innerHTML = "";
    if (!sources.length) {
      box.appendChild(el("p", "muted", "No scans or photos loaded yet. Drop image files above."));
      return;
    }
    for (const s of sources) {
      const d = el("div", "src");
      const im = el("img"); im.src = bytesToUrl(s.bytes); im.alt = s.name;
      d.appendChild(im);
      d.appendChild(el("div", "srcname", s.name));
      const row = el("div", "row");
      const bWhole = el("button", null, "Use whole image");
      bWhole.addEventListener("click", () => addSlipFromSource(s));
      const bCrop = el("button", null, "Cut slips out…");
      bCrop.addEventListener("click", () => openCrop(s));
      const bDel = el("button", "danger", "Remove");
      bDel.addEventListener("click", async () => {
        if (!confirm(`Remove "${s.name}"? Slips already cut from it are kept.`)) return;
        sources = sources.filter(x => x !== s); await save(); renderSources();
      });
      row.append(bWhole, bCrop, bDel);
      d.appendChild(row);
      box.appendChild(d);
    }
  }

  /* ---------------- cropping ---------------- */
  let cropRect = null, cropDrag = null;

  function openCrop(src) {
    cropTarget = src;
    const dlg = $("#cropDlg"), cv = $("#cropCanvas");
    const img = new Image();
    img.onload = () => {
      const maxW = Math.min(window.innerWidth - 60, 900);
      const scale = Math.min(1, maxW / img.width);
      cv.width = Math.round(img.width * scale);
      cv.height = Math.round(img.height * scale);
      cv._img = img; cropRect = null;
      drawCrop();
      dlg.classList.add("open");
    };
    img.src = bytesToUrl(src.bytes);
  }
  let cropTaken = [];
  function closeCrop() {
    $("#cropDlg").classList.remove("open");
    cropTarget = null;
    // every picture goes through Prepare, however it got here
    const taken = cropTaken; cropTaken = [];
    if (taken.length) openPrep(taken[0], taken);
  }

  function drawCrop() {
    const cv = $("#cropCanvas");
    if (!cv || !cv._img) return;
    const cx = cv.getContext("2d");
    cx.clearRect(0, 0, cv.width, cv.height);
    cx.drawImage(cv._img, 0, 0, cv.width, cv.height);
    if (cropRect) {
      cx.save();
      cx.fillStyle = "rgba(10,7,5,.55)";
      cx.fillRect(0, 0, cv.width, cv.height);
      cx.clearRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
      cx.drawImage(cv._img,
        cropRect.x / cv.width * cv._img.width, cropRect.y / cv.height * cv._img.height,
        cropRect.w / cv.width * cv._img.width, cropRect.h / cv.height * cv._img.height,
        cropRect.x, cropRect.y, cropRect.w, cropRect.h);
      cx.strokeStyle = "#c08a4a"; cx.lineWidth = 2;
      cx.strokeRect(cropRect.x + 1, cropRect.y + 1, cropRect.w - 2, cropRect.h - 2);
      cx.restore();
    }
    $("#cropTake").disabled = !cropRect || cropRect.w < 8 || cropRect.h < 8;
  }
  function cropPos(e) {
    const cv = $("#cropCanvas"), r = cv.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: (t.clientX - r.left) * (cv.width / r.width),
             y: (t.clientY - r.top) * (cv.height / r.height) };
  }
  function cropStart(e) { if (!cropTarget) return; e.preventDefault(); cropDrag = cropPos(e); cropRect = null; drawCrop(); }
  function cropMove(e) {
    if (!cropDrag || !cropTarget) return;
    e.preventDefault();
    const p = cropPos(e);
    cropRect = { x: Math.min(cropDrag.x, p.x), y: Math.min(cropDrag.y, p.y),
                 w: Math.abs(p.x - cropDrag.x), h: Math.abs(p.y - cropDrag.y) };
    drawCrop();
  }
  function cropEnd() { if (!cropDrag) return; cropDrag = null; drawCrop(); }

  async function takeCrop() {
    if (!cropRect || !cropTarget) return;
    const cv = $("#cropCanvas");
    const out = drawScaled(cv._img,
      cropRect.x / cv.width  * cv._img.width,  cropRect.y / cv.height * cv._img.height,
      cropRect.w / cv.width  * cv._img.width,  cropRect.h / cv.height * cv._img.height);
    cropTaken.push(await pushSlip(await canvasToBytes(out),
                                  out.width > out.height ? "half" : "quarter"));
    cropRect = null; drawCrop();
    toast("Slip cut. Draw another rectangle, or close when done — you'll prepare them next.");
  }
  async function addSlipFromSource(src) {
    const item = await pushSlip(src.bytes, src.w > src.h ? "half" : "quarter");
    openPrep(item, [item]);
  }

  const newUid = () => "q" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function loadBytes(bytes, mime) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("could not read that picture"));
      img.src = bytesToUrl(bytes, mime || "image/jpeg");
    });
  }

  /* Re-derive a notice's picture from its untouched original. Always works
     from the original, never from the last styled result, so styles never
     stack up on each other and picking "As photographed" really does undo. */
  async function restyle(q) {
    const src = baseBytesOf(q);
    if (!src) return false;
    if (!q.origBytes && !q.baseBytes) q.origBytes = src;
    const img = await loadBytes(src, baseMimeOf(q));
    let cv = document.createElement("canvas");
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    cv.getContext("2d", { willReadFrequently: true }).drawImage(img, 0, 0);
    cv = turnedCanvas(cv, q);          // the turn is part of the derivation
    const res = FL.apply(cv, q.style || "none", q.styleAmt == null ? 0.5 : q.styleAmt);
    const mime = res.alpha ? "image/png" : "image/jpeg";
    q.bytes = await canvasToBytes(cv, mime);
    q.mime = mime;
    delete q.image;              // it is a different picture now
    return true;
  }

  async function setStyle(q, name, amt) {
    q.style = name;
    if (amt != null) q.styleAmt = amt;
    const row = document.querySelector(`.qitem[data-uid="${q.uid}"]`);
    if (row) row.classList.add("working");
    try {
      await restyle(q);
    } catch (e) { toast(e.message, true); }
    await save(); renderQueue();
  }

  async function styleAll(name, amt) {
    const list = activeList().filter(q => originalBytes(q));
    if (!list.length) { toast("No pictures staged to style.", true); return; }
    toast(`Styling ${list.length} picture${list.length === 1 ? "" : "s"}…`);
    for (const q of list) {
      q.style = name;
      if (amt != null) q.styleAmt = amt;
      try { await restyle(q); } catch (e) { /* skip the unreadable one */ }
      await new Promise(r => setTimeout(r, 0));   // let the page breathe
    }
    await save(); renderQueue();
    toast(`${list.length} picture${list.length === 1 ? "" : "s"} set to ${FL.STYLES[name].label}.`);
  }

  /* Scans and phone photos arrive sideways constantly. Rotating the pixels
     themselves (rather than with a CSS transform) keeps everything
     downstream — aspect guessing, the export, the archive — consistent. */
  /* Set how far a notice is turned. Nothing is rewritten: the angle is
     stored and the picture re-derived, so it can go back to square exactly. */
  async function setTurn(q, patch) {
    if (!baseBytesOf(q)) { toast("Nothing to turn on a text notice.", true); return; }
    if (patch.quarter != null) q.quarter = ((patch.quarter % 4) + 4) % 4;
    if (patch.tilt != null) q.tilt = Math.max(-45, Math.min(45, patch.tilt));
    const row = document.querySelector(`.qitem[data-uid="${q.uid}"]`);
    if (row) row.classList.add("working");
    try { await restyle(q); } catch (e) { toast(e.message, true); }
    await save(); renderQueue();
  }

  async function pushSlip(bytes, guess) {
    const item = {
      uid: newUid(), size: guess || lastSize,
      kind: "Notice", title: "", body: "", author: "",
      bytes, origBytes: bytes, mime: "image/jpeg",
      style: "none", styleAmt: 0.5, hidden: false, margin: 100,
    };
    activeList().push(item);
    await save(); renderQueue();
    return item;                       // so an import can walk what it just staged
  }
  async function addTextSlip(size) {
    lastSize = size || lastSize;
    activeList().push({
      uid: newUid(), size: lastSize,
      kind: "Notice", title: "", body: "", author: "",
      bytes: null, hidden: false, margin: 100,
      style: "none", styleAmt: 0.5,
    });
    // deliberately does NOT scroll to the new row — the sticky add bar means
    // you can keep clicking, and yanking the page under you is jarring
    await save(); renderQueue();
  }

  /* ---------------- bulk import from a form export ----------------
     Two files out of Tally: the CSV of responses, and the batch download
     of every uploaded file. Drop both here together. Nothing is fetched
     over the network, so there is no token to expire and no cross-origin
     problem to trip over. */

  const FIELDS = [
    ["title",  "Headline"],
    ["body",   "Body text"],
    ["kind",   "Kind"],
    ["author", "Attributed to"],
    ["size",   "Requested size"],
    ["image",  "Uploaded file"],
    ["id",     "Unique id (for de-duping)"],
  ];

  async function takeImportFiles(fileList) {
    const all = Array.from(fileList);
    const csvFile = all.find(f => /\.csv$/i.test(f.name) || f.type === "text/csv");
    const imgs = all.filter(f => /^image\//.test(f.type));

    if (!csvFile && !imp) { toast("Add the .csv from your form as well as the images.", true); return; }

    if (csvFile) {
      let rows;
      try { rows = BK.parseCSV(await csvFile.text()); }
      catch (e) { toast("Could not read that CSV: " + e.message, true); return; }
      if (rows.length < 2) { toast("That CSV has no responses in it.", true); return; }
      imp = {
        rows,
        headers: rows[0],
        mapping: reuseMapping(rows[0]) || BK.guessMapping(rows[0]),
        files: (imp && imp.files) || [],
        name: csvFile.name,
      };
    }
    if (imgs.length) imp.files = imp.files.concat(imgs);
    renderImport();
  }

  /* A remembered mapping is only reused when the columns still line up. */
  function reuseMapping(headers) {
    const saved = site.importMap;
    if (!saved || !saved.headers) return null;
    if (saved.headers.length !== headers.length) return null;
    if (saved.headers.some((h, i) => h !== headers[i])) return null;
    return { ...saved.map };
  }

  function computeImport() {
    const seen = new Set(site.importedKeys || []);
    const { records, duplicates } = BK.buildRows(imp.rows, imp.mapping, { seen });
    const match = BK.matchImages(records, imp.files.map(f => f.name));
    return { records, duplicates, match };
  }

  function renderImport() {
    const panel = $("#importPanel");
    const box = $("#importBody");
    if (!imp) { panel.hidden = true; box.innerHTML = ""; return; }
    panel.hidden = false;
    box.innerHTML = "";

    const { records, duplicates, match } = computeImport();
    imp.built = { records, duplicates, match };

    // column mapping
    const mapWrap = el("div", "mapgrid");
    for (const [field, label] of FIELDS) {
      const l = el("label", "fld");
      l.appendChild(el("span", null, label));
      const sel = el("select");
      const none = el("option", null, "— not in this form —"); none.value = "";
      sel.appendChild(none);
      imp.headers.forEach((h, i) => {
        const o = el("option", null, h || `(column ${i + 1})`);
        o.value = String(i);
        if (imp.mapping[field] === i) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", () => {
        if (sel.value === "") delete imp.mapping[field];
        else imp.mapping[field] = Number(sel.value);
        renderImport();
      });
      l.appendChild(sel);
      mapWrap.appendChild(l);
    }
    box.appendChild(mapWrap);

    // what we found
    const sum = el("div", "impsum");
    const withFiles = records.filter(r => r.fileKeys.length).length;
    sum.innerHTML =
      `<b>${records.length}</b> new response${records.length === 1 ? "" : "s"} from <i>${imp.name}</i>` +
      (duplicates.length ? ` · <b>${duplicates.length}</b> already imported, skipped` : "") +
      `<br>${imp.files.length} image file${imp.files.length === 1 ? "" : "s"} added · ` +
      `<b>${match.got}</b> of <b>${withFiles}</b> response${withFiles === 1 ? "" : "s"} matched to a picture` +
      (match.unmatchedFiles.length
        ? `<br><span class="warn">${match.unmatchedFiles.length} file(s) matched nothing: ` +
          match.unmatchedFiles.slice(0, 6).join(", ") + (match.unmatchedFiles.length > 6 ? "…" : "") + `</span>`
        : "") +
      (withFiles > match.got
        ? `<br><span class="warn">${withFiles - match.got} response(s) mention a file you have not added yet — ` +
          `use the batch download on Tally's Submissions tab.</span>`
        : "");
    box.appendChild(sum);

    // preview table
    if (records.length) {
      const tbl = el("div", "imptable");
      tbl.appendChild(rowEl(["", "Size", "Kind", "Headline", "Attributed to", "Picture"], true));
      for (const r of records.slice(0, 12)) {
        tbl.appendChild(rowEl([
          String(r.rowNumber),
          r.size ? L.SIZE[r.size].label : "—",
          r.kind || "—",
          r.title || el("i", null, "(no headline)").textContent,
          r.author || "—",
          match.matched.get(r.fingerprint) || (r.fileKeys.length ? "missing" : "—"),
        ], false, r.fileKeys.length && !match.matched.get(r.fingerprint)));
      }
      if (records.length > 12) tbl.appendChild(rowEl([`…and ${records.length - 12} more`, "", "", "", "", ""]));
      box.appendChild(tbl);
    }

    const row = el("div", "row");
    const go = el("button", "primary", `Add ${records.length} to staging`);
    go.disabled = !records.length;
    go.addEventListener("click", commitImport);
    const cancel = el("button", null, "Discard this import");
    cancel.addEventListener("click", () => { imp = null; renderImport(); });
    row.append(go, cancel);
    box.appendChild(row);
  }

  function rowEl(cells, head, bad) {
    const r = el("div", "improw" + (head ? " head" : "") + (bad ? " bad" : ""));
    for (const c of cells) r.appendChild(el("span", null, String(c)));
    return r;
  }

  async function commitImport() {
    const { records, match } = imp.built;
    const byName = new Map(imp.files.map(f => [f.name, f]));
    let added = 0, withPic = 0;
    const staged = [];

    for (const rec of records) {
      let bytes = null, guess = rec.size;
      const fname = match.matched.get(rec.fingerprint);
      if (fname && byName.has(fname)) {
        try {
          const img = await fileToImage(byName.get(fname));
          const cv = drawScaled(img, 0, 0, img.naturalWidth, img.naturalHeight);
          bytes = await canvasToBytes(cv);
          if (!guess) guess = cv.width > cv.height ? "half" : "quarter";
          withPic++;
        } catch (e) { toast(`Could not read ${fname}: ${e.message}`, true); }
      }
      const item = {
        uid: newUid(), size: guess || "half",
        kind: rec.kind || "Notice", title: rec.title || "", body: rec.body || "",
        author: rec.author || "", bytes, origBytes: bytes, mime: "image/jpeg",
        style: "none", styleAmt: 0.5, hidden: false, margin: 100,
      };
      queue.push(item);
      if (bytes) staged.push(item);
      added++;
      site.importedKeys.push(rec.fingerprint);
    }

    site.importMap = { headers: imp.headers.slice(), map: { ...imp.mapping } };
    imp = null;
    await save();
    renderImport(); renderQueue();
    toast(`${added} notice${added === 1 ? "" : "s"} staged, ${withPic} with a picture. Column mapping remembered.`);
    // straight into preparing the ones that came with a picture; Skip and Stop
    // are right there, so a batch of thirty is never thirty forced dialogs
    if (staged.length) openPrep(staged[0], staged);
  }


  /* ---------------- preparing a picture ----------------
     A real notice is a rectangle. What is crooked is the photograph of it —
     the sheet lies at a few degrees on the table and the frame catches more
     than the sheet. So the first and main tool straightens and crops back to
     a rectangle, rather than tracing an irregular outline.

       1 Straighten & crop — rotate the sheet upright and cut to its edges
       2 Edges             — brush away a thumb or a shadow that survived
       3 Tone              — settle the paper's colour against the board

     No perspective correction, on purpose: a badly keystoned photo is better
     retaken than stretched straight. Every picture can be skipped and the
     whole run stopped, so importing thirty is never thirty forced dialogs. */

  let prep = null;

  const TOOLS = ["crop", "edges", "tone"];

  function cloneCanvas(cv) {
    const c = document.createElement("canvas");
    c.width = cv.width; c.height = cv.height;
    c.getContext("2d").drawImage(cv, 0, 0);
    return c;
  }
  async function bytesToCanvas(bytes, mime) {
    const img = await loadBytes(bytes, mime);
    const cv = document.createElement("canvas");
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    cv.getContext("2d", { willReadFrequently: true }).drawImage(img, 0, 0);
    return cv;
  }
  const pixelsOf = cv => {
    const im = cv.getContext("2d", { willReadFrequently: true })
                 .getImageData(0, 0, cv.width, cv.height);
    return { data: im.data, width: im.width, height: im.height };
  };
  function canvasFrom(img) {
    const cv = document.createElement("canvas");
    cv.width = img.width; cv.height = img.height;
    cv.getContext("2d").putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
    return cv;
  }

  /* Size the preview to the picture. The floors stop a short landscape
     phone collapsing the canvas to nothing. */
  function fitPrepView(cv) {
    const view = $("#prepCanvas");
    const maxW = Math.max(240, Math.min(window.innerWidth - 80, 860));
    const maxH = Math.max(200, window.innerHeight - 300);
    const scale = Math.min(1, maxW / cv.width, maxH / cv.height);
    prep.scale = scale;
    view.width = Math.max(1, Math.round(cv.width * scale));
    view.height = Math.max(1, Math.round(cv.height * scale));
  }

  /* The board's own paper colour, which the Tone tool aims at. */
  function boardPaperRGB() {
    return TN.fromHex(site.config && site.config.paper) || [239, 230, 208];
  }
  /* True paper proportions of the slip this picture is destined for. */
  const arOf = q => (L.SIZE[q.size] || L.SIZE.half).ar;

  /* Put the corners on the paper if we can find it. Falling back to the
     picture's own corners rather than an inset means "we could not find it"
     comes out as "nothing is cropped", not as a mystery 4% trim. */
  function startQuad(cv) {
    const found = GM.guessPaperQuad(pixelsOf(cv));
    return { quad: found || GM.defaultQuad(cv.width, cv.height, 0), guessed: !!found };
  }
  const isWholeQuad = (q, w, h) => {
    const c = [[0, 0], [w, 0], [w, h], [0, h]];
    return q.every((p, i) => Math.abs(p[0] - c[i][0]) < 1.5 && Math.abs(p[1] - c[i][1]) < 1.5);
  };

  async function openPrep(q, list) {
    const src = baseBytesOf(q);
    if (!src) { toast("That notice has no picture to prepare.", true); return; }
    if (!q.origBytes && !q.baseBytes) q.origBytes = src;

    const cv = turnedCanvas(await bytesToCanvas(src, baseMimeOf(q)), q);
    const walk = list && list.length ? list : [q];
    prep = {
      q, list: walk, i: Math.max(0, walk.indexOf(q)),
      work: cv, restoreFrom: cloneCanvas(cv), toneFrom: null,
      scale: 1, tool: "crop", radius: 26, erasing: true,
      quad: null, dragCorner: -1, painting: false,
      lock: site.config.cropLock !== false,
      amount: q.toneAmt == null ? defaultToneAmount() : q.toneAmt,
      contrast: q.toneContrast || 0,
    };
    fitPrepView(cv);
    prep.quad = startQuad(cv).quad;

    $("#cropLock").checked = prep.lock;
    $("#prepSize").value = q.size || "half";
    $("#brushSize").value = String(prep.radius);
    $("#brushSizeVal").textContent = prep.radius + "px";
    $("#brushErase").classList.add("on");
    $("#brushRestore").classList.remove("on");
    $("#toneAmt").value = String(prep.amount);
    $("#toneAmtVal").textContent = prep.amount + "%";
    $("#toneContrast").value = String(prep.contrast);
    setTool("crop");
    refreshWalk();
    $("#prepDlg").classList.add("open");
  }
  function closePrep() { $("#prepDlg").classList.remove("open"); prep = null; }

  const defaultToneAmount = () =>
    site.config && site.config.toneAmt != null ? site.config.toneAmt : 60;

  function refreshWalk() {
    if (!prep) return;
    const n = prep.list.length, more = prep.i < n - 1;
    $("#prepWhich").textContent = n > 1 ? `Picture ${prep.i + 1} of ${n}` : "";
    $("#prepSkip").hidden = !more;
    $("#prepStop").hidden = false;
    $("#prepStop").textContent = more ? "Stop — leave the rest" : "Leave it as it is";
    $("#prepSave").textContent = more ? "Save and next" : "Save";
  }
  async function prepSkip() {
    if (!prep) return;
    if (prep.i >= prep.list.length - 1) { closePrep(); return; }
    await openPrep(prep.list[prep.i + 1], prep.list);
  }
  function prepStop() {
    const left = prep ? prep.list.length - prep.i : 0;
    closePrep();
    if (left > 1) toast(`Stopped. ${left} left as they came in — prepare any of them later.`);
  }

  function setTool(t) {
    // Leaving the corners tool applies them. Carrying an uncommitted shape
    // around invisibly would mean brushing on one picture and saving another.
    if (prep && prep.tool === "crop" && t !== "crop") commitCrop(true);
    if (prep) prep.tool = t;
    for (const k of TOOLS) {
      const b = $("#tool-" + k); if (b) b.classList.toggle("on", k === t);
      const o = $("#opts-" + k); if (o) o.hidden = k !== t;
    }
    $("#prepCanvas").style.cursor = t === "edges" ? "none" : "crosshair";
    if (t === "tone" && prep && !prep.toneFrom) prep.toneFrom = cloneCanvas(prep.work);
    drawPrep();
  }

  /* Checkerboard behind the picture so transparency is obvious. */
  function drawChecks(cx, w, h) {
    const s = 10;
    for (let y = 0; y < h; y += s) {
      for (let x = 0; x < w; x += s) {
        cx.fillStyle = ((x / s + y / s) % 2) ? "#2a231c" : "#221c16";
        cx.fillRect(x, y, s, s);
      }
    }
  }

  function drawPrep(pointer) {
    if (!prep) return;
    const view = $("#prepCanvas");
    const cx = view.getContext("2d");
    const k = prep.scale;
    cx.clearRect(0, 0, view.width, view.height);
    drawChecks(cx, view.width, view.height);
    cx.drawImage(prep.work, 0, 0, view.width, view.height);

    if (prep.tool === "crop" && prep.quad) {
      const pts = prep.quad.map(([x, y]) => [x * k, y * k]);
      cx.save();
      cx.beginPath();
      cx.rect(0, 0, view.width, view.height);
      cx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 3; i >= 1; i--) cx.lineTo(pts[i][0], pts[i][1]);
      cx.closePath();
      cx.fillStyle = "rgba(10,7,5,.62)";
      cx.fill("evenodd");
      cx.restore();

      cx.strokeStyle = "#c08a4a"; cx.lineWidth = 2;
      cx.beginPath();
      cx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < 4; i++) cx.lineTo(pts[i][0], pts[i][1]);
      cx.closePath(); cx.stroke();

      pts.forEach(([x, y], i) => {
        cx.beginPath(); cx.arc(x, y, 8, 0, 7);
        cx.fillStyle = i === prep.dragCorner ? "#e8dfd0" : "#c08a4a";
        cx.fill();
        cx.lineWidth = 2; cx.strokeStyle = "#14100d"; cx.stroke();
      });
    } else if (prep.tool === "edges" && pointer) {
      cx.beginPath();
      cx.arc(pointer.x * k, pointer.y * k, prep.radius * k, 0, 7);
      cx.strokeStyle = prep.erasing ? "#e0705a" : "#7fb069";
      cx.lineWidth = 2; cx.stroke();
    }
  }

  function prepPos(e) {
    const view = $("#prepCanvas"), r = view.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: (t.clientX - r.left) * (view.width / r.width) / prep.scale,
             y: (t.clientY - r.top) * (view.height / r.height) / prep.scale };
  }

  function prepDown(e) {
    if (!prep) return;
    e.preventDefault();
    const p = prepPos(e);
    if (prep.tool === "crop") {
      let best = -1, bestD = Infinity;
      prep.quad.forEach(([x, y], i) => {
        const d = Math.hypot(x - p.x, y - p.y);
        if (d < bestD) { bestD = d; best = i; }
      });
      prep.dragCorner = best;
      if (bestD >= 30 / prep.scale) prep.quad[best] = [p.x, p.y];
      drawPrep();
    } else if (prep.tool === "edges") {
      prep.painting = true;
      paintAt(p);
    }
  }
  function prepMove(e) {
    if (!prep) return;
    const p = prepPos(e);
    if (prep.tool === "crop") {
      if (prep.dragCorner >= 0) {
        e.preventDefault();
        prep.quad[prep.dragCorner] = [
          Math.max(0, Math.min(prep.work.width, p.x)),
          Math.max(0, Math.min(prep.work.height, p.y)),
        ];
        drawPrep();
      }
    } else if (prep.tool === "edges") {
      if (prep.painting) { e.preventDefault(); paintAt(p); }
      drawPrep(p);
    }
  }
  function prepUp() {
    if (!prep) return;
    prep.dragCorner = -1;
    prep.painting = false;
    drawPrep();
  }

  function paintAt(p) {
    const cx = prep.work.getContext("2d", { willReadFrequently: true });
    cx.save();
    cx.globalCompositeOperation = prep.erasing ? "destination-out" : "source-over";
    if (!prep.erasing && prep.restoreFrom) {
      cx.beginPath(); cx.arc(p.x, p.y, prep.radius, 0, 7); cx.clip();
      cx.drawImage(prep.restoreFrom, 0, 0);
    } else {
      const g = cx.createRadialGradient(p.x, p.y, prep.radius * 0.55, p.x, p.y, prep.radius);
      g.addColorStop(0, "rgba(0,0,0,1)"); g.addColorStop(1, "rgba(0,0,0,0)");
      cx.fillStyle = g;
      cx.beginPath(); cx.arc(p.x, p.y, prep.radius, 0, 7); cx.fill();
    }
    cx.restore();
    prep.toneFrom = null;
    drawPrep(p);
  }

  /* Take the four corners of the paper and map them onto a rectangle. The
     corners need not make one — that is the point. A sheet photographed from
     an angle is a quadrilateral, and cropping to its bounding box would keep
     the distortion; mapping it onto a rectangle takes it out, so what lands
     on the board is the square sheet it was before the camera got hold of it. */
  function commitCrop(silent) {
    if (!prep || !prep.quad) return false;
    // Untouched corners usually mean nothing to do — but not when the locked
    // size no longer matches the picture's shape. That is exactly the case
    // where the keeper has changed the size and come back to re-crop, and
    // bailing out here left the button doing nothing at all.
    const cur = prep.work.width / prep.work.height;
    const want = arOf(prep.q);
    const needsShape = prep.lock && Math.abs(cur - want) / want > 0.01;
    if (isWholeQuad(prep.quad, prep.work.width, prep.work.height) && !needsShape) return false;

    const src = pixelsOf(prep.work);
    const m = TN.measurePaper(src);
    const opts = {
      ar: prep.lock ? arOf(prep.q) : 0,
      maxEdge: MAX_EDGE,
      fill: m ? m.paper.map(Math.round) : boardPaperRGB(),
    };
    const outA = GM.unwarpQuad(src, prep.quad, opts);
    if (!outA) { toast("Those four corners don't make a shape.", true); return false; }
    // how much of the result is the selection rather than padding
    prep.blankPct = Math.max(0, Math.round(
      100 * (1 - (outA.contentW * outA.contentH) / (outA.width * outA.height))));
    // the restore copy is put through the identical map, so "Put back" keeps
    // painting the right pixels in the right places afterwards
    const outB = GM.unwarpQuad(pixelsOf(prep.restoreFrom), prep.quad, opts) || outA;

    prep.work = canvasFrom(outA);
    prep.restoreFrom = canvasFrom(outB);
    prep.toneFrom = null;
    fitPrepView(prep.work);
    prep.quad = GM.defaultQuad(prep.work.width, prep.work.height, 0);
    if (!silent) {
      toast(prep.blankPct > 18
        ? `Straightened. ${prep.blankPct}% of this ${prep.q.size} is blank paper — a different size, or a narrower selection, would fill it better.`
        : "Straightened to a rectangle.");
    }
    return true;
  }

  function setCropLock(on) {
    if (!prep) return;
    prep.lock = !!on;
    site.config.cropLock = !!on;
    save();
  }
  /* Re-find the sheet, in case a hand-placed corner went astray. */
  function refindCrop() {
    if (!prep) return;
    const found = startQuad(prep.work);
    prep.quad = found.quad;
    drawPrep();
    toast(found.guessed ? "Found the sheet again."
                        : "Couldn't pick the sheet out — set the corners by hand.", !found.guessed);
  }
  /* Quarter turns inside the editor, for a photo that came in sideways. */
  function turnPrep(dir) {
    if (!prep) return;
    for (const key of ["work", "restoreFrom"]) {
      const from = prep[key];
      const cv = document.createElement("canvas");
      cv.width = from.height; cv.height = from.width;
      const cx = cv.getContext("2d");
      cx.translate(cv.width / 2, cv.height / 2);
      cx.rotate(dir * Math.PI / 2);
      cx.drawImage(from, -from.width / 2, -from.height / 2);
      prep[key] = cv;
    }
    prep.toneFrom = null;
    fitPrepView(prep.work);
    prep.quad = startQuad(prep.work).quad;
    drawPrep();
  }

  /* Tone: re-derived from a snapshot every time, so dragging the slider back
     and forth never stacks one correction on top of another. */
  function applyToneNow() {
    if (!prep) return;
    if (!prep.toneFrom) prep.toneFrom = cloneCanvas(prep.work);
    const src = prep.toneFrom;
    const cv = document.createElement("canvas");
    cv.width = src.width; cv.height = src.height;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    cx.drawImage(src, 0, 0);
    if (prep.amount > 0 || prep.contrast !== 0) {
      const im = cx.getImageData(0, 0, cv.width, cv.height);
      TN.applyTone({ data: im.data, width: im.width, height: im.height }, {
        target: boardPaperRGB(),
        amount: prep.amount / 100,
        contrast: prep.contrast / 100,
      });
      cx.putImageData(im, 0, 0);
    }
    prep.work = cv;
    drawPrep();
  }

  async function resetPrep() {
    if (!prep) return;
    const src = prep.q.origBytes || originalBytes(prep.q);
    if (!src) return;
    const cv = turnedCanvas(await bytesToCanvas(src, "image/jpeg"), prep.q);
    prep.work = cv;
    prep.restoreFrom = cloneCanvas(cv);
    prep.toneFrom = null;
    fitPrepView(cv);
    prep.quad = startQuad(cv).quad;
    prep.tool = "crop";
    setTool("crop");
    toast("Back to the picture as imported.");
  }

  async function savePrep() {
    if (!prep) return;
    if (prep.tool === "crop") commitCrop(true);
    const q = prep.q, list = prep.list, i = prep.i;

    let img = pixelsOf(prep.work);
    img = GM.trimTransparent(img);
    const cv = document.createElement("canvas");
    cv.width = img.width; cv.height = img.height;
    cv.getContext("2d").putImageData(new ImageData(img.data, img.width, img.height), 0, 0);

    // Alpha here means the brush went through to nothing, so the notice is no
    // longer a plain rectangle and the board must not draw a sheet behind it.
    const cut = GM.hasAlpha(img);
    q.baseBytes = await canvasToBytes(cv, cut ? "image/png" : "image/jpeg");
    q.baseMime = cut ? "image/png" : "image/jpeg";
    q.cutout = cut;
    q.toneAmt = prep.amount;
    q.toneContrast = prep.contrast;
    // the editor was already showing the turned picture, and that is what has
    // just been written, so the stored turn has to go back to zero
    q.quarter = 0; q.tilt = 0;
    // The colour of this notice's own paper. Whatever backing shows around it
    // — the sliver left when the crop is not quite the slot's proportions —
    // is painted this, so the join is invisible instead of a cream frame.
    const m = TN.measurePaper(img);
    if (m) q.paper = TN.toHex(m.paper.map(Math.round)); else delete q.paper;
    // what shape this picture actually is, so a later size change can say so
    q.picAR = img.width / img.height;
    if (prep.blankPct != null) q.blankPct = prep.blankPct; else delete q.blankPct;
    delete q.image;
    await restyle(q);
    await save(); renderQueue();

    if (i < list.length - 1) { await openPrep(list[i + 1], list); return; }
    closePrep();
    toast("Saved.");
  }

  /* Sample the staged pictures and move the BOARD to meet them, rather than
     the other way round. */
  async function boardColourFromNotices() {
    const list = activeList().filter(q => baseBytesOf(q));
    if (!list.length) { toast("No pictures staged to sample.", true); return; }
    const papers = [];
    for (const q of list) {
      try {
        const m = TN.measurePaper(pixelsOf(await bytesToCanvas(baseBytesOf(q), baseMimeOf(q))));
        if (m) papers.push(m.paper);
      } catch (e) { /* skip the unreadable one */ }
      await new Promise(r => setTimeout(r, 0));
    }
    const suggested = TN.suggestBoardPaper(papers);
    if (!suggested) { toast("Could not read a paper colour from those.", true); return; }
    site.config.paper = TN.toHex(suggested);
    await save(); renderSettings(); applyPalette();
    toast(`Board colour taken from ${papers.length} notice${papers.length === 1 ? "" : "s"}: ${site.config.paper}`);
  }

  /* Push the configured colour into the page this Desk is showing. */
  function applyPalette() {
    S.applyPalette(site.config, document.documentElement);
  }

  /* ---------------- the working list ---------------- */
  const activeList = () => editing ? editing.items : queue;

  function renderQueue() {
    const list = activeList();
    const box = $("#queue");
    box.innerHTML = "";

    const live = list.filter(q => !q.hidden);
    $("#queueCount").textContent =
      `${live.length} to post` + (list.length - live.length ? `, ${list.length - live.length} withheld` : "");
    $("#editBanner").hidden = !editing;
    if (editing) $("#editBannerText").textContent =
      `Editing cycle ${site.cycles[editing.index].cycle} — changes republish that cycle and everything after it.`;
    $("#reverseBtn").disabled = list.length < 2;

    if (!list.length) {
      box.appendChild(el("p", "muted",
        editing ? "This cycle has no notices left. Saving now would empty it."
                : "Nothing staged. Add scans above, or use the buttons to add a typed notice."));
      updatePreview(); return;
    }

    list.forEach((q, i) => {
      const d = el("div", "qitem" + (q.hidden ? " off" : ""));
      d.draggable = true;
      d.dataset.idx = String(i);
      d.dataset.uid = q.uid;

      const grip = el("div", "qgrip");
      grip.innerHTML = "<span></span><span></span><span></span>";
      grip.title = "Drag to reorder — earlier in the list is placed first, nearest the centre";
      d.appendChild(grip);

      const thumb = el("div", "qthumb");
      const url = slipImageUrl(q);
      if (url) { const im = el("img"); im.src = url; thumb.appendChild(im); }
      else thumb.appendChild(el("span", null, "text"));
      d.appendChild(thumb);

      const body = el("div", "qbody");

      const fields = [];
      const pick = el("div", "sizepick");
      for (const s of L.ORDER) {
        const lab = el("label");
        lab.title = `${L.SIZE[s].label} — ${L.SIZE[s].note}`;
        const rb = el("input"); rb.type = "radio"; rb.name = "size-" + q.uid; rb.value = s;
        rb.checked = q.size === s;
        rb.addEventListener("change", async () => { q.size = s; lastSize = s; await save(); renderQueue(); });
        lab.appendChild(rb);
        lab.insertAdjacentHTML("beforeend", sizeIcon(s));
        lab.appendChild(el("span", "nm", L.SIZE[s].label));
        pick.appendChild(lab);
      }

      const mk = (ph, key, tag) => {
        const n = el(tag || "input");
        if (tag !== "textarea") n.type = "text";
        n.placeholder = ph; n.value = q[key] || "";
        n.addEventListener("input", () => { q[key] = n.value; debounceSave(); });
        return n;
      };
      const kind   = mk("Kind (Notice, Rumour, Bounty…)", "kind");
      const title  = mk("Headline", "title");
      const bodyIn = mk("Body text (shown when a reader opens the slip)", "body", "textarea");
      const author = mk("Attributed to (optional)", "author");

      // margin: how much breathing room the sheet keeps. 0 lets the ink run
      // right to the edge, which is how you cram a long notice onto a small slip.
      const mrow = el("div", "mrow");
      const mlab = el("span", "mlab", "Margin");
      const mrange = el("input"); mrange.type = "range";
      mrange.min = "0"; mrange.max = "150"; mrange.step = "5";
      mrange.value = String(q.margin == null ? 100 : q.margin);
      const mval = el("span", "mval", mrange.value + "%");
      mrange.addEventListener("input", () => {
        q.margin = Number(mrange.value); mval.textContent = mrange.value + "%";
        debounceSave();
      });
      const mreset = el("button", "tiny", "reset");
      mreset.title = "Back to the normal margin";
      mreset.addEventListener("click", async () => { q.margin = 100; await save(); renderQueue(); });
      const oflow = el("span", "oflow"); oflow.hidden = true;
      oflow.textContent = "text is being cut off";
      oflow.title = "Shrink the margin, shorten the text, or use a bigger sheet";
      mrow.append(mlab, mrange, mval, mreset, oflow);
      body.append(pick);

      // A picture is cropped to fit one size. Change the size afterwards and
      // it can only be shrunk to fit the new slot — which is fine as a
      // stopgap but looks wrong, so say so plainly and offer the way out
      // rather than leaving the keeper to wonder what broke.
      if (url && q.picAR) {
        const want = arOf(q);
        const mismatched = Math.abs(q.picAR - want) / want > 0.08;
        const mostlyBlank = !mismatched && q.blankPct > 18;
        if (mismatched || mostlyBlank) {
          const frow = el("div", "mrow");
          const warn = el("span", "oflow");
          warn.textContent = mismatched
            ? "cropped for a different size — shrunk to fit for now"
            : `${q.blankPct}% of this slip is blank paper`;
          warn.title = mismatched
            ? "The picture keeps its own shape and sits smaller inside this slip."
            : "The sheet is a different shape from this size, so it is padded to fit. " +
              "A different size, or a narrower selection, would fill it better.";
          const refit = el("button", "tiny", mismatched ? "Re-crop to fit" : "Re-crop");
          refit.addEventListener("click", () => openPrep(q));
          frow.append(warn, refit);
          body.appendChild(frow);
        }
      }
      body.append(mrow);

      // Turn: quarter turns for a sideways photo, a fine tilt for a sheet that
      // was simply laid down crooked. Both are stored, not baked in.
      if (url || originalBytes(q)) {
        const trow = el("div", "mrow");
        trow.appendChild(el("span", "mlab", "Turn"));
        const ccw = el("button", "tiny", "⟲");
        ccw.title = "A quarter turn anticlockwise";
        ccw.addEventListener("click", () => setTurn(q, { quarter: (q.quarter || 0) - 1 }));
        const cw = el("button", "tiny", "⟳");
        cw.title = "A quarter turn clockwise";
        cw.addEventListener("click", () => setTurn(q, { quarter: (q.quarter || 0) + 1 }));
        const trange = el("input"); trange.type = "range";
        trange.min = "-45"; trange.max = "45"; trange.step = "0.5";
        trange.value = String(q.tilt || 0);
        trange.title = "Fine tilt, for a sheet that was lying crooked";
        // one readout, showing the TOTAL turn — quarter turns and fine tilt
        // together — so it always says what you are actually looking at
        const tval = el("span", "mval");
        tval.style.minWidth = "52px";
        const showTurn = tilt => {
          const total = (q.quarter || 0) * 90 + tilt;
          tval.textContent = total ? total.toFixed(1) + "°" : "square";
        };
        showTurn(q.tilt || 0);
        // on input the readout follows the thumb; the picture is only redrawn
        // when the drag ends, or every pixel of travel would resample it
        trange.addEventListener("input", () => showTurn(Number(trange.value)));
        trange.addEventListener("change", () => setTurn(q, { tilt: Number(trange.value) }));
        const treset = el("button", "tiny", "reset");
        treset.title = "Back to no turn at all";
        treset.addEventListener("click", () => setTurn(q, { quarter: 0, tilt: 0 }));
        trow.append(ccw, cw, trange, tval, treset);
        body.appendChild(trow);
      }

      // style: only meaningful once there is a picture to style
      if (url || originalBytes(q)) {
        const srow = el("div", "srow");
        srow.appendChild(el("span", "mlab", "Style"));
        const sel = el("select");
        for (const name of FL.ORDER) {
          const o = el("option", null, FL.STYLES[name].label);
          o.value = name;
          if ((q.style || "none") === name) o.selected = true;
          sel.appendChild(o);
        }
        sel.addEventListener("change", () => setStyle(q, sel.value));
        const amt = el("input"); amt.type = "range";
        amt.min = "0"; amt.max = "100"; amt.step = "10";
        amt.value = String(Math.round((q.styleAmt == null ? 0.5 : q.styleAmt) * 100));
        amt.title = "Strength — lower keeps fine strokes, higher suppresses paper grain";
        amt.disabled = !q.style || q.style === "none";
        amt.addEventListener("change", () => setStyle(q, q.style, Number(amt.value) / 100));
        const busy = el("span", "busy", "working…");
        srow.append(sel, amt, busy);
        body.appendChild(srow);
      }

      const row = el("div", "row");
      const up = el("button", null, "↑"); up.title = "Move earlier";
      up.addEventListener("click", async () => {
        if (i > 0) { [list[i-1], list[i]] = [list[i], list[i-1]]; await save(); renderQueue(); }
      });
      const down = el("button", null, "↓"); down.title = "Move later";
      down.addEventListener("click", async () => {
        if (i < list.length-1) { [list[i+1], list[i]] = [list[i], list[i+1]]; await save(); renderQueue(); }
      });
      const hide = el("button", null, q.hidden ? "Show on board" : "Withhold");
      hide.title = "Withheld notices stay in your working copy but are never published";
      hide.addEventListener("click", async () => { q.hidden = !q.hidden; await save(); renderQueue(); });
      const del = el("button", "danger", "Delete");
      del.title = "Destroys the image entirely — use for anything that must not be kept";
      del.addEventListener("click", async () => {
        if (!confirm("Delete this permanently, including its image?")) return;
        const at = list.indexOf(q);
        if (at >= 0) list.splice(at, 1);
        await save(); renderQueue();
      });
      const dup = el("button", null, "Duplicate");
      dup.title = "Copy this notice, picture and all";
      dup.addEventListener("click", async () => {
        const copy = { ...q, uid: newUid() };
        list.splice(list.indexOf(q) + 1, 0, copy);
        await save(); renderQueue();
      });
      const fix = el("button", null, "Prepare…");
      fix.title = "Set the corners of the paper, brush the edges, settle the tone";
      fix.disabled = !url;
      fix.addEventListener("click", () => openPrep(q));

      row.append(up, down, dup, fix, hide, del);
      body.append(kind, title, bodyIn, author, row);

      d.appendChild(body);
      box.appendChild(d);
    });
    wireDragReorder(box);
    updatePreview();
  }

  /* ---- drag to reorder ----
     Order is an artistic call: whatever sits earliest is placed first and so
     lands nearest the centre. The ↑ ↓ buttons remain for touch screens and
     keyboards, where HTML5 drag-and-drop does not fire. */
  let dragFrom = null;
  function wireDragReorder(box) {
    const list = activeList();
    box.querySelectorAll(".qitem").forEach(item => {
      item.addEventListener("dragstart", e => {
        dragFrom = Number(item.dataset.idx);
        item.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", String(dragFrom)); } catch (_) {}
      });
      item.addEventListener("dragend", () => {
        dragFrom = null;
        box.querySelectorAll(".qitem").forEach(n => n.classList.remove("dragging", "over-a", "over-b"));
      });
      item.addEventListener("dragover", e => {
        if (dragFrom === null) return;
        e.preventDefault(); e.dataTransfer.dropEffect = "move";
        const r = item.getBoundingClientRect();
        const after = (e.clientY - r.top) > r.height / 2;
        item.classList.toggle("over-a", !after);
        item.classList.toggle("over-b", after);
      });
      item.addEventListener("dragleave", () => item.classList.remove("over-a", "over-b"));
      item.addEventListener("drop", async e => {
        if (dragFrom === null) return;
        e.preventDefault();
        const r = item.getBoundingClientRect();
        const after = (e.clientY - r.top) > r.height / 2;
        let to = Number(item.dataset.idx) + (after ? 1 : 0);
        const moved = list[dragFrom];
        list.splice(dragFrom, 1);
        if (dragFrom < to) to--;
        list.splice(Math.max(0, Math.min(list.length, to)), 0, moved);
        dragFrom = null;
        await save(); renderQueue();
      });
    });
  }

  async function clearStaged() {
    const list = activeList();
    if (!list.length) return;
    const what = editing ? "every notice in the cycle you are editing" : "everything staged";
    if (!confirm(`Remove ${what}? ${list.length} notice(s), including their pictures.`)) return;
    if (editing) editing.items = []; else queue = [];
    await save(); renderQueue();
    toast("Staging cleared.");
  }

  async function reverseOrder() {
    activeList().reverse();
    await save(); renderQueue();
    toast("Order reversed — last in is now placed first.");
  }

  let saveTimer = null;
  function debounceSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { save(); updatePreview(); }, 400);
  }

  /* ---------------- packing, preview, posting ---------------- */
  function boardBeforeIndex(idx) {
    let b = L.emptyBoard();
    for (let i = 0; i < idx && i < site.cycles.length; i++) {
      const c = site.cycles[i];
      b = L.applyCycle(b, { slats: c.slats, slatCount: c.slats.length }, c.cycle).board;
    }
    return b;
  }
  const currentBoard = () => boardBeforeIndex(site.cycles.length);

  /* Give staged items their published form: image bytes are written into the
     image map under a stable name, working-only fields dropped. */
  function freezeItems(list, cycleNo) {
    return list.map(q => {
      const out = {
        uid: q.uid, size: q.size, cycle: cycleNo,
        kind: q.kind || "", title: q.title || "", body: q.body || "",
        author: q.author || "",
        margin: q.margin == null ? 100 : q.margin,
        rot: q.rot != null ? q.rot : Math.round((Math.random() * 2.6 - 1.3) * 100) / 100,
      };
      if (q.style && q.style !== "none") out.style = q.style;
      // tells the board to skip the parchment and let this picture be its
      // own sheet — without it a cut-out sits on an invented rectangle
      if (q.cutout) out.cutout = true;
      if (q.paper) out.paper = q.paper;
      if (q.image) out.image = q.image;
      else if (q.bytes) {
        const ext = q.mime === "image/png" ? "png" : "jpg";
        const name = `images/c${cycleNo}-${q.uid}.${ext}`;
        images[name] = q.bytes;
        if (q.origBytes) origins[name] = q.origBytes;   // local only, never exported
        out.image = name;
      }
      return out;
    });
  }
  function packAt(frozen, idx) {
    return L.packCycle(frozen.map(p => ({ ...p, id: p.uid })), idx % 2 === 1, false);
  }

  function previewPack() {
    const live = activeList().filter(q => !q.hidden);
    if (!live.length) return null;
    const idx = editing ? editing.index : site.cycles.length;
    const cycleNo = editing ? site.cycles[editing.index].cycle
                            : (site.cycles.length ? site.cycles[site.cycles.length-1].cycle : 0) + 1;
    // preview only — resolve images by reference, do not write to the map
    const shaped = live.map(q => ({
      ...q, cycle: cycleNo,
      image: q.image || null, bytes: q.bytes || null,
      mime: q.mime || (q.image && /\.png$/i.test(q.image) ? "image/png" : "image/jpeg"),
      margin: q.margin == null ? 100 : q.margin,
      rot: q.rot != null ? q.rot : 0, id: q.uid,
    }));
    return { packed: L.packCycle(shaped, idx % 2 === 1, false), idx, cycleNo };
  }

  function updatePreview() {
    const info = $("#previewInfo");
    const pv = previewPack();
    if (!pv) {
      info.textContent = "Nothing staged to preview.";
      $("#postBtn").disabled = true;
      renderPreviewBoard(currentBoard());
      return;
    }
    $("#postBtn").disabled = false;
    $("#postBtn").textContent = editing ? "Save changes to this cycle" : "Post this cycle";

    const before = boardBeforeIndex(pv.idx);
    const res = L.applyCycle(before, pv.packed, pv.cycleNo);
    renderPreviewBoard(res.board);

    const retired = res.retired.reduce((n, s) => n + s.slips.length, 0);
    info.innerHTML =
      `<b>${pv.packed.slatCount}</b> slat${pv.packed.slatCount === 1 ? "" : "s"} of content` +
      (res.pull > pv.packed.slatCount
        ? `, <span class="warn">${res.pull} pulled — a hanging Full takes its slat with the one beneath it</span>` : "") +
      (retired ? ` · ${retired} notice${retired === 1 ? "" : "s"} retire to the archive` : "") +
      (editing && pv.idx < site.cycles.length - 1
        ? `<br><span class="warn">${site.cycles.length - 1 - pv.idx} later cycle(s) will be recomputed.</span>` : "");
  }

  function renderPreviewBoard(board) {
    S.renderBoard($("#pvSlats"), board, {
      interactive: true, imageUrl: slipImageUrl,
      onOpen: p => focusStaged(p.uid),
    });
    if (!$("#fullPv").hidden) renderFullPreview(board);
    requestAnimationFrame(flagOverflow);
  }

  /* Clicking a slip in the preview walks the staging list to it. With the
     list scrolling inside its own box, the notice you just spotted on the
     board can otherwise be a long way from the top. */
  function focusStaged(uid) {
    if (!uid) return;
    const row = document.querySelector(`#queue .qitem[data-uid="${uid}"]`);
    if (!row) { toast("That one is already posted — it isn't in the staging list.", true); return; }
    const box = $("#queue");
    // scroll the container, not the page: scrollIntoView would drag the whole
    // desk about and take the preview off screen, which is the thing to avoid
    const top = row.offsetTop - box.offsetTop - (box.clientHeight - row.offsetHeight) / 2;
    box.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    for (const n of box.querySelectorAll(".qitem.found")) n.classList.remove("found");
    row.classList.add("found");
    const t = row.querySelector("input[type=text]");
    if (t) t.focus({ preventScroll: true });
    setTimeout(() => row.classList.remove("found"), 1800);
  }

  /* A slip clips whatever will not fit. Rather than let that be a surprise on
     the published board, measure the rendered preview and mark the rows whose
     text is being cut off — the margin slider is usually the fix. */
  function flagOverflow() {
    const over = new Set();
    for (const n of $("#pvSlats").querySelectorAll(".slip:not(.has-img)")) {
      if (n.scrollHeight > n.clientHeight + 1 && n.dataset.uid) over.add(n.dataset.uid);
    }
    for (const row of document.querySelectorAll("#queue .qitem")) {
      const uid = row.dataset.uid;
      const badge = row.querySelector(".oflow");
      if (badge) badge.hidden = !uid || !over.has(uid);
    }
  }

  /* The full-size preview is the real board layout at real proportions —
     the same markup the public page uses — so what you approve here is
     literally what visitors get. */
  function previewBoards() {
    const pv = previewPack();
    if (!pv) {
      const b = currentBoard();
      return { before: b, after: b, pull: 0 };
    }
    const before = boardBeforeIndex(pv.idx);
    const res = L.applyCycle(before, pv.packed, pv.cycleNo);
    return { before, after: res.board, pull: res.pull };
  }
  function renderFullPreview(board) {
    S.renderBoard($("#fpSlats"), board || previewBoards().after,
                  { interactive: true, imageUrl: slipImageUrl, onOpen: p => S.openReader(p, slipImageUrl) });
  }
  function openFullPreview() {
    const f = $("#fullPv");
    f.hidden = false;
    document.body.classList.add("noscroll");
    const lines = S.titleLines(site.config);
    $("#fpBrand").innerHTML = lines.map(t => `<span class="bline"></span>`).join("");
    Array.from($("#fpBrand").children).forEach((n, i) => { n.textContent = lines[i]; });
    renderFullPreview();
    const pv = previewPack();
    $("#fpNote").textContent = pv
      ? `As it would look after posting — ${pv.packed.slatCount} slat(s) of new content.`
      : "The board as it stands now. Nothing is staged.";
  }
  function closeFullPreview() {
    $("#fullPv").hidden = true;
    document.body.classList.remove("noscroll");
  }
  function playFullPreview() {
    const { before, after, pull } = previewBoards();
    if (!pull) { toast("Nothing staged to animate.", true); return; }
    S.playTransition($("#fpSlats"), before, after, pull,
      { interactive: true, imageUrl: slipImageUrl, onOpen: p => S.openReader(p, slipImageUrl) });
  }

  /* Recompute the board and archive from the stored cycles. */
  function rebuildDerived() {
    let b = L.emptyBoard();
    const arch = [];
    for (const c of site.cycles) {
      const res = L.applyCycle(b, { slats: c.slats, slatCount: c.slats.length }, c.cycle);
      b = res.board;
      for (const s of res.retired) for (const p of s.slips) arch.push(p);
    }
    site.archive = arch;
    pruneImages(b);
  }
  function pruneImages(board) {
    const keep = new Set();
    for (const s of board) if (s) for (const p of s.slips) if (p.image) keep.add(p.image);
    for (const p of site.archive) if (p.image) keep.add(p.image);
    for (const c of site.cycles) for (const it of (c.items || [])) if (it.image) keep.add(it.image);
    for (const k of Object.keys(images)) if (!keep.has(k)) delete images[k];
    for (const k of Object.keys(origins)) if (!keep.has(k)) delete origins[k];
  }

  async function postCycle() {
    const live = activeList().filter(q => !q.hidden);
    if (!live.length) return;

    if (editing) {
      const idx = editing.index;
      const cycleNo = site.cycles[idx].cycle;
      const frozen = freezeItems(live, cycleNo);
      site.cycles[idx] = {
        cycle: cycleNo,
        items: editing.items.map(q => {
          const f = frozen.find(x => x.uid === q.uid);
          return f ? { ...f, hidden: false } : { ...q, bytes: undefined, hidden: true };
        }),
        slats: packAt(frozen, idx).slats,
      };
      rebuildDerived();
      editing = null;
      await save();
      renderQueue(); renderCycles();
      toast(`Cycle ${cycleNo} updated. Export the site to publish the change.`);
      return;
    }

    const cycleNo = (site.cycles.length ? site.cycles[site.cycles.length-1].cycle : 0) + 1;
    const idx = site.cycles.length;
    const frozen = freezeItems(live, cycleNo);
    site.cycles.push({ cycle: cycleNo, items: frozen, slats: packAt(frozen, idx).slats });
    rebuildDerived();
    queue = [];
    await save();
    renderQueue(); renderCycles(); renderBackupNag();
    toast(`Cycle ${cycleNo} posted. Export the site to publish it.`);
  }

  function startEdit(idx) {
    if (queue.length && !editing) {
      if (!confirm("You have notices staged for a new cycle. They will be kept aside while you edit. Continue?")) return;
    }
    const c = site.cycles[idx];
    editing = {
      index: idx,
      items: (c.items || itemsFromSlats(c.slats)).map(p => ({ ...p })),
    };
    renderQueue(); renderCycles();
  }
  async function cancelEdit() {
    editing = null;
    renderQueue(); renderCycles();
    toast("Edit cancelled — nothing changed.");
  }

  function renderCycles() {
    // the local side of the comparison just moved — re-judge it
    if (pub) { syncState = compareToPublished(); renderSync(); }
    const box = $("#cycles");
    box.innerHTML = "";
    if (!site.cycles.length) { box.appendChild(el("p", "muted", "No cycles posted yet.")); return; }
    for (let i = site.cycles.length - 1; i >= 0; i--) {
      const c = site.cycles[i];
      const n = c.slats.reduce((a, s) => a + s.length, 0);
      const d = el("div", "crow" + (editing && editing.index === i ? " editing" : ""));
      d.appendChild(el("span", null,
        `Cycle ${c.cycle} — ${n} notice${n === 1 ? "" : "s"}, ${c.slats.length} slat${c.slats.length === 1 ? "" : "s"}`));
      const btns = el("div", "row");
      const edit = el("button", null, editing && editing.index === i ? "Editing…" : "Edit");
      edit.disabled = !!editing;
      edit.title = "Reopen this cycle and change its notices";
      edit.addEventListener("click", () => startEdit(i));
      btns.appendChild(edit);
      const del = el("button", "danger", "Delete");
      del.disabled = !!editing;
      del.title = "Remove this cycle entirely — later cycles are recomputed";
      del.addEventListener("click", async () => {
        const later = site.cycles.length - 1 - i;
        if (!confirm(`Delete cycle ${c.cycle} outright?` +
          (later ? `\n\n${later} later cycle(s) will be recomputed, so the board and archive will shift.` : "") +
          `\n\nIts notices are NOT returned to staging. Use Unpost for that.`)) return;
        site.cycles.splice(i, 1);
        rebuildDerived();
        await save(); renderQueue(); renderCycles();
        toast(`Cycle ${c.cycle} deleted. Export to publish the change.`);
      });
      btns.appendChild(del);

      if (i === site.cycles.length - 1) {
        const undo = el("button", "danger", "Unpost");
        undo.disabled = !!editing;
        undo.title = "Take this cycle back down and return its notices to staging";
        undo.addEventListener("click", async () => {
          if (!confirm(`Unpost cycle ${c.cycle}? Its notices go back to the staging list.`)) return;
          site.cycles.pop();
          rebuildDerived();
          for (const p of (c.items || itemsFromSlats(c.slats))) {
            queue.push({ ...p, uid: newUid(), bytes: p.image ? images[p.image] : null, hidden: false });
          }
          await save(); renderQueue(); renderCycles();
        });
        btns.appendChild(undo);
      }
      d.appendChild(btns);
      box.appendChild(d);
    }
  }

  /* ---------------- keeper password ---------------- */
  const hex = u8 => Array.from(u8).map(b => b.toString(16).padStart(2, "0")).join("");
  const unhex = h => new Uint8Array((h.match(/.{1,2}/g) || []).map(b => parseInt(b, 16)));

  async function derive(pass, saltHex, rounds) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass),
      "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: unhex(saltHex), iterations: rounds, hash: "SHA-256" }, key, 256);
    return hex(new Uint8Array(bits));
  }
  async function makeLock(pass) {
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    return { salt, rounds: PBKDF2_ROUNDS, hash: await derive(pass, salt, PBKDF2_ROUNDS) };
  }

  async function gate() {
    let lock = null;
    try {
      const r = await fetch("data/keeper-lock.json", { cache: "no-store" });
      if (r.ok) { const j = await r.json(); if (j && j.hash) lock = j; }
    } catch (e) { /* no lock file published */ }
    if (!lock) { site && (site.keeperLock = site.keeperLock || null); return true; }
    if (!site.keeperLock) site.keeperLock = lock;

    try { if (sessionStorage.getItem("codex.keeper.ok") === lock.hash) return true; } catch (e) {}

    return new Promise(resolve => {
      const g = $("#gate");
      g.hidden = false;
      const submit = async () => {
        const pass = $("#gatePass").value;
        $("#gateMsg").textContent = "Checking…";
        try {
          const got = await derive(pass, lock.salt, lock.rounds || PBKDF2_ROUNDS);
          if (got === lock.hash) {
            try { sessionStorage.setItem("codex.keeper.ok", lock.hash); } catch (e) {}
            g.hidden = true; resolve(true);
          } else {
            $("#gateMsg").textContent = "That isn't it.";
            $("#gatePass").select();
          }
        } catch (e) { $("#gateMsg").textContent = "Could not check: " + e.message; }
      };
      $("#gateGo").addEventListener("click", submit);
      $("#gatePass").addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
      $("#gatePass").focus();
    });
  }


  /* ---------------- staying in step with the published board ----------------
     The Desk keeps its work in THIS browser. With several keepers that is a
     clobbering risk: whoever exports last would overwrite the others. So on
     every load we compare against what is actually published and say plainly
     where we stand. The published board is the shared source of truth; the
     Pull button adopts it. */

  let pub = null;        // the published board, or null if it could not be read
  let syncState = "unknown";

  const cycleSig = c =>
    `${c.cycle}#${(c.items || []).length}#${(c.slats || []).reduce((n, s) => n + s.length, 0)}` +
    `#${(c.items || []).map(i => i.uid + ":" + i.size + ":" + (i.title || "")).join("|")}`;
  const sigList = st => (st && st.cycles ? st.cycles : []).map(cycleSig);

  function compareToPublished() {
    if (!pub) return "unknown";
    const a = sigList(site), b = sigList(pub);
    const common = Math.min(a.length, b.length);
    for (let i = 0; i < common; i++) if (a[i] !== b[i]) return "diverged";
    if (a.length === b.length) return "insync";
    return a.length > b.length ? "ahead" : "behind";
  }

  async function readPublished() {
    try {
      const r = await fetch("data/board.json", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      pub = await r.json();
    } catch (e) { pub = null; }
    syncState = compareToPublished();
    renderSync();
  }

  const SYNC_COPY = {
    insync:   ["ok",   "In step with the published board.", ""],
    ahead:    ["warn", "You have work this browser has not published yet.",
               "Export and upload when you are ready."],
    behind:   ["bad",  "The published board is ahead of this browser.",
               "Another keeper has posted since you last synced. Pull before you do anything, or you will overwrite their work."],
    diverged: ["bad",  "This browser and the published board disagree.",
               "You and another keeper have both changed things. Pulling adopts the published board and discards local changes — back up first if you need them."],
    unknown:  ["warn", "Could not read the published board.",
               "Open the Keeper's Desk from your site's web address, not from a local file."],
  };

  function renderSync() {
    const box = $("#syncBox");
    if (!box) return;
    const [tone, head, detail] = SYNC_COPY[syncState] || SYNC_COPY.unknown;
    const localN = sigList(site).length, pubN = pub ? sigList(pub).length : 0;
    box.className = "syncbox " + tone;
    box.innerHTML =
      `<b>${head}</b>` +
      (detail ? `<br><span class="muted">${detail}</span>` : "") +
      `<br><span class="muted">This browser: ${localN} cycle${localN === 1 ? "" : "s"}` +
      (pub ? ` · Published: ${pubN} cycle${pubN === 1 ? "" : "s"}` : "") + `</span>`;
    $("#pullBtn").hidden = !pub || syncState === "insync";
    $("#pullBtn").textContent = syncState === "behind"
      ? "Pull the published board" : "Replace this browser with the published board";
  }

  async function pullPublished() {
    if (!pub) return;
    const lose = syncState === "ahead" || syncState === "diverged";
    if (lose && !confirm(
      "This replaces everything in this browser with what is currently published.\n\n" +
      "Local work that has not been published will be lost. Save a backup file first if you need it.\n\nContinue?")) return;

    const next = JSON.parse(JSON.stringify(pub));
    if (!next.config) next.config = blankSite().config;
    if (!next.config.titleLines) next.config.titleLines = S.titleLines(next.config);
    for (const c of next.cycles || []) if (!c.items) c.items = itemsFromSlats(c.slats);
    next.keeperLock = site.keeperLock;                 // the lock lives beside, not inside
    next.importMap = site.importMap || next.importMap || null;
    next.importedKeys = Array.from(new Set([...(site.importedKeys || []), ...(next.importedKeys || [])]));

    // pull down every picture the published board refers to
    const want = new Set();
    for (const c of next.cycles || []) for (const it of (c.items || [])) if (it.image) want.add(it.image);
    for (const c of next.cycles || []) for (const sl of (c.slats || [])) for (const p of sl) if (p.image) want.add(p.image);
    for (const p of (next.archive || [])) if (p.image) want.add(p.image);

    const fresh = {};
    let missed = 0;
    for (const name of want) {
      if (images[name]) { fresh[name] = images[name]; continue; }
      try {
        const r = await fetch(name, { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        fresh[name] = new Uint8Array(await r.arrayBuffer());
      } catch (e) { missed++; }
    }

    site = next; images = fresh; editing = null;
    await save();
    syncState = compareToPublished();
    renderAll(); renderSync();
    toast(`Pulled the published board — ${want.size - missed} picture(s) fetched` +
          (missed ? `, ${missed} could not be read.` : "."), missed > 0);
  }

  /* ---------------- export / import ---------------- */
  const publicSite = () => {
    const { keeperLock, ...rest } = site;
    return rest;
  };

  async function collectStatic() {
    const files = [];
    const names = ["index.html", "archive.html", "keeper.html",
                   "assets/style.css", "assets/viewport.js",
                   "assets/layout.js", "assets/slip.js", "assets/bulk.js",
                   "assets/filters.js", "assets/geom.js", "assets/tone.js",
                   "assets/board.js", "assets/archive.js", "assets/keeper.js",
                   "assets/zip.js", "READ-ME-FIRST.html"];
    for (const f of names) {
      try {
        const r = await fetch(f, { cache: "no-store" });
        if (!r.ok) throw new Error(r.status);
        files.push({ name: f, data: new Uint8Array(await r.arrayBuffer()) });
      } catch (e) {
        toast(`Could not read ${f} — export may be incomplete. Run the Keeper's Desk from the hosted site, not a local file.`, true);
      }
    }
    return files;
  }

  function dataFiles() {
    const enc = new TextEncoder();
    const files = [{ name: "data/board.json", data: enc.encode(JSON.stringify(publicSite(), null, 1)) }];
    files.push({ name: "data/keeper-lock.json",
                 data: enc.encode(JSON.stringify(site.keeperLock || {}, null, 1)) });
    for (const [name, bytes] of Object.entries(images)) files.push({ name, data: bytes });
    return files;
  }

  function exportGuard() {
    if (syncState === "behind" || syncState === "diverged") {
      return confirm(
        "The published board has changes this browser does not have.\n\n" +
        "Uploading this export will overwrite another keeper's work.\n\nExport anyway?");
    }
    return true;
  }

  async function exportSite() {
    if (!exportGuard()) return;
    const files = (await collectStatic()).concat(dataFiles());
    Z.download(Z.makeZip(files, new Date()), "codex-broadside-site.zip");
    toast(`Exported ${files.length} files. Drag the zip onto your host to publish.`);
  }
  async function exportDataOnly() {
    if (!exportGuard()) return;
    Z.download(Z.makeZip(dataFiles(), new Date()), "codex-board-data.zip");
    toast("Exported data and images only.");
  }
  function backupAge() {
    const posted = site.cycles.length;
    const at = site.backupAtCycles;
    if (at == null) return posted > 0 ? posted : 0;
    return Math.max(0, posted - at);
  }
  function renderBackupNag() {
    const n = backupAge();
    const box = $("#backupNag");
    if (!box) return;
    box.className = "backupnag" + (n >= 2 ? " bad" : n >= 1 ? " warn" : "");
    box.textContent = n === 0
      ? "Backed up as of the latest cycle."
      : `${n} cycle${n === 1 ? "" : "s"} posted since your last backup.`;
  }

  function exportBackup() {
    const payload = {
      site,
      images: Object.fromEntries(Object.entries(images).map(([k, v]) => [k, Array.from(v)])),
      origins: Object.fromEntries(Object.entries(origins).map(([k, v]) => [k, Array.from(v)])),
      queue: queue.map(q => ({ ...q,
        bytes: q.bytes ? Array.from(q.bytes) : null,
        origBytes: q.origBytes ? Array.from(q.origBytes) : null })),
    };
    const stamp = new Date().toISOString().slice(0, 10);
    Z.download(new Blob([JSON.stringify(payload)], { type: "application/json" }),
               `codex-keeper-backup-${stamp}.json`);
    site.backupAtCycles = site.cycles.length;
    save().then(renderBackupNag);
    toast("Backup saved. Keep this if you switch computers.");
  }
  async function importBackup(file) {
    try {
      const p = JSON.parse(await file.text());
      if (!p.site) throw new Error("That isn't a keeper backup file.");
      site = p.site;
      if (!site.config.titleLines) site.config.titleLines = S.titleLines(site.config);
      for (const c of site.cycles) if (!c.items) c.items = itemsFromSlats(c.slats);
      images = Object.fromEntries(Object.entries(p.images || {}).map(([k, v]) => [k, new Uint8Array(v)]));
      origins = Object.fromEntries(Object.entries(p.origins || {}).map(([k, v]) => [k, new Uint8Array(v)]));
      queue = (p.queue || []).map(q => ({ ...q,
        bytes: q.bytes ? new Uint8Array(q.bytes) : null,
        origBytes: q.origBytes ? new Uint8Array(q.origBytes) : null }));
      sources = []; editing = null;
      await save(); renderAll();
      toast("Backup restored.");
    } catch (e) { toast(e.message, true); }
  }

  /* ---------------- settings ---------------- */
  function renderSettings() {
    $("#cfgTitle").value = S.titleLines(site.config).join("\n");
    $("#cfgUrl").value = site.config.submitUrl || "";
    $("#cfgLabel").value = site.config.submitLabel || "";
    $("#cfgPaper").value = (site.config && site.config.paper) || "#efe6d0";
    $("#lockState").textContent = site.keeperLock
      ? "A password is set. It takes effect once you export and publish."
      : "No password set.";
    $("#clearLock").hidden = !site.keeperLock;
  }
  async function saveSettings() {
    site.config.titleLines = $("#cfgTitle").value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    delete site.config.title; delete site.config.subtitle;
    site.config.submitUrl = $("#cfgUrl").value.trim();
    site.config.submitLabel = $("#cfgLabel").value.trim() || "Post a notice";
    await save(); renderSettings();
    toast("Settings saved. Export the site to publish them.");
  }
  async function setPassword() {
    const p1 = $("#newPass").value;
    if (!p1) { toast("Type a password first.", true); return; }
    if (p1.length < 6) { toast("Use at least six characters — ideally a short phrase.", true); return; }
    site.keeperLock = await makeLock(p1);
    $("#newPass").value = "";
    try { sessionStorage.setItem("codex.keeper.ok", site.keeperLock.hash); } catch (e) {}
    await save(); renderSettings();
    toast("Password set. Export and publish for it to take effect.");
  }
  async function clearPassword() {
    if (!confirm("Remove the keeper password?")) return;
    site.keeperLock = null;
    await save(); renderSettings();
    toast("Password removed. Export and publish to apply.");
  }

  /* ---------------- chrome ---------------- */
  let toastTimer = null;
  function toast(msg, bad) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast show" + (bad ? " bad" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = "toast"; }, 4600);
  }
  function renderAll() {
    renderSources(); renderQueue(); renderCycles(); renderSettings(); renderBackupNag();
    applyPalette();          // so the Desk's own preview matches the board
  }

  document.addEventListener("DOMContentLoaded", async () => {
    await load();
    if (!(await gate())) return;
    document.body.classList.add("unlocked");
    renderAll();

    $("#pick").addEventListener("change", e => { addFiles(e.target.files); e.target.value = ""; });
    const drop = $("#drop");
    ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => {
      e.preventDefault(); drop.classList.add("hot");
    }));
    ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => {
      e.preventDefault(); drop.classList.remove("hot");
    }));
    drop.addEventListener("drop", e => addFiles(e.dataTransfer.files));

    // one add button per size, so you can rattle off several of the same kind
    document.querySelectorAll("[data-add]").forEach(b => {
      b.innerHTML = sizeIcon(b.dataset.add) + `<span class="nm">Add ${L.SIZE[b.dataset.add].label}</span>`;
      b.title = `Add a ${L.SIZE[b.dataset.add].label.toLowerCase()} notice — ${L.SIZE[b.dataset.add].note}`;
      b.addEventListener("click", () => addTextSlip(b.dataset.add));
    });
    $("#impPick").addEventListener("change", e => { takeImportFiles(e.target.files); e.target.value = ""; });
    const idrop = $("#impDrop");
    ["dragenter", "dragover"].forEach(ev => idrop.addEventListener(ev, e => {
      e.preventDefault(); idrop.classList.add("hot");
    }));
    ["dragleave", "drop"].forEach(ev => idrop.addEventListener(ev, e => {
      e.preventDefault(); idrop.classList.remove("hot");
    }));
    idrop.addEventListener("drop", e => takeImportFiles(e.dataTransfer.files));
    $("#forgetImports").addEventListener("click", async () => {
      if (!confirm("Forget which responses have already been imported? The next import will offer everything again.")) return;
      site.importedKeys = []; await save(); renderImport();
      toast("Import history cleared.");
    });
    renderImport();
    readPublished();
    $("#pullBtn").addEventListener("click", pullPublished);
    $("#recheckBtn").addEventListener("click", () => { readPublished(); toast("Rechecked."); });

    $("#fullPvBtn").addEventListener("click", openFullPreview);
    $("#fpClose").addEventListener("click", closeFullPreview);
    $("#fpPlay").addEventListener("click", playFullPreview);
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && !$("#fullPv").hidden && !S.readerIsOpen()) closeFullPreview();
    });

    const allSel = $("#styleAll");
    for (const name of FL.ORDER) {
      const o = document.createElement("option");
      o.value = name; o.textContent = FL.STYLES[name].label;
      allSel.appendChild(o);
    }
    allSel.addEventListener("change", async () => {
      const v = allSel.value;
      allSel.selectedIndex = 0;
      if (!v) return;
      if (!confirm(`Set every staged picture to "${FL.STYLES[v].label}"? This replaces each notice's own style.`)) return;
      await styleAll(v);
    });

    $("#reverseBtn").addEventListener("click", reverseOrder);
    $("#clearStaged").addEventListener("click", clearStaged);
    $("#cancelEdit").addEventListener("click", cancelEdit);

    $("#postBtn").addEventListener("click", postCycle);
    $("#exportSite").addEventListener("click", exportSite);
    $("#exportData").addEventListener("click", exportDataOnly);
    $("#backup").addEventListener("click", exportBackup);
    $("#restore").addEventListener("change", e => {
      if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = "";
    });
    $("#saveCfg").addEventListener("click", saveSettings);
    $("#setPass").addEventListener("click", setPassword);
    $("#clearLock").addEventListener("click", clearPassword);

    const tv = $("#prepCanvas");
    tv.addEventListener("mousedown", prepDown);
    window.addEventListener("mousemove", e => { if (prep) prepMove(e); });
    window.addEventListener("mouseup", () => { if (prep) prepUp(); });
    tv.addEventListener("touchstart", prepDown, { passive: false });
    tv.addEventListener("touchmove", prepMove, { passive: false });
    tv.addEventListener("touchend", prepUp);
    for (const t of TOOLS) {
      const b = $("#tool-" + t);
      if (b) b.addEventListener("click", () => setTool(t));
    }
    $("#prepCrop").addEventListener("click", () => { commitCrop(); setTool("edges"); });
    $("#cropLock").addEventListener("change", e => setCropLock(e.target.checked));
    $("#prepSize").addEventListener("change", async e => {
      if (!prep) return;
      prep.q.size = e.target.value;
      lastSize = e.target.value;
      await save(); renderQueue();
      drawPrep();
    });
    $("#cropRefind").addEventListener("click", refindCrop);
    $("#turnLeft").addEventListener("click", () => turnPrep(-1));
    $("#turnRight").addEventListener("click", () => turnPrep(1));
    $("#prepSave").addEventListener("click", savePrep);
    $("#prepSkip").addEventListener("click", prepSkip);
    $("#prepStop").addEventListener("click", prepStop);
    $("#prepReset").addEventListener("click", resetPrep);
    $("#prepClose").addEventListener("click", prepStop);
    $("#brushSize").addEventListener("input", e => {
      if (prep) prep.radius = Number(e.target.value);
      $("#brushSizeVal").textContent = e.target.value + "px";
    });
    $("#brushErase").addEventListener("click", () => {
      if (prep) prep.erasing = true;
      $("#brushErase").classList.add("on"); $("#brushRestore").classList.remove("on");
    });
    $("#brushRestore").addEventListener("click", () => {
      if (prep) prep.erasing = false;
      $("#brushRestore").classList.add("on"); $("#brushErase").classList.remove("on");
    });
    $("#toneAmt").addEventListener("input", e => {
      if (!prep) return;
      prep.amount = Number(e.target.value);
      $("#toneAmtVal").textContent = e.target.value + "%";
      applyToneNow();
    });
    $("#toneContrast").addEventListener("input", e => {
      if (!prep) return;
      prep.contrast = Number(e.target.value);
      applyToneNow();
    });
    $("#boardFromNotices").addEventListener("click", boardColourFromNotices);
    $("#cfgPaper").addEventListener("input", async e => {
      site.config.paper = e.target.value;
      applyPalette(); await save();
    });

    const cv = $("#cropCanvas");
    cv.addEventListener("mousedown", cropStart);
    window.addEventListener("mousemove", cropMove);
    window.addEventListener("mouseup", cropEnd);
    cv.addEventListener("touchstart", cropStart, { passive: false });
    cv.addEventListener("touchmove", cropMove, { passive: false });
    cv.addEventListener("touchend", cropEnd);
    $("#cropTake").addEventListener("click", takeCrop);
    $("#cropClose").addEventListener("click", closeCrop);

    $("#wipe").addEventListener("click", async () => {
      if (!confirm("Erase everything in this browser — board, archive, images, staged notices?")) return;
      if (!confirm("Really? This cannot be undone and your backup file is the only way back.")) return;
      site = blankSite(); images = {}; queue = []; sources = []; editing = null;
      await save(); renderAll(); toast("Wiped.");
    });
  });
})();
