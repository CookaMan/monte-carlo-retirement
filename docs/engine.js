/* Monte Carlo retirement engine, the in-browser counterpart of models.py + stats.py.
 *
 * Everything lives inside mcEngine() so the page can also start it in a Web
 * Worker from mcEngine.toString() (that works even when index.html is opened
 * from disk). Pure computation: no DOM. All money is in today's dollars,
 * because the returns are real (inflation-adjusted).
 */
function mcEngine(root) {
  "use strict";

  const PCTS = [5, 25, 50, 75, 95];
  const END_PCTS = [1, 5, 10, 25, 50, 75, 90, 95, 99];
  const SWEEP = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5];
  const MODELS = {
    gbm: "GBM (normal returns)",
    boot: "Historical bootstrap",
    t: "Student-t (fat tails)",
  };

  const DEFAULTS = {
    // plan (matches config.toml)
    currentAge: 35, retireAge: 65, endAge: 95,
    balance: 100000, contribution: 15000, contribGrowth: 0, stocks: 60,
    // spending & strategy
    spending: 60000, phaseOn: false, phaseAge: 80, phasePct: -20,
    oneTime: [{ age: 0, amount: 0 }, { age: 0, amount: 0 }, { age: 0, amount: 0 }],
    strategy: "fixed", pctRate: 4, grBand: 20, grAdj: 10, grFloor: 80, grCeil: 130,
    floorPct: 75,
    // income
    ssBenefit: 0, ssClaimAge: 67, ssFra: 67, ssCutPct: 23, ssCutYear: 2033, ssColaGap: 0,
    pension: 0, pensionAge: 65, pensionCola: true, pensionInfl: 2.5,
    workIncome: 0, workUntil: 70,
    // market
    useGbm: true, useBoot: true, useT: false, tDf: 4,
    stockAdj: 0, bondAdj: 0, volMult: 1, crashPct: 0, badPct: 0, badYears: 10,
    // simulation
    histStart: 1871, block: 12, paths: 10000, seed: 42,
    currentYear: 0,   // 0 = this year
  };

  // ---------- random numbers ----------
  // sfc32, seeded through splitmix32 from (seed, model, path), so any single
  // path can be re-created exactly. That gives common random numbers across
  // the withdrawal sweep without storing every path's returns.
  function splitmix32(a) {
    return function () {
      a = (a + 0x9e3779b9) | 0;
      let z = a;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) >>> 0;
    };
  }
  function makeRng(seed, model, path) {
    const sm = splitmix32((seed * 0x27d4eb2d) ^ (model * 0x165667b1) ^ path);
    let a = sm(), b = sm(), c = sm(), d = sm();
    const next = function () {
      a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
      const t = (a + b) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      d = (d + 1) | 0;
      const r = (t + d) | 0;
      c = (c + r) | 0;
      return (r >>> 0) / 4294967296;   // [0, 1)
    };
    for (let i = 0; i < 12; i++) next();
    return next;
  }
  // Box-Muller: fills two standard normals into out[0], out[1]
  function normals2(rng, out) {
    const u = 1 - rng(), v = rng();
    const r = Math.sqrt(-2 * Math.log(u)), th = 2 * Math.PI * v;
    out[0] = r * Math.cos(th);
    out[1] = r * Math.sin(th);
  }
  const _nz = [0, 0];
  function normal(rng) { normals2(rng, _nz); return _nz[0]; }
  // Marsaglia-Tsang gamma(k, 1)
  function gamma(rng, k) {
    if (k < 1) return gamma(rng, k + 1) * Math.pow(1 - rng(), 1 / k);
    const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x, v;
      do { x = normal(rng); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      const u = 1 - rng();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  // ---------- history ----------
  function prepHistory(H, startYear) {
    const y0 = parseInt(H.start.slice(0, 4), 10), m0 = parseInt(H.start.slice(5, 7), 10);
    const off = Math.max(0, (startYear - y0) * 12 - (m0 - 1));
    const s = H.stocks.slice(off), b = H.bonds.slice(off);
    const T = s.length;
    if (T < 120) throw new Error("only " + T + " months of history after " + startYear);
    const ls = new Float64Array(T), lb = new Float64Array(T);
    for (let i = 0; i < T; i++) { ls[i] = Math.log1p(s[i]); lb[i] = Math.log1p(b[i]); }
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    const ms = mean(ls), mb = mean(lb);
    let css = 0, cbb = 0, csb = 0;
    for (let i = 0; i < T; i++) {
      const ds = ls[i] - ms, db = lb[i] - mb;
      css += ds * ds; cbb += db * db; csb += ds * db;
    }
    css /= T - 1; cbb /= T - 1; csb /= T - 1;    // ddof=1, like np.cov
    let gs = 1, gb = 1;
    for (let i = 0; i < T; i++) { gs *= 1 + s[i]; gb *= 1 + b[i]; }
    const sd = x => Math.sqrt(x * 12);
    const startIdx = off;
    const ym = i => { const k = m0 - 1 + i; return (y0 + Math.floor(k / 12)) + "-" + String(k % 12 + 1).padStart(2, "0"); };
    return {
      T, ls, lb, mu: [ms, mb], cov: [[css, csb], [csb, cbb]],
      summary: {
        start: ym(startIdx), end: ym(startIdx + T - 1), months: T,
        ann_return: { stocks: Math.pow(gs, 12 / T) - 1, bonds: Math.pow(gb, 12 / T) - 1 },
        ann_vol: { stocks: sd(css), bonds: sd(cbb) },
        corr: csb / Math.sqrt(css * cbb),
      },
    };
  }

  // ---------- Social Security ----------
  /** Benefit multiple for claiming at `claimAge` given full retirement age `fra`:
   *  -5/9% per month for the first 36 months early, -5/12% per month beyond,
   *  +2/3% per month (8%/yr) of delayed credits, which stop at 70. */
  function ssFactor(claimAge, fra) {
    const months = Math.round((claimAge - fra) * 12);
    if (months < 0) {
      const m = -months;
      return 1 - Math.min(m, 36) * 5 / 900 - Math.max(m - 36, 0) * 5 / 1200;
    }
    return 1 + Math.min(months, Math.max(0, Math.round((70 - fra) * 12))) * 2 / 300;
  }

  // ---------- deterministic monthly schedules ----------
  function schedules(p) {
    const n = Math.round((p.endAge - p.currentAge) * 12);
    const nWork = Math.min(n, Math.round(Math.max(p.retireAge - p.currentAge, 0) * 12));
    const year0 = p.currentYear || new Date().getFullYear();
    const contrib = new Float64Array(n), ss = new Float64Array(n), pen = new Float64Array(n),
          work = new Float64Array(n), planned = new Float64Array(n), oneTime = new Float64Array(n);
    const claim = Math.min(70, Math.max(62, p.ssClaimAge));
    const ssBase = p.ssBenefit * ssFactor(claim, p.ssFra);
    for (let t = 0; t < n; t++) {
      const age = p.currentAge + t / 12, y = Math.floor(t / 12);
      if (t < nWork) contrib[t] = p.contribution * Math.pow(1 + p.contribGrowth / 100, y) / 12;
      if (ssBase > 0 && age >= claim - 1e-9) {
        const yrs = Math.floor(age - claim + 1e-9);
        let v = ssBase * Math.pow(1 - p.ssColaGap / 100, yrs);
        if (year0 + y >= p.ssCutYear) v *= 1 - p.ssCutPct / 100;
        ss[t] = v / 12;
      }
      if (p.pension > 0 && age >= p.pensionAge - 1e-9) {
        const yrs = Math.floor(age - p.pensionAge + 1e-9);
        pen[t] = p.pension * (p.pensionCola ? 1 : Math.pow(1 - p.pensionInfl / 100, yrs)) / 12;
      }
      if (t >= nWork) {
        if (p.workIncome > 0 && age < p.workUntil - 1e-9) work[t] = p.workIncome / 12;
        const phase = p.phaseOn && age >= p.phaseAge - 1e-9 ? 1 + p.phasePct / 100 : 1;
        planned[t] = p.spending * phase / 12;
      }
    }
    for (const o of p.oneTime || []) {
      if (!o || !o.amount) continue;
      const t = Math.round((o.age - p.currentAge) * 12);
      if (t >= 0 && t < n) oneTime[t] += o.amount;
    }
    const income = new Float64Array(n);
    const base = new Float64Array(n);   // every cashflow except planned spending
    for (let t = 0; t < n; t++) { income[t] = ss[t] + pen[t] + work[t]; base[t] = contrib[t] + income[t] + oneTime[t]; }
    return { n, nWork, nYears: Math.floor(n / 12), contrib, ss, pen, work, income, planned, oneTime, base };
  }

  // ---------- return generation ----------
  /** Fill out[t] with portfolio simple returns for one path. kind: "gbm" | "boot" | "t". */
  function makeGenerator(kind, H, p, S) {
    const w = p.stocks / 100, n = S.n;
    const [ms, mb] = H.mu, c = H.cov;
    const L11 = Math.sqrt(Math.max(c[0][0], 0));
    const L21 = L11 > 0 ? c[1][0] / L11 : 0;
    const L22 = Math.sqrt(Math.max(c[1][1] - L21 * L21, 0));
    const k = p.volMult;
    // per-month additive log adjustments (return haircut, bad decade, crash)
    // stockAdj/bondAdj are %/yr added to returns (negative = below history)
    const adjS = new Float64Array(n).fill(p.stockAdj / 100 / 12);
    const adjB = new Float64Array(n).fill(p.bondAdj / 100 / 12);
    if (p.badPct && p.badYears > 0) {
      const e = Math.min(n, S.nWork + Math.round(p.badYears * 12));
      for (let t = S.nWork; t < e; t++) { adjS[t] -= p.badPct / 100 / 12; adjB[t] -= p.badPct / 100 / 12; }
    }
    if (p.crashPct > 0 && S.nWork < n) adjS[S.nWork] += Math.log(Math.max(1e-6, 1 - p.crashPct / 100));
    const z = [0, 0], df = Math.max(2.1, p.tDf), tScale = Math.sqrt(df - 2);
    // chi2 with even integer df is -2 log(product of df/2 uniforms): much cheaper than gamma
    const half = df / 2, evenInt = Number.isInteger(half) && half <= 30;
    const chi2 = evenInt
      ? rng => { let u = 1; for (let i = 0; i < half; i++) u *= 1 - rng(); return -2 * Math.log(u); }
      : rng => 2 * gamma(rng, half);
    const flatS = p.stockAdj / 100 / 12, flatB = p.bondAdj / 100 / 12;
    const port = (lrs, lrb, t) => {   // t = -1: flat adjustment only
      lrs = ms + k * (lrs - ms) + (t < 0 ? flatS : adjS[t]);
      lrb = mb + k * (lrb - mb) + (t < 0 ? flatB : adjB[t]);
      return w * Math.expm1(lrs) + (1 - w) * Math.expm1(lrb);
    };
    if (kind === "boot") {
      const pj = 1 / Math.max(p.block, 1), T = H.T, ls = H.ls, lb = H.lb;
      // Most months only get the flat haircut, so precompute each historical
      // month's portfolio return once; shocked months are done individually.
      const base = new Float64Array(T);
      for (let i = 0; i < T; i++) base[i] = port(ls[i], lb[i], -1);
      const special = new Uint8Array(n);
      for (let t = 0; t < n; t++) special[t] = adjS[t] !== flatS || adjB[t] !== flatB ? 1 : 0;
      return function (rng, out) {
        let i = Math.floor(rng() * T);
        for (let t = 0; t < n; t++) {
          if (t > 0) i = rng() < pj ? Math.floor(rng() * T) : (i + 1) % T;
          out[t] = special[t] ? port(ls[i], lb[i], t) : base[i];
        }
      };
    }
    return function (rng, out) {
      for (let t = 0; t < n; t++) {
        normals2(rng, z);
        let s = 1;
        if (kind === "t") s = tScale / Math.sqrt(chi2(rng));   // sqrt((v-2)/W), W~chi2(v)
        const z1 = z[0] * s, z2 = z[1] * s;
        out[t] = port(ms + L11 * z1, mb + L21 * z1 + L22 * z2, t);
      }
    };
  }

  // ---------- one path through the plan ----------
  /** Run one path. mult scales spending (or the % rate). Spending is checked
   *  against floorPct of plan (or, for the % strategy, of first-year spending).
   *  If rec is given, the
   *  path's yearly wealth/spending is written into it. Returns
   *  {fail: month index of ruin or -1, below: spending ever fell below the floor}. */
  function runPath(ret, S, p, mult, rec) {
    const n = S.n, nWork = S.nWork, strat = p.strategy;
    const floor = p.floorPct / 100;
    const grLo = p.grFloor / 100, grHi = p.grCeil / 100;
    const band = p.grBand / 100, adj = p.grAdj / 100, rate = p.pctRate / 100 * mult;
    let w = p.balance, fail = -1, below = false, m = 1, wr0 = 0, pctWd = 0, ref = 0;
    let spendY = 0, planY = 0;
    for (let t = 0; t < n; t++) {
      if (rec && t % 12 === 0) rec.wealth[t / 12] = w;
      if (rec && t === nWork) rec.atRetire = w;
      let cf, spend = 0;
      const inc = S.income[t];
      if (t < nWork) {
        cf = S.contrib[t] + inc;
      } else {
        const plan = S.planned[t] * mult;
        const yearStart = (t - nWork) % 12 === 0;
        if (strat === "percent") {
          if (yearStart) pctWd = fail < 0 ? rate * Math.max(w, 0) / 12 : 0;
          spend = pctWd + inc;
          cf = -pctWd;
          // the floor for a %-of-portfolio plan is relative to first-year spending
          if (t === nWork) ref = spend;
        } else {
          if (strat === "guardrails" && yearStart && fail < 0 && w > 0) {
            const need = (plan * m - inc) * 12;
            if (t === nWork) { wr0 = (plan - inc) * 12 / w; }
            else if (wr0 > 0) {
              const wr = need / w;
              if (wr > wr0 * (1 + band)) m *= 1 - adj;
              else if (wr < wr0 * (1 - band)) m *= 1 + adj;
              m = Math.min(grHi, Math.max(grLo, m));
            }
          }
          spend = strat === "guardrails" ? plan * m : plan;
          cf = inc - spend;
        }
        planY += strat === "percent" ? ref : plan;
      }
      cf += S.oneTime[t];
      if (fail < 0) {
        w += cf;
        if (w < 0) { fail = t; w = 0; }
      }
      if (fail >= 0) {
        w = 0;
        if (t >= nWork) spend = inc;    // broke: only income is left to spend
      } else {
        w *= 1 + ret[t];
      }
      if (t >= nWork) spendY += spend;
      if (t % 12 === 11 || t === n - 1) {
        if (planY > 0 && spendY < floor * planY - 1e-6) below = true;
        if (rec) rec.spend[Math.floor(t / 12)] = spendY;
        spendY = 0; planY = 0;
      }
    }
    if (rec) rec.wealth[n / 12 | 0] = w, rec.end = w;
    return { fail, below };
  }

  /** Fast path for the fixed-dollar strategy when only ruin matters (the
   *  sweep): with fixed spending, spending only drops below the floor after
   *  ruin, so success == never ruined. Same arithmetic as runPath. */
  function ruinMonthFixed(ret, S, p, mult) {
    const n = S.n, base = S.base, planned = S.planned;
    let w = p.balance;
    for (let t = 0; t < n; t++) {
      w += base[t] - mult * planned[t];
      if (w < 0) return t;
      w *= 1 + ret[t];
    }
    return -1;
  }

  // ---------- statistics ----------
  function pctSorted(a, q) {          // linear interpolation, like np.percentile
    const x = q / 100 * (a.length - 1), i = Math.floor(x), f = x - i;
    return i + 1 < a.length ? a[i] + f * (a[i + 1] - a[i]) : a[i];
  }
  function columnBands(mat, rows, cols, pcts) {
    const out = {}; pcts.forEach(q => (out[q] = new Array(cols)));
    const col = new Float64Array(rows);
    for (let j = 0; j < cols; j++) {
      for (let i = 0; i < rows; i++) col[i] = mat[i * cols + j];
      col.sort();
      pcts.forEach(q => (out[q][j] = Math.round(pctSorted(col, q))));
    }
    return out;
  }

  // ---------- full run ----------
  function run(params, history, onProgress) {
    const p = Object.assign({}, DEFAULTS, params);
    if (!(p.currentAge < p.endAge)) throw new Error("current age must be below the end age");
    if (p.retireAge > p.endAge) throw new Error("retirement age must be at or below the end age");
    const t0 = Date.now();
    const H = prepHistory(history, p.histStart);
    const S = schedules(p);
    const nY = S.nYears, n = S.n, P = Math.max(1, Math.round(p.paths));
    const kinds = [];
    if (p.useGbm) kinds.push("gbm");
    if (p.useBoot) kinds.push("boot");
    if (p.useT) kinds.push("t");
    const ret = new Float64Array(n);
    const fixed = p.strategy === "fixed";
    const results = [];
    kinds.forEach((kind, mi) => {
      const gen = makeGenerator(kind, H, p, S);
      const wealth = new Float64Array(P * (nY + 1)), spend = new Float64Array(P * Math.max(nY, 1));
      const fails = new Int32Array(P), ends = new Float64Array(P), atRet = new Float64Array(P);
      const sweepOk = new Int32Array(SWEEP.length);
      let ok = 0, lasts = 0, above = 0;
      const rec = { wealth: new Float64Array(nY + 1), spend: new Float64Array(Math.max(nY, 1)), atRetire: 0, end: 0 };
      const modelId = ["gbm", "boot", "t"].indexOf(kind) + 1;
      for (let i = 0; i < P; i++) {
        gen(makeRng(p.seed, modelId, i), ret);
        rec.spend.fill(0);
        const r = runPath(ret, S, p, 1, rec);
        fails[i] = r.fail; ends[i] = rec.end; atRet[i] = S.nWork < n ? rec.atRetire : rec.end;
        wealth.set(rec.wealth, i * (nY + 1));
        spend.set(rec.spend.subarray(0, Math.max(nY, 1)), i * Math.max(nY, 1));
        if (r.fail < 0) lasts++;
        if (!r.below) above++;
        if (r.fail < 0 && !r.below) ok++;
        for (let j = 0; j < SWEEP.length; j++) {
          if (SWEEP[j] === 1) { if (r.fail < 0 && !r.below) sweepOk[j]++; continue; }
          if (fixed) { if (ruinMonthFixed(ret, S, p, SWEEP[j]) < 0) sweepOk[j]++; continue; }
          const s = runPath(ret, S, p, SWEEP[j], null);
          if (s.fail < 0 && !s.below) sweepOk[j]++;
        }
        if (onProgress && (i & 1023) === 1023) onProgress((mi + (i + 1) / P) / kinds.length);
      }
      // failure ages
      const fy = new Array(nY).fill(0);
      for (let i = 0; i < P; i++) if (fails[i] >= 0) { const y = Math.floor(fails[i] / 12); if (y < nY) fy[y]++; }
      // ending percentiles
      const endSorted = Float64Array.from(ends).sort();
      const ending = {}; END_PCTS.forEach(q => (ending[q] = pctSorted(endSorted, q)));
      // 1-in-100 path: rank by survival month, then ending wealth (like stats.worst_path)
      const order = Array.from({ length: P }, (_, i) => i).sort((a, b) => {
        const sa = fails[a] < 0 ? n : fails[a], sb = fails[b] < 0 ? n : fails[b];
        return sa - sb || ends[a] - ends[b];
      });
      const wi = order[Math.floor(0.01 * (P - 1))];
      const worst = Array.from(wealth.subarray(wi * (nY + 1), (wi + 1) * (nY + 1)), Math.round);
      const sortedAt = Float64Array.from(atRet).sort();
      results.push({
        key: kind,
        name: MODELS[kind],
        success: ok / P,
        lasts: lasts / P,
        above_floor: above / P,
        bands: columnBands(wealth, P, nY + 1, PCTS),
        spend_bands: columnBands(spend, P, Math.max(nY, 1), PCTS),
        failure_years: fy.map(c => c / P),
        ending,
        worst,
        median_at_retirement: pctSorted(sortedAt, 50),
        sweep: Array.from(sweepOk, c => c / P),
      });
    });
    const yearSum = a => { const o = new Array(nY).fill(0); for (let t = 0; t < nY * 12; t++) o[Math.floor(t / 12)] += a[t]; return o.map(Math.round); };
    return {
      params: p,
      ages: Array.from({ length: nY + 1 }, (_, y) => p.currentAge + y),
      retire_year: Math.floor(S.nWork / 12),
      sweep_mults: SWEEP,
      income: { ss: yearSum(S.ss), pension: yearSum(S.pen), work: yearSum(S.work), planned: yearSum(S.planned) },
      ss_factor: ssFactor(Math.min(70, Math.max(62, p.ssClaimAge)), p.ssFra),
      history: H.summary,
      models: results,
      ms: Date.now() - t0,
    };
  }

  root.MC = {
    DEFAULTS, MODELS, SWEEP, run, ssFactor, schedules, runPath, prepHistory, makeGenerator,
    makeRng, gamma, normal, pctSorted, ruinMonthFixed,
  };
}
mcEngine(typeof self !== "undefined" ? self : this);
