"""Build the fund universe artifact outside the backend startup path."""
import argparse
import gzip
import hashlib
import json
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from service.eastmoney import fetch_universe  # noqa: E402

DATA_DIR = ROOT / "backend" / "data"
ARTIFACT = DATA_DIR / "fund-universe.json.gz"
META = DATA_DIR / "fund-universe.meta.json"
MIN_FUND_COUNT = 1000
MAX_NAME_LENGTH = 200
MAX_OPTIONAL_TEXT_LENGTH = 200
CODE_PATTERN = re.compile(r"^\d{6}$")
DIGEST_PATTERN = re.compile(r"^[0-9a-f]{64}$")


def _validate_and_sort_funds(value) -> list[dict]:
    """Return a canonical, code-sorted universe or reject the whole snapshot."""
    if not isinstance(value, list) or len(value) < MIN_FUND_COUNT:
        count = len(value) if isinstance(value, list) else "not-a-list"
        raise RuntimeError(f"基金全集数量异常: {count}")

    normalized: list[dict] = []
    codes: set[str] = set()
    for index, row in enumerate(value):
        if not isinstance(row, dict):
            raise RuntimeError(f"基金全集第 {index + 1} 项不是对象")
        code = row.get("code")
        if not isinstance(code, str) or CODE_PATTERN.fullmatch(code) is None:
            raise RuntimeError(f"基金全集第 {index + 1} 项代码无效")
        if code in codes:
            raise RuntimeError(f"基金全集存在重复代码: {code}")
        codes.add(code)

        name = row.get("name")
        if not isinstance(name, str) or not name.strip() or len(name) > MAX_NAME_LENGTH:
            raise RuntimeError(f"基金全集第 {index + 1} 项名称无效")

        optional: dict[str, str | None] = {}
        for field in ("type", "pinyin"):
            text = row.get(field)
            if text is not None and (
                not isinstance(text, str) or len(text) > MAX_OPTIONAL_TEXT_LENGTH
            ):
                raise RuntimeError(f"基金全集第 {index + 1} 项 {field} 无效")
            optional[field] = text

        normalized.append({
            "code": code,
            "name": name.strip(),
            "type": optional["type"],
            "pinyin": optional["pinyin"],
        })

    return sorted(normalized, key=lambda fund: fund["code"])


def verify_snapshot(artifact: Path | None = None, meta_path: Path | None = None) -> dict:
    """Validate the complete on-disk artifact/meta pair without network access."""
    artifact = ARTIFACT if artifact is None else Path(artifact)
    meta_path = META if meta_path is None else Path(meta_path)
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        compressed = artifact.read_bytes()
        if not compressed.startswith(b"\x1f\x8b"):
            raise RuntimeError("基金全集 artifact 不是 gzip")
        payload = gzip.decompress(compressed)
        digest = hashlib.sha256(payload).hexdigest()
        funds = json.loads(payload)
    except (FileNotFoundError, OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("基金全集 artifact 无法读取") from error

    if not isinstance(meta, dict) or meta.get("schema_version") != 1:
        raise RuntimeError("基金全集 meta schema 无效")
    expected_digest = meta.get("sha256")
    if not isinstance(expected_digest, str) or DIGEST_PATTERN.fullmatch(expected_digest) is None:
        raise RuntimeError("基金全集 meta digest 无效")
    if digest != expected_digest:
        raise RuntimeError("基金全集 artifact digest 不匹配")

    normalized = _validate_and_sort_funds(funds)
    if normalized != funds:
        raise RuntimeError("基金全集 artifact 未按代码稳定规范化")
    count = meta.get("fund_count")
    if isinstance(count, bool) or not isinstance(count, int) or count != len(funds):
        raise RuntimeError("基金全集 artifact 数量与 meta 不匹配")
    return meta


def _current_snapshot_matches(digest: str, fund_count: int) -> bool:
    try:
        meta = verify_snapshot()
        return meta.get("sha256") == digest and meta.get("fund_count") == fund_count
    except RuntimeError:
        return False


def build() -> dict:
    funds = _validate_and_sort_funds(fetch_universe())
    payload = json.dumps(funds, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(payload).hexdigest()
    if _current_snapshot_matches(digest, len(funds)):
        return json.loads(META.read_text(encoding="utf-8"))
    meta = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "eastmoney fundcode_search.js",
        "fund_count": len(funds),
        "sha256": digest,
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    artifact_fd, artifact_name = tempfile.mkstemp(prefix="fund-universe-", suffix=".json.gz", dir=DATA_DIR)
    meta_fd, meta_name = tempfile.mkstemp(prefix="fund-universe-", suffix=".meta.json", dir=DATA_DIR)
    try:
        with open(artifact_fd, "wb", closefd=True) as raw_stream:
            with gzip.GzipFile(fileobj=raw_stream, mode="wb", compresslevel=9, mtime=0) as stream:
                stream.write(payload)
        with open(meta_fd, "w", encoding="utf-8", closefd=True) as stream:
            stream.write(json.dumps(meta, ensure_ascii=False, indent=2) + "\n")
        Path(artifact_name).replace(ARTIFACT)
        Path(meta_name).replace(META)
    finally:
        Path(artifact_name).unlink(missing_ok=True)
        Path(meta_name).unlink(missing_ok=True)
    return verify_snapshot()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--verify", action="store_true",
        help="只校验已写入的 artifact/meta，不访问上游",
    )
    args = parser.parse_args(argv)
    result = verify_snapshot() if args.verify else build()
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
