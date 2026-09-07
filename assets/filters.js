/* ============================================================
   filters.js — turning a photograph of a piece of paper into
   something that reads as drawn, engraved or painted.

   All of it is plain canvas pixel work: no libraries, no network,
   no GPU. Everything runs once, when the keeper picks a style, and
   the original is always kept so a style can be changed or undone.

   The line styles output ink on TRANSPARENT ground, so the board's
   parchment shows through instead of a white rectangle sitting on it.
   ============================================================ */
(function (global) {
  "use strict";

  const clamp255 = v => v < 0 ? 0 : v > 255 ? 255 : v;

  /* ---------- helpers ---------- */

  function luminance(d, w, h) {
    const L = new Float32Array(w * h);
    for (let i = 0, p = 0; i < L.length; i++, p += 4) {
      L[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    }
    return L;
  }

  /* Separable box blur, run three times ≈ a Gaussian. Sliding window,
     so cost is independent of radius. */
  function boxBlur(src, w, h, r) {
    // NOTE: must never write into `src`. An earlier version swapped buffers in
    // a way that aliased the caller's array, so the second blur in a
    // difference-of-Gaussians was reading the first blur's output — the two
    // came out identical, the difference was zero, and every line-art style
    // rendered completely blank.
    let a = Float32Array.from(src);
    if (r < 1) return a;
    const b = new Float32Array(w * h);
    const win = 2 * r + 1;

    for (let pass = 0; pass < 3; pass++) {
      // horizontal: a -> b
      for (let y = 0; y < h; y++) {
        const row = y * w;
        let sum = 0;
        for (let x = -r; x <= r; x++) sum += a[row + Math.min(w - 1, Math.max(0, x))];
        for (let x = 0; x < w; x++) {
          b[row + x] = sum / win;
          sum += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
        }
      }
      // vertical: b -> a
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let y = -r; y <= r; y++) sum += b[Math.min(h - 1, Math.max(0, y)) * w + x];
        for (let y = 0; y < h; y++) {
          a[y * w + x] = sum / win;
          sum += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
        }
      }
    }
    return a;
  }

  /* Paper grain and sensor noise are exactly the kind of small high-frequency
     detail a difference-of-Gaussians is built to find, so without this every
     line style renders the grain as speckle. Radius scales with the image so
     the effect is the same at any resolution. */
  function denoise(L, w, h) {
    return boxBlur(L, w, h, Math.max(1, Math.round(Math.min(w, h) / 420)));
  }

  /* Flatten uneven lighting: divide by a heavily blurred copy of itself.
     This is what stops a photo taken under one lamp going black down one
     side the moment you threshold it. */
  function flatten(L, w, h, strength) {
    const base = boxBlur(L, w, h, Math.max(8, Math.round(Math.min(w, h) / 12)));
    const out = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) {
      const norm = 255 * (L[i] + 1) / (base[i] + 1);
      out[i] = L[i] + (norm - L[i]) * strength;
    }
    return out;
  }

  function autoLevels(L, lowPct, highPct) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < L.length; i++) hist[clamp255(Math.round(L[i])) | 0]++;
    const total = L.length;
    let lo = 0, hi = 255, acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * lowPct) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > total * highPct) { hi = v; break; } }
    if (hi - lo < 8) { lo = 0; hi = 255; }
    const out = new Float32Array(L.length);
    const span = hi - lo;
    for (let i = 0; i < L.length; i++) out[i] = clamp255(((L[i] - lo) / span) * 255);
    return out;
  }

  /* Difference of Gaussians — the workhorse behind pen-and-ink.

     `thresh` is in real luminance units, and the threshold is subtracted
     BEFORE any gain is applied. An earlier version multiplied first, which
     meant a three-unit wobble of paper grain saturated the curve exactly as
     hard as a pen stroke did, and every line style came out covered in
     speckle. Returns 0..1, where 1 means "definitely a line". */
  function dog(L, w, h, radius, thresh, soft) {
    const a = boxBlur(L, w, h, Math.max(1, Math.round(radius)));
    const b = boxBlur(L, w, h, Math.max(2, Math.round(radius * 2.4)));
    const e = new Float32Array(L.length);
    const k = soft || 2.5;
    for (let i = 0; i < L.length; i++) {
      e[i] = 1 / (1 + Math.exp(-((b[i] - a[i]) - thresh) / k));
    }
    return e;
  }

  /* Integral image, for constant-time window statistics. */
  function integral(src, w, h) {
    const I = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      for (let x = 0; x < w; x++) {
        rowSum += src[y * w + x];
        I[(y + 1) * (w + 1) + (x + 1)] = I[y * (w + 1) + (x + 1)] + rowSum;
      }
    }
    return I;
  }
  const boxSum = (I, w, x0, y0, x1, y1) => {
    const W = w + 1;
    return I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0];
  };

  /* ============================================================
     THE STYLES
     Each returns { data, alpha } where alpha true means the result
     should be saved as PNG so the paper shows through.
     ============================================================ */

  const INK = [58, 44, 30];   // a brown-black, warmer than pure black

  function styleAged(img, amt) {
    const d = img.data;
    const k = amt;
    for (let p = 0; p < d.length; p += 4) {
      const l = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
      // partial desaturation toward a warm sepia, plus a gentle S-curve
      const s = (v, tint) => {
        const mixed = v + (l * tint - v) * (0.55 * k);
        const c = (mixed / 255 - 0.5) * (1 + 0.35 * k) + 0.5;
        return clamp255(c * 255);
      };
      d[p]     = s(d[p],     1.07);
      d[p + 1] = s(d[p + 1], 0.98);
      d[p + 2] = s(d[p + 2], 0.82);
    }
    return { data: img, alpha: false };
  }

  function styleInk(img, amt, w, h) {
    const d = img.data;
    let L = luminance(d, w, h);
    L = denoise(L, w, h);
    L = flatten(L, w, h, 0.7);
    // deliberately NOT auto-levelled: on a blank region the only variation is
    // grain, and stretching it to full range is what makes speckle
    const e = dog(L, w, h, 1 + amt * 2, 11 - amt * 5, 2.2);
    for (let i = 0, p = 0; i < e.length; i++, p += 4) {
      const ink = Math.min(1, Math.max(0, (e[i] - 0.35) / 0.5));
      d[p] = INK[0]; d[p + 1] = INK[1]; d[p + 2] = INK[2];
      d[p + 3] = Math.round(255 * ink);
    }
    return { data: img, alpha: true };
  }

  function styleEngraving(img, amt, w, h) {
    const d = img.data;
    let L = luminance(d, w, h);
    L = denoise(L, w, h);
    L = flatten(L, w, h, 0.75);
    // tone drives the hatching and wants its full range; edges must not, or
    // grain becomes lines
    const tone = autoLevels(L, 0.01, 0.01);
    const smooth = boxBlur(tone, w, h, Math.max(2, Math.round(Math.min(w, h) / 130)));
    const e = dog(L, w, h, 1.4, 11, 2.2);
    const spacing = Math.max(3, Math.round(4 + (1 - amt) * 4));

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, p = i * 4;
        const dark = 1 - smooth[i] / 255;                 // 0 light .. 1 dark
        // hatching: one set of diagonals, a second crossing set in the darks
        const h1 = ((x + y) % spacing) === 0;
        const h2 = ((x - y + w * spacing) % spacing) === 0;
        let ink = 0;
        if (dark > 0.22 && h1) ink = Math.min(1, (dark - 0.22) / 0.30);
        if (dark > 0.55 && h2) ink = Math.max(ink, Math.min(1, (dark - 0.55) / 0.30));
        if (dark > 0.86) ink = 1;                          // solid blacks
        ink = Math.max(ink, Math.min(1, Math.max(0, (e[i] - 0.4) / 0.45)));  // keep the outlines
        d[p] = INK[0]; d[p + 1] = INK[1]; d[p + 2] = INK[2];
        d[p + 3] = Math.round(255 * ink);
      }
    }
    return { data: img, alpha: true };
  }

  function styleHalftone(img, amt, w, h) {
    const d = img.data;
    let L = luminance(d, w, h);
    L = denoise(L, w, h);
    L = flatten(L, w, h, 0.8);
    L = autoLevels(L, 0.01, 0.01);
    const cell = Math.max(3, Math.round(4 + (1 - amt) * 5));
    const out = new Uint8ClampedArray(d.length);

    for (let cy = 0; cy < h; cy += cell) {
      for (let cx = 0; cx < w; cx += cell) {
        let sum = 0, n = 0;
        for (let y = cy; y < Math.min(h, cy + cell); y++)
          for (let x = cx; x < Math.min(w, cx + cell); x++) { sum += L[y * w + x]; n++; }
        const dark = 1 - (sum / n) / 255;
        const rad = Math.sqrt(dark) * (cell * 0.72);
        const mx = cx + cell / 2, my = cy + cell / 2;
        for (let y = cy; y < Math.min(h, cy + cell); y++) {
          for (let x = cx; x < Math.min(w, cx + cell); x++) {
            const dist = Math.hypot(x - mx, y - my);
            const a = Math.min(1, Math.max(0, rad - dist + 0.5));
            const p = (y * w + x) * 4;
            out[p] = INK[0]; out[p + 1] = INK[1]; out[p + 2] = INK[2];
            out[p + 3] = Math.round(255 * a);
          }
        }
      }
    }
    d.set(out);
    return { data: img, alpha: true };
  }

  /* Kuwahara: for each pixel look at four overlapping quadrants and adopt
     the mean colour of whichever is flattest. Edges survive, everything
     else turns into brush-shaped patches of flat colour. */
  function stylePainted(img, amt, w, h) {
    const d = img.data;
    const r = Math.max(2, Math.round(2 + amt * 5));
    const L = luminance(d, w, h);
    const L2 = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) L2[i] = L[i] * L[i];

    const R = new Float32Array(L.length), G = new Float32Array(L.length), B = new Float32Array(L.length);
    for (let i = 0, p = 0; i < L.length; i++, p += 4) { R[i] = d[p]; G[i] = d[p + 1]; B[i] = d[p + 2]; }

    const iL = integral(L, w, h), iL2 = integral(L2, w, h);
    const iR = integral(R, w, h), iG = integral(G, w, h), iB = integral(B, w, h);
    const out = new Uint8ClampedArray(d.length);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let best = Infinity, bR = 0, bG = 0, bB = 0;
        for (let q = 0; q < 4; q++) {
          const x0 = Math.max(0, q & 1 ? x : x - r), x1 = Math.min(w, q & 1 ? x + r + 1 : x + 1);
          const y0 = Math.max(0, q & 2 ? y : y - r), y1 = Math.min(h, q & 2 ? y + r + 1 : y + 1);
          const n = (x1 - x0) * (y1 - y0);
          if (n <= 0) continue;
          const s = boxSum(iL, w, x0, y0, x1, y1);
          const s2 = boxSum(iL2, w, x0, y0, x1, y1);
          const varr = s2 / n - (s / n) * (s / n);
          if (varr < best) {
            best = varr;
            bR = boxSum(iR, w, x0, y0, x1, y1) / n;
            bG = boxSum(iG, w, x0, y0, x1, y1) / n;
            bB = boxSum(iB, w, x0, y0, x1, y1) / n;
          }
        }
        const p = (y * w + x) * 4;
        // a little extra saturation, the way paint sits heavier than a photo
        const mean = (bR + bG + bB) / 3;
        out[p]     = clamp255(mean + (bR - mean) * 1.25);
        out[p + 1] = clamp255(mean + (bG - mean) * 1.25);
        out[p + 2] = clamp255(mean + (bB - mean) * 1.25);
        out[p + 3] = d[p + 3];
      }
    }
    d.set(out);
    return { data: img, alpha: false };
  }

  /* Painted, then the drawing put back on top of it. */
  function styleWatercolour(img, amt, w, h) {
    const orig = new Uint8ClampedArray(img.data);
    stylePainted(img, Math.min(1, amt + 0.15), w, h);
    const d = img.data;

    const tmp = { data: orig };
    let L = luminance(orig, w, h);
    L = denoise(L, w, h);
    L = flatten(L, w, h, 0.65);
    const e = dog(L, w, h, 1.3, 13, 2.4);

    for (let i = 0, p = 0; i < e.length; i++, p += 4) {
      const ink = Math.min(1, Math.max(0, (e[i] - 0.4) / 0.45)) * 0.8;
      // wash out the flats a little so it reads as pigment on paper
      d[p]     = clamp255(d[p]     * (1 - ink) + INK[0] * ink);
      d[p + 1] = clamp255(d[p + 1] * (1 - ink) + INK[1] * ink);
      d[p + 2] = clamp255(d[p + 2] * (1 - ink) + INK[2] * ink);
    }
    for (let p = 0; p < d.length; p += 4) {
      d[p]     = clamp255(255 - (255 - d[p])     * 0.88);
      d[p + 1] = clamp255(255 - (255 - d[p + 1]) * 0.88);
      d[p + 2] = clamp255(255 - (255 - d[p + 2]) * 0.90);
    }
    return { data: img, alpha: false };
  }

  function stylePoster(img, amt, w, h) {
    const d = img.data;
    const levels = Math.max(2, Math.round(6 - amt * 3));
    stylePainted(img, 0.5, w, h);

    let L = luminance(d, w, h);
    L = denoise(L, w, h);
    const e = dog(L, w, h, 1.4, 13, 2.4);

    /* Quantise BRIGHTNESS and carry the colour along with it, rather than
       quantising the three channels separately. Independent per-channel
       rounding on a slightly noisy image sends neighbouring pixels to
       different levels in red and green, and flat paper comes out magenta. */
    const step = 255 / (levels - 1);
    for (let i = 0, p = 0; i < L.length; i++, p += 4) {
      const l = Math.max(6, L[i]);
      const q = Math.min(255, Math.max(0, Math.round(l / step) * step));
      const k = q / l;
      for (let c = 0; c < 3; c++) d[p + c] = clamp255(d[p + c] * k);
      const ink = Math.min(1, Math.max(0, (e[i] - 0.4) / 0.45));
      for (let c = 0; c < 3; c++) d[p + c] = clamp255(d[p + c] * (1 - ink) + INK[c] * ink);
    }
    return { data: img, alpha: false };
  }

  const STYLES = {
    none:        { label: "As photographed", fn: null,             alpha: false },
    aged:        { label: "Aged",            fn: styleAged,        alpha: false },
    ink:         { label: "Pen and ink",     fn: styleInk,         alpha: true  },
    engraving:   { label: "Engraving",       fn: styleEngraving,   alpha: true  },
    halftone:    { label: "Broadsheet",      fn: styleHalftone,    alpha: true  },
    painted:     { label: "Painted",         fn: stylePainted,     alpha: false },
    watercolour: { label: "Watercolour",     fn: styleWatercolour, alpha: false },
    poster:      { label: "Woodblock",       fn: stylePoster,      alpha: false },
  };
  const ORDER = ["none", "aged", "ink", "engraving", "halftone", "painted", "watercolour", "poster"];

  /**
   * Apply a style to a canvas in place.
   * Returns { alpha } so the caller knows whether to encode PNG or JPEG.
   */
  function apply(canvas, styleName, amount) {
    const style = STYLES[styleName];
    const cx = canvas.getContext("2d", { willReadFrequently: true });
    const img = cx.getImageData(0, 0, canvas.width, canvas.height);

    /* If the keeper has already cut this picture to the shape of the paper,
       those pixels are see-through and must STAY see-through. The line styles
       compute their own alpha from scratch, so without carrying the incoming
       alpha through they would happily draw ink across everything that was
       just cut away. */
    const d = img.data;
    let wasCut = false;
    const baseAlpha = new Uint8Array(d.length / 4);
    for (let i = 0, p = 3; i < baseAlpha.length; i++, p += 4) {
      baseAlpha[i] = d[p];
      if (d[p] < 250) wasCut = true;
    }

    if (!style || !style.fn) {
      return { alpha: wasCut };
    }

    const res = style.fn(img, amount == null ? 0.5 : amount, canvas.width, canvas.height);
    const out = res.data.data;
    if (wasCut) {
      for (let i = 0, p = 3; i < baseAlpha.length; i++, p += 4) {
        out[p] = Math.round(out[p] * baseAlpha[i] / 255);
      }
    }
    cx.clearRect(0, 0, canvas.width, canvas.height);
    cx.putImageData(res.data, 0, 0);
    return { alpha: !!res.alpha || wasCut };
  }

  global.CodexFilters = { STYLES, ORDER, apply, boxBlur, denoise, autoLevels, flatten, dog };
})(typeof window !== "undefined" ? window : globalThis);
