import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def package(path: str) -> dict:
    return json.loads(read(path))


def test_current_release_version_is_consistent() -> None:
    version = package("frontend/package.json")["version"]

    assert re.fullmatch(r"\d+\.\d+\.\d+", version)
    assert package("frontend/package-lock.json")["version"] == version
    assert package("frontend/package-lock.json")["packages"][""]["version"] == version
    assert package("worker/package.json")["version"] == version
    assert package("worker/package-lock.json")["version"] == version
    assert package("worker/package-lock.json")["packages"][""]["version"] == version

    markers = {
        "frontend/src/version.ts": f"APP_VERSION = '{version}'",
        "frontend/vite.config.ts": f"司南基金 v{version}",
        "backend/main.py": f'version="{version}"',
        "worker/src/index.ts": f"version: '{version}'",
        "worker/src/index.test.ts": f"body.version).toBe('{version}')",
        "README.md": f"当前版本：`{version}`",
        "docs/DEPLOY.md": f"当前 v{version} 生产方案",
    }
    for path, marker in markers.items():
        assert marker in read(path), path

    latest_changelog = re.search(r"^## (\d+\.\d+\.\d+) - ", read("CHANGELOG.md"), re.MULTILINE)
    assert latest_changelog is not None
    assert latest_changelog.group(1) == version
