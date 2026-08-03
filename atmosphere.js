(function initAtmosphere() {
  const canvas = document.getElementById("energy");
  if (!canvas) return;

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ctx = canvas.getContext("2d");
  let w = 0;
  let h = 0;
  let dots = [];
  let raf = 0;
  let t0 = performance.now();

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }

  function seed() {
    const count = Math.min(140, Math.floor((w * h) / 14000));
    dots = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 0.6 + Math.random() * 1.8,
      a: 0.15 + Math.random() * 0.55,
      s: 0.4 + Math.random() * 1.2,
      hue: Math.random() < 0.55 ? "power" : Math.random() < 0.5 ? "cyan" : "impact",
    }));
  }

  function color(d, alpha) {
    if (d.hue === "cyan") return `rgba(79,212,200,${alpha})`;
    if (d.hue === "impact") return `rgba(255,120,90,${alpha})`;
    return `rgba(255,232,170,${alpha})`;
  }

  function frame(now) {
    const t = (now - t0) / 1000;
    ctx.clearRect(0, 0, w, h);
    for (const d of dots) {
      const tw = reduce ? d.a : d.a * (0.55 + 0.45 * Math.sin(t * d.s + d.x * 0.01));
      ctx.beginPath();
      ctx.fillStyle = color(d, tw);
      ctx.arc(d.x, d.y + Math.sin(t * 0.35 + d.x) * (reduce ? 0 : 2), d.r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!reduce) raf = requestAnimationFrame(frame);
  }

  resize();
  window.addEventListener("resize", resize);
  if (reduce) {
    frame(performance.now());
  } else {
    raf = requestAnimationFrame(frame);
  }

  window.addEventListener("pagehide", () => cancelAnimationFrame(raf), { once: true });
})();
