/* PanelBook phone scanner: barcode UPC + on-device OCR of title/issue,
   fuzzy-matched to the known collection, saved to an exportable CSV. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    video: $("video"), frame: $("frame"), scanBtn: $("scanBtn"),
    status: $("status"), series: $("series"), suggest: $("suggest"),
    matchNote: $("matchNote"), issue: $("issue"), year: $("year"),
    upc: $("upc"), notes: $("notes"), raw: $("raw"),
    addBtn: $("addBtn"), clearBtn: $("clearBtn"), wipeBtn: $("wipeBtn"),
    list: $("list"), count: $("count"),
    exportBtn: $("exportBtn"), copyBtn: $("copyBtn"),
    pushBtn: $("pushBtn"), pushStatus: $("pushStatus"),
  };

  const CFG = (window.PANELBOOK_CONFIG || {});
  const supabaseReady = () => Boolean(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);

  const STORE_KEY = "panelbook_scans";
  let stream = null;
  let detector = null;
  let detectTimer = null;
  let ocrWorker = null;
  let knownSeries = []; // { name, norm, grams }

  const setStatus = (msg, kind = "") => {
    els.status.textContent = msg;
    els.status.className = "status" + (kind ? " " + kind : "");
  };

  /* ---------- known-series index (for fuzzy matching) ---------- */
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const bigrams = (s) => {
    const t = s.replace(/\s+/g, "");
    const g = new Set();
    for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
    return g;
  };
  const dice = (aGrams, bStr) => {
    const b = bigrams(bStr);
    if (!aGrams.size || !b.size) return 0;
    let inter = 0;
    for (const g of b) if (aGrams.has(g)) inter++;
    return (2 * inter) / (aGrams.size + b.size);
  };

  async function loadKnownSeries() {
    try {
      const res = await fetch("collection.json", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const names = new Set();
      for (const r of data.collection || []) if (r.series) names.add(String(r.series));
      knownSeries = [...names].map((name) => {
        const n = norm(name);
        return { name, norm: n, grams: bigrams(n) };
      });
    } catch (_) { /* matching just degrades to manual entry */ }
  }

  // Returns up to `n` best series matches for an OCR blob.
  function matchSeries(text, n = 3) {
    const candidate = norm(text);
    if (!candidate || !knownSeries.length) return [];
    const scored = knownSeries
      .map((k) => ({ name: k.name, score: dice(k.grams, candidate) }))
      .filter((x) => x.score >= 0.34)
      .sort((a, b) => b.score - a.score);
    // de-dupe by name, keep top n
    const seen = new Set();
    const out = [];
    for (const s of scored) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      out.push(s);
      if (out.length >= n) break;
    }
    return out;
  }

  /* ---------- camera + barcode ---------- */
  async function startCamera() {
    setStatus("Starting camera…");
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
    } catch (e) {
      setStatus("Camera blocked. Allow camera access, and use HTTPS (or localhost).", "warn");
      return;
    }
    els.video.srcObject = stream;
    await els.video.play().catch(() => {});
    els.scanBtn.textContent = "Scan this comic";
    els.scanBtn.onclick = captureAndRead;
    setStatus("Pointed at a cover? Tap “Scan this comic”.", "ok");
    startBarcodeLoop();
  }

  function startBarcodeLoop() {
    if (!("BarcodeDetector" in window)) return; // OCR still works without it
    try {
      detector = new window.BarcodeDetector({
        formats: ["upc_a", "ean_13", "upc_e", "ean_8"],
      });
    } catch (_) { return; }
    const tick = async () => {
      if (!detector || els.video.readyState < 2) return;
      try {
        const codes = await detector.detect(els.video);
        if (codes && codes.length) {
          const raw = codes[0].rawValue || "";
          applyBarcode(raw);
        }
      } catch (_) { /* transient */ }
    };
    detectTimer = setInterval(tick, 600);
  }

  // Main UPC identifies the series; a 5-digit add-on (if present) encodes the issue.
  function applyBarcode(raw) {
    const digits = String(raw).replace(/\D/g, "");
    if (!digits) return;
    const main = digits.slice(0, 12);
    if (!els.upc.value || els.upc.value !== main) {
      els.upc.value = main;
      setStatus("Barcode read: " + main, "ok");
    }
    // If a 5-digit supplement rode along, first 3 digits are the issue number.
    if (digits.length >= 17) {
      const addon = digits.slice(12, 17);
      const iss = parseInt(addon.slice(0, 3), 10);
      if (iss && !els.issue.value) els.issue.value = String(iss);
    }
  }

  /* ---------- capture + OCR ---------- */
  async function ensureWorker() {
    if (ocrWorker) return ocrWorker;
    setStatus("Loading OCR (first time only)…");
    ocrWorker = await Tesseract.createWorker("eng");
    return ocrWorker;
  }

  // Draw a normalised crop of the current video frame to an offscreen canvas.
  function cropToCanvas(topFrac, bottomFrac, digitsOnly) {
    const v = els.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    const y0 = Math.floor(vh * topFrac);
    const y1 = Math.floor(vh * bottomFrac);
    const h = Math.max(1, y1 - y0);
    const c = document.createElement("canvas");
    const scale = Math.min(2, 1400 / vw) || 1;
    c.width = Math.floor(vw * scale);
    c.height = Math.floor(h * scale);
    const ctx = c.getContext("2d");
    ctx.drawImage(v, 0, y0, vw, h, 0, 0, c.width, c.height);
    // grayscale + contrast boost helps OCR on print
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      let g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      g = (g - 128) * 1.35 + 128;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      d[i] = d[i + 1] = d[i + 2] = g;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  async function captureAndRead() {
    if (!els.video.videoWidth) { setStatus("Camera not ready yet.", "warn"); return; }
    els.scanBtn.disabled = true;
    try {
      const worker = await ensureWorker();

      setStatus("Reading title…");
      const titleCanvas = cropToCanvas(0.0, 0.42, false);
      await worker.setParameters({ tessedit_char_whitelist: "" });
      const tTitle = (await worker.recognize(titleCanvas)).data.text || "";

      setStatus("Reading barcode digits…");
      const numCanvas = cropToCanvas(0.72, 1.0, true);
      await worker.setParameters({ tessedit_char_whitelist: "0123456789 #No." });
      const tNum = (await worker.recognize(numCanvas)).data.text || "";

      applyOcr(tTitle, tNum);
      setStatus("Check the fields, then “Add to list”.", "ok");
    } catch (e) {
      setStatus("OCR failed: " + (e.message || e), "warn");
    } finally {
      els.scanBtn.disabled = false;
    }
  }

  function applyOcr(titleText, numText) {
    els.raw.textContent = "TITLE: " + titleText.replace(/\s+/g, " ").trim() +
      "\nBARCODE: " + numText.replace(/\s+/g, " ").trim();

    // Series: match each non-trivial title line, keep the best overall.
    const lines = titleText.split(/\n+/).map((l) => l.trim()).filter((l) => l.replace(/[^a-z0-9]/gi, "").length >= 3);
    let best = [];
    for (const line of [titleText, ...lines]) {
      const m = matchSeries(line);
      if (m.length && (!best.length || m[0].score > best[0].score)) best = m;
    }
    renderSuggestions(best);
    if (best.length && !els.series.value) els.series.value = best[0].name;

    // Issue: prefer an explicit "#N" on the cover, else the barcode add-on.
    const issFromTitle = titleText.match(/#\s*(\d{1,4})/) || titleText.match(/\bNO\.?\s*(\d{1,4})/i);
    if (issFromTitle && !els.issue.value) els.issue.value = issFromTitle[1];
    if (!els.issue.value) {
      const groups = (numText.match(/\d{5}/g) || []).filter((g) => els.upc.value.indexOf(g) === -1);
      if (groups.length) {
        const iss = parseInt(groups[groups.length - 1].slice(0, 3), 10);
        if (iss) els.issue.value = String(iss);
      }
    }

    // Year: any plausible 19xx/20xx on the cover.
    const yr = titleText.match(/\b(19[3-9]\d|20[0-4]\d)\b/);
    if (yr && !els.year.value) els.year.value = yr[1];
  }

  function renderSuggestions(matches) {
    els.suggest.innerHTML = "";
    if (!matches.length) {
      els.matchNote.textContent = knownSeries.length
        ? "No confident series match — type it in."
        : "";
      return;
    }
    els.matchNote.textContent = "Best guesses (tap to use):";
    for (const m of matches) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = `${m.name}  ·  ${(m.score * 100).toFixed(0)}%`;
      b.onclick = () => { els.series.value = m.name; };
      els.suggest.appendChild(b);
    }
  }

  /* ---------- session list + storage ---------- */
  const load = () => { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { return []; } };
  const save = (rows) => localStorage.setItem(STORE_KEY, JSON.stringify(rows));

  function render() {
    const rows = load();
    els.count.textContent = rows.length;
    els.list.innerHTML = "";
    rows.slice().reverse().forEach((r, revIdx) => {
      const idx = rows.length - 1 - revIdx;
      const li = document.createElement("li");
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.innerHTML = `<strong>${escapeHtml(r.series || "(no series)")} #${escapeHtml(r.issue_number || "?")}</strong>` +
        `<small>${[r.year, r.upc].filter(Boolean).map(escapeHtml).join(" · ")}</small>`;
      const del = document.createElement("button");
      del.type = "button"; del.textContent = "\u00d7"; del.title = "Remove";
      del.onclick = () => { const cur = load(); cur.splice(idx, 1); save(cur); render(); };
      li.appendChild(meta); li.appendChild(del);
      els.list.appendChild(li);
    });
  }

  function addCurrent() {
    const series = els.series.value.trim();
    const issue = els.issue.value.trim();
    if (!series && !issue && !els.upc.value.trim()) {
      setStatus("Nothing to add — scan or type a comic first.", "warn");
      return;
    }
    const rows = load();
    rows.push({
      source: "scan",
      series,
      issue_number: issue,
      year: els.year.value.trim(),
      title: series && issue ? `${series} #${issue}` : series,
      upc: els.upc.value.trim(),
      notes: els.notes.value.trim(),
      scanned_at: new Date().toISOString(),
      raw_ocr: els.raw.textContent.replace(/\s+/g, " ").trim(),
    });
    save(rows);
    render();
    clearFields();
    setStatus("Added. Scan the next one.", "ok");
  }

  function clearFields() {
    ["series", "issue", "year", "upc", "notes"].forEach((k) => (els[k].value = ""));
    els.suggest.innerHTML = "";
    els.matchNote.textContent = "";
    els.raw.textContent = "";
  }

  /* ---------- export ---------- */
  const COLS = ["source", "series", "issue_number", "year", "title", "upc", "notes", "scanned_at", "raw_ocr"];
  const csvCell = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  function toCsv(rows) {
    const head = COLS.join(",");
    const body = rows.map((r) => COLS.map((c) => csvCell(r[c])).join(",")).join("\n");
    return head + "\n" + body + "\n";
  }
  function exportCsv() {
    const rows = load();
    if (!rows.length) { setStatus("List is empty.", "warn"); return; }
    const blob = new Blob([toCsv(rows)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `panelbook_scans_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
    setStatus(`Exported ${rows.length} scans.`, "ok");
  }
  async function copyText() {
    const rows = load();
    if (!rows.length) { setStatus("List is empty.", "warn"); return; }
    const text = toCsv(rows);
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Copied CSV to clipboard.", "ok");
    } catch {
      setStatus("Copy failed — use Export CSV instead.", "warn");
    }
  }

  /* ---------- push to master (Supabase) ---------- */
  function setPush(msg, kind = "") {
    els.pushStatus.textContent = msg;
    els.pushStatus.className = "status" + (kind ? " " + kind : "");
  }

  async function pushToMaster() {
    if (!supabaseReady()) {
      setPush("Add your Supabase details to config.js to enable this.", "warn");
      return;
    }
    const rows = load();
    if (!rows.length) { setPush("List is empty.", "warn"); return; }

    const payload = rows.map((r) => ({
      series: r.series || null,
      issue_number: r.issue_number || null,
      year: r.year || null,
      title: r.title || null,
      upc: r.upc || null,
      notes: r.notes || null,
      raw_ocr: r.raw_ocr || null,
      scanned_at: r.scanned_at || null,
      device: navigator.userAgent.slice(0, 120),
    }));

    els.pushBtn.disabled = true;
    setPush(`Pushing ${payload.length}…`);
    try {
      const res = await fetch(
        `${CFG.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${CFG.SCANS_TABLE || "panelbook_scans"}`,
        {
          method: "POST",
          headers: {
            apikey: CFG.SUPABASE_ANON_KEY,
            Authorization: `Bearer ${CFG.SUPABASE_ANON_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify(payload),
        }
      );
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`${res.status} ${t}`.trim());
      }
      save([]);
      render();
      setPush(`Pushed ${payload.length} to master. Pull them on your PC.`, "ok");
    } catch (e) {
      setPush("Push failed: " + (e.message || e) + " — your scans are still saved here.", "warn");
    } finally {
      els.pushBtn.disabled = false;
    }
  }

  const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- wire up ---------- */
  els.scanBtn.disabled = false;
  els.scanBtn.textContent = "Start camera";
  els.scanBtn.onclick = startCamera;
  els.addBtn.onclick = addCurrent;
  els.clearBtn.onclick = clearFields;
  els.wipeBtn.onclick = () => {
    if (confirm("Empty the whole scanned list? (export first if you need it)")) { save([]); render(); }
  };
  els.exportBtn.onclick = exportCsv;
  els.copyBtn.onclick = copyText;
  els.pushBtn.onclick = pushToMaster;
  if (!supabaseReady()) {
    els.pushBtn.textContent = "Push to master (set up Supabase)";
  }
  els.series.addEventListener("input", () => {
    renderSuggestions(matchSeries(els.series.value));
  });

  loadKnownSeries();
  render();
})();
