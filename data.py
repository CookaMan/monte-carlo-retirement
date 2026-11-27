"""Historical real (inflation-adjusted) monthly returns for US stocks and bonds.

Source: Robert Shiller's "Irrational Exuberance" dataset, monthly since 1871.
  - Stocks: S&P Composite real total return price (dividends reinvested, CPI-deflated)
  - Bonds:  real total return of a 10-year Treasury, CPI-deflated

The spreadsheet is downloaded once and cached in cache/ for CACHE_DAYS days.
"""
from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

URL = ("https://img1.wsimg.com/blobby/go/e5e77e0b-59d1-44d9-ab25-4763ac982e53/"
       "downloads/ie_data.xls")
CACHE = Path(__file__).parent / "cache" / "ie_data.xls"
CACHE_DAYS = 30

STOCK_COL = 9    # Real Total Return Price
BOND_COL = 18    # Real Total Bond Returns (cumulative index)


def _download(path: Path) -> None:
    path.parent.mkdir(exist_ok=True)
    r = requests.get(URL, timeout=60, headers={"User-Agent": "monte-carlo-retirement"})
    r.raise_for_status()
    path.write_bytes(r.content)


def _shiller_date(d: float) -> pd.Timestamp:
    """Shiller writes months as 1871.01 ... 1871.12 (and October as 1871.1)."""
    year = int(d)
    month = int(round((d - year) * 100))
    return pd.Timestamp(year=year, month=month, day=1)


def load_returns(start_year: int = 1871, refresh: bool = False) -> pd.DataFrame:
    """Monthly real simple returns, columns ['stocks', 'bonds'], indexed by month."""
    stale = (not CACHE.exists()
             or time.time() - CACHE.stat().st_mtime > CACHE_DAYS * 86400)
    if refresh or stale:
        try:
            _download(CACHE)
        except requests.RequestException:
            if not CACHE.exists():
                raise
            print("warning: download failed, using cached data")

    raw = pd.read_excel(CACHE, sheet_name="Data", header=None, skiprows=8,
                        engine="calamine")
    raw = raw[[0, STOCK_COL, BOND_COL]].apply(pd.to_numeric, errors="coerce").dropna()
    raw.index = [_shiller_date(d) for d in raw[0]]
    levels = raw[[STOCK_COL, BOND_COL]].set_axis(["stocks", "bonds"], axis=1)
    rets = levels.pct_change().dropna()
    rets = rets[rets.index.year >= start_year]
    if len(rets) < 120:
        raise ValueError(f"only {len(rets)} months of history after {start_year}")
    return rets


if __name__ == "__main__":
    r = load_returns()
    print(f"{len(r)} months, {r.index[0]:%Y-%m} to {r.index[-1]:%Y-%m}")
    ann = (1 + r).prod() ** (12 / len(r)) - 1
    vol = np.log1p(r).std() * np.sqrt(12)
    print("annualized real return:", ann.round(4).to_dict())
    print("annualized volatility: ", vol.round(4).to_dict())
