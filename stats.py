"""Summary statistics for a batch of simulated wealth paths."""
from __future__ import annotations

import numpy as np

PERCENTILES = [5, 25, 50, 75, 95]


def success_rate(fail_month: np.ndarray) -> float:
    return float(np.mean(fail_month < 0))


def yearly_bands(wealth: np.ndarray) -> dict[int, list[float]]:
    """Percentile wealth at each year boundary: {pct: [value per year]}."""
    yearly = wealth[:, ::12]
    return {p: np.percentile(yearly, p, axis=0).round(0).tolist() for p in PERCENTILES}


def failure_years(fail_month: np.ndarray, n_years: int) -> list[float]:
    """Share of all paths that run out of money in each year of the plan."""
    failed = fail_month[fail_month >= 0] // 12
    counts = np.bincount(failed, minlength=n_years)[:n_years]
    return (counts / fail_month.size).round(5).tolist()


def ending_percentiles(wealth: np.ndarray) -> dict[int, float]:
    end = wealth[:, -1]
    return {p: float(np.percentile(end, p)) for p in [1, 5, 10, 25, 50, 75, 90, 95, 99]}


def worst_path(wealth: np.ndarray, fail_month: np.ndarray, pct: float = 1.0) -> list[float]:
    """The path at the given percentile from the bottom.

    Paths are ranked by ending wealth; ruined paths (ending at 0) are ranked
    by how early they failed, earliest = worst.
    """
    n_months = wealth.shape[1] - 1
    survive = np.where(fail_month < 0, n_months, fail_month)
    order = np.lexsort((wealth[:, -1], survive))
    i = order[int(np.floor(pct / 100 * (len(order) - 1)))]
    return wealth[i, ::12].round(0).tolist()


def max_drawdown(wealth: np.ndarray) -> np.ndarray:
    """Largest peak-to-trough drop of each path (0..1). Contributions mask some of it."""
    peak = np.maximum.accumulate(wealth, axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        dd = np.where(peak > 0, 1 - wealth / peak, 0.0)
    return dd.max(axis=1)
