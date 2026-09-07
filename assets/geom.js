/* ============================================================
   geom.js — tidying up the edges of a photographed notice.

   No perspective correction: a badly keystoned photo is better
   retaken than rescued. What this does is let a keeper trace the
   actual shape of the paper — four corners, not necessarily a
   rectangle — and drop everything outside it to transparent, so a
   torn or skewed slip sits on the board as its own shape rather
   than as a rectangle of somebody's carpet.

   Pure functions over {data, width, height}, so they can be tested
   without a browser.
   ============================================================ */
(function (global) {
  "use strict";

  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

  /* Signed distance from a point to the line through a→b.
     Positive on the left of the direction of travel. */
  function edgeSide(px, py, ax, ay, bx, by) {
    const ex = bx - ax, ey = by - ay;
    const len = Math.hypot(ex, ey) || 1e-6;
    return ((px - ax) * ey - (py - ay) * ex) / len;
  }

  /* Is the quad wound clockwise in screen coordinates (y down)? */
  function isClockwise(q) {
    let area = 0;
    for (let i = 0; i < 4; i++) {
      const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4];
      area += (x2 - x1) * (y2 + y1);
    }
    return area > 0;
  }

  /* Coverage of a pixel by the quad: 1 inside, 0 outside, and a soft
     edge in between so the cut doesn't come out jagged. `feather` is
     in pixels. Works for any convex quad in either winding order. */
  function coverage(q, x, y, feather) {
    const s = isClockwise(q) ? 1 : -1;
    let worst = Infinity;
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4];
      const d = s * edgeSide(x, y, ax, ay, bx, by);
      if (d < worst) worst = d;
    }
    if (feather <= 0) return worst >= 0 ? 1 : 0;
    return clamp(worst / feather + 0.5, 0, 1);
  }

  const bboxOf = q => {
    const xs = q.map(p => p[0]), ys = q.map(p => p[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys),
             x1: Math.max(...xs), y1: Math.max(...ys) };
  };

  /**
   * Keep what is inside the quad, drop the rest to transparent, and
   * trim to the quad's bounding box so we aren't carrying a wide
   * transparent margin around.
   * Returns a new {data, width, height}.
   */
  function cutToQuad(img, quad, opts) {
    opts = opts || {};
    const feather = opts.feather == null ? 1.2 : opts.feather;
    const W = img.width, H = img.height;

    const bb = bboxOf(quad);
    const x0 = clamp(Math.floor(bb.x0) - 1, 0, W - 1);
    const y0 = clamp(Math.floor(bb.y0) - 1, 0, H - 1);
    const x1 = clamp(Math.ceil(bb.x1) + 1, 1, W);
    const y1 = clamp(Math.ceil(bb.y1) + 1, 1, H);
    const ow = Math.max(1, x1 - x0), oh = Math.max(1, y1 - y0);

    const out = new Uint8ClampedArray(ow * oh * 4);
    const src = img.data;

    for (let y = 0; y < oh; y++) {
      for (let x = 0; x < ow; x++) {
        const sx = x0 + x, sy = y0 + y;
        const sp = (sy * W + sx) * 4, dp = (y * ow + x) * 4;
        const cov = coverage(quad, sx + 0.5, sy + 0.5, feather);
        out[dp]     = src[sp];
        out[dp + 1] = src[sp + 1];
        out[dp + 2] = src[sp + 2];
        out[dp + 3] = Math.round((src[sp + 3] == null ? 255 : src[sp + 3]) * cov);
      }
    }
    // x/y are where this crop sits in the source, so a caller holding a
    // parallel picture (the pristine copy the restore brush paints from)
    // can crop it the same way and stay in register.
    return { data: out, width: ow, height: oh, x: x0, y: y0 };
  }

  /** Does this picture have any see-through pixels? Decides PNG vs JPEG. */
  function hasAlpha(img) {
    const d = img.data;
    for (let p = 3; p < d.length; p += 4) if (d[p] < 250) return true;
    return false;
  }

  /* Trim fully transparent rows and columns from the edges. */
  function trimTransparent(img, threshold) {
    const t = threshold == null ? 4 : threshold;
    const W = img.width, H = img.height, d = img.data;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (d[(y * W + x) * 4 + 3] > t) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return img;                       // nothing left; leave it alone
    if (x0 === 0 && y0 === 0 && x1 === W - 1 && y1 === H - 1) return img;
    const ow = x1 - x0 + 1, oh = y1 - y0 + 1;
    const out = new Uint8ClampedArray(ow * oh * 4);
    for (let y = 0; y < oh; y++) {
      const from = ((y + y0) * W + x0) * 4;
      out.set(d.subarray(from, from + ow * 4), y * ow * 4);
    }
    return { data: out, width: ow, height: oh };
  }

  /** The four corners of the whole picture, inset a little. */
  function defaultQuad(w, h, inset) {
    const i = inset == null ? 0 : inset;
    return [[i, i], [w - i, i], [w - i, h - i], [i, h - i]];
  }

  /* Otsu's method: the threshold that best splits a histogram into two
     groups. Used here to separate a pale sheet from whatever it was
     photographed on. */
  function otsu(hist, total) {
    let sum = 0;
    for (let v = 0; v < 256; v++) sum += v * hist[v];
    let sumB = 0, wB = 0, best = 0, bestVar = -1;
    for (let v = 0; v < 256; v++) {
      wB += hist[v];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += v * hist[v];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > bestVar) { bestVar = between; best = v; }
    }
    return best;
  }

  /**
   * Guess where the sheet of paper is in a photograph, so the corner handles
   * start on the notice rather than on the corners of the whole picture.
   * Without this, pressing "cut to this shape" without dragging anything
   * keeps the tablecloth — which is the one thing the tool exists to remove.
   *
   * The paper is the bright group; its four corners are the points furthest
   * along each diagonal, which is exact for any quadrilateral however it is
   * rotated. Returns a quad in the same [TL,TR,BR,BL] order as defaultQuad,
   * or null when there is nothing to find (a flatbed scan that is all paper,
   * or a picture with no clear sheet in it) so the caller can fall back.
   */
  function guessPaperQuad(img, opts) {
    opts = opts || {};
    const W = img.width, H = img.height, d = img.data;
    const step = Math.max(1, Math.round(Math.max(W, H) / (opts.grid || 220)));
    const sw = Math.floor((W - 1) / step) + 1, sh = Math.floor((H - 1) / step) + 1;
    if (sw < 8 || sh < 8) return null;

    const lum = new Float32Array(sw * sh), seen = new Uint8Array(sw * sh);
    const hist = new Uint32Array(256);
    let total = 0;
    for (let gy = 0; gy < sh; gy++) {
      for (let gx = 0; gx < sw; gx++) {
        const i = (Math.min(H - 1, gy * step) * W + Math.min(W - 1, gx * step)) * 4;
        if (d[i + 3] < 128) continue;            // already cut away
        const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        lum[gy * sw + gx] = L; seen[gy * sw + gx] = 1;
        hist[Math.round(clamp(L, 0, 255))]++; total++;
      }
    }
    if (total < 64) return null;

    const t = otsu(hist, total);
    const bright = new Uint8Array(sw * sh);
    let count = 0;
    for (let i = 0; i < bright.length; i++) {
      if (seen[i] && lum[i] > t) { bright[i] = 1; count++; }
    }
    const frac = count / total;
    // too little and there is no sheet to find; too much and the picture is
    // already nothing but paper, so the whole frame is the right answer
    if (frac < 0.10 || frac > 0.90) return null;

    // drop specks: a corner must have bright neighbours, or one hot pixel of
    // glare on the tablecloth would drag a handle right off the paper
    const solid = (gx, gy) => {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = gx + dx, y = gy + dy;
          if (x < 0 || y < 0 || x >= sw || y >= sh) continue;
          if (bright[y * sw + x]) n++;
        }
      }
      return n >= 6;
    };

    // furthest along each diagonal = the four corners of the quad
    let tl = null, tr = null, br = null, bl = null;
    let vTL = Infinity, vBR = -Infinity, vTR = -Infinity, vBL = Infinity;
    for (let gy = 0; gy < sh; gy++) {
      for (let gx = 0; gx < sw; gx++) {
        if (!bright[gy * sw + gx] || !solid(gx, gy)) continue;
        const s = gx + gy, dd = gx - gy;
        if (s < vTL) { vTL = s; tl = [gx, gy]; }
        if (s > vBR) { vBR = s; br = [gx, gy]; }
        if (dd > vTR) { vTR = dd; tr = [gx, gy]; }
        if (dd < vBL) { vBL = dd; bl = [gx, gy]; }
      }
    }
    if (!tl || !tr || !br || !bl) return null;

    const up = ([gx, gy]) => [clamp(gx * step, 0, W), clamp(gy * step, 0, H)];
    const quad = [up(tl), up(tr), up(br), up(bl)];

    // a degenerate result (a line, or a sliver) is worse than no guess
    const bb = bboxOf(quad);
    if ((bb.x1 - bb.x0) < W * 0.15 || (bb.y1 - bb.y0) < H * 0.15) return null;
    return quad;
  }

  /* ---------- straightening ----------
     A real notice is a rectangle. What is crooked is the photograph of it:
     the sheet sits at a few degrees on the table, and the frame includes
     more than the sheet. So rather than keeping an irregular outline, work
     out the angle the sheet is lying at and the upright rectangle it
     occupies once that angle is taken out. */

  /* The angle the sheet is lying at, from its four corners. All four edges
     vote — two horizontals and two verticals turned into horizontals — so a
     single badly-placed corner only moves the answer by a quarter of its
     own error. */
  function quadAngle(quad) {
    const ang = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
    const norm = a => {
      while (a > Math.PI / 2) a -= Math.PI;
      while (a <= -Math.PI / 2) a += Math.PI;
      return a;
    };
    const votes = [
      ang(quad[0], quad[1]),                 // top edge
      ang(quad[3], quad[2]),                 // bottom edge
      ang(quad[0], quad[3]) - Math.PI / 2,   // left edge, turned flat
      ang(quad[1], quad[2]) - Math.PI / 2,   // right edge, turned flat
    ].map(norm);
    // average around the circle, so +89° and -89° don't cancel to 0
    const sy = votes.reduce((t, a) => t + Math.sin(2 * a), 0);
    const sx = votes.reduce((t, a) => t + Math.cos(2 * a), 0);
    return Math.atan2(sy, sx) / 2;
  }

  const rotPt = (x, y, cx, cy, a) => {
    const c = Math.cos(a), s = Math.sin(a), dx = x - cx, dy = y - cy;
    return [dx * c - dy * s, dx * s + dy * c];
  };

  /**
   * The upright rectangle a photographed sheet occupies. Coordinates are in
   * the straightened frame, measured from the picture's centre, so
   * {angle, x, y, w, h} is everything a crop needs.
   */
  function straightenRect(quad, W, H) {
    const angle = quadAngle(quad);
    const cx = W / 2, cy = H / 2;
    const pts = quad.map(([x, y]) => rotPt(x, y, cx, cy, -angle));
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    return { angle, x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
  }

  /**
   * Reshape a rectangle to a given width:height, keeping its centre.
   * 'inside' shrinks it to fit (losing a sliver of paper); 'outside' grows
   * it (which would let the background back in). Inside is the safe one.
   */
  function fitAspect(rect, ar, mode) {
    if (!ar || !isFinite(ar) || ar <= 0) return { ...rect };
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    // the width that gives the wanted ratio if height is the limit, versus
    // the width we already have; inside takes the smaller, outside the larger
    const byHeight = rect.h * ar;
    const w = mode === "outside" ? Math.max(rect.w, byHeight) : Math.min(rect.w, byHeight);
    const h = w / ar;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  /* The whole picture as a straightened rect: no rotation, everything in. */
  const wholeRect = (W, H) => ({ angle: 0, x: -W / 2, y: -H / 2, w: W, h: H });

  /* ---------- perspective ----------
     A notice photographed from anywhere but straight above comes out as a
     quadrilateral, not a rectangle: the far edge is shorter than the near
     one. Tracing the four real corners and then simply cropping to their
     bounding box keeps that distortion. Mapping the quad onto a rectangle
     removes it — the sheet comes back square, which is what it was. */

  /* The projective transform taking the unit square onto a quad, after
     Heckbert. Corners are [TL, TR, BR, BL], i.e. (0,0) (1,0) (1,1) (0,1).
     Returns [a,b,c,d,e,f,g,h] with
        x = (a·u + b·v + c) / (g·u + h·v + 1)
        y = (d·u + e·v + f) / (g·u + h·v + 1)  */
  function squareToQuad(q) {
    const [x0, y0] = q[0], [x1, y1] = q[1], [x2, y2] = q[2], [x3, y3] = q[3];
    const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
    const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;

    if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
      // the quad is a parallelogram: no perspective, just an affine map
      return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0];
    }
    const den = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(den) < 1e-12) return null;          // degenerate
    const g = (dx3 * dy2 - dy3 * dx2) / den;
    const h = (dx1 * dy3 - dy1 * dx3) / den;
    return [
      x1 - x0 + g * x1, x3 - x0 + h * x3, x0,
      y1 - y0 + g * y1, y3 - y0 + h * y3, y0,
      g, h,
    ];
  }

  /* Where a point of the destination rectangle came from in the source. */
  function mapPoint(m, u, v) {
    const w = m[6] * u + m[7] * v + 1;
    if (Math.abs(w) < 1e-12) return [0, 0];
    return [(m[0] * u + m[1] * v + m[2]) / w, (m[3] * u + m[4] * v + m[5]) / w];
  }

  /* Side lengths of the quad, used to pick a sensible output size: the two
     opposite edges disagree under perspective, so take the longer of each
     pair and no detail is thrown away. */
  function quadExtent(q) {
    const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
    return {
      w: Math.max(len(q[0], q[1]), len(q[3], q[2])),
      h: Math.max(len(q[0], q[3]), len(q[1], q[2])),
    };
  }

  /**
   * Straighten a quadrilateral out into a rectangle.
   *   img   {data,width,height}
   *   quad  four corners [TL,TR,BR,BL] in source pixels
   *   opts  ar    force this width:height (else the quad's own proportions)
   *         maxEdge  cap on the long side
   *         fill  [r,g,b] for anything sampled from outside the picture
   * Returns {data,width,height}.
   */
  function unwarpQuad(img, quad, opts) {
    opts = opts || {};
    const m = squareToQuad(quad);
    if (!m) return null;

    const ext = quadExtent(quad);
    // The whole selection is always kept, at its own proportions.
    let cw = ext.w, ch = ext.h;
    let ow = cw, oh = ch;

    if (opts.ar && isFinite(opts.ar) && opts.ar > 0) {
      // Demanding a shape must PAD, never stretch and never crop.
      //
      //  · Stretching maps the sheet's four corners onto a rectangle of the
      //    wrong proportions and squashes everything between them.
      //  · Cropping reaches the shape by throwing away the edges of what the
      //    keeper actually selected, which is worse: they drew that outline
      //    on purpose and pixels inside it went missing.
      //
      // So the selection is mapped whole, centred, and the surrounding
      // margin is filled with the sheet's own paper colour — invisible on the
      // board, and nothing is lost.
      ow = Math.max(cw, ch * opts.ar);
      oh = ow / opts.ar;
    }
    const cap = opts.maxEdge || 2000;
    const k = Math.min(1, cap / Math.max(ow, oh));
    ow = Math.max(1, Math.round(ow * k));
    oh = Math.max(1, Math.round(oh * k));
    cw = Math.max(1, Math.min(ow, Math.round(cw * k)));
    ch = Math.max(1, Math.min(oh, Math.round(ch * k)));
    const ox = Math.round((ow - cw) / 2), oy = Math.round((oh - ch) / 2);

    const W = img.width, H = img.height, src = img.data;
    const out = new Uint8ClampedArray(ow * oh * 4);
    const fill = opts.fill || [239, 230, 208];

    for (let y = 0; y < oh; y++) {
      const inRow = y >= oy && y < oy + ch;
      const v = inRow ? ((y - oy) + 0.5) / ch : 0;
      for (let x = 0; x < ow; x++) {
        const dp = (y * ow + x) * 4;
        if (!inRow || x < ox || x >= ox + cw) {       // the padded margin
          out[dp] = fill[0]; out[dp + 1] = fill[1]; out[dp + 2] = fill[2]; out[dp + 3] = 255;
          continue;
        }
        const u = ((x - ox) + 0.5) / cw;
        const [sx, sy] = mapPoint(m, u, v);

        // bilinear, so a stretched edge does not come out stair-stepped
        const fx = Math.floor(sx), fy = Math.floor(sy);
        if (fx < -1 || fy < -1 || fx > W || fy > H) {
          out[dp] = fill[0]; out[dp + 1] = fill[1]; out[dp + 2] = fill[2]; out[dp + 3] = 255;
          continue;
        }
        const tx = sx - fx, ty = sy - fy;
        const x0 = clamp(fx, 0, W - 1), x1 = clamp(fx + 1, 0, W - 1);
        const y0 = clamp(fy, 0, H - 1), y1 = clamp(fy + 1, 0, H - 1);
        const i00 = (y0 * W + x0) * 4, i10 = (y0 * W + x1) * 4;
        const i01 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4;
        for (let c = 0; c < 4; c++) {
          const top = src[i00 + c] * (1 - tx) + src[i10 + c] * tx;
          const bot = src[i01 + c] * (1 - tx) + src[i11 + c] * tx;
          out[dp + c] = top * (1 - ty) + bot * ty;
        }
      }
    }
    // contentW/H say how much of the result is the selection itself, so a
    // caller can warn when a size leaves most of the slip blank
    return { data: out, width: ow, height: oh, contentW: cw, contentH: ch };
  }

  /**
   * Straightening a crooked scan must not make it smaller.
   *
   * Turning a picture grows its bounding box — a 680x440 sheet tilted 12°
   * needs 757x572 to hold its corners. Dropped into a slot of fixed
   * proportions the extra is blank paper, so the notice itself shrinks and
   * ends up marooned in the middle of its sheet. Every photo tool solves this
   * the same way: rotate, then crop back, keeping the original proportions.
   *
   * Returns the largest rectangle with the SAME width:height that still fits
   * inside the picture once it has been turned by `deg`.
   */
  function rotateFit(w, h, deg) {
    const t = (((deg % 180) + 180) % 180) * Math.PI / 180;
    const a = Math.abs(Math.cos(t)), b = Math.abs(Math.sin(t));
    // a w×h box scaled by s and turned by t has a bounding box of
    //   s(w·a + h·b) × s(w·b + h·a); it fits when both sides are within
    //   the original, so take whichever constraint bites first
    const s = Math.min(w / (w * a + h * b), h / (w * b + h * a));
    return {
      scale: s,
      w: Math.max(1, Math.round(w * s)),
      h: Math.max(1, Math.round(h * s)),
    };
  }

  global.CodexGeom = {
    cutToQuad, coverage, bboxOf, hasAlpha, trimTransparent, defaultQuad, isClockwise,
    guessPaperQuad, otsu, quadAngle, straightenRect, fitAspect, wholeRect,
    squareToQuad, mapPoint, quadExtent, unwarpQuad, rotateFit,
  };
})(typeof window !== "undefined" ? window : globalThis);
