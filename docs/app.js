/* Page logic: builds the input form, keeps inputs in the URL hash, runs the
 * engine (one Web Worker per model, in parallel) and draws the charts. */
(function () {
  "use strict";

  const THIS_YEAR = new Date().getFullYear();
  const MODEL_ORDER = ["gbm", "boot", "t"];
  const MODEL_COLOR = { gbm: "--s1", boot: "--s2", t: "--s3" };

  // ---------- input definitions ----------
  const num = (key, label, o = {}) => Object.assign({ key, label, type: "number", step: 1 }, o);
  const cash = (key, label, o = {}) => num(key, label, Object.assign({ step: 1000, pre: "$" }, o));
  const rate = (key, label, o = {}) => num(key, label, Object.assign({ step: 0.5, post: "%" }, o));
  const check = (key, label, o = {}) => Object.assign({ key, label, type: "check" }, o);
  const isPct = p => p.strategy === "percent", isGr = p => p.strategy === "guardrails";

  const SECTIONS = [
    { title: "Your plan", open: true, fields: [
      num("currentAge", "Current age", { min: 18, max: 90 }),
      num("retireAge", "Retirement age", { min: 18, max: 100 }),
      num("endAge", "Plan until age", { min: 20, max: 110, help: "The money has to last this long." }),
      cash("balance", "Savings today", { min: 0, step: 10000 }),
      cash("contribution", "Yearly savings until retirement", { min: 0 }),
      rate("contribGrowth", "Savings grow by (per year)", { help: "Real raises: 1% means savings beat inflation by 1% a year." }),
      { key: "stocks", label: "Stocks", type: "range", min: 0, max: 100, step: 5, post: "%",
        help: "The rest goes in 10-year Treasuries. Rebalanced monthly." },
    ]},
    { title: "Spending & withdrawals", open: true, fields: [
      cash("spending", "Yearly spending in retirement", { min: 0, show: p => !isPct(p),
        help: "In today's dollars. Social Security, pensions and work income below cover part of it." }),
      { key: "strategy", label: "Withdrawal strategy", type: "select", wide: true, options: [
        ["fixed", "Fixed dollars, inflation-adjusted"],
        ["percent", "Fixed % of the portfolio each year"],
        ["guardrails", "Guardrails (Guyton-Klinger)"]] },
      rate("pctRate", "Withdraw this share each year", { show: isPct, min: 0, step: 0.25,
        help: "Recomputed every birthday. Spending rises and falls with the market, so the money never fully runs out." }),
      rate("grBand", "Guardrail width (±)", { show: isGr, min: 0, step: 5,
        help: "Act when the withdrawal rate drifts this far from where it started." }),
      rate("grAdj", "Spending change at a guardrail", { show: isGr, min: 0, step: 1 }),
      rate("grFloor", "Never spend below (% of plan)", { show: isGr, min: 0, step: 5 }),
      rate("grCeil", "Never spend above (% of plan)", { show: isGr, min: 100, step: 5 }),
      rate("floorPct", "Spending floor for success", { min: 0, max: 100, step: 5, show: p => p.strategy !== "fixed",
        help: "A path also fails if a year's spending drops below this share of plan (of first-year spending for the % strategy). That is how variable strategies fail." }),
      check("phaseOn", "Spend differently later in retirement"),
      num("phaseAge", "…starting at age", { show: p => p.phaseOn }),
      rate("phasePct", "…change spending by", { show: p => p.phaseOn, step: 5,
        help: "Use −20% for slower \"slow-go\" years, or + for long-term care." }),
    ]},
    { title: "One-time expenses & windfalls", custom: "onetime" },
    { title: "Income", fields: [
      cash("ssBenefit", "Social Security at full retirement age", { min: 0,
        help: "Yearly benefit in today's dollars, from your statement at ssa.gov/myaccount. 0 = none." }),
      num("ssClaimAge", "Claim Social Security at", { min: 62, max: 70, show: p => p.ssBenefit > 0 }),
      cash("pension", "Pension or annuity (per year)", { min: 0 }),
      num("pensionAge", "Pension starts at age", { show: p => p.pension > 0 }),
      check("pensionCola", "Pension keeps up with inflation", { show: p => p.pension > 0 }),
      rate("pensionInfl", "Inflation eroding a fixed pension", { show: p => p.pension > 0 && !p.pensionCola }),
      cash("workIncome", "Part-time work in retirement", { min: 0 }),
      num("workUntil", "Work until age", { show: p => p.workIncome > 0 }),
    ]},
    { title: "Social Security program changes", fields: [
      rate("ssCutPct", "Benefit cut if the trust fund runs short", { min: 0, max: 100, step: 1,
        help: "2025 Trustees Report: ~77% of benefits payable once reserves run out in 2033, about a 23% cut. Set 0 if Congress fixes it." }),
      num("ssCutYear", "Cut starts in year", { min: THIS_YEAR, max: 2100 }),
      num("ssFra", "Full retirement age", { min: 62, max: 72,
        help: "67 today. Raising it lowers the benefit you get at any given claiming age." }),
      rate("ssColaGap", "COLA shortfall per year", { min: 0, step: 0.1,
        help: "Benefit loses this much buying power each year (e.g. if COLAs track a lower inflation measure)." }),
    ]},
    { title: "Market assumptions & stress tests", fields: [
      check("useGbm", "Model: GBM (normal returns)"),
      check("useBoot", "Model: historical bootstrap"),
      check("useT", "Model: Student-t (fat tails)"),
      num("tDf", "Fat-tail degrees of freedom", { show: p => p.useT, min: 3, max: 30,
        help: "Lower = fatter tails. 4 gives crashes far more often than a normal curve." }),
      rate("stockAdj", "Stock returns vs. history (per year)", { step: 0.5,
        help: "Negative if you expect less than the US's 150-year record, e.g. −1.5." }),
      rate("bondAdj", "Bond returns vs. history (per year)", { step: 0.5 }),
      num("volMult", "Volatility multiplier", { min: 0, max: 3, step: 0.1, post: "×",
        help: "1 = historical swings. 1.3 = 30% bigger ups and downs." }),
      rate("crashPct", "Crash at retirement: stocks fall", { min: 0, max: 90, step: 5,
        help: "One-time drop in your first month of retirement, the worst sequence-of-returns timing." }),
      rate("badPct", "Bad stretch: returns lower by (per year)", { min: 0, step: 0.5 }),
      num("badYears", "…for the first N years of retirement", { min: 0, max: 40, show: p => p.badPct > 0 }),
    ]},
    { title: "Simulation", fields: [
      num("histStart", "History starts in", { min: 1871, max: 2000,
        help: "Both models learn from US data since this year (1871 to 2024)." }),
      num("block", "Bootstrap block length", { min: 1, max: 120, post: "mo",
        help: "Average stretch of real history replayed at a time." }),
      num("paths", "Paths per model", { min: 100, max: 50000, step: 1000 }),
      num("seed", "Random seed", { help: "Same seed, same results." }),
    ]},
  ];
  const OT_N = 3;

  const DEFAULTS = Object.assign({}, MC.DEFAULTS);
  delete DEFAULTS.oneTime; delete DEFAULTS.currentYear;
  for (let i = 1; i <= OT_N; i++) { DEFAULTS["ot" + i + "Age"] = 60 + 10 * i; DEFAULTS["ot" + i + "Amt"] = 0; }
  const KEYS = Object.keys(DEFAULTS);
  const TYPE = k => typeof DEFAULTS[k];

  // ---------- state: defaults <- localStorage <- URL hash ----------
  function parseHash(h) {
    const out = {};
    new URLSearchParams(h.replace(/^#/, "")).forEach((v, k) => {
      if (!(k in DEFAULTS)) return;
      if (TYPE(k) === "boolean") out[k] = v === "1";
      else if (TYPE(k) === "number") { const x = parseFloat(v); if (isFinite(x)) out[k] = x; }
      else out[k] = v;
    });
    return out;
  }
  function toHash(p) {
    const q = new URLSearchParams();
    KEYS.forEach(k => {
      if (p[k] === DEFAULTS[k]) return;
      q.set(k, TYPE(k) === "boolean" ? (p[k] ? "1" : "0") : String(p[k]));
    });
    const s = q.toString();
    return s ? "#" + s : "";
  }
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } },
  };
  let state = Object.assign({}, DEFAULTS,
    location.hash.length > 1 ? {} : (store.get("mc-last") || {}), parseHash(location.hash));
  KEYS.forEach(k => { if (typeof state[k] !== TYPE(k)) state[k] = DEFAULTS[k]; });

  // ---------- form ----------
  const form = document.getElementById("form");
  const inputs = {};
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function fieldHtml(f) {
    const id = "f-" + f.key, help = f.help ? `<div class="help">${esc(f.help)}</div>` : "";
    const attrs = ["min", "max", "step"].filter(a => f[a] != null).map(a => `${a}="${f[a]}"`).join(" ");
    if (f.type === "check") return `<div class="field check" data-key="${f.key}"><input type="checkbox" id="${id}"><label for="${id}">${esc(f.label)}</label>${help}</div>`;
    if (f.type === "select") return `<div class="field${f.wide ? " wide" : ""}" data-key="${f.key}"><label for="${id}">${esc(f.label)}</label><select id="${id}">${f.options.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select>${help}</div>`;
    if (f.type === "range") return `<div class="field range" data-key="${f.key}"><label for="${id}">${esc(f.label)} <span class="unit" id="${id}-split"></span></label><div class="rangebox"><input type="range" id="${id}-r" ${attrs} aria-label="${esc(f.label)}"><div class="inwrap has-post"><input type="number" id="${id}" ${attrs}><span class="post">${f.post}</span></div></div>${help}</div>`;
    const cls = (f.pre ? " has-pre" : "") + (f.post ? " has-post" : "");
    return `<div class="field" data-key="${f.key}"><label for="${id}">${esc(f.label)}</label><div class="inwrap${cls}">${f.pre ? `<span class="pre">${f.pre}</span>` : ""}<input type="number" inputmode="decimal" id="${id}" ${attrs}>${f.post ? `<span class="post">${f.post}</span>` : ""}</div>${help}</div>`;
  }
  function oneTimeHtml() {
    let h = `<div class="field"><div class="help" style="margin:0">Negative = expense (a new roof: −30000). Positive = windfall (an inheritance or home downsizing).</div></div><div class="ot-head"><span>Age</span><span>Amount, today's $</span></div>`;
    for (let i = 1; i <= OT_N; i++) {
      h += `<div class="ot"><input type="number" id="f-ot${i}Age" aria-label="One-time ${i} age" min="18" max="110"><input type="number" id="f-ot${i}Amt" aria-label="One-time ${i} amount" step="1000"></div>`;
    }
    return h;
  }
  SECTIONS.forEach((s, si) => {
    const d = document.createElement("details");
    d.className = "group"; d.dataset.section = si;
    if (s.open) d.open = true;
    d.innerHTML = `<summary>${esc(s.title)}<span class="changed"></span></summary><div class="fields">${s.custom ? oneTimeHtml() : s.fields.map(fieldHtml).join("")}</div>`;
    form.appendChild(d);
  });
  KEYS.forEach(k => { const el = document.getElementById("f-" + k); if (el) inputs[k] = el; });
  const ALL_FIELDS = SECTIONS.flatMap(s => s.fields || []);
  const sectionKeys = SECTIONS.map(s => s.custom ? KEYS.filter(k => /^ot\d/.test(k)) : s.fields.map(f => f.key));

  function writeForm() {
    KEYS.forEach(k => {
      const el = inputs[k]; if (!el) return;
      if (el.type === "checkbox") el.checked = !!state[k]; else el.value = state[k];
      el.classList.remove("invalid");
    });
    const r = document.getElementById("f-stocks-r"); if (r) r.value = state.stocks;
    refreshForm();
  }
  function refreshForm() {
    ALL_FIELDS.forEach(f => {
      const row = form.querySelector(`.field[data-key="${f.key}"]`);
      if (row) row.classList.toggle("hidden", !!f.show && !f.show(state));
    });
    document.getElementById("f-stocks-split").textContent = `(${state.stocks}/${100 - state.stocks} stocks/bonds)`;
    sectionKeys.forEach((keys, i) => {
      const n = keys.filter(k => state[k] !== DEFAULTS[k]).length;
      form.querySelector(`details[data-section="${i}"] .changed`).textContent = n ? `${n} changed` : "";
    });
  }
  function readField(k) {
    const el = inputs[k];
    if (el.type === "checkbox") return el.checked;
    if (el.tagName === "SELECT") return el.value;
    const v = parseFloat(el.value);
    const bad = !isFinite(v) || (el.min !== "" && v < +el.min) || (el.max !== "" && v > +el.max);
    el.classList.toggle("invalid", bad);
    return bad ? undefined : v;
  }
  form.addEventListener("input", e => {
    let k = e.target.id.replace(/^f-/, "");
    if (k === "stocks-r") { k = "stocks"; inputs.stocks.value = e.target.value; }
    if (!(k in DEFAULTS)) return;
    const v = readField(k);
    if (v === undefined) return;              // keep the last valid value until the input is fixed
    if (k === "stocks") document.getElementById("f-stocks-r").value = v;
    state[k] = v;
    refreshForm();
    schedule();
  });

  // ---------- running ----------
  const WORKER_SRC = mcEngine.toString() + "\nmcEngine(self);\n" +
    "self.onmessage = function (e) { try { postMessage({ ok: true, r: MC.run(e.data.params, e.data.history) }); }" +
    " catch (err) { postMessage({ ok: false, error: String(err && err.message || err) }); } };";
  let workerUrl = null, workersOk = typeof Worker !== "undefined";
  try { workerUrl = URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" })); } catch (e) { workersOk = false; }
  let live = [], runId = 0, timer = null;

  function engineParams(p, onlyModel) {
    const e = {};
    Object.keys(MC.DEFAULTS).forEach(k => { if (k in p) e[k] = p[k]; });
    e.oneTime = [];
    for (let i = 1; i <= OT_N; i++) e.oneTime.push({ age: p["ot" + i + "Age"], amount: p["ot" + i + "Amt"] });
    e.currentYear = THIS_YEAR;
    if (onlyModel) { e.useGbm = onlyModel === "gbm"; e.useBoot = onlyModel === "boot"; e.useT = onlyModel === "t"; }
    return e;
  }
  function runInWorker(params) {
    return new Promise((resolve, reject) => {
      let w;
      try { w = new Worker(workerUrl); } catch (e) { workersOk = false; reject(e); return; }
      live.push(w);
      w.onmessage = ev => { w.terminate(); ev.data.ok ? resolve(ev.data.r) : reject(new Error(ev.data.error)); };
      w.onerror = ev => { ev.preventDefault(); w.terminate(); workersOk = false; reject(new Error("worker")); };
      w.postMessage({ params, history: window.MC_HISTORY });
    });
  }
  function runHere(params) {
    return new Promise((resolve, reject) => setTimeout(() => {
      try { resolve(MC.run(params, window.MC_HISTORY)); } catch (e) { reject(e); }
    }, 20));
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(go, 350);
    history.replaceState(null, "", location.pathname + location.search + toHash(state));
    store.set("mc-last", state);
  }
  async function go() {
    const id = ++runId;
    live.forEach(w => w.terminate()); live = [];
    const p = Object.assign({}, state);
    const kinds = MODEL_ORDER.filter(k => p[{ gbm: "useGbm", boot: "useBoot", t: "useT" }[k]]);
    if (!kinds.length) { setStatus("Pick at least one model under Market assumptions.", true); return; }
    if (p.retireAge < p.currentAge || p.endAge <= p.currentAge || p.retireAge > p.endAge) {
      setStatus("Ages must run current ≤ retirement ≤ plan-until (and current < plan-until).", true); return;
    }
    setStatus("Running " + kinds.length + " model" + (kinds.length > 1 ? "s" : "") + " × " + p.paths.toLocaleString() + " paths…", false, true);
    const t0 = performance.now();
    let parts;
    try {
      if (workersOk) {
        try { parts = await Promise.all(kinds.map(k => runInWorker(engineParams(p, k)))); }
        catch (e) { if (workersOk) throw e; parts = null; }   // workers unavailable (e.g. file:// policy): fall back
      }
      if (!parts) parts = [await runHere(engineParams(p))];
    } catch (e) {
      if (id === runId) setStatus("Error: " + e.message, true);
      return;
    }
    if (id !== runId) return;
    const out = Object.assign({}, parts[0], { models: parts.flatMap(r => r.models) });
    out.models.sort((a, b) => MODEL_ORDER.indexOf(a.key) - MODEL_ORDER.indexOf(b.key));
    out.state = p;
    const secs = (performance.now() - t0) / 1000;
    setStatus(`${out.models.length} model${out.models.length > 1 ? "s" : ""} × ${p.paths.toLocaleString()} paths in ${secs.toFixed(1)} s` +
      (workersOk ? "" : " (single thread)"));
    last = out;
    render(out);
  }
  function setStatus(text, err, busy) {
    const s = document.getElementById("status");
    s.classList.toggle("busy", !!busy);
    document.getElementById("status-text").innerHTML = err ? `<span class="err">${esc(text)}</span>` : esc(text);
  }

  // ---------- formatting ----------
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const money = v => {
    const a = Math.abs(v), s = v < 0 ? "−$" : "$";
    if (a < 0.5) return "$0";
    if (a >= 1e6) return s + (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + "M";
    if (a >= 1e3) return s + Math.round(a / 1e3) + "k";
    return s + Math.round(a);
  };
  const pct = v => (v * 100).toFixed(1) + "%";
  const alpha = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, "0");

  // ---------- derived numbers ----------
  function primary(out) { return out.models.find(m => m.key === "boot") || out.models[0]; }
  /** Highest spending (or % rate) with >= target success, interpolated on the sweep grid. */
  function safeLevel(m, mults, target) {
    const s = m.sweep;
    if (s[0] < target) return { mult: mults[0], below: true };
    for (let j = 0; j < s.length - 1; j++) {
      if (s[j] >= target && s[j + 1] < target) {
        return { mult: mults[j] + (s[j] - target) / (s[j] - s[j + 1]) * (mults[j + 1] - mults[j]) };
      }
    }
    return { mult: mults[mults.length - 1], above: true };
  }
  function fmtLevel(p, mult) {
    return p.strategy === "percent" ? (p.pctRate * mult).toFixed(2) + "%" : money(p.spending * mult);
  }
  function metrics(out) {
    const pm = primary(out), p = out.state;
    const sl = safeLevel(pm, out.sweep_mults, 0.9);
    return {
      success: Object.fromEntries(out.models.map(m => [m.key, m.success])),
      safe: p.strategy === "percent" ? p.pctRate * sl.mult : p.spending * sl.mult,
      safePct: p.strategy === "percent",
      atRetire: pm.median_at_retirement, end: pm.ending[50],
    };
  }

  // ---------- baseline ----------
  let baseline = store.get("mc-baseline"), last = null;
  document.getElementById("pin").onclick = () => {
    if (!last) return;
    baseline = { m: metrics(last), hash: toHash(last.state), when: new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) };
    store.set("mc-baseline", baseline);
    render(last);
  };
  document.getElementById("reset").onclick = () => { state = Object.assign({}, DEFAULTS); writeForm(); schedule(); };
  document.getElementById("copy").onclick = async e => {
    const b = e.target;
    try { await navigator.clipboard.writeText(location.href); b.textContent = "Copied"; }
    catch (err) { b.textContent = "Copy failed"; }
    setTimeout(() => (b.textContent = "Copy link"), 1500);
  };
  function deltaHtml(cur, base, kind) {
    if (base == null || !isFinite(base)) return "";
    const d = cur - base;
    if (kind === "pts") {
      const pts = d * 100;
      if (Math.abs(pts) < 0.05) return `<div class="delta flat">same as baseline</div>`;
      return `<div class="delta ${pts > 0 ? "up" : "down"}">${pts > 0 ? "▲" : "▼"} ${Math.abs(pts).toFixed(1)} pts vs. baseline</div>`;
    }
    if (Math.abs(d) < Math.max(1, Math.abs(base) * 0.001)) return `<div class="delta flat">same as baseline</div>`;
    const txt = kind === "rate" ? Math.abs(d).toFixed(2) + " pts" : money(Math.abs(d));
    return `<div class="delta ${d > 0 ? "up" : "down"}">${d > 0 ? "▲" : "▼"} ${txt} vs. baseline</div>`;
  }

  // ---------- rendering ----------
  const charts = {};
  function chart(id, cfg) {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(document.getElementById(id), cfg);
    return charts[id];
  }
  function render(out) {
    const p = out.state, h = out.history, pm = primary(out);
    const colorOf = k => css(MODEL_COLOR[k]);
    Chart.defaults.color = css("--muted");
    Chart.defaults.borderColor = css("--border");
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    const moneyAxis = { ticks: { callback: v => money(v) }, beginAtZero: true, grid: { color: css("--border") } };
    const ageAxis = { title: { display: true, text: "Age" }, ticks: { maxTicksLimit: 10 }, grid: { display: false } };
    const legend = { labels: { usePointStyle: true, pointStyle: "circle", boxWidth: 8, boxHeight: 8 } };

    // subtitle
    const stratName = { fixed: "fixed spending", percent: `${p.pctRate}% of portfolio`, guardrails: "guardrail spending" }[p.strategy];
    const extras = [];
    if (p.ssBenefit > 0) extras.push(`Social Security ${money(p.ssBenefit * out.ss_factor)}/yr from ${p.ssClaimAge}`);
    if (p.pension > 0) extras.push(`pension ${money(p.pension)}/yr`);
    if (p.crashPct > 0) extras.push(`${p.crashPct}% crash at retirement`);
    if (p.stockAdj || p.bondAdj) extras.push(`returns ${p.stockAdj >= 0 ? "+" : ""}${p.stockAdj}% stocks, ${p.bondAdj >= 0 ? "+" : ""}${p.bondAdj}% bonds`);
    document.getElementById("subtitle").textContent =
      `Age ${p.currentAge} → retire at ${p.retireAge} → last to ${p.endAge} · ${p.stocks}/${100 - p.stocks} stocks/bonds · ` +
      (p.strategy === "percent" ? stratName : `${money(p.spending)}/yr, ${stratName}`) + (extras.length ? " · " + extras.join(" · ") : "");

    // baseline banner
    const bb = document.getElementById("baseline-banner");
    if (baseline) {
      bb.classList.add("show");
      bb.innerHTML = `Comparing against the baseline you pinned at ${esc(baseline.when)}. ` +
        `<a href="${esc(baseline.hash || "#")}" id="bl-load">Load it</a> · <a href="#" id="bl-clear">Clear</a>`;
      document.getElementById("bl-clear").onclick = e => { e.preventDefault(); baseline = null; store.del("mc-baseline"); render(last); };
      document.getElementById("bl-load").onclick = e => {
        e.preventDefault(); state = Object.assign({}, DEFAULTS, parseHash(baseline.hash)); writeForm(); schedule();
      };
    } else bb.classList.remove("show");

    // tiles
    const m = metrics(out), b = baseline && baseline.m;
    const sl = safeLevel(pm, out.sweep_mults, 0.9);
    const tiles = out.models.map(md => [
      `<span class="dot" style="background:${colorOf(md.key)}"></span>${esc(md.name)}`, pct(md.success),
      p.strategy === "fixed" ? "chance the money lasts" : "lasts and stays above the floor",
      deltaHtml(md.success, b && b.success[md.key], "pts")]);
    tiles.push([p.strategy === "percent" ? "Safe withdrawal rate" : "Safe spending",
      (sl.below ? "< " : sl.above ? "> " : "") + fmtLevel(p, sl.mult),
      `highest ${p.strategy === "percent" ? "rate" : "spending"} with 90% success (${pm.key === "boot" ? "bootstrap" : esc(pm.name)})`,
      b && b.safePct === m.safePct ? deltaHtml(m.safe, b.safe, m.safePct ? "rate" : "money") : ""]);
    if (out.retire_year > 0) tiles.push(["Median at retirement", money(m.atRetire), "today's dollars", deltaHtml(m.atRetire, b && b.atRetire, "money")]);
    tiles.push(["Median at the end", money(m.end), `at age ${p.endAge}`, deltaHtml(m.end, b && b.end, "money")]);
    document.getElementById("tiles").innerHTML = tiles.map(([l, v, n, d]) =>
      `<div class="card tile"><div class="label">${l}</div><div class="value">${v}</div><div class="note">${n}</div>${d || ""}</div>`).join("");

    // fan charts with a shared y max
    const rawMax = Math.max(1, ...out.models.map(md => Math.max(...md.bands[95])));
    const step = rawMax > 5e6 ? 1e6 : rawMax > 1e6 ? 5e5 : 1e5;
    const yMax = Math.ceil(rawMax / step) * step;
    const fans = document.getElementById("fans");
    Object.keys(charts).filter(k => k.startsWith("fan")).forEach(k => { charts[k].destroy(); delete charts[k]; });
    fans.innerHTML = out.models.map((md, i) =>
      `<div class="card"><h2><span class="dot" style="background:${colorOf(md.key)}"></span>${esc(md.name)}</h2>` +
      `<div class="note">Shaded: 5th–95th and 25th–75th percentile wealth. Line: median. Red: a 1-in-100 bad path.</div>` +
      `<div class="chart"><canvas id="fan${i}"></canvas></div></div>`).join("");
    out.models.forEach((md, i) => {
      const c = colorOf(md.key);
      const line = (label, data, extra) => Object.assign({ label, data, pointRadius: 0, pointHitRadius: 6, borderWidth: 0, tension: .2 }, extra);
      chart("fan" + i, {
        type: "line",
        data: { labels: out.ages, datasets: [
          line("5th pct", md.bands[5]),
          line("95th pct", md.bands[95], { fill: "-1", backgroundColor: alpha(c, .14) }),
          line("25th pct", md.bands[25]),
          line("75th pct", md.bands[75], { fill: "-1", backgroundColor: alpha(c, .28) }),
          line("Median", md.bands[50], { borderColor: c, borderWidth: 2 }),
          line("1-in-100", md.worst, { borderColor: css("--bad"), borderWidth: 1.5 }),
        ]},
        options: { responsive: true, maintainAspectRatio: false, animation: false,
          interaction: { mode: "index", intersect: false },
          plugins: { legend: { display: false },
            tooltip: { itemSort: (a, b2) => b2.raw - a.raw, callbacks: { title: x => "Age " + x[0].label, label: x => `${x.dataset.label}: ${money(x.raw)}` } } },
          scales: { x: ageAxis, y: Object.assign({ max: yMax }, moneyAxis) } },
      });
    });

    // sweep
    const isP = p.strategy === "percent";
    document.getElementById("sweep-title").textContent = isP ? "Success rate vs. withdrawal rate" : "Success rate vs. spending";
    document.getElementById("sweep-note").textContent = (isP ? "Same random paths, different withdrawal rates." : "Same random paths, different spending levels.") +
      " The large dot is your plan." + (p.strategy !== "fixed" ? ` Success = never broke and never below ${p.floorPct}% of ${isP ? "first-year" : "planned"} spending.` : "");
    // zoom in when every model is near 100%, but never start the axis above 50%
    const lowest = Math.min(...out.models.flatMap(md => md.sweep));
    const sweepMin = Math.min(0.5, Math.max(0, Math.floor((lowest - 0.05) * 10) / 10));
    chart("sweep", {
      type: "line",
      data: { labels: out.sweep_mults.map(x => fmtLevel(p, x)), datasets: out.models.map(md => ({
        label: md.name, data: md.sweep, borderColor: colorOf(md.key), backgroundColor: colorOf(md.key),
        borderWidth: 2, tension: .2, pointRadius: out.sweep_mults.map(x => x === 1 ? 6 : 3), pointHoverRadius: 7,
        pointBorderColor: css("--card"), pointBorderWidth: 2 })) },
      options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
        plugins: { legend, tooltip: { callbacks: { label: x => `${x.dataset.label}: ${pct(x.raw)}` } } },
        scales: { x: { title: { display: true, text: isP ? "Withdrawal rate" : "Yearly spending" }, grid: { display: false } },
                  y: { min: sweepMin, max: 1, ticks: { callback: v => Math.round(v * 100) + "%" }, grid: { color: css("--border") } } } },
    });

    // failure ages
    chart("fail", {
      type: "bar",
      data: { labels: out.ages.slice(0, -1), datasets: out.models.map(md => ({
        label: md.name, data: md.failure_years, backgroundColor: colorOf(md.key),
        borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "bottom", categoryPercentage: 0.85, barPercentage: 0.9 })) },
      options: { responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend, tooltip: { callbacks: { title: x => "Age " + x[0].label, label: x => `${x.dataset.label}: ${pct(x.raw)}` } } },
        scales: { x: ageAxis, y: { beginAtZero: true, ticks: { callback: v => +(v * 100).toPrecision(2) + "%" }, grid: { color: css("--border") } } } },
    });

    // spending by age (primary model), retirement years only
    const ry = out.retire_year, nY = out.ages.length - 1;
    const retAges = out.ages.slice(ry, nY);
    const sb = q => pm.spend_bands[q].slice(ry, nY);
    const planned = out.income.planned.slice(ry, nY);
    const pc = colorOf(pm.key);
    document.getElementById("spend-note").textContent =
      `${pm.name}: median and 5th–95th percentile of what you actually spend each year` + (isP ? "." : ", against the plan (dashed).") +
      (p.strategy === "fixed" ? " With fixed spending, the band only drops when a path runs out of money." : "");
    const sline = (label, data, extra) => Object.assign({ label, data, pointRadius: 0, pointHitRadius: 6, borderWidth: 0, tension: .2 }, extra);
    chart("spend", {
      type: "line",
      data: { labels: retAges, datasets: [
        sline("5th pct", sb(5)),
        sline("95th pct", sb(95), { fill: "-1", backgroundColor: alpha(pc, .18) }),
        sline("Median", sb(50), { borderColor: pc, borderWidth: 2 }),
      ].concat(isP ? [] : [sline("Plan", planned, { borderColor: css("--muted"), borderWidth: 1.5, borderDash: [5, 4] })]) },
      options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: x => "Age " + x[0].label, label: x => `${x.dataset.label}: ${money(x.raw)}` } } },
        scales: { x: ageAxis, y: moneyAxis } },
    });

    // income stack at the median
    const inc = k => out.income[k].slice(ry, nY);
    const ss = inc("ss"), pen = inc("pension"), work = inc("work");
    const fromPort = sb(50).map((v, i) => Math.max(0, v - ss[i] - pen[i] - work[i]));
    const series = [["Social Security", ss, "--s1"], ["Pension", pen, "--s2"], ["Part-time work", work, "--s3"], ["From portfolio (median)", fromPort, "--s4"]]
      .filter(s => s[1].some(v => v > 0));
    document.getElementById("income-note").textContent =
      `Yearly income by source in today's dollars. The portfolio fills the gap up to median spending (${pm.name}).` +
      (p.ssBenefit > 0 && p.ssCutPct > 0 ? ` The Social Security step-down is the ${p.ssCutPct}% trust-fund cut in ${p.ssCutYear}.` : "");
    chart("income", {
      type: "bar",
      data: { labels: retAges, datasets: series.map(([label, data, c]) => ({
        label, data, backgroundColor: css(c), borderColor: css("--card"), borderWidth: { top: 1 }, borderSkipped: false,
        categoryPercentage: 0.9, barPercentage: 0.95 })) },
      options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
        plugins: { legend, tooltip: { callbacks: { title: x => "Age " + x[0].label, label: x => `${x.dataset.label}: ${money(x.raw)}` } } },
        scales: { x: Object.assign({ stacked: true }, ageAxis), y: Object.assign({ stacked: true }, moneyAxis) } },
    });

    // ending table
    const ps = Object.keys(pm.ending);
    document.getElementById("ending").innerHTML =
      `<tr><th>Percentile</th>${out.models.map(md => `<th><span class="dot" style="background:${colorOf(md.key)}"></span>${esc(md.name)}</th>`).join("")}</tr>` +
      ps.map(k => `<tr><td>${k}${k == 1 ? "st" : "th"}${k == 50 ? " (median)" : ""}</td>${out.models.map(md => `<td>${money(md.ending[k])}</td>`).join("")}</tr>`).join("") +
      `<tr><td>Success</td>${out.models.map(md => `<td>${pct(md.success)}</td>`).join("")}</tr>` +
      (p.strategy !== "fixed" ? `<tr><td>Never broke</td>${out.models.map(md => `<td>${pct(md.lasts)}</td>`).join("")}</tr>` +
        `<tr><td>Stays above floor</td>${out.models.map(md => `<td>${pct(md.above_floor)}</td>`).join("")}</tr>` : "");

    // about
    const ssLine = p.ssBenefit > 0
      ? `Claiming Social Security at ${p.ssClaimAge} with a full retirement age of ${p.ssFra} pays ${(out.ss_factor * 100).toFixed(1)}% of the full benefit ` +
        `(SSA rules: −5/9% a month for up to 36 months early, −5/12% a month beyond that, +8% a year for waiting until 70).` +
        (p.ssCutPct > 0 ? ` From ${p.ssCutYear} benefits are cut ${p.ssCutPct}%.` : "") +
        (p.ssColaGap > 0 ? ` Each year the benefit loses ${p.ssColaGap}% of its buying power.` : "")
      : "Add a Social Security benefit under Income to see how claiming age and program changes move the odds.";
    const strat = {
      fixed: "Fixed spending: the same inflation-adjusted amount every year, whatever the market does (the classic 4% rule).",
      percent: `Fixed percentage: each birthday you withdraw ${p.pctRate}% of what's left. You never fully run out, but spending swings with the market, so a path fails if a year's spending drops below ${p.floorPct}% of your first-year spending.`,
      guardrails: `Guardrails: you start at planned spending. Each year, if your withdrawal rate has drifted more than ${p.grBand}% above where it started, spending is cut ${p.grAdj}%. If it has drifted that far below, spending rises ${p.grAdj}%. Spending stays between ${p.grFloor}% and ${p.grCeil}% of plan.`,
    }[p.strategy];
    document.getElementById("about").innerHTML =
      `<p>All models use US real (inflation-adjusted) total returns from Robert Shiller's dataset, ${h.start} to ${h.end} ` +
      `(${h.months.toLocaleString()} months). Over that span stocks returned ${pct(h.ann_return.stocks)}/yr with ${pct(h.ann_vol.stocks)} volatility, ` +
      `and bonds ${pct(h.ann_return.bonds)}/yr with ${pct(h.ann_vol.bonds)}. Their correlation was ${h.corr.toFixed(2)}. Every dollar figure is in today's dollars.</p>` +
      `<p><b>GBM</b> draws each month's log-returns from a normal distribution with the historical mean and covariance: no fat tails, no memory. ` +
      `<b>Historical bootstrap</b> replays real stretches of history (blocks averaging ${p.block} months), so it keeps crashes, inflation spells and ` +
      `stock/bond co-movement. <b>Student-t</b> keeps GBM's mean and covariance but swaps the bell curve for fat tails (${p.tDf} degrees of freedom), so extreme months are far more common.</p>` +
      `<p>${esc(strat)} ${esc(ssLine)}</p>` +
      `<p>Each month the cashflow happens first, then the market moves. Savings and income go in, spending comes out. A path that can't cover a month is broke and stays at $0. ` +
      `The portfolio is rebalanced monthly, with no taxes or fees. Social Security and pensions are simplified (no spousal or survivor benefits, no earnings test). ` +
      `The past is one sample of what's possible, not a forecast. This is not financial advice. ` +
      `Source: <a href="https://github.com/CookaMan/monte-carlo-retirement">github.com/CookaMan/monte-carlo-retirement</a>.</p>`;
  }

  // re-render on OS theme change (chart colors come from CSS tokens)
  if (window.matchMedia) {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    (mq.addEventListener ? mq.addEventListener.bind(mq, "change") : mq.addListener.bind(mq))(() => last && render(last));
  }
  window.addEventListener("hashchange", () => {
    const h = toHash(state);
    if (location.hash === h || (location.hash === "#" && h === "")) return;
    state = Object.assign({}, DEFAULTS, parseHash(location.hash)); writeForm(); schedule();
  });

  writeForm();
  go();
  window.MCApp = { get state() { return state; }, get last() { return last; }, go, setState(o) { Object.assign(state, o); writeForm(); return go(); } };
})();
