"""Local-only browser fixture: built frontend + real ASGI routes, synthetic fund.

Run from backend after building frontend:
    python tests/browser_preview.py --port 43857

No startup lifespan, real database, write route, or backend upstream is used.
Browser-owned public third-party GETs may still run; this is not production or
physical-device acceptance. Stop with Ctrl+C after the manual smoke test.
"""
from __future__ import annotations

import argparse
import copy
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main  # noqa: E402


def run(port: int) -> None:
    fixture = {
        "code": "000001", "name": "本地合成测试基金", "type": "混合型",
        "scale": None, "buy_rate": None, "source_rate": None,
        "ret_1m": None, "ret_6m": None, "ret_1y": None, "ret_3y": None,
        "rank_in_type": None, "rank_total": None, "manager": None,
        "manager_id": None, "manager_worktime": None,
        "latest_nav": 1.21, "latest_nav_date": "2026-08-28",
        "nav_history": [
            {"date": "2026-08-27", "nav": 1.20, "ac_return": None},
            {"date": "2026-08-28", "nav": 1.21, "ac_return": None},
        ],
        "source": "local_browser_fixture", "updated_at": "2026-08-28T18:00:00+08:00",
        "stale": True, "data_age_hours": 72,
    }
    main.app.dependency_overrides[main.fund_detail_dep] = lambda: copy.deepcopy(fixture)
    main._decision_detail = lambda detail: copy.deepcopy(detail)
    main.repo.universe_count = lambda: 1
    main.repo.query_funds = lambda **_kwargs: {
        "total": 1, "page": 1, "page_size": 20,
        "items": [{key: fixture[key] for key in ("code", "name", "type")}],
    }
    main.repo.public_operations_status = lambda: {
        "redacted": True, "universe_artifact": None,
        "cache": {"requests": 0, "hits": 0, "hit_rate": None, "oldest_age_hours": None},
        "latest_decision_write": None, "latest_result_settlement": None,
    }
    # Intentionally do not enter the app lifespan: no scheduled/startup imports.
    client = TestClient(main.app, raise_server_exceptions=False)
    dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
    if not (dist / "index.html").is_file():
        raise RuntimeError("Build frontend before running the browser fixture")

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(dist), **kwargs)

        def do_GET(self):
            if self.path.startswith("/api/"):
                response = client.get(self.path)
                self.send_response(response.status_code)
                self.send_header("Content-Type", response.headers.get("content-type", "application/json"))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(response.content)))
                self.end_headers()
                self.wfile.write(response.content)
                return
            if self.path.startswith("/fund-compass/"):
                self.path = self.path[len("/fund-compass"):]
            super().do_GET()

    print(f"Synthetic local browser fixture: http://127.0.0.1:{port}/fund-compass/", flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=43857)
    run(parser.parse_args().port)
