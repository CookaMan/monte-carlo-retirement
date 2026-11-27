"""Write a self-contained HTML report (data inlined as JSON, charts via Chart.js)."""
from __future__ import annotations

import json
from pathlib import Path

TEMPLATE = Path(__file__).parent / "template.html"


def write(out: dict, reports_dir: Path) -> Path:
    reports_dir.mkdir(exist_ok=True)
    payload = json.dumps(out).replace("</", "<\\/")
    html = TEMPLATE.read_text().replace("/*__DATA__*/null", payload)
    stamp = out["generated"].replace(" ", "_").replace(":", "")
    path = reports_dir / f"report_{stamp}.html"
    path.write_text(html)
    (reports_dir / "latest.html").write_text(html)
    return path
