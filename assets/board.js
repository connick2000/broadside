/* ============================================================
   board.js — the public Broadside Display.

   Renders data/board.json, lets a reader open any slip at true
   paper aspect ratio, and can walk the board back to any earlier
   state, replaying the slat change into it.
   ============================================================ */
(function () {
  "use strict";
  const L = window.CodexLayout;
  const S = window.CodexSlip;
  const $ = s => document.querySelector(s);
  const SEEN_KEY = "codex.lastSeenCycle";

  let state = null;
  let view = 0;          // which cycle's resulting state we're showing
  let maxCycle = 0;


  /* ---------- history ---------- */

  /* The board as it stood immediately after cycle n was posted. */
  function boardAfter(n) {
    let b = L.emptyBoard();
    for (const c of state.cycles) {
      if (c.cycle > n) break;
      b = L.applyCycle(b, { slats: c.slats, slatCount: c.slats.length }, c.cycle).board;
    }
    return b;
  }
  /* The before/after pair and slat count for the change INTO cycle n. */
  function changeInto(n) {
    const before = boardAfter(n - 1);
    const c = state.cycles.find(x => x.cycle === n);
    if (!c) return { before, after: before, pull: 0 };
    const res = L.applyCycle(before, { slats: c.slats, slatCount: c.slats.length }, c.cycle);
    return { before, after: res.board, pull: res.pull };
  }

  /* ---------- rendering ---------- */
  const opts = () => ({ interactive: true, onOpen: openReader });

  function paint(board) { S.renderBoard($("#slats"), board, opts()); }

  /* The slat change itself lives in slip.js, so the Keeper's full preview
     plays exactly what visitors will see. */
  function playTransition(before, after, pull, done) {
    S.playTransition($("#slats"), before, after, pull, opts(), done);
  }

  /* ---------- reader ---------- */
  const openReader = p => S.openReader(p);

  /* ---------- history controls ---------- */
  /* `animate` is the caller's decision, not something inferred here. An
     earlier version derived it from whether the view moved forward, but the
     initial view is assigned before this runs, so that test was always false
     and the return-visit animation never played. */
  function setView(n, animate) {
    n = Math.max(1, Math.min(maxCycle, n));
    view = n;
    $("#hRange").value = String(n);
    $("#hPrev").disabled = n <= 1;
    $("#hNext").disabled = n >= maxCycle;
    $("#hNow").disabled = n >= maxCycle;

    const { before, after, pull } = changeInto(n);
    if (animate) playTransition(before, after, pull);
    else paint(after);

    const live = after.filter(Boolean).reduce((t, s) => t + s.slips.length, 0);
    const isNow = n >= maxCycle;
    $("#hLabel").innerHTML = isNow
      ? `<b>Current</b> — ${maxCycle} change${maxCycle === 1 ? "" : "s"} so far`
      : `<b>${maxCycle - n}</b> change${maxCycle - n === 1 ? "" : "s"} ago`;
    $("#hLabel").title = `Board as it stood after cycle ${n}`;

    const archived = (state.archive || []).length;
    $("#status").innerHTML =
      `${live} notice${live === 1 ? "" : "s"} on the board` +
      (archived ? ` · <a href="archive.html">${archived} archived</a>` : "");
    $("#status").title = `Cycle ${n}`;
  }

  /* ---------- boot ---------- */
  async function boot() {
    let data;
    try {
      const res = await fetch("data/board.json", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      data = await res.json();
    } catch (err) {
      $("#status").innerHTML = `<span class="err">Could not load the board.</span> ` +
        `If you opened this file directly from your computer, browsers block that — ` +
        `put the folder on a web host.`;
      paint(L.emptyBoard());
      return;
    }
    state = data;

    const cfg = data.config || {};
    S.applyPalette(cfg);   // board colour, if one was sampled from the notices
    const lines = S.titleLines(cfg);
    const brand = $("#brand");
    brand.innerHTML = "";
    for (const t of lines) {
      const d = document.createElement("span");
      d.className = "bline"; d.textContent = t;
      brand.appendChild(d);
    }
    document.title = S.titleFlat(cfg);
    if (cfg.submitUrl) {
      const a = $("#submitLink");
      a.href = cfg.submitUrl; a.hidden = false;
      a.textContent = cfg.submitLabel || "Post a notice";
    }

    const cycles = data.cycles || [];
    if (!cycles.length) {
      paint(L.emptyBoard());
      $("#status").textContent = "The board is empty. Nothing has been posted to the Crossroads yet.";
      return;
    }

    maxCycle = cycles[cycles.length - 1].cycle;
    const hist = $("#history");
    hist.hidden = false;
    const range = $("#hRange");
    range.min = "1"; range.max = String(maxCycle);

    let seen = null;
    try { seen = Number(localStorage.getItem(SEEN_KEY)) || null; } catch (e) {}
    view = maxCycle;
    setView(maxCycle, seen !== null && seen < maxCycle);
    try { localStorage.setItem(SEEN_KEY, String(maxCycle)); } catch (e) {}

    range.addEventListener("input", () => setView(Number(range.value), false));
    $("#hPrev").addEventListener("click", () => setView(view - 1, false));
    $("#hNext").addEventListener("click", () => setView(view + 1, true));
    $("#hNow").addEventListener("click", () => setView(maxCycle, false));
    $("#replay").addEventListener("click", () => {
      const { before, after, pull } = changeInto(view);
      playTransition(before, after, pull);
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    S.mountReader();
    document.addEventListener("keydown", e => {
      if (!state || S.readerIsOpen()) return;
      if (e.key === "ArrowLeft")  setView(view - 1, false);
      if (e.key === "ArrowRight") setView(view + 1, true);
    });
    boot();
  });
})();
