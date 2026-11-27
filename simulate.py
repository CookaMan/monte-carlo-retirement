"""Monte Carlo retirement simulator: textbook GBM vs. historical bootstrap.

    python simulate.py                     run the plan in config.toml
    python simulate.py --paths 2000        quicker run
    python simulate.py --withdrawal 50000  try a different spending level
    python simulate.py --no-open           don't open the report in a browser

In PyCharm, open this folder and press the green Run button ("Simulate").
"""
from __future__ import annotations

import argparse
import datetime as dt
import time
import tomllib
import webbrowser
from pathlib import Path

import numpy as np

import data
import models
import report
import stats

ROOT = Path(__file__).parent
SWEEP = np.linspace(0.5, 1.5, 11)   # withdrawal levels as multiples of the plan's


def load_config(path: Path) -> dict:
    with open(path, "rb") as f:
        cfg = tomllib.load(f)
    w = cfg["portfolio"]
    if abs(w["stocks"] + w["bonds"] - 1) > 1e-9:
        raise ValueError("portfolio.stocks + portfolio.bonds must equal 1")
    p = cfg["plan"]
    if not p["current_age"] < p["end_age"] or p["retirement_age"] > p["end_age"]:
        raise ValueError("ages must satisfy current_age < end_age and retirement_age <= end_age")
    return cfg


def summarize(name: str, wealth: np.ndarray, fail: np.ndarray, n_years: int) -> dict:
    return {
        "name": name,
        "success": stats.success_rate(fail),
        "bands": stats.yearly_bands(wealth),
        "failure_years": stats.failure_years(fail, n_years),
        "ending": stats.ending_percentiles(wealth),
        "worst": stats.worst_path(wealth, fail),
        "median_drawdown": float(np.median(stats.max_drawdown(wealth))),
    }


def run(cfg: dict) -> dict:
    plan, port, sim = cfg["plan"], cfg["portfolio"], cfg["simulation"]
    hist = data.load_returns(sim["history_start_year"])
    log_hist = np.log1p(hist.to_numpy())
    weights = np.array([port["stocks"], port["bonds"]])

    cashflows = models.cashflow_schedule(plan["current_age"], plan["retirement_age"],
                                         plan["end_age"], plan["annual_contribution"],
                                         plan["annual_withdrawal"])
    n_months = cashflows.size
    n_years = n_months // 12
    rng = np.random.default_rng(sim["seed"])

    returns = {
        "GBM (normal returns)": models.gbm_returns(
            log_hist.mean(axis=0), np.cov(log_hist, rowvar=False),
            sim["paths"], n_months, rng),
        "Historical bootstrap": models.bootstrap_returns(
            hist.to_numpy(), sim["paths"], n_months, sim["bootstrap_block_months"], rng),
    }

    results = []
    for name, r in returns.items():
        wealth, fail = models.simulate_wealth(r, weights, plan["starting_balance"], cashflows)
        res = summarize(name, wealth, fail, n_years)
        # Withdrawal sweep on the same random returns (common random numbers),
        # so differences between levels come from spending, not luck.
        res["sweep"] = []
        for m in SWEEP:
            cf = models.cashflow_schedule(plan["current_age"], plan["retirement_age"],
                                          plan["end_age"], plan["annual_contribution"],
                                          plan["annual_withdrawal"] * m)
            _, f = models.simulate_wealth(r, weights, plan["starting_balance"], cf)
            res["sweep"].append(stats.success_rate(f))
        retire_idx = int(round((plan["retirement_age"] - plan["current_age"]) * 12))
        res["median_at_retirement"] = float(np.median(wealth[:, retire_idx]))
        results.append(res)

    ann_ret = ((1 + hist).prod() ** (12 / len(hist)) - 1).to_dict()
    ann_vol = (np.log1p(hist).std() * np.sqrt(12)).to_dict()
    return {
        "config": cfg,
        "ages": [plan["current_age"] + y for y in range(n_years + 1)],
        "sweep_withdrawals": (SWEEP * plan["annual_withdrawal"]).round(0).tolist(),
        "history": {"start": f"{hist.index[0]:%Y-%m}", "end": f"{hist.index[-1]:%Y-%m}",
                    "months": len(hist), "ann_return": ann_ret, "ann_vol": ann_vol,
                    "corr": float(hist.corr().iloc[0, 1])},
        "models": results,
        "generated": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
    }


def print_summary(out: dict) -> None:
    p = out["config"]["plan"]
    h = out["history"]
    print(f"\nPlan: age {p['current_age']} -> retire {p['retirement_age']} -> last to "
          f"{p['end_age']}, withdraw ${p['annual_withdrawal']:,.0f}/yr")
    print(f"History: {h['start']} to {h['end']} ({h['months']} months)\n")
    print(f"{'Model':<24}{'Success':>9}{'Median @ retire':>18}{'Median end':>14}{'5th pct end':>14}")
    for m in out["models"]:
        print(f"{m['name']:<24}{m['success']:>9.1%}{m['median_at_retirement']:>18,.0f}"
              f"{m['ending'][50]:>14,.0f}{m['ending'][5]:>14,.0f}")
    print()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", type=Path, default=ROOT / "config.toml")
    ap.add_argument("--paths", type=int, help="number of simulated paths")
    ap.add_argument("--seed", type=int, help="random seed")
    ap.add_argument("--withdrawal", type=float, help="annual withdrawal, today's dollars")
    ap.add_argument("--refresh", action="store_true", help="re-download historical data")
    ap.add_argument("--no-open", action="store_true", help="don't open the report")
    args = ap.parse_args()

    cfg = load_config(args.config)
    if args.paths:
        cfg["simulation"]["paths"] = args.paths
    if args.seed is not None:
        cfg["simulation"]["seed"] = args.seed
    if args.withdrawal is not None:
        cfg["plan"]["annual_withdrawal"] = args.withdrawal
    if args.refresh:
        data.load_returns(refresh=True)

    t0 = time.perf_counter()
    out = run(cfg)
    print_summary(out)
    path = report.write(out, ROOT / "reports")
    print(f"Report: {path}  ({time.perf_counter() - t0:.1f}s)")
    if not args.no_open:
        webbrowser.open(path.as_uri())


if __name__ == "__main__":
    main()
