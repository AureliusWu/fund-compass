"""Safely publish large static datasets as a manifest plus bounded chunks."""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any


def _json_bytes(payload: Any) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def atomic_write_json(path: str | Path, payload: Any) -> None:
    """Write one JSON file completely before replacing the visible path."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".tmp", dir=target.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(_json_bytes(payload))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def write_chunks(out_file: str, collection: str, rows: list, updated: str, size: int = 1000) -> None:
    """Publish immutable chunks first and atomically replace the manifest last.

    Chunk names include a content digest, so a reader that already fetched the old
    manifest can never observe a half-old/half-new generation.  The immediately
    preceding generation is retained for those readers; older orphan generations
    are removed only after the new manifest is visible.
    """
    if not collection or not isinstance(rows, list) or size <= 0:
        raise ValueError("invalid chunk dataset")

    base = Path(out_file)
    chunk_dir = base.parent / base.stem
    chunk_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = chunk_dir / "manifest.json"

    previous_files: set[str] = set()
    try:
        previous = json.loads(manifest_path.read_text(encoding="utf-8"))
        if isinstance(previous.get("chunks"), list):
            previous_files = {
                str(name) for name in previous["chunks"]
                if isinstance(name, str) and Path(name).name == name
            }
    except (FileNotFoundError, json.JSONDecodeError, OSError, AttributeError):
        previous_files = set()

    files: list[str] = []
    chunk_hashes: dict[str, str] = {}
    for index in range(0, len(rows), size):
        payload = {collection: rows[index:index + size]}
        content = _json_bytes(payload)
        digest = hashlib.sha256(content).hexdigest()
        name = f"part-{index // size:03d}-{digest[:12]}.json"
        target = chunk_dir / name
        if not target.exists() or hashlib.sha256(target.read_bytes()).hexdigest() != digest:
            atomic_write_json(target, payload)
        files.append(name)
        chunk_hashes[name] = digest

    dataset_digest = hashlib.sha256(_json_bytes(rows)).hexdigest()
    manifest = {
        "schema_version": 2,
        "updated": updated,
        "total": len(rows),
        "collection": collection,
        "sha256": dataset_digest,
        "chunks": files,
        "chunk_sha256": chunk_hashes,
    }
    atomic_write_json(manifest_path, manifest)  # publication point: always last

    keep = set(files) | previous_files
    for old in chunk_dir.glob("part-*.json"):
        if old.name not in keep:
            old.unlink()
