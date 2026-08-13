import gzip
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("build_universe_tool", ROOT / "tools" / "build_universe.py")
tool = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(tool)


def funds():
    return [{"code": f"{index:06d}", "name": f"基金{index}", "type": "混合型", "pinyin": "JJ"} for index in range(1001)]


def test_unchanged_universe_does_not_rewrite_timestamp_or_artifact(tmp_path, monkeypatch):
    artifact = tmp_path / "fund-universe.json.gz"
    meta_path = tmp_path / "fund-universe.meta.json"
    rows = funds()
    payload = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(payload).hexdigest()
    artifact.write_bytes(gzip.compress(payload, mtime=0))
    original_meta = {
        "schema_version": 1, "generated_at": "2026-08-01T00:00:00+00:00", "source": "test",
        "fund_count": len(rows), "sha256": digest,
    }
    meta_path.write_text(json.dumps(original_meta), encoding="utf-8")
    before = artifact.read_bytes()
    monkeypatch.setattr(tool, "ARTIFACT", artifact)
    monkeypatch.setattr(tool, "META", meta_path)
    monkeypatch.setattr(tool, "DATA_DIR", tmp_path)
    monkeypatch.setattr(tool, "fetch_universe", lambda: rows)

    assert tool.build() == original_meta
    assert artifact.read_bytes() == before
    assert json.loads(meta_path.read_text(encoding="utf-8")) == original_meta


def test_corrupt_artifact_is_rebuilt_even_when_meta_hash_matches(tmp_path, monkeypatch):
    artifact = tmp_path / "fund-universe.json.gz"
    meta_path = tmp_path / "fund-universe.meta.json"
    rows = funds()
    payload = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    digest = hashlib.sha256(payload).hexdigest()
    artifact.write_bytes(b"corrupt")
    meta_path.write_text(json.dumps({"fund_count": len(rows), "sha256": digest}), encoding="utf-8")
    monkeypatch.setattr(tool, "ARTIFACT", artifact)
    monkeypatch.setattr(tool, "META", meta_path)
    monkeypatch.setattr(tool, "DATA_DIR", tmp_path)
    monkeypatch.setattr(tool, "fetch_universe", lambda: rows)

    result = tool.build()

    assert result["sha256"] == digest
    with gzip.open(artifact, "rb") as stream:
        assert hashlib.sha256(stream.read()).hexdigest() == digest


def test_build_sorts_by_code_and_writes_matching_count_and_digest(tmp_path, monkeypatch):
    artifact = tmp_path / "fund-universe.json.gz"
    meta_path = tmp_path / "fund-universe.meta.json"
    rows = list(reversed(funds()))
    rows[0] = {**rows[0], "type": None, "pinyin": None}
    monkeypatch.setattr(tool, "ARTIFACT", artifact)
    monkeypatch.setattr(tool, "META", meta_path)
    monkeypatch.setattr(tool, "DATA_DIR", tmp_path)
    monkeypatch.setattr(tool, "fetch_universe", lambda: rows)

    result = tool.build()
    payload = gzip.decompress(artifact.read_bytes())
    written = json.loads(payload)

    assert [row["code"] for row in written] == sorted(row["code"] for row in rows)
    assert result["schema_version"] == 1
    assert result["fund_count"] == len(written)
    assert result["sha256"] == hashlib.sha256(payload).hexdigest()
    assert tool.verify_snapshot() == result


@pytest.mark.parametrize(
    "mutate",
    [
        lambda rows: rows.__setitem__(1, {**rows[1], "code": rows[0]["code"]}),
        lambda rows: rows.__setitem__(1, {**rows[1], "code": "12345"}),
        lambda rows: rows.__setitem__(1, {**rows[1], "name": "   "}),
        lambda rows: rows.__setitem__(1, {**rows[1], "name": "基" * 201}),
        lambda rows: rows.__setitem__(1, {**rows[1], "type": 0}),
        lambda rows: rows.__setitem__(1, {**rows[1], "pinyin": "P" * 201}),
        lambda rows: rows.__delitem__(slice(999, None)),
    ],
    ids=(
        "duplicate-code", "bad-code", "blank-name", "long-name", "bad-type",
        "long-pinyin", "too-few-funds",
    ),
)
def test_invalid_source_snapshot_fails_without_overwriting(tmp_path, monkeypatch, mutate):
    artifact = tmp_path / "fund-universe.json.gz"
    meta_path = tmp_path / "fund-universe.meta.json"
    artifact.write_bytes(b"previous-artifact")
    meta_path.write_bytes(b"previous-meta")
    rows = funds()
    mutate(rows)
    monkeypatch.setattr(tool, "ARTIFACT", artifact)
    monkeypatch.setattr(tool, "META", meta_path)
    monkeypatch.setattr(tool, "DATA_DIR", tmp_path)
    monkeypatch.setattr(tool, "fetch_universe", lambda: rows)

    with pytest.raises(RuntimeError):
        tool.build()

    assert artifact.read_bytes() == b"previous-artifact"
    assert meta_path.read_bytes() == b"previous-meta"


def test_verify_rejects_meta_count_mismatch(tmp_path):
    rows = funds()
    payload = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    artifact = tmp_path / "fund-universe.json.gz"
    meta_path = tmp_path / "fund-universe.meta.json"
    artifact.write_bytes(gzip.compress(payload, mtime=0))
    meta_path.write_text(json.dumps({
        "schema_version": 1,
        "fund_count": len(rows) - 1,
        "sha256": hashlib.sha256(payload).hexdigest(),
    }), encoding="utf-8")

    with pytest.raises(RuntimeError, match="数量"):
        tool.verify_snapshot(artifact, meta_path)
