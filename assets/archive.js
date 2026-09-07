/* ============================================================
   archive.js — everything that has fallen off the bottom of the board,
   laid out at true relative sizes and readable at a tap.
   ============================================================ */
(function () {
  "use strict";
  const S = window.CodexSlip;
  const $ = s => document.querySelector(s);
  let slips = [];

  function el(t, c, x) { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; }

  function card(p) {
    const d = el("button", `acard sz-${p.size || "half"}`
      + (p.image ? " has-img" : "") + (p.image && p.cutout ? " bare" : ""));
    if (p.paper) d.style.setProperty("--slip-paper", p.paper);
    d.type = "button";

    if (p.image) {
      const img = el("img");
      img.src = p.image; img.alt = p.title || "notice"; img.loading = "lazy";
      d.appendChild(img);
    } else {
      d.appendChild(el("div", "ameta", [p.kind, p.author].filter(Boolean).join(" · ") || "Notice"));
      if (p.title) d.appendChild(el("h3", null, p.title));
      if (p.body) d.appendChild(el("p", null, p.body));
    }
    d.title = [p.kind, p.title, p.cycle ? `posted in cycle ${p.cycle}` : null]
      .filter(Boolean).join(" · ");
    d.addEventListener("click", () => S.openReader(p));
    return d;
  }

  function render() {
    const q = $("#q").value.trim().toLowerCase();
    const sizeF = $("#sizeFilter").value;
    const list = slips.filter(p => {
      if (sizeF && p.size !== sizeF) return false;
      if (!q) return true;
      return [p.title, p.body, p.kind, p.author, p.cycle && ("cycle " + p.cycle)]
        .filter(Boolean).join(" ").toLowerCase().includes(q);
    });
    const grid = $("#grid");
    grid.innerHTML = "";
    if (!list.length) {
      grid.appendChild(el("p", "muted", slips.length ? "Nothing matches that." : "The archive is empty."));
    } else {
      for (const p of list) grid.appendChild(card(p));
    }
    $("#count").textContent =
      `${list.length} of ${slips.length} retired notice${slips.length === 1 ? "" : "s"}`;
  }

  async function boot() {
    S.mountReader();
    let data;
    try {
      const res = await fetch("data/board.json", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      data = await res.json();
    } catch (err) {
      $("#count").innerHTML = `<span class="err">Could not load the archive.</span> ` +
        `<span class="muted">If you opened this file straight from your computer, browsers block that. ` +
        `Put the folder on a web host.</span>`;
      return;
    }
    S.applyPalette(data.config || {});
    if (data.config) {
      const lines = S.titleLines(data.config);
      const brand = $("#brand");
      brand.innerHTML = "";
      for (const t of lines) {
        const d = document.createElement("span");
        d.className = "bline"; d.textContent = t;
        brand.appendChild(d);
      }
      document.title = "Archive · " + S.titleFlat(data.config);
      if (data.config.submitUrl) {
        const a = $("#submitLink");
        a.href = data.config.submitUrl; a.hidden = false;
        a.textContent = data.config.submitLabel || "Post a notice";
      }
    }
    slips = (data.archive || []).slice().sort((a, b) => (b.cycle || 0) - (a.cycle || 0));
    $("#q").addEventListener("input", render);
    $("#sizeFilter").addEventListener("change", render);
    render();
  }
  document.addEventListener("DOMContentLoaded", boot);
})();
