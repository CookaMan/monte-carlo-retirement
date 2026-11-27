# Monte Carlo Retirement Simulator

How likely is a retirement plan to last? This project simulates 10,000 possible futures for a stock/bond portfolio and answers that question with two different models of the market:

| Model | How it generates returns | What it misses / keeps |
|---|---|---|
| **GBM** (geometric Brownian motion) | Monthly log-returns drawn from a normal distribution with the historical mean and covariance (correlated via a Cholesky factor) | The textbook model. No fat tails, no memory. |
| **Historical bootstrap** | Replays random stretches of real history (stationary block bootstrap, average block 12 months) | Keeps crashes, inflation spells and stock/bond co-movement. |

The gap between the two shows how much "real-world" structure (fat tails, sequence-of-returns risk) matters for your plan.

Data: Robert Shiller's monthly US dataset, 1871 to present, with **real (inflation-adjusted) total returns** for the S&P Composite and 10-year Treasuries. All results are in today's dollars.

## Example output

For the classic **4% rule** (a $1M portfolio, $40k/yr, 60/40, 30 years):

```
Model                     Success
GBM (normal returns)        98.0%
Historical bootstrap        93.2%
```

The normal-distribution model is overconfident. Real history has more bad stretches.

The HTML report includes:
- a fan chart of wealth by age for each model
- success rate across withdrawal levels
- the ages when plans fail
- an ending-wealth percentile table

## Setup

```bash
git clone https://github.com/CookaMan/monte-carlo-retirement.git
cd monte-carlo-retirement
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

### PyCharm

1. **File → Open** the project folder.
2. **Settings → Project → Python Interpreter → Add Interpreter → Existing**, then pick `.venv/bin/python`.
3. Choose **Simulate** in the run dropdown (top right) and press ▶. The summary prints in the Run window and the report opens in your browser.
4. Choose **Tests** and press ▶ to run the test suite.

## Usage

Edit `config.toml` (ages, balance, contributions, withdrawal, stock/bond mix), then run one of these:

```bash
.venv/bin/python simulate.py                     # full run, opens the report
.venv/bin/python simulate.py --paths 2000        # quicker
.venv/bin/python simulate.py --withdrawal 50000  # try another spending level
.venv/bin/python simulate.py --seed 7 --no-open
.venv/bin/python -m pytest                       # tests
```

Reports are written to `reports/` (the newest is always `reports/latest.html`).

## Project layout

| File | Purpose |
|---|---|
| `simulate.py` | CLI entry point: config → models → stats → report |
| `data.py` | Downloads and caches Shiller's data, turns it into monthly real returns |
| `models.py` | `gbm_returns`, `bootstrap_returns`, `cashflow_schedule`, `simulate_wealth` |
| `stats.py` | Success rate, percentile bands, failure ages, worst path, drawdowns |
| `report.py` + `template.html` | Self-contained HTML report (Chart.js) |
| `tests/` | Unit tests for the math |

## The math, briefly

- **GBM:** if log-returns are normal with mean μ and variance σ², then wealth is log-normal. The median grows at μ, but the mean grows faster, at μ + σ²/2. That gap is the volatility drag.
- **Stationary bootstrap** (Politis & Romano, 1994): each month, keep walking forward through history with probability 1 − 1/b, or jump to a random month with probability 1/b. Block lengths are geometric with mean b.
- **Ruin:** cashflows happen at the start of each month. A path that can't cover a withdrawal is marked failed and stays at $0.
- **Withdrawal sweep:** every spending level is tested on the *same* random paths (common random numbers), so the curve reflects spending, not sampling noise.

## Caveats

The portfolio is rebalanced monthly, with no taxes, fees or Social Security. It uses US data only, from one of the best-performing markets in history. The past is one sample of what's possible, not a forecast. This is not financial advice.
