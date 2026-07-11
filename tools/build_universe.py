"""Build the fund universe artifact outside the backend startup path."""
import gzip
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from service.eastmoney import fetch_universe  # noqa: E402

DATA_DIR = ROOT / "backend" / "data"
ARTIFACT = DATA_DIR / "fund-universe.json.gz"
META = DATA_DIR / "fund-universe.meta.json"


def build() -> dict:
    funds = fetch_universe()
    if len(funds) < 1000:
        raise RuntimeError(f"基金全集数量异常: {len(funds)}")
    payload = json.dumps(funds, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(payload).hexdigest()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with gzip.open(ARTIFACT, "wb", compresslevel=9) as stream:
        stream.write(payload)
    meta = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "eastmoney fundcode_search.js",
        "fund_count": len(funds),
        "sha256": digest,
    }
    META.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return meta


if __name__ == "__main__":
    print(json.dumps(build(), ensure_ascii=False))
