"""Write large static datasets as a small manifest plus bounded JSON chunks."""
import json
from pathlib import Path


def write_chunks(out_file: str, collection: str, rows: list, updated: str, size: int = 1000) -> None:
    base = Path(out_file)
    chunk_dir = base.parent / base.stem
    chunk_dir.mkdir(parents=True, exist_ok=True)
    for old in chunk_dir.glob("part-*.json"):
        old.unlink()

    files = []
    for index in range(0, len(rows), size):
        name = f"part-{index // size:03d}.json"
        with (chunk_dir / name).open("w", encoding="utf-8") as stream:
            json.dump({collection: rows[index:index + size]}, stream, ensure_ascii=False, separators=(",", ":"))
        files.append(name)

    with (chunk_dir / "manifest.json").open("w", encoding="utf-8") as stream:
        json.dump({"updated": updated, "total": len(rows), "chunks": files}, stream, ensure_ascii=False, separators=(",", ":"))
