"""Checks that the in-browser engine (docs/engine.js) agrees with the Python one.

Runs the JavaScript under JavaScriptCore's `jsc` shell, which ships with macOS.
Skipped where it isn't available.
"""
import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

import models

ROOT = Path(__file__).resolve().parent.parent
JSC = shutil.which("jsc") or "/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc"
pytestmark = pytest.mark.skipif(not Path(JSC).exists(), reason="JavaScriptCore (jsc) not available")


def js(code: str, tmp_path: Path):
    """Run `code` with engine.js (and the real history) loaded; it must print() one JSON value."""
    script = tmp_path / "t.js"
    script.write_text(
        "var window = this;\n"
        f"load({json.dumps(str(ROOT / 'docs' / 'history.js'))});\n"
        f"load({json.dumps(str(ROOT / 'docs' / 'engine.js'))});\n" + code)
    out = subprocess.run([JSC, str(script)], capture_output=True, text=True, timeout=120)
    assert out.returncode == 0 and "Exception" not in out.stdout + out.stderr, out.stdout + out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


def test_social_security_claim_factors(tmp_path):
    f = js("print(JSON.stringify([62, 64, 65, 67, 68, 70, 72].map(a => MC.ssFactor(a, 67)).concat([MC.ssFactor(67, 69)])))",
           tmp_path)
    assert f[:7] == pytest.approx([0.70, 0.80, 0.8667, 1.0, 1.08, 1.24, 1.24], abs=1e-4)
    assert f[7] == pytest.approx(1 - 24 * 5 / 900)          # FRA raised to 69, claim at 67


def test_zero_volatility_compounds_like_python(tmp_path):
    n = 24
    wealth = js(f"""
      const H = {{ T: 1, ls: [0], lb: [0], mu: [Math.log(1.005), Math.log(1.005)], cov: [[0, 0], [0, 0]] }};
      const p = Object.assign({{}}, MC.DEFAULTS, {{ currentAge: 60, retireAge: 62, endAge: 62,
        balance: 1000, contribution: 0, spending: 0 }});
      const S = MC.schedules(p), ret = new Float64Array(S.n);
      MC.makeGenerator("gbm", H, p, S)(MC.makeRng(1, 1, 0), ret);
      const rec = {{ wealth: new Float64Array(S.nYears + 1), spend: new Float64Array(S.nYears) }};
      MC.runPath(ret, S, p, 1, rec);
      print(JSON.stringify(rec.end));""", tmp_path)
    r = np.full((1, n, 1), 0.005)
    py, _ = models.simulate_wealth(r, [1.0], 1000.0, np.zeros(n))
    assert wealth == pytest.approx(py[0, -1], rel=1e-12)


def test_fixed_plan_matches_python_cashflows_and_ruin(tmp_path):
    rng = np.random.default_rng(3)
    ret = rng.normal(0.003, 0.04, (1, 60))
    out = js(f"""
      const p = Object.assign({{}}, MC.DEFAULTS, {{ currentAge: 60, retireAge: 62, endAge: 65,
        balance: 50000, contribution: 12000, spending: 40000 }});
      const S = MC.schedules(p), ret = Float64Array.from({json.dumps(ret[0].tolist())});
      const rec = {{ wealth: new Float64Array(S.nYears + 1), spend: new Float64Array(S.nYears) }};
      const r = MC.runPath(ret, S, p, 1, rec);
      print(JSON.stringify({{ cf: Array.from(S.base, (b, t) => b - S.planned[t]), fail: r.fail,
        fast: MC.ruinMonthFixed(ret, S, p, 1), wealth: Array.from(rec.wealth) }}));""", tmp_path)
    cf = models.cashflow_schedule(60, 62, 65, 12_000, 40_000)
    wealth, fail = models.simulate_wealth(ret[:, :, None], [1.0], 50_000.0, cf)
    assert np.allclose(out["cf"], cf)
    assert out["fail"] == fail[0] == out["fast"]
    assert fail[0] >= 0, "test plan should run out of money"
    assert np.allclose(out["wealth"], wealth[0, ::12])


