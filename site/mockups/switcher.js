// Floating mockup switcher, injected into every mockup page.
(function () {
  const pages = [
    ["1-graphite.html", "Graphite"],
    ["1e-graphite-refined.html", "Graphite+"],
    ["2-paper-cobalt.html", "Paper"],
    ["2b-cobalt-block.html", "Block"],
    ["2c-ink.html", "Ink"],
    ["2e-paper-refined.html", "Refined"],
  ];
  const current = location.pathname.split("/").pop();
  const bar = document.createElement("div");
  bar.setAttribute("role", "navigation");
  bar.setAttribute("aria-label", "Mockup switcher");
  bar.style.cssText =
    "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:9999;" +
    "display:flex;gap:4px;padding:6px;border-radius:999px;" +
    "background:rgba(24,24,27,.92);border:1px solid rgba(255,255,255,.14);" +
    "backdrop-filter:blur(10px);box-shadow:0 8px 30px rgba(0,0,0,.35);" +
    "font:600 13px/1 system-ui,sans-serif;";
  pages.forEach(([href, label], i) => {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = (i + 1) + " " + label;
    const active = href === current;
    a.style.cssText =
      "padding:8px 14px;border-radius:999px;text-decoration:none;" +
      (active ? "background:#e4e4e7;color:#18181b;" : "color:#a1a1aa;");
    if (!active) {
      a.onmouseenter = () => (a.style.color = "#e4e4e7");
      a.onmouseleave = () => (a.style.color = "#a1a1aa");
    }
    bar.appendChild(a);
  });
  document.body.appendChild(bar);
  addEventListener("keydown", (e) => {
    if (e.target.closest("input,textarea")) return;
    const n = Number(e.key);
    if (n >= 1 && n <= pages.length) location.href = pages[n - 1][0];
  });
})();
