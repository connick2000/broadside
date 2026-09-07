/* The board is sized from MEASURED pixels, not from viewport units.
   ------------------------------------------------------------------
   iOS Safari resolves dvh/vh against a viewport that is stale for a while
   after a rotation, and — if the page never scrolls, which this one never
   does — can stay stale indefinitely. The symptom is exactly what a phone
   showed: right in portrait, wrong proportions when tipped, and still wrong
   when tipped back.

   So: measure the visual viewport, publish it as --vpw / --vph, and measure
   again on every event that could have changed it, plus a few frames later
   because the first number a phone reports after a rotation is frequently
   the old one. Also measure the stacked navigation bars rather than
   guessing at their height, which is what used to squeeze the board.

   The CSS falls back to 100vw/100dvh, so the page is still correct if this
   file fails to load. */
(function () {
  "use strict";
  const root = document.documentElement;
  const vv = window.visualViewport || null;

  function apply() {
    // visualViewport is the box the user can actually see; innerWidth/Height
    // is the layout viewport, which is the one that goes stale.
    //
    // But while someone is pinch-zoomed in, the visual viewport is a small
    // window onto a larger page. Re-laying the board out to fit it would
    // shrink the board as fast as they zoomed, so at any scale but 1 the
    // layout viewport is the honest answer.
    const zoomed = vv && Math.abs((vv.scale || 1) - 1) > 0.01;
    const w = Math.round(vv && !zoomed ? vv.width : window.innerWidth);
    const h = Math.round(vv && !zoomed ? vv.height : window.innerHeight);
    if (!(w > 0 && h > 0)) return;
    root.style.setProperty("--vpw", w + "px");
    root.style.setProperty("--vph", h + "px");

    // How much height the navigation bars take when they stack above and
    // below the board. Measured, because it depends on how the masthead
    // wraps, which depends on the screen.
    const stage = document.querySelector(".stage");
    let rails = 0;
    if (stage && getComputedStyle(stage).flexDirection === "column") {
      for (const r of stage.querySelectorAll(":scope > .siderail"))
        rails += r.getBoundingClientRect().height;
    }
    root.style.setProperty("--railsh", Math.round(rails) + "px");
  }

  // A rotation is not one event at one moment. Re-read for about a second.
  let timers = [];
  function settle() {
    apply();
    requestAnimationFrame(apply);
    timers.forEach(clearTimeout);
    timers = [60, 180, 400, 800, 1400].map(t => setTimeout(apply, t));
  }

  apply();
  addEventListener("resize", apply, { passive: true });
  addEventListener("orientationchange", settle, { passive: true });
  addEventListener("pageshow", settle, { passive: true });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) settle(); });
  if (vv) {
    vv.addEventListener("resize", apply, { passive: true });
    vv.addEventListener("scroll", apply, { passive: true });
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", settle);
  else settle();
  addEventListener("load", settle);

  // Fonts arriving late change how the masthead wraps, which changes the
  // rail height, which changes how wide the board may be.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(settle).catch(() => {});
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => apply());
    const start = () => {
      const stage = document.querySelector(".stage");
      if (stage) for (const r of stage.querySelectorAll(":scope > .siderail")) ro.observe(r);
    };
    if (document.readyState === "loading")
      document.addEventListener("DOMContentLoaded", start);
    else start();
  }
})();
