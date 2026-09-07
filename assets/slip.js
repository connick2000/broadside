/* ============================================================
   slip.js — one place that decides how a slip is shaped and drawn.

   Both the public board and the Keeper's Desk preview use this, so
   they can never drift apart. The box is derived from the real sheet
   size, not from the slot it sits in: every slip therefore renders at
   its true paper aspect ratio, and the reader can zoom to exactly the
   same shape.
   ============================================================ */
(function (global) {
  "use strict";
  const L = global.CodexLayout;

  const PAPER_RATIO = 11 / 12;   // sheet height ÷ slot height — identical for all four sizes
  const FILL        = 0.955;     // small breathing gap so sheets don't butt together
  const TOP_BIAS    = 0.40;      // sits a touch high in its slot, as if pinned at the top

  /* Percentages relative to the slat the slip belongs to. */
  function slipBox(p) {
    const wHalfCols = p.hw * FILL;
    const hHalfRows = p.hh * FILL * PAPER_RATIO;
    const left = p.hx + (p.hw - wHalfCols) / 2;
    const top  = p.hy + (p.hh - hHalfRows) * TOP_BIAS;
    return {
      left:   (left      / L.HC)          * 100,
      width:  (wHalfCols / L.HC)          * 100,
      top:    (top       / L.HR_PER_SLAT) * 100,
      height: (hHalfRows / L.HR_PER_SLAT) * 100,
    };
  }

  /* The aspect ratio a reader/zoom view must use to match the board. */
  const aspectOf = size => (L.SIZE[size] || L.SIZE.half).ar;

  /**
   * opts:
   *   imageUrl(p) -> string        how to resolve a slip's picture
   *   interactive: bool            adds button semantics + click handler
   *   onOpen(p)
   */
  function buildSlip(p, opts) {
    opts = opts || {};
    const d = document.createElement("div");
    // A picture cut to the real shape of its paper IS the sheet. Painting the
    // board's parchment behind it would put a second, fake sheet under a real
    // one — exactly the thing the cutting is meant to get rid of.
    d.className = `slip sz-${p.size}${p.drape ? " drape" : ""}${p.cutout ? " bare" : ""}`;
    if (p.uid) d.dataset.uid = p.uid;
    // per-notice margin: 1 = the normal breathing room, 0 = ink to the edge
    const pad = (p.margin == null ? 100 : p.margin) / 100;
    d.style.setProperty("--pad", String(pad));
    // The colour of this notice's own paper, sampled when it was prepared.
    // Whatever backing shows around the picture — the sliver left when the
    // crop is not quite the slot's proportions — is painted this, so the join
    // disappears instead of showing a cream frame round a white scan.
    if (p.paper) d.style.setProperty("--slip-paper", p.paper);

    const box = slipBox(p);
    d.style.left   = box.left + "%";
    d.style.top    = box.top + "%";
    d.style.width  = box.width + "%";
    d.style.height = box.height + "%";
    d.style.transform = `rotate(${p.rot || 0}deg)`;
    if (p.drape) d.style.zIndex = 4;

    const url = opts.imageUrl ? opts.imageUrl(p) : (p.image || "");
    if (url) {
      // no caption on the face — the sheet is the scan, and every pixel of
      // the slip is given over to showing it whole
      d.classList.add("has-img");
      const img = document.createElement("img");
      img.src = url; img.alt = p.title || p.kind || "notice"; img.loading = "lazy";
      d.appendChild(img);
    } else {
      // No kind, no line. It used to fall back to the word "Notice", which
      // printed itself on every sheet whether the keeper wanted it or not —
      // and cost the body a line of height to say nothing.
      if (p.kind) {
        const kind = document.createElement("span");
        kind.className = "kind"; kind.textContent = p.kind;
        d.appendChild(kind);
      }
      if (p.title) {
        const t = document.createElement("span");
        t.className = "ttl"; t.textContent = p.title;
        d.appendChild(t);
      }
      if (p.body && p.size !== "eighth") {
        const b = document.createElement("span");
        b.className = "body"; b.textContent = p.body;
        d.appendChild(b);
      }
    }
    if (p.drape) {
      const f = document.createElement("span");
      f.className = "fold";
      d.appendChild(f);
    }

    // the cycle stays out of the way — it lives in the tooltip, not on the face
    d.title = [p.kind, p.title, p.cycle ? `posted in cycle ${p.cycle}` : null]
      .filter(Boolean).join(" · ");

    if (opts.interactive) {
      d.tabIndex = 0;
      d.setAttribute("role", "button");
      d.setAttribute("aria-label", `Read: ${p.title || p.kind || "notice"}`);
      const go = () => opts.onOpen && opts.onOpen(p);
      d.addEventListener("click", go);
      d.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
      });
    } else {
      d.style.cursor = "default";
    }
    return d;
  }

  /* Paint a whole board (array of ROWS slats) into a .slats container.
     `layout.rowOffset` shifts every slat by that many rows, which is how the
     incoming slats get parked above the top edge before they slide down. */
  function renderBoard(container, board, opts, layout) {
    const off = (layout && layout.rowOffset) || 0;
    container.innerHTML = "";
    for (let r = 0; r < L.ROWS; r++) {
      const s = document.createElement("div");
      s.className = "slat";
      s.style.top = `calc(${r + off} * 100% / ${L.ROWS})`;
      s.dataset.row = r;
      // Upper slats must outrank lower ones. A slat is its own stacking
      // context, so a hanging Full cannot paint over the slat beneath it
      // on the slip's own z-index alone.
      s.style.zIndex = String(L.ROWS - r);
      const data = board[r];
      if (data) for (const p of data.slips) s.appendChild(buildSlip(p, opts));
      container.appendChild(s);
    }
  }

  /* ------------------------------------------------------------
     The zoomed sheet. Shared by the board and the archive so the
     two can never disagree about what a slip looks like up close.
     ------------------------------------------------------------ */
  function mountReader() {
    if (document.getElementById("reader")) return;
    const rd = document.createElement("div");
    rd.className = "reader"; rd.id = "reader";
    rd.setAttribute("role", "dialog");
    rd.setAttribute("aria-modal", "true");
    rd.setAttribute("aria-label", "Notice");
    rd.innerHTML = `<button class="close" id="readerClose">Close</button>
                    <div class="sheet" id="readerSheet"></div>`;
    document.body.appendChild(rd);
    rd.querySelector("#readerClose").addEventListener("click", closeReader);
    rd.addEventListener("click", e => { if (e.target === rd) closeReader(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeReader(); });
  }

  function openReader(p, resolveImage) {
    mountReader();
    const rd = document.getElementById("reader");
    const sheet = document.getElementById("readerSheet");
    sheet.innerHTML = "";
    sheet.style.setProperty("--ar", String(aspectOf(p.size)));

    const src = resolveImage ? resolveImage(p) : (p.image || "");
    sheet.classList.toggle("scrolls", !src && (p.body || "").length > 400);
    // same reasoning as on the board: a cut-out is its own sheet, so the
    // zoom must not draw parchment behind it either
    sheet.classList.toggle("bare", !!(p.cutout && src));
    sheet.classList.toggle("hasimg", !!src);
    if (p.paper) sheet.style.setProperty("--slip-paper", p.paper);
    else sheet.style.removeProperty("--slip-paper");

    const metaText = [p.kind, p.author].filter(Boolean).join("  ·  ");
    if (metaText) {
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = metaText;
      meta.title = p.cycle ? `Posted in cycle ${p.cycle}` : "";
      sheet.appendChild(meta);
    }

    if (p.title) {
      const h = document.createElement("h2"); h.textContent = p.title; sheet.appendChild(h);
    }
    if (src) {
      const img = document.createElement("img");
      img.src = src; img.alt = p.title || "notice"; sheet.appendChild(img);
    }
    if (p.body) {
      const b = document.createElement("p"); b.textContent = p.body; sheet.appendChild(b);
    }
    rd.classList.add("open");
    document.getElementById("readerClose").focus();
  }
  function closeReader() {
    const rd = document.getElementById("reader");
    if (rd) rd.classList.remove("open");
  }
  const readerIsOpen = () => {
    const rd = document.getElementById("reader");
    return !!rd && rd.classList.contains("open");
  };

  /* ------------------------------------------------------------
     Title handling. The masthead is authored as separate lines;
     a flattened form is used for the browser tab and the archive.
     ------------------------------------------------------------ */
  const DEFAULT_TITLE_LINES = [
    "Codex Field Chronicles:",
    "Crossroads Chapter —",
    "Broadside Display",
  ];
  function titleLines(config) {
    config = config || {};
    if (Array.isArray(config.titleLines) && config.titleLines.length) {
      return config.titleLines.filter(s => String(s).trim() !== "");
    }
    if (typeof config.title === "string" && config.title.trim()) {
      return config.title.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    }
    return DEFAULT_TITLE_LINES.slice();
  }
  const titleFlat = config => titleLines(config).join(" ");

  /* ------------------------------------------------------------
     The slat change, in three beats, matching the prop:
       1. the lowest slats draw out to the right
       2. the stack settles downward — and the fresh slats, parked
          just above the top edge, ride down with it
       3. a clean repaint in the final position
     Beat 2 animates the container rather than individual slats, so
     survivors and newcomers move as one piece.
     Shared by the public board and the Keeper's full preview.
     ------------------------------------------------------------ */
  let animating = false;
  function playTransition(container, before, after, pull, opts, done) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const finish = () => { renderBoard(container, after, opts); done && done(); };
    if (reduce || !pull || animating) { finish(); return; }
    animating = true;

    renderBoard(container, before, opts);
    const rows = Array.from(container.querySelectorAll(".slat"));

    requestAnimationFrame(() => {
      for (let r = L.ROWS - pull; r < L.ROWS; r++) {
        if (!rows[r]) continue;
        rows[r].classList.add("anim");
        rows[r].style.transform = "translateX(118%)";
      }
      setTimeout(() => {
        renderBoard(container, after, opts, { rowOffset: -pull });
        container.style.transition = "none";
        container.style.transform = "translateY(0)";
        requestAnimationFrame(() => {
          container.style.transition = "transform 700ms cubic-bezier(.36,.06,.2,1)";
          container.style.transform = `translateY(${(pull / L.ROWS) * 100}%)`;
          setTimeout(() => {
            container.style.transition = "none";
            container.style.transform = "";
            finish();
            requestAnimationFrame(() => { container.style.transition = ""; });
            animating = false;
          }, 740);
        });
      }, 560);
    });
  }

  /* The board can be told to move to meet the notices rather than the other
     way round: a paper colour sampled from the scans is written here as CSS
     variables, and the slats are derived from it so the whole thing stays
     coherent instead of the sheets and the backing drifting apart.
     With no colour set, the stylesheet's own values stand. */
  const PALETTE_VARS = { paper: "--paper", paper2: "--paper-2", slat: "--slat", slat2: "--slat-2" };
  function applyPalette(config, root) {
    const el = root || document.documentElement;
    const TN = global.CodexTone;
    const rgb = TN && TN.fromHex(config && config.paper);
    if (!rgb) {
      for (const v of Object.values(PALETTE_VARS)) el.style.removeProperty(v);
      return null;
    }
    const pal = TN.boardPalette(rgb);
    for (const [k, v] of Object.entries(PALETTE_VARS)) el.style.setProperty(v, TN.toHex(pal[k]));
    return pal;
  }

  global.CodexSlip = {
    slipBox, aspectOf, buildSlip, renderBoard, playTransition, PAPER_RATIO, FILL,
    mountReader, openReader, closeReader, readerIsOpen, applyPalette,
    titleLines, titleFlat, DEFAULT_TITLE_LINES,
  };
})(typeof window !== "undefined" ? window : globalThis);