def test_bootstrap_replays_history_in_blocks(tmp_path):
    out = js("""
      const hist = { start: "1871-01", stocks: Array.from({ length: 1000 }, (_, i) => i / 1e5),
                     bonds: new Array(1000).fill(0) };
      const H = MC.prepHistory(hist, 1871);
      const p = Object.assign({}, MC.DEFAULTS, { currentAge: 40, retireAge: 90, endAge: 90,
        stocks: 100, block: 12, contribution: 0 });
      const S = MC.schedules(p), ret = new Float64Array(S.n), gen = MC.makeGenerator("boot", H, p, S);
      let cont = 0, steps = 0, bad = 0;
      for (let i = 0; i < 300; i++) {
        gen(MC.makeRng(7, 2, i), ret);
        for (let t = 0; t < S.n; t++) {
          const k = Math.round(ret[t] * 1e5);
          if (Math.abs(ret[t] - k / 1e5) > 1e-9 || k < 0 || k >= 1000) bad++;
          if (t > 0) { steps++; if (k === Math.round(ret[t - 1] * 1e5) + 1) cont++; }
        }
      }
      print(JSON.stringify({ bad, cont: cont / steps }));""", tmp_path)
    assert out["bad"] == 0                                  # only historical months appear
    assert out["cont"] == pytest.approx(1 - 1 / 12, abs=0.01)


def test_same_seed_same_results(tmp_path):
    out = js("""
      const p = { paths: 300, useT: true };
      const a = JSON.stringify(MC.run(p, window.MC_HISTORY).models);
      const b = JSON.stringify(MC.run(p, window.MC_HISTORY).models);
      const c = JSON.stringify(MC.run(Object.assign({ seed: 7 }, p), window.MC_HISTORY).models);
      print(JSON.stringify([a === b, a === c]));""", tmp_path)
    assert out == [True, False]


def test_guardrails_keep_spending_between_floor_and_ceiling(tmp_path):
    out = js("""
      const r = MC.run({ paths: 500, currentAge: 65, retireAge: 65, endAge: 95, balance: 3e6,
        contribution: 0, spending: 60000, strategy: "guardrails", grFloor: 80, grCeil: 130,
        useBoot: true, useGbm: false }, window.MC_HISTORY);
      const m = r.models[0];
      print(JSON.stringify({ lasts: m.lasts, lo: Math.min(...m.spend_bands[5]), hi: Math.max(...m.spend_bands[95]) }));""",
             tmp_path)
    assert out["lasts"] == 1.0
    assert 0.8 * 60_000 - 1 <= out["lo"] and out["hi"] <= 1.3 * 60_000 + 1
    assert out["hi"] > 60_000                               # a big cushion should trigger raises


def test_social_security_cut_and_claiming(tmp_path):
    out = js("""
      const S = MC.schedules(Object.assign({}, MC.DEFAULTS, { currentAge: 60, retireAge: 62, endAge: 80,
        ssBenefit: 24000, ssClaimAge: 62, ssFra: 67, ssCutPct: 25, ssCutYear: 2030, currentYear: 2026 }));
      print(JSON.stringify({ before: S.ss[0], at62: S.ss[24], after: S.ss[48] }));""", tmp_path)
    assert out["before"] == 0
    assert out["at62"] == pytest.approx(24000 * 0.70 / 12)   # 2028: claimed early, no cut yet
    assert out["after"] == pytest.approx(24000 * 0.70 * 0.75 / 12)   # 2030 onwards: 25% cut


def test_success_rates_agree_with_python_engine(tmp_path):
    """Different random numbers, same models: default plan within ~1.5 pts."""
    import simulate
    cfg = simulate.load_config(ROOT / "config.toml")
    py = {m["name"]: m["success"] for m in simulate.run(cfg)["models"]}
    out = js("""
      const r = MC.run({}, window.MC_HISTORY);
      print(JSON.stringify(Object.fromEntries(r.models.map(m => [m.name, m.success]))));""", tmp_path)
    for name, s in py.items():
        assert out[name] == pytest.approx(s, abs=0.015), name
