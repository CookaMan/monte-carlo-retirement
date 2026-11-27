# Monte Carlo Retirement Simulator

How likely is a retirement plan to last? This project simulates 10,000 possible futures for a stock/bond portfolio and answers that question with two different models of the market:

| Model | How it generates returns | What it misses / keeps |
|---|---|---|
| **GBM** (geometric Brownian motion) | Monthly log-returns drawn from a normal distribution with the historical mean and covariance (correlated via a Cholesky factor) | The textbook model. No fat tails, no memory. |
| **Historical bootstrap** | Replays random stretches of real history (stationary block bootstrap, average block 12 months) | Keeps crashes, inflation spells and stock/bond co-movement. |

The gap between the two shows how much "real-world" structure (fat tails, sequence-of-returns risk) matters for your plan.

**Try it in the browser: https://cookaman.github.io/monte-carlo-retirement/** (an interactive version where every assumption is an input; see [below](#interactive-web-app)).

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

## Interactive web app

`docs/` holds an interactive version that runs entirely in the browser. Change any input and the simulation reruns in about a second, with each model in its own Web Worker. It's hosted on GitHub Pages, and it also works opened straight from disk. In PyCharm, pick the **Web App** run config and press ▶. That re-exports the history data and opens the page.

What you can change:

| Group | Inputs |
|---|---|
| **Plan** | ages, savings, yearly savings, savings growth (raises), stock/bond mix |
| **Spending & withdrawals** | yearly spending; spending that changes later in retirement (e.g. −20% after 80); up to three one-time expenses or windfalls; withdrawal strategy: **fixed dollars**, **fixed % of portfolio**, or **guardrails** (Guyton-Klinger style, with floor and ceiling); the spending floor that counts as failure |
| **Income** | Social Security benefit and **claiming age 62–70** (SSA early-claim reductions and delayed credits); pension (with or without COLA); part-time work in retirement |
| **Social Security program changes** | **trust-fund benefit cut** (default 23% from 2033, per the 2025 Trustees Report); **raised full retirement age**; **COLA shortfall** (benefits losing buying power) |
| **Market assumptions & stress tests** | models to run, including a third, **Student-t fat-tailed** model; stock and bond returns vs. history (e.g. −1.5%/yr); volatility multiplier; **crash at retirement**; **bad decade** (lower returns for the first N years of retirement) |
| **Simulation** | history start year, bootstrap block length, paths, seed |

Inputs are saved in the URL, so **Copy link** shares an exact scenario. **Pin as baseline** shows every tile's change against a pinned scenario, e.g. "what does the 2033 Social Security cut cost me?"

How the extras are modeled:

- **Success:** the money never runs out, *and* no year's spending falls below the floor (a % of planned spending, or of first-year spending for the % strategy). With fixed spending this is plain "the money lasts". Variable strategies rarely go broke; they fail by cutting spending too far.
- **Income offsets spending:** the portfolio covers only spending minus Social Security, pension and work income. Surplus income gets saved.
- **Guardrails:** each year, if the withdrawal rate has drifted more than ±20% from where it started, spending moves ∓10%, held between the floor and ceiling.
- **Student-t:** same mean and covariance as GBM, with fat tails from a multivariate t (ν degrees of freedom).
- **Common random numbers:** each path is re-created from its own seed, so the spending sweep and baseline comparisons differ only by the change you made, not by luck.

The JavaScript engine (`docs/engine.js`) mirrors `models.py`. `tests/test_engine_js.py` runs it under macOS's built-in JavaScriptCore and checks it against the Python code: exact on deterministic cases, and within 1.5 points on the default plan's success rates.

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
5. Choose **Web App** and press ▶ to open the interactive version.

## Usage

Edit `config.toml` (ages, balance, contributions, withdrawal, stock/bond mix), then run one of these:

```bash
.venv/bin/python simulate.py                     # full run, opens the report
.venv/bin/python simulate.py --paths 2000        # quicker
.venv/bin/python simulate.py --withdrawal 50000  # try another spending level
.venv/bin/python simulate.py --seed 7 --no-open
.venv/bin/python export_web.py --open            # interactive web app
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
| `tests/` | Unit tests for the math, plus JS-vs-Python parity tests |
| `docs/index.html`, `docs/app.js` | Interactive web app: inputs, URL state, charts |
| `docs/engine.js` | The simulation in JavaScript (GBM, bootstrap, Student-t, strategies, Social Security) |
| `docs/history.js` | Shiller returns for the page, generated by `export_web.py` |

## The math, briefly

- **GBM:** if log-returns are normal with mean μ and variance σ², then wealth is log-normal. The median grows at μ, but the mean grows faster, at μ + σ²/2. That gap is the volatility drag.
- **Stationary bootstrap** (Politis & Romano, 1994): each month, keep walking forward through history with probability 1 − 1/b, or jump to a random month with probability 1/b. Block lengths are geometric with mean b.
- **Ruin:** cashflows happen at the start of each month. A path that can't cover a withdrawal is marked failed and stays at $0.
- **Withdrawal sweep:** every spending level is tested on the *same* random paths (common random numbers), so the curve reflects spending, not sampling noise.

## Caveats

The portfolio is rebalanced monthly, with no taxes or fees. The command-line version has no Social Security. The web app models it simply: no spousal or survivor benefits and no earnings test. It uses US data only, from one of the best-performing markets in history. The past is one sample of what's possible, not a forecast. This is not financial advice.
