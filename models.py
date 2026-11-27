"""Return generators and the wealth simulation.

Every generator returns an array of monthly simple returns with shape
(n_paths, n_months, n_assets).
"""
from __future__ import annotations

import numpy as np


def gbm_returns(mu: np.ndarray, cov: np.ndarray, n_paths: int, n_months: int,
                rng: np.random.Generator) -> np.ndarray:
    """Correlated geometric Brownian motion, sampled monthly.

    mu and cov are the mean vector and covariance matrix of monthly *log*
    returns (so the drift already includes the -sigma^2/2 correction).
    Correlation comes from the Cholesky factor L of cov: z ~ N(0, I) -> L z.
    """
    mu = np.asarray(mu, dtype=float)
    cov = np.atleast_2d(np.asarray(cov, dtype=float))
    n_assets = mu.size
    z = rng.standard_normal((n_paths, n_months, n_assets))
    # cholesky fails on an all-zero matrix, which is a legitimate "no risk" input
    L = np.linalg.cholesky(cov) if np.any(cov) else np.zeros_like(cov)
    log_r = mu + z @ L.T
    return np.expm1(log_r)


def bootstrap_returns(history: np.ndarray, n_paths: int, n_months: int,
                      mean_block: float, rng: np.random.Generator) -> np.ndarray:
    """Stationary block bootstrap (Politis & Romano, 1994).

    Each path walks through the historical months in order, and each month
    it jumps to a random new month with probability 1/mean_block. That gives
    blocks of geometric length (mean = mean_block), which keeps crashes,
    recoveries and stock/bond co-movement intact. The history wraps around.
    """
    history = np.asarray(history, dtype=float)
    T = history.shape[0]
    p_jump = 1.0 / max(mean_block, 1.0)
    idx = np.empty((n_paths, n_months), dtype=np.int64)
    idx[:, 0] = rng.integers(0, T, n_paths)
    for t in range(1, n_months):
        jump = rng.random(n_paths) < p_jump
        idx[:, t] = np.where(jump, rng.integers(0, T, n_paths), (idx[:, t - 1] + 1) % T)
    return history[idx]


def cashflow_schedule(current_age: float, retire_age: float, end_age: float,
                      annual_contribution: float, annual_withdrawal: float) -> np.ndarray:
    """Monthly cashflows: + contributions before retirement, - withdrawals after."""
    n_months = int(round((end_age - current_age) * 12))
    n_work = int(round(max(retire_age - current_age, 0) * 12))
    cf = np.full(n_months, -annual_withdrawal / 12.0)
    cf[:n_work] = annual_contribution / 12.0
    return cf


def simulate_wealth(asset_returns: np.ndarray, weights: np.ndarray, start: float,
                    cashflows: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Run every path through the plan.

    The portfolio is rebalanced to `weights` every month, so its return is
    weights . asset_returns. Each month the cashflow happens first, then the
    market moves. A path that can't cover a withdrawal is ruined: wealth is
    set to 0 and stays there.

    Returns (wealth, fail_month):
      wealth     shape (n_paths, n_months + 1), wealth[:, 0] == start
      fail_month shape (n_paths,), month index of ruin, or -1 if never ruined
    """
    port = asset_returns @ np.asarray(weights, dtype=float)
    n_paths, n_months = port.shape
    if cashflows.shape[0] != n_months:
        raise ValueError("cashflows and returns cover different numbers of months")
    wealth = np.empty((n_paths, n_months + 1))
    wealth[:, 0] = start
    fail = np.full(n_paths, -1)
    w = np.full(n_paths, float(start))
    for t in range(n_months):
        w = w + cashflows[t]
        broke = (w < 0) & (fail < 0)
        fail[broke] = t
        w = np.where(fail >= 0, 0.0, w * (1.0 + port[:, t]))
        wealth[:, t + 1] = w
    return wealth, fail
