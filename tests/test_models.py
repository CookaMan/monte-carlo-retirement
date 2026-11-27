import numpy as np
import pytest

import models
import stats


def rng():
    return np.random.default_rng(0)


def test_gbm_zero_volatility_is_deterministic_compounding():
    mu = np.array([np.log(1.005)])          # exactly 0.5% per month
    r = models.gbm_returns(mu, np.zeros((1, 1)), 3, 24, rng())
    assert np.allclose(r, 0.005)
    wealth, fail = models.simulate_wealth(r, [1.0], 1000.0, np.zeros(24))
    assert np.allclose(wealth[:, -1], 1000 * 1.005 ** 24)
    assert (fail == -1).all()


def test_gbm_matches_input_moments_and_correlation():
    mu = np.array([0.006, 0.002])
    cov = np.array([[0.0020, 0.0003], [0.0003, 0.0004]])
    r = models.gbm_returns(mu, cov, 20_000, 60, rng())
    log_r = np.log1p(r).reshape(-1, 2)
    assert np.allclose(log_r.mean(axis=0), mu, atol=2e-4)
    assert np.allclose(np.cov(log_r, rowvar=False), cov, rtol=0.02)


def test_bootstrap_only_draws_historical_rows():
    hist = np.arange(40, dtype=float).reshape(20, 2) / 100
    r = models.bootstrap_returns(hist, 500, 100, 6, rng())
    rows = {tuple(x) for x in hist}
    assert all(tuple(x) in rows for x in r.reshape(-1, 2))


def test_bootstrap_block_length_is_about_right():
    hist = np.arange(1000, dtype=float)[:, None]
    r = models.bootstrap_returns(hist, 200, 600, 12, rng())[:, :, 0]
    continues = (np.diff(r, axis=1) == 1).mean()
    assert continues == pytest.approx(1 - 1 / 12, abs=0.01)


def test_no_withdrawals_and_positive_returns_never_fail():
    r = np.full((50, 120, 2), 0.01)
    cf = models.cashflow_schedule(40, 50, 50, 1000, 0)
    wealth, fail = models.simulate_wealth(r, [0.5, 0.5], 0.0, cf)
    assert (fail == -1).all()
    assert stats.success_rate(fail) == 1.0


def test_ruin_is_detected_and_sticks():
    r = np.zeros((1, 24, 1))
    cf = np.full(24, -100.0)
    wealth, fail = models.simulate_wealth(r, [1.0], 1000.0, cf)
    assert fail[0] == 10                     # 10 withdrawals of 100 empty it; the 11th fails
    assert (wealth[0, 11:] == 0).all()


def test_cashflow_schedule_split():
    cf = models.cashflow_schedule(60, 62, 65, 12_000, 24_000)
    assert cf.size == 60
    assert (cf[:24] == 1000).all() and (cf[24:] == -2000).all()


def test_failure_years_sum_to_failure_rate():
    fail = np.array([-1, 5, 30, 30, -1, 100])
    shares = stats.failure_years(fail, 10)
    assert sum(shares) == pytest.approx(4 / 6, abs=1e-4)
