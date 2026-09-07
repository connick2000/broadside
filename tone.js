/* ============================================================
   tone.js — making scanned paper and the board agree.

   A scan carries the paper it was printed on and the light it was
   photographed under. Dropped straight onto the board it can read as a
   cold white rectangle against warm homasote, or the reverse. Two ways
   out, and this file serves both:

     · pull the picture toward the board  — applyTone()
     · pull the board toward the pictures — suggestBoardPaper()

   Everything here is a pure function over {data,width,height}, so it can
   be tested without a browser.
   ============================================================ */
(function (global) {
  "use strict";

  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
  const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  /* How many pixels to step over so a big scan is still measured quickly.
     ~20k samples is plenty to find a paper tone. */
  function strideFor(w, h) {
    return Math.max(1, Math.floor(Math.sqrt((w * h) / 20000)));
  }

  /**
   * Find the tone of the paper itself, ignoring the ink and ignoring
   * anything already cut away to transparency.
   *
   * The paper is not simply "the brightest pixel" — a specular glare off a
   * phone flash is brighter than the sheet, and one dust speck should not
   * set the white point. So we take the band between the 90th percentile
   * and the 99.5th and average that, which lands on the sheet itself.
   *
   * Returns { paper:[r,g,b], low, high, samples } or null if there is
   * nothing opaque to measure.
   */
  function measurePaper(img) {
    const { data: d, width: W, height: H } = img;
    const st = strideFor(W, H);
    const hist = new Uint32Array(256);
    let count = 0;

    for (let y = 0; y < H; y += st) {
      for (let x = 0; x < W; x += st) {
        const i = (y * W + x) * 4;
        if (d[i + 3] < 200) continue;               // cut away — not paper
        hist[Math.round(lum(d[i], d[i + 1], d[i + 2]))]++;
        count++;
      }
    }
    if (!count) return null;

    const pct = p => {
      let acc = 0; const t = count * p;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= t) return v; }
      return 255;
    };
    const low = pct(0.02), high = pct(0.90), cap = pct(0.995);
    const band = Math.max(low + 1, high - 14);

    let r = 0, g = 0, b = 0, m = 0;
    for (let y = 0; y < H; y += st) {
      for (let x = 0; x < W; x += st) {
        const i = (y * W + x) * 4;
        if (d[i + 3] < 200) continue;
        // must round exactly as the histogram did, or a perfectly uniform
        // sheet whose luminance rounds down falls outside its own band and
        // the whole measurement comes back empty
        const L = Math.round(lum(d[i], d[i + 1], d[i + 2]));
        if (L >= band && L <= cap) { r += d[i]; g += d[i + 1]; b += d[i + 2]; m++; }
      }
    }
    if (!m) return null;
    return { paper: [r / m, g / m, b / m], low, high, samples: count };
  }

  /* Per-channel gain that would carry `paper` onto `target`, eased by
     `amount` and kept inside sane bounds so a dark photo cannot be
     multiplied into a white blur. */
  function toneGain(paper, target, amount) {
    const a = amount == null ? 1 : clamp(amount, 0, 1);
    return [0, 1, 2].map(c => {
      const full = target[c] / Math.max(1, paper[c]);
      return clamp(1 + (full - 1) * a, 0.45, 2.2);
    });
  }

  /* A shoulder instead of a cliff: identity up to the knee, then rolling
     off so the top end approaches 1 without ever blocking up into a flat
     white. Above the knee it is compressive, so it must only be reached
     for values that would genuinely have clipped — applied indiscriminately
     it darkens highlights that were never in danger, and the paper then
     never lands on the colour it was aimed at. */
  function softClip(x, knee) {
    const K = knee == null ? 0.78 : clamp(knee, 0, 0.999);
    if (x <= 0) return 0;
    if (x <= K) return x;
    const room = 1 - K;
    return K + room * (1 - Math.exp(-(x - K) / room));
  }

  /**
   * Retint a picture so its paper sits on `target`, optionally with a
   * contrast nudge. Alpha is untouched, so a cut-out keeps its shape.
   * Mutates and returns img.
   *
   *   target   [r,g,b] the board's paper colour
   *   amount   0..1, how far to go (1 = paper lands exactly on target)
   *   contrast -1..1, negative flattens, positive deepens the ink
   */
  function applyTone(img, opts) {
    opts = opts || {};
    const target = opts.target || [239, 230, 208];
    const amount = opts.amount == null ? 0.7 : clamp(opts.amount, 0, 1);
    const contrast = clamp(opts.contrast || 0, -1, 1);

    if (amount <= 0 && !contrast) return img;
    const m = opts.measured || measurePaper(img);
    if (!m) return img;
    const g = toneGain(m.paper, target, amount);

    // a lookup per channel — a few hundred exp() calls instead of one per pixel
    const lut = [0, 1, 2].map(c => {
      const t = new Uint8ClampedArray(256);
      // Darkening can never overflow, so it is applied exactly. Brightening
      // can, so it gets a shoulder — and the knee is put at the paper's own
      // target level, which means the paper lands precisely where it was
      // aimed and only what was brighter than paper (glare, blown corners)
      // is compressed into the room left above it.
      const lift = g[c] > 1;
      const knee = clamp(target[c] / 255, 0.5, 0.995);
      for (let v = 0; v < 256; v++) {
        let x = (v / 255) * g[c];
        if (lift) x = softClip(x, knee);
        else if (x > 1) x = 1;
        if (contrast) {
          x = 0.5 + (x - 0.5) * (1 + contrast);
          x = x < 0 ? 0 : softClip(x, knee);
        }
        t[v] = Math.round(x * 255);
      }
      return t;
    });

    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i]     = lut[0][d[i]];
      d[i + 1] = lut[1][d[i + 1]];
      d[i + 2] = lut[2][d[i + 2]];
    }
    return img;
  }

  /* The median is deliberate: one badly lit scan in a batch of ten should
     not drag the whole board's colour toward it, and a median simply
     ignores it where a mean would not. */
  function medianOf(xs) {
    const s = xs.slice().sort((a, b) => a - b);
    const n = s.length;
    if (!n) return null;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  /**
   * Given several measured papers, propose a board colour that sits with
   * them. Returns [r,g,b] rounded, or null if there was nothing to go on.
   */
  function suggestBoardPaper(papers) {
    const good = (papers || []).filter(p => p && p.length === 3);
    if (!good.length) return null;
    return [0, 1, 2].map(c => Math.round(clamp(medianOf(good.map(p => p[c])), 0, 255)));
  }

  /* The board paints paper as a gradient between two tones, and the slats
     behind it a little darker still. Given one sampled colour, derive the
     rest so the board stays coherent instead of turning flat. */
  const scale = (rgb, k) => rgb.map(v => Math.round(clamp(v * k, 0, 255)));
  function boardPalette(paper) {
    return {
      paper:  scale(paper, 1),
      paper2: scale(paper, 0.963),
      slat:   scale(paper, 0.908),
      slat2:  scale(paper, 0.868),
    };
  }

  const toHex = rgb =>
    "#" + rgb.map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");
  function fromHex(h) {
    const s = String(h || "").replace("#", "").trim();
    if (!/^[0-9a-f]{6}$/i.test(s)) return null;
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  }

  global.CodexTone = {
    measurePaper, applyTone, toneGain, softClip,
    suggestBoardPaper, boardPalette, medianOf, toHex, fromHex, lum,
  };
})(typeof window !== "undefined" ? window : globalThis);
