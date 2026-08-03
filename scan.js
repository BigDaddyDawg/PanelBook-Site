/* PanelBook phone scanner: barcode UPC + on-device OCR of title/issue,
   fuzzy-matched to the known collection, saved to an exportable CSV.
   Photos are never stored — only extracted text fields persist locally
   or in Supabase. Camera frames live in memory for OCR, then are discarded. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    video: $("video"), still: $("still"), camwrap: $("camwrap"),
    scanBtn: $("scanBtn"), uploadBtn: $("uploadBtn"), fileInput: $("fileInput"),
    status: $("status"), series: $("series"), suggest: $("suggest"),
    matchNote: $("matchNote"), issue: $("issue"), year: $("year"),
    upc: $("upc"), notes: $("notes"), raw: $("raw"),
    addBtn: $("addBtn"), clearBtn: $("clearBtn"), wipeBtn: $("wipeBtn"),
    list: $("list"), count: $("count"),
    exportBtn: $("exportBtn"), copyBtn: $("copyBtn"),
    pushBtn: $("pushBtn"), pushStatus: $("pushStatus"),
    quick: $("quick"), quickBtn: $("quickBtn"), quickClear: $("quickClear"),
    quickStatus: $("quickStatus"), quickPick: $("quickPick"),
  };

  const CFG = (window.PANELBOOK_CONFIG || {});
  const supabaseReady = () => Boolean(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);

  const STORE_KEY = "panelbook_scans";
  let stream = null;
  let detector = null;
  let detectTimer = null;
  let ocrWorker = null;
  let knownSeries = []; // { name, norm, grams }
  let seriesAliases = {}; // norm alias -> display name
  let issueYears = {}; // "Series|issue" -> "2025"
  let issueBooks = {}; // "Series|issue" -> { year, series, volume, issue }
  const MIN_YEAR = 2009; // hard rule: collection is modern-only
  const MAX_NEIGHBOR_GAP = 4; // infer year only across small same-vol holes
  const YEAR_HINT_SLACK = 3; // search give-or-take a few years around typed hints
  let pendingQuick = null; // bulk add waiting for run pick

  const setStatus = (msg, kind = "") => {
    els.status.textContent = msg;
    els.status.className = "status" + (kind ? " " + kind : "");
  };
  const setQuick = (msg, kind = "") => {
    els.quickStatus.textContent = msg;
    els.quickStatus.className = "status" + (kind ? " " + kind : "");
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

  function indexSeriesNames(names) {
    const byNorm = new Map(knownSeries.map((k) => [k.norm, k]));
    for (const name of names) {
      const n = norm(name);
      if (!n || byNorm.has(n)) continue;
      const row = { name: String(name), norm: n, grams: bigrams(n) };
      knownSeries.push(row);
      byNorm.set(n, row);
    }
  }

  async function loadKnownSeries() {
    // Prefer the static catalog (works even when collection is empty / wiped).
    try {
      const res = await fetch("series_catalog.json", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        indexSeriesNames(data.series || []);
        const aliases = data.aliases || {};
        for (const [k, v] of Object.entries(aliases)) seriesAliases[norm(k)] = v;
      }
    } catch (_) { /* optional */ }
    try {
      const res = await fetch("collection.json", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        const names = [];
        for (const r of data.collection || []) if (r.series) names.push(String(r.series));
        indexSeriesNames(names);
      }
    } catch (_) { /* matching just degrades to typed text */ }
    try {
      const res = await fetch("issue_years.json", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        issueYears = data.years || {};
        issueBooks = data.books || {};
      }
    } catch (_) { /* years stay blank until catalog is published */ }
  }

  function yearOk(y) {
    const n = parseInt(y, 10);
    return n && n >= MIN_YEAR ? String(n) : "";
  }

  function lookupYearFlat(series, issue) {
    const key = `${series}|${issue}`;
    return yearOk(issueYears[key] || issueYears[`${series}|${String(issue)}`] || "");
  }

  /** If #N has no year but nearest known #s on both sides share a year, use it. */
  function inferYearFromNeighbors(series, issue) {
    const n = parseInt(issue, 10);
    if (!Number.isFinite(n)) return "";
    const prefix = `${series}|`;
    const known = [];
    for (const [key, y] of Object.entries(issueYears)) {
      if (!key.startsWith(prefix)) continue;
      const iss = key.slice(prefix.length);
      if (!/^\d+$/.test(iss)) continue;
      const yy = yearOk(y);
      if (!yy) continue;
      known.push({ n: parseInt(iss, 10), y: yy });
    }
    known.sort((a, b) => a.n - b.n);
    let left = null, right = null;
    for (const row of known) {
      if (row.n < n) left = row;
      else if (row.n > n) { right = row; break; }
    }
    if (!left || !right) return "";
    if (right.n - left.n - 1 > MAX_NEIGHBOR_GAP) return "";
    if (left.y !== right.y) return "";
    const bl = issueBooks[`${series}|${left.n}`];
    const br = issueBooks[`${series}|${right.n}`];
    if (bl && br && (String(bl.volume) !== String(br.volume) || bl.series !== br.series)) {
      return "";
    }
    return left.y;
  }

  /**
   * Translate typed series+# into the physical book identity when known
   * (e.g. Venom #241 → All-New Venom Vol 1 #2), including neighbor-inferred years.
   * Optional lockedRun { series, volume } forces a chosen reboot.
   */
  function resolveBook(series, issue, lockedRun) {
    const iss = String(issue);
    if (lockedRun && lockedRun.series) {
      const runKey = `${lockedRun.series}|${iss}`;
      const b = issueBooks[runKey];
      if (b && yearOk(b.year)) {
        return {
          series: b.series || lockedRun.series,
          issue: b.issue != null && b.issue !== "" ? String(b.issue) : iss,
          year: String(b.year),
          volume: b.volume != null && b.volume !== "" ? String(b.volume) : String(lockedRun.volume || ""),
          note: lockedRun.series !== series ? `typed ${series} #${iss}` : "",
        };
      }
      // Issue not in index for this run — still commit the chosen identity.
      return {
        series: lockedRun.series,
        issue: iss,
        year: "",
        volume: lockedRun.volume != null && lockedRun.volume !== "" ? String(lockedRun.volume) : "",
        note: [
          lockedRun.series !== series ? `typed ${series} #${iss}` : "",
          "needs_year",
        ].filter(Boolean).join("; "),
      };
    }
    const key = `${series}|${iss}`;
    const b = issueBooks[key];
    if (b) {
      const y = yearOk(b.year) || inferYearFromNeighbors(series, iss);
      if (y) {
        const outSeries = b.series || series;
        const outIssue = b.issue != null && b.issue !== "" ? String(b.issue) : iss;
        const remapped = outSeries !== series || outIssue !== iss;
        return {
          series: outSeries,
          issue: outIssue,
          year: y,
          volume: b.volume != null && b.volume !== "" ? String(b.volume) : "",
          note: remapped ? `typed ${series} #${iss}` : "",
        };
      }
    }
    const year = lookupYearFlat(series, iss) || inferYearFromNeighbors(series, iss);
    return { series, issue: iss, year, volume: "", note: "" };
  }

  function lookupYear(series, issue) {
    return resolveBook(series, issue).year;
  }

  function seriesAffinity(typed, candidate) {
    const a = norm(typed), b = norm(candidate);
    if (!a || !b) return 0;
    if (a === b) return 100;
    if (b.includes(a) || a.includes(b)) return 85;
    const at = new Set(a.split(" ").filter(Boolean));
    const bt = b.split(" ").filter(Boolean);
    let inter = 0;
    for (const t of bt) if (at.has(t)) inter++;
    if (!inter) return 0;
    return 40 + Math.round((30 * inter) / Math.max(at.size, bt.size));
  }

  // Returns up to `n` best series matches for an OCR / typed blob.
  function matchSeries(text, n = 3) {
    const candidate = norm(text);
    if (!candidate || !knownSeries.length) return [];
    const scored = knownSeries
      .map((k) => {
        let score = dice(k.grams, candidate);
        if (k.norm === candidate) score = 1;
        else if (k.norm.startsWith(candidate) || candidate.startsWith(k.norm)) score = Math.max(score, 0.92);
        else if (k.norm.includes(candidate) || candidate.includes(k.norm)) score = Math.max(score, 0.75);
        return { name: k.name, score };
      })
      .filter((x) => x.score >= 0.34)
      .sort((a, b) => b.score - a.score || a.name.length - b.name.length);
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

  function prettySeries(s) {
    return String(s || "").trim().replace(/\s+/g, " ").split(" ")
      .map((word) => word.split("-")
        .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : p))
        .join("-"))
      .join(" ");
  }

  function resolveSeries(raw) {
    const n = norm(raw);
    if (!n) return "";
    if (seriesAliases[n]) return seriesAliases[n];
    const exact = knownSeries.find((k) => k.norm === n);
    if (exact) return exact.name;
    const matches = matchSeries(raw, 1);
    if (matches.length && matches[0].score >= 0.55) return matches[0].name;
    return prettySeries(raw);
  }

  /* ---------- quick type: single, range, comma list, optional year hint ---------- */
  const MAX_RANGE = 150;

  function clearQuickPick() {
    pendingQuick = null;
    if (els.quickPick) els.quickPick.innerHTML = "";
  }

  function parseYearHints(parenBody) {
    const years = [...String(parenBody || "").matchAll(/\b((?:19|20)\d{2})\b/g)]
      .map((m) => parseInt(m[1], 10))
      .filter((y) => y >= MIN_YEAR);
    return [...new Set(years)].sort((a, b) => a - b);
  }

  function parseIssueTokens(listText) {
    const parts = String(listText || "").split(/[,;]+/).map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return null;
    const issues = [];
    for (const part of parts) {
      let m = part.match(/^(\d{1,4})\s*(?:[-–—]|to)\s*(\d{1,4})$/i);
      if (m) {
        const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        const lo = Math.min(a, b), hi = Math.max(a, b);
        if (hi - lo + 1 > MAX_RANGE) return null;
        for (let n = lo; n <= hi; n++) issues.push(n);
        continue;
      }
      if (/^\d{1,4}$/.test(part)) {
        issues.push(parseInt(part, 10));
        continue;
      }
      return null;
    }
    return [...new Set(issues)].sort((a, b) => a - b);
  }

  function parseQuick(text) {
    let t = String(text || "").trim().replace(/\s+/g, " ");
    if (!t) return null;
    let yearHints = [];
    const paren = t.match(/\(([^)]*)\)\s*$/);
    if (paren) {
      yearHints = parseYearHints(paren[1]);
      t = t.slice(0, paren.index).trim();
    }

    // "Ultimates: 4, 7, 9, 11" or "Ultimates: 4-6, 9"
    let m = t.match(/^(.+?)\s*:\s*(.+)$/);
    if (m) {
      const issues = parseIssueTokens(m[2]);
      if (issues && issues.length) {
        return { seriesRaw: m[1].trim(), issues, yearHints };
      }
    }

    // "Ultimates 4, 7, 9, 11"
    m = t.match(/^(.+?)\s+(\d{1,4}(?:\s*[,;]\s*\d{1,4}(?:\s*(?:[-–—]|to)\s*\d{1,4})?)+)$/i);
    if (m) {
      const issues = parseIssueTokens(m[2]);
      if (issues && issues.length) {
        return { seriesRaw: m[1].trim(), issues, yearHints };
      }
    }

    m = t.match(/^(.*?)[\s#]+(\d{1,4})\s*(?:[-–—]|to)\s*(\d{1,4})\s*$/i);
    if (m) {
      const a = parseInt(m[2], 10), b = parseInt(m[3], 10);
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const issues = [];
      for (let n = lo; n <= hi; n++) issues.push(n);
      return { seriesRaw: m[1].trim(), issues, yearHints };
    }
    m = t.match(/^(.*?)[\s#]+(\d{1,4})\s*$/);
    if (m) {
      return { seriesRaw: m[1].trim(), issues: [parseInt(m[2], 10)], yearHints };
    }
    return null;
  }

  function findRunCandidates(typedSeries, issues, yearHints) {
    const want = new Set((issues || []).map(String));
    const hints = (yearHints || []).filter((y) => y >= MIN_YEAR);
    const lo = hints.length ? Math.min(...hints) - YEAR_HINT_SLACK : null;
    const hi = hints.length ? Math.max(...hints) + YEAR_HINT_SLACK : null;

    // series||volume -> aggregate
    const runs = new Map();
    for (const [key, b] of Object.entries(issueBooks)) {
      const pipe = key.lastIndexOf("|");
      if (pipe < 0) continue;
      const keyIssue = key.slice(pipe + 1);
      if (!/^\d+$/.test(keyIssue)) continue;
      const seriesName = String(b.series || key.slice(0, pipe));
      const aff = seriesAffinity(typedSeries, seriesName);
      if (aff < 40) continue;
      const y = parseInt(b.year, 10);
      if (!y || y < MIN_YEAR) continue;
      const vol = b.volume != null && b.volume !== "" ? String(b.volume) : "";
      const rkey = `${seriesName}||${vol}`;
      let run = runs.get(rkey);
      if (!run) {
        run = {
          series: seriesName,
          volume: vol,
          affinity: aff,
          years: [],
          hitIssues: [],
          inWindow: 0,
        };
        runs.set(rkey, run);
      }
      run.years.push(y);
      if (want.has(keyIssue)) run.hitIssues.push(parseInt(keyIssue, 10));
      if (lo == null || (y >= lo && y <= hi)) run.inWindow += 1;
    }

    let list = [...runs.values()].map((r) => {
      const ymin = Math.min(...r.years);
      const ymax = Math.max(...r.years);
      const overlapsHint = lo == null || (ymax >= lo && ymin <= hi);
      const hit = [...new Set(r.hitIssues)].sort((a, b) => a - b);
      return {
        series: r.series,
        volume: r.volume,
        affinity: r.affinity,
        yearMin: ymin,
        yearMax: ymax,
        hitIssues: hit,
        inWindow: r.inWindow,
        overlapsHint,
        label:
          `${r.series}` +
          (r.volume ? ` Vol ${r.volume}` : "") +
          ` (${ymin === ymax ? ymin : ymin + "–" + ymax})` +
          (hit.length ? ` · has #${hit.slice(0, 4).join(",")}${hit.length > 4 ? "…" : ""}` : ""),
      };
    });

    if (hints.length) {
      // Prefer runs that overlap the fuzzy year window; if none, fall back to name matches.
      const windowed = list.filter((r) => r.overlapsHint);
      if (windowed.length) list = windowed;
    } else {
      // No hint: only bother the user when multiple distinct runs hit the typed issues.
      list = list.filter((r) => r.hitIssues.length > 0);
    }

    list.sort((a, b) =>
      (b.overlapsHint === a.overlapsHint ? 0 : b.overlapsHint ? 1 : -1) ||
      b.hitIssues.length - a.hitIssues.length ||
      b.inWindow - a.inWindow ||
      b.affinity - a.affinity ||
      a.yearMin - b.yearMin
    );
    return list.slice(0, 8);
  }

  function appendRows(entries) {
    const rows = load();
    const now = new Date().toISOString();
    for (const e of entries) {
      const book = resolveBook(e.series, e.issue, e.lockedRun);
      const series = book.series;
      const issue = book.issue;
      const year = e.year || book.year || "";
      const volume = e.volume || book.volume || "";
      const noteBits = [e.notes, book.note].filter(Boolean);
      rows.push({
        source: "scan",
        series,
        issue_number: String(issue),
        year,
        volume,
        title: series && issue ? `${series} #${issue}` : series,
        upc: e.upc || "",
        notes: noteBits.join("; "),
        scanned_at: now,
        raw_ocr: e.raw || "",
      });
    }
    save(rows);
    render();
  }

  function commitQuick(typedSeries, issues, lockedRun, rawText, yearHints) {
    const entries = issues.map((i) => ({
      series: typedSeries,
      issue: i,
      lockedRun: lockedRun || null,
      notes: (!lockedRun && yearHints && yearHints.length)
        ? `year_hint:${yearHints[0]}${yearHints.length > 1 ? "-" + yearHints[yearHints.length - 1] : ""}`
        : "",
      raw: `quick: ${rawText}`,
    }));
    appendRows(entries);
    const sample = resolveBook(typedSeries, issues[0], lockedRun || null);
    const withYear = entries.reduce((n, e) => {
      const b = resolveBook(e.series, e.issue, e.lockedRun);
      return n + (b.year ? 1 : 0);
    }, 0);
    const runLabel = lockedRun
      ? `${lockedRun.series}${lockedRun.volume ? " Vol " + lockedRun.volume : ""}`
      : typedSeries;
    const label = issues.length === 1
      ? `Added ${sample.series} #${sample.issue}` +
        (sample.volume ? ` Vol ${sample.volume}` : "") +
        (sample.year ? ` (${sample.year})` : "") + "."
      : `Added ${runLabel}: ${issues.length} issues (${withYear} with year).`;
    setQuick(label + " Next?", withYear === issues.length ? "ok" : "warn");
    els.quick.value = "";
    clearQuickPick();
    els.quick.focus();
  }

  function renderQuickPick(candidates, typedSeries, issues, yearHints, rawText) {
    if (!els.quickPick) return;
    els.quickPick.innerHTML = "";
    pendingQuick = { typedSeries, issues, yearHints, rawText, candidates };

    const hintLabel = yearHints.length
      ? ` around ${yearHints[0]}${yearHints.length > 1 ? "–" + yearHints[yearHints.length - 1] : ""} (±${YEAR_HINT_SLACK})`
      : "";
    setQuick(
      candidates.length
        ? `Which run is this${hintLabel}? Tap one:`
        : `No catalog run near those years — pick how to save:`,
      "warn"
    );

    const addChip = (label, onClick) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = label;
      b.onclick = onClick;
      els.quickPick.appendChild(b);
    };

    for (const c of candidates) {
      addChip(c.label, () => {
        commitQuick(typedSeries, issues, { series: c.series, volume: c.volume }, rawText, yearHints);
      });
    }
    addChip(`Keep typed “${typedSeries}” (resolve later)`, () => {
      commitQuick(typedSeries, issues, null, rawText, yearHints);
    });
  }

  function addQuick() {
    clearQuickPick();
    const rawText = els.quick.value.trim();
    const parsed = parseQuick(rawText);
    if (!parsed || !parsed.seriesRaw || !parsed.issues || !parsed.issues.length) {
      setQuick('Try: venom 241   or   ultimates: 4, 7, 9 (2011 or 2012)', "warn");
      return;
    }
    if (parsed.issues.length > MAX_RANGE) {
      setQuick(`Too many issues (${parsed.issues.length}). Max ${MAX_RANGE} at once.`, "warn");
      return;
    }
    const typedSeries = resolveSeries(parsed.seriesRaw);
    const yearHints = parsed.yearHints || [];
    const candidates = findRunCandidates(typedSeries, parsed.issues, yearHints);

    // Year hint (or multiple plausible runs) → ask the human. Don't auto-guess reboots.
    if (yearHints.length || candidates.length > 1) {
      renderQuickPick(candidates, typedSeries, parsed.issues, yearHints, rawText);
      return;
    }

    // Unambiguous single/range with one catalog run (or none) — add directly.
    const locked = candidates.length === 1
      ? { series: candidates[0].series, volume: candidates[0].volume }
      : null;
    commitQuick(typedSeries, parsed.issues, locked, rawText, yearHints);
  }

  /* ---------- camera + barcode ---------- */
  async function startCamera() {
    setStatus("Starting camera…");
    els.camwrap.classList.remove("using-photo");
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
  function applyBarcode(raw, { overwriteIssue = false } = {}) {
    const digits = String(raw).replace(/\D/g, "");
    if (!digits) return null;
    const main = digits.slice(0, 12);
    if (!els.upc.value || els.upc.value !== main) {
      els.upc.value = main;
      setStatus("Barcode read: " + main, "ok");
    }
    // If a 5-digit supplement rode along, first 3 digits are the volume issue number.
    let addonIssue = null;
    if (digits.length >= 17) {
      const addon = digits.slice(12, 17);
      const iss = parseInt(addon.slice(0, 3), 10);
      if (iss) {
        addonIssue = String(iss);
        if (overwriteIssue || !els.issue.value) els.issue.value = addonIssue;
      }
    }
    return { upc: main, addonIssue };
  }

  async function detectBarcodeOn(source) {
    if (!("BarcodeDetector" in window)) return null;
    try {
      if (!detector) {
        detector = new window.BarcodeDetector({
          formats: ["upc_a", "ean_13", "upc_e", "ean_8"],
        });
      }
      const codes = await detector.detect(source);
      if (codes && codes.length) return applyBarcode(codes[0].rawValue || "", { overwriteIssue: false });
    } catch (_) { /* unsupported source or transient */ }
    return null;
  }

  /* ---------- capture + OCR ---------- */
  async function ensureWorker() {
    if (ocrWorker) return ocrWorker;
    setStatus("Loading OCR (first time only)…");
    ocrWorker = await Tesseract.createWorker("eng");
    return ocrWorker;
  }

  function sourceSize(source) {
    return {
      w: source.videoWidth || source.naturalWidth || source.width || 0,
      h: source.videoHeight || source.naturalHeight || source.height || 0,
    };
  }

  // Throwaway canvas for OCR — never persisted, never uploaded.
  function cropToCanvas(source, topFrac, bottomFrac) {
    const { w: vw, h: vh } = sourceSize(source);
    if (!vw || !vh) throw new Error("Image not ready");
    const y0 = Math.floor(vh * topFrac);
    const y1 = Math.floor(vh * bottomFrac);
    const h = Math.max(1, y1 - y0);
    const c = document.createElement("canvas");
    const scale = Math.min(2, 1400 / vw) || 1;
    c.width = Math.floor(vw * scale);
    c.height = Math.floor(h * scale);
    const ctx = c.getContext("2d");
    ctx.drawImage(source, 0, y0, vw, h, 0, 0, c.width, c.height);
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

  function resetScanFields() {
    els.series.value = "";
    els.issue.value = "";
    els.year.value = "";
    els.upc.value = "";
    els.notes.value = "";
    els.suggest.innerHTML = "";
    els.matchNote.textContent = "";
  }

  async function readFromSource(source) {
    resetScanFields();
    const worker = await ensureWorker();

    setStatus("Reading barcode…");
    await detectBarcodeOn(source);

    // Title band is wider than the live reticle: seller photos often crop oddly,
    // and landmark numbers ("900") sit mid-cover as often as in the header.
    setStatus("Reading title…");
    const titleCanvas = cropToCanvas(source, 0.0, 0.55);
    await worker.setParameters({ tessedit_char_whitelist: "" });
    const tTitle = (await worker.recognize(titleCanvas)).data.text || "";

    setStatus("Reading barcode digits…");
    const numCanvas = cropToCanvas(source, 0.70, 1.0);
    await worker.setParameters({ tessedit_char_whitelist: "0123456789 #No.LGYISSUE" });
    const tNum = (await worker.recognize(numCanvas)).data.text || "";

    titleCanvas.width = titleCanvas.height = 0;
    numCanvas.width = numCanvas.height = 0;

    const detail = applyOcr(tTitle, tNum);
    const filled = [els.series.value && "series", els.issue.value && "issue", els.year.value && "year"]
      .filter(Boolean).join(", ");
    let msg = filled
      ? `Filled ${filled}. Check, then “Add to list”.`
      : "Couldn't read series/issue — type them in (raw OCR below).";
    if (detail && detail.altIssue) msg += ` (also saw #${detail.altIssue})`;
    setStatus(msg, filled ? "ok" : "warn");
  }

  async function captureAndRead() {
    if (!els.video.videoWidth) { setStatus("Camera not ready yet.", "warn"); return; }
    els.camwrap.classList.remove("using-photo");
    els.scanBtn.disabled = true;
    els.uploadBtn.disabled = true;
    try {
      await readFromSource(els.video);
    } catch (e) {
      setStatus("OCR failed: " + (e.message || e), "warn");
    } finally {
      els.scanBtn.disabled = false;
      els.uploadBtn.disabled = false;
    }
  }

  async function readFromFile(file) {
    if (!file || !file.type.startsWith("image/")) {
      setStatus("Pick a cover photo (jpg/png/heic).", "warn");
      return;
    }
    els.scanBtn.disabled = true;
    els.uploadBtn.disabled = true;
    let bitmap = null;
    try {
      setStatus("Loading photo…");
      // Object URL preview (not stored beyond this session)
      if (els.still.dataset.url) URL.revokeObjectURL(els.still.dataset.url);
      const url = URL.createObjectURL(file);
      els.still.dataset.url = url;
      els.still.src = url;
      els.camwrap.classList.add("using-photo");
      await new Promise((resolve, reject) => {
        els.still.onload = resolve;
        els.still.onerror = () => reject(new Error("Couldn't open that photo"));
      });
      bitmap = await createImageBitmap(els.still);
      await readFromSource(bitmap);
    } catch (e) {
      setStatus("OCR failed: " + (e.message || e), "warn");
    } finally {
      if (bitmap && bitmap.close) bitmap.close();
      els.scanBtn.disabled = false;
      els.uploadBtn.disabled = false;
      els.fileInput.value = "";
    }
  }

  // Prefer a cover line that looks like a title, not "#300" or a year alone.
  function draftSeriesFromOcr(lines) {
    for (const line of lines) {
      const cleaned = line
        .replace(/#\s*\d{1,4}/g, "")
        .replace(/\bNO\.?\s*\d{1,4}\b/gi, "")
        .replace(/\b(?:LGY|LEGACY|LANDMARK(?:\s+ISSUE)?)\s*#?\s*\d{1,4}\b/gi, "")
        .replace(/\bVARIANT(?:\s+EDITION)?\b/gi, "")
        .replace(/\b(19[3-9]\d|20[0-4]\d)\b/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (cleaned.replace(/[^a-z0-9]/gi, "").length >= 3) return cleaned;
    }
    return lines[0] || "";
  }

  // Strip retailer ratio text so "1:25" / "1 for 25" never becomes the issue.
  function scrubRatioNoise(text) {
    return String(text || "")
      .replace(/\b1\s*[:\/]\s*\d{1,3}\b/gi, " ")
      .replace(/\b1\s+for\s+\d{1,3}\b/gi, " ")
      .replace(/\b\d{1,3}\s*[-–]\s*copy\b/gi, " ");
  }

  // Cover volume # beats LGY footnotes (ASM #21 + LGY #915 → 21).
  // Landmark art/LGY only wins when the big number is not merely a tiny LGY tag.
  function pickIssue(titleText, numText) {
    const text = scrubRatioNoise(titleText);
    const cands = [];
    const add = (raw, source, weight) => {
      const n = parseInt(String(raw).replace(/\D/g, ""), 10);
      if (!n || n > 9999) return;
      if (n >= 1930 && n <= 2039) return; // years, not issues
      cands.push({ value: String(n), source, weight, n });
    };

    // LGY is a small Marvel trade-dress footnote — weaker than #N / ISSUE.
    for (const m of text.matchAll(/\b(?:LGY|LEGACY)\s*#?\s*(\d{1,4})\b/gi)) {
      add(m[1], "legacy", 45);
    }
    // Marvel issue box is often "MARVEL 21 LGY #915" — volume # sits beside LGY, no hash.
    for (const m of text.matchAll(/\b(\d{1,3})\s+LGY\b/gi)) {
      add(m[1], "beside-lgy", 88);
    }
    for (const m of text.matchAll(/\bMARVEL\s+(\d{1,3})\b/gi)) {
      add(m[1], "marvel-box", 85);
    }
    for (const m of text.matchAll(/\bLANDMARK(?:\s+ISSUE)?\s*#?\s*(\d{1,4})\b/gi)) {
      add(m[1], "landmark", 95);
    }
    for (const m of text.matchAll(/\bISSUE\s*#?\s*(\d{1,4})\b/gi)) {
      add(m[1], "issue-word", 90);
    }
    // Don't treat "LGY #915" as a normal #915 issue hit.
    const withoutLgy = text.replace(/\b(?:LGY|LEGACY)\s*#?\s*\d{1,4}\b/gi, " ");
    for (const m of withoutLgy.matchAll(/#\s*(\d{1,4})\b/g)) {
      add(m[1], "hash", 80);
    }
    for (const m of withoutLgy.matchAll(/\bNO\.?\s*(\d{1,4})\b/gi)) {
      add(m[1], "no", 70);
    }
    // Big cover art numbers (e.g. ASM "900") with no # — weaker than #N.
    for (const m of withoutLgy.matchAll(/\b(\d{3,4})\b/g)) {
      add(m[1], "bare", 55);
    }

    const groups = (scrubRatioNoise(numText).match(/\d{5}/g) || [])
      .filter((g) => els.upc.value.indexOf(g) === -1);
    if (groups.length) {
      const iss = parseInt(groups[groups.length - 1].slice(0, 3), 10);
      if (iss) add(iss, "barcode-ocr", 40);
    }
    if (els.issue.value) add(els.issue.value, "barcode-api", 35);

    if (!cands.length) return { issue: null, altIssue: null, lgy: null };

    cands.sort((a, b) => b.weight - a.weight || b.n - a.n);
    let best = cands[0];
    const cover = cands.filter((c) => c.source !== "barcode-ocr" && c.source !== "barcode-api");
    if (cover.length >= 2) {
      const hi = cover.reduce((a, b) => (a.n > b.n ? a : b));
      const lo = cover.reduce((a, b) => (a.n < b.n ? a : b));
      // ASM #6 / #900 style — only promote a large number that isn't a lone LGY footnote.
      const hiIsLandmark = hi.source === "landmark" || hi.source === "bare" ||
        hi.source === "hash" || hi.source === "issue-word";
      if (lo.n <= 99 && hi.n >= 100 && hi.n >= lo.n * 10 && hiIsLandmark) best = hi;
    }
    const lgy = cands.find((c) => c.source === "legacy");
    const alt = cands.find((c) => c.value !== best.value);
    return {
      issue: best.value,
      altIssue: alt ? alt.value : null,
      lgy: lgy ? lgy.value : null,
    };
  }

  function fillVariantNotes(titleText, picked) {
    if (els.notes.value.trim()) return; // don't clobber typed notes
    const bits = [];
    if (/\bVARIANT\b/i.test(titleText)) bits.push("Variant");
    if (picked.lgy && picked.lgy !== picked.issue) bits.push(`LGY #${picked.lgy}`);
    if (bits.length) els.notes.value = bits.join(" · ");
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
    if (best.length) els.series.value = best[0].name;
    else if (lines.length) els.series.value = draftSeriesFromOcr(lines);

    const picked = pickIssue(titleText, numText);
    if (picked.issue) els.issue.value = picked.issue;
    fillVariantNotes(titleText, picked);

    const yr = titleText.match(/\b(19[3-9]\d|20[0-4]\d)\b/);
    if (yr) els.year.value = yr[1];
    return picked;
  }

  function renderSuggestions(matches) {
    els.suggest.innerHTML = "";
    if (!matches.length) {
      els.matchNote.textContent = knownSeries.length
        ? (els.series.value
          ? "No match in collection — OCR draft filled in (edit if needed)."
          : "No confident series match — type it in.")
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

  /* ---------- session list + storage (text fields only, no images) ---------- */
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
        `<small>${[r.volume ? "Vol " + r.volume : "", r.year, r.upc].filter(Boolean).map(escapeHtml).join(" · ")}</small>`;
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
      setStatus("Nothing to add — type quick entry or fill a comic first.", "warn");
      return;
    }
    const book = series && issue ? resolveBook(series, issue) : null;
    appendRows([{
      series,
      issue,
      year: els.year.value.trim() || (book && book.year) || "",
      volume: (book && book.volume) || "",
      upc: els.upc.value.trim(),
      notes: els.notes.value.trim(),
      raw: els.raw.textContent.replace(/\s+/g, " ").trim(),
    }]);
    clearFields();
    setStatus("Added. Next one.", "ok");
    if (els.quick) els.quick.focus();
  }

  function clearFields() {
    ["series", "issue", "year", "upc", "notes"].forEach((k) => (els[k].value = ""));
    els.suggest.innerHTML = "";
    els.matchNote.textContent = "";
    els.raw.textContent = "";
    els.camwrap.classList.remove("using-photo");
    if (els.still.dataset.url) {
      URL.revokeObjectURL(els.still.dataset.url);
      delete els.still.dataset.url;
    }
    els.still.removeAttribute("src");
  }

  /* ---------- export ---------- */
  const COLS = ["source", "series", "issue_number", "year", "volume", "title", "upc", "notes", "scanned_at", "raw_ocr"];
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
      volume: r.volume || null,
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
  els.uploadBtn.onclick = () => els.fileInput.click();
  els.fileInput.onchange = () => {
    const f = els.fileInput.files && els.fileInput.files[0];
    if (f) readFromFile(f);
  };
  els.quickBtn.onclick = addQuick;
  els.quickClear.onclick = () => {
    els.quick.value = "";
    clearQuickPick();
    setQuick("Series + issues, optional year hint. Ambiguous runs ask you to pick.");
    els.quick.focus();
  };
  els.quick.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addQuick(); }
  });
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

  loadKnownSeries().then(() => {
    els.quick.focus();
  });
  render();
})();
