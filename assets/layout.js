/* ============================================================
   layout.js — the placement grammar of the Broadside Display.

   The board is 5 columns x 6 slats. Everything resolves onto a
   half-unit lattice: 10 half-columns wide, 2 half-rows per slat.

     Full     2w x 4h   pinned to one slat, HANGS over the slat below
     Half     2w x 2h   one whole column slot
     Quarter  1w x 2h   half a column, full slat height
     Eighth   1w x 1h   quarter of a column slot

   Grammar:
     - the bottom slat of a cycle fills centre-outward
     - every slat above it fills outside-inward
     - within a slat, mirror pairs are exhausted before stepping in,
       which keeps a partial tier balanced AND leaves the centre
       notch that makes the chevron read
     - eighths hug the top of their slot on the bottom slat and the
       bottom of their slot on the slats above, closing each cycle
       up around its own seam
     - a Full is pinned to one slat only and hangs free over the one
       below, so it can never sit on the lowest slat of a cycle
   ============================================================ */
(function (global) {
  "use strict";

  const COLS = 5;
  const ROWS = 6;
  const HC_PER_COL = 2;
  const HR_PER_SLAT = 2;
  const HC = COLS * HC_PER_COL;          // 10 half-columns
  const SLAT_UNITS = HC * HR_PER_SLAT;   // 20 half-units per slat

  /* pw/ph are the real sheet dimensions in inches. A slot is 8.5" per column
     and 6" per slat, so the paper is always 11/12 of its slot's height and
     exactly its slot's width — which is what makes every slip render at a
     true paper aspect ratio instead of stretching to fill the slot. */
  const SIZE = {
    full:    { w:2, h:4, area:8, pw:8.5,  ph:11,   label:"Full",    note:"8.5 × 11 portrait — hangs over the slat below" },
    half:    { w:2, h:2, area:4, pw:8.5,  ph:5.5,  label:"Half",    note:"8.5 × 5.5 landscape — one column" },
    quarter: { w:1, h:2, area:2, pw:4.25, ph:5.5,  label:"Quarter", note:"4.25 × 5.5 portrait — half a column" },
    eighth:  { w:1, h:1, area:1, pw:4.25, ph:2.75, label:"Eighth",  note:"4.25 × 2.75 landscape — quarter of a column" },
  };
  for (const k of Object.keys(SIZE)) SIZE[k].ar = SIZE[k].pw / SIZE[k].ph;
  const ORDER = ["full", "half", "quarter", "eighth"];

  const colOrderCentreOut = flip => flip ? [2,3,1,4,0] : [2,1,3,0,4];
  const colOrderOutsideIn = flip => flip ? [4,0,3,1,2] : [0,4,1,3,2];

  function colGroups(isBottom, flip) {
    const g = isBottom ? [[2],[1,3],[0,4]] : [[0,4],[1,3],[2]];
    return flip ? g.map(p => p.length > 1 ? [p[1], p[0]] : p) : g;
  }
  function halfColOrder(col, isBottom) {
    if (isBottom) return col < 2 ? [1,0] : [0,1];
    return col <= 2 ? [0,1] : [1,0];
  }
  const eighthRows = isBottom => isBottom ? [0,1] : [1,0];

  function packCycle(slips, flip, tight) {
    const queue = [...slips].sort((a,b) => ORDER.indexOf(a.size) - ORDER.indexOf(b.size));
    const area = queue.reduce((s,x) => s + (SIZE[x.size] ? SIZE[x.size].area : 0), 0);
    let k = Math.max(1, Math.ceil(area / SLAT_UNITS));
    if (queue.some(x => x.size === "full")) k = Math.max(k, 2);

    for (let guard = 0; guard < 40; guard++) {
      const attempt = tryPack(queue, k, flip, false, !tight);
      if (attempt) return { slats: attempt, slatCount: k };
      k++;
      if (k > ROWS * 4) break;
    }
    return { slats: tryPack(queue, ROWS, flip, true, !tight) || [], slatCount: ROWS };
  }

  function tryPack(queue, k, flip, force, spread) {
    const occ = Array.from({length:k}, () =>
                Array.from({length:HR_PER_SLAT}, () => new Array(HC).fill(false)));
    const out = Array.from({length:k}, () => []);
    const pending = [...queue];

    const claim = (s,hx,hy,w,h) => {
      for (let y = hy; y < hy+h; y++) for (let x = hx; x < hx+w; x++) occ[s][y][x] = true;
    };
    const free = (s,hx,hy,w,h) => {
      if (s < 0 || s >= k || hx < 0 || hx+w > HC || hy < 0 || hy+h > HR_PER_SLAT) return false;
      for (let y = hy; y < hy+h; y++) for (let x = hx; x < hx+w; x++) if (occ[s][y][x]) return false;
      return true;
    };

    /* Fulls first. Pinned to slat lower+1, hanging over slat lower. */
    for (const f of queue.filter(p => p.size === "full")) {
      let done = false;
      for (let lower = 0; lower + 1 < k && !done; lower += 2) {
        for (const col of colOrderCentreOut(flip)) {
          const hx = col * HC_PER_COL;
          if (free(lower, hx, 0, 2, 2) && free(lower+1, hx, 0, 2, 2)) {
            claim(lower, hx, 0, 2, 2);
            claim(lower+1, hx, 0, 2, 2);
            out[lower+1].push({ ...f, hx, hy:0, hw:2, hh:4, drape:true });
            done = true; break;
          }
        }
      }
      if (!done && !force) return null;
      const i = pending.indexOf(f); if (i >= 0) pending.splice(i, 1);
    }

    const placeInColumn = (s, col, isBottom, budget) => {
      const base = col * HC_PER_COL;
      let n = 0;
      while (pending.length && n < budget) {
        const size = pending[0].size;
        if (size === "half") {
          if (!free(s, base, 0, 2, 2)) break;
          claim(s, base, 0, 2, 2);
          out[s].push({ ...pending.shift(), hx:base, hy:0, hw:2, hh:2 });
          n++; continue;
        }
        if (size === "quarter") {
          let put = false;
          for (const off of halfColOrder(col, isBottom)) {
            if (free(s, base+off, 0, 1, 2)) {
              claim(s, base+off, 0, 1, 2);
              out[s].push({ ...pending.shift(), hx:base+off, hy:0, hw:1, hh:2 });
              put = true; break;
            }
          }
          if (!put) break;
          n++; continue;
        }
        if (size === "eighth") {
          let put = false;
          for (const off of halfColOrder(col, isBottom)) {
            for (const hy of eighthRows(isBottom)) {
              if (free(s, base+off, hy, 1, 1)) {
                claim(s, base+off, hy, 1, 1);
                out[s].push({ ...pending.shift(), hx:base+off, hy, hw:1, hh:1 });
                put = true; break;
              }
            }
            if (put) break;
          }
          if (!put) break;
          n++; continue;
        }
        break;
      }
      return n;
    };

    for (let s = 0; s < k && pending.length; s++) {
      const isBottom = (s === 0);
      if (spread) {
        for (const group of colGroups(isBottom, flip)) {
          for (let guard = 0; guard < SLAT_UNITS && pending.length; guard++) {
            let moved = 0;
            for (const col of group) moved += placeInColumn(s, col, isBottom, 1);
            if (!moved) break;
          }
        }
      } else {
        const cols = isBottom ? colOrderCentreOut(flip) : colOrderOutsideIn(flip);
        for (const col of cols) {
          if (!pending.length) break;
          placeInColumn(s, col, isBottom, Infinity);
        }
      }
    }

    if (pending.length && !force) return null;
    return out;
  }

  /* ------------------------------------------------------------
     Apply a packed cycle to a board. board is an array of ROWS
     entries, index 0 = top slat, each null or {cycle, slips[]}.
     Returns { board, retired, pull }.
     ------------------------------------------------------------ */
  function applyCycle(board, packed, cycleNo) {
    const k = Math.min(packed.slatCount, ROWS);

    // A Full hangs over the slat below it; if that slat is pulled the sheet
    // would dangle off the bottom edge, so its own slat must come out too.
    let pull = k;
    for (let guard = 0; guard < ROWS; guard++) {
      const newBottom = ROWS - pull - 1;
      if (newBottom < 0) break;
      const s = board[newBottom];
      if (s && s.slips.some(p => p.drape)) pull++; else break;
    }
    pull = Math.min(pull, ROWS);

    const retired = [];
    for (let r = ROWS - pull; r < ROWS; r++) if (board[r]) retired.push(board[r]);

    const next = Array.from({length:ROWS}, () => null);
    for (let r = 0; r + pull < ROWS; r++) next[r + pull] = board[r];
    for (let i = 0; i < k; i++) next[k-1-i] = { cycle: cycleNo, slips: packed.slats[i] || [] };
    for (let r = k; r < pull; r++) next[r] = { cycle: cycleNo, slips: [], blank: true };

    return { board: next, retired, pull };
  }

  const emptyBoard = () => Array.from({length:ROWS}, () => null);

  global.CodexLayout = {
    COLS, ROWS, HC, HC_PER_COL, HR_PER_SLAT, SLAT_UNITS, SIZE, ORDER,
    packCycle, tryPack, applyCycle, emptyBoard,
  };
})(typeof window !== "undefined" ? window : globalThis);
