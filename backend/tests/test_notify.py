import importlib.util
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
NOTIFY_PATH = ROOT / "tools" / "notify.py"


def load_notify():
    spec = importlib.util.spec_from_file_location("notify_tool_under_test", NOTIFY_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_missing_required_configuration_fails_before_network(monkeypatch, capsys) -> None:
    notify = load_notify()
    monkeypatch.setattr(notify, "GIST_ID", "")
    monkeypatch.setattr(notify, "GIST_TOKEN", "")
    monkeypatch.setattr(notify, "SC_SENDKEY", "")
    monkeypatch.setattr(notify, "_req", lambda *args, **kwargs: (_ for _ in ()).throw(
        AssertionError("network must not be called when required configuration is missing")
    ))

    assert notify.main() == 2
    error = capsys.readouterr().err
    assert "GIST_ID" in error
    assert "GIST_TOKEN" in error
    assert "SC_SENDKEY" in error


def test_malformed_gist_id_fails_closed(monkeypatch) -> None:
    notify = load_notify()
    monkeypatch.setattr(notify, "GIST_ID", "not-a-gist")
    monkeypatch.setattr(notify, "GIST_TOKEN", "configured")
    monkeypatch.setattr(notify, "SC_SENDKEY", "configured")
    monkeypatch.setattr(notify, "_req", lambda *args, **kwargs: (_ for _ in ()).throw(
        AssertionError("network must not be called for a malformed Gist ID")
    ))

    assert notify.main() == 2


def test_notify_reads_only_the_explicit_gist(monkeypatch) -> None:
    notify = load_notify()
    gist_id = "a" * 32
    requests = []

    def fake_request(url, data=None, headers=None, method=None, timeout=90):
        requests.append((url, method))
        if url.endswith("/api/health"):
            return "{}"
        if url.endswith("/api/fund/000001/signal"):
            return '{"signal":"hold","name":"synthetic"}'
        if url == f"{notify.GH}/gists/{gist_id}" and method == "PATCH":
            return "{}"
        if url == f"{notify.GH}/gists/{gist_id}":
            return '{"files":{' \
                '"sinan-watchlist.json":{"content":"[{\\"code\\":\\"000001\\"}]"},' \
                '"sinan-signal-state.json":{"content":"{\\"000001\\":\\"hold\\"}"}' \
                '}}'
        raise AssertionError(f"unexpected request: {url}")

    monkeypatch.setattr(notify, "GIST_ID", gist_id)
    monkeypatch.setattr(notify, "GIST_TOKEN", "configured")
    monkeypatch.setattr(notify, "SC_SENDKEY", "configured")
    monkeypatch.setattr(notify, "FORCE", False)
    monkeypatch.setattr(notify, "trading_now", lambda: True)
    monkeypatch.setattr(notify, "_req", fake_request)

    assert notify.main() == 0
    gist_urls = [url for url, _ in requests if url.startswith(f"{notify.GH}/gists")]
    assert gist_urls
    assert set(gist_urls) == {f"{notify.GH}/gists/{gist_id}"}
    assert all("per_page" not in url for url, _ in requests)


def test_notification_transport_error_does_not_expose_sendkey(monkeypatch) -> None:
    notify = load_notify()
    sendkey = "sensitive-sendkey"
    monkeypatch.setattr(notify, "SC_SENDKEY", sendkey)
    monkeypatch.setattr(notify, "_req", lambda *args, **kwargs: (_ for _ in ()).throw(
        RuntimeError(f"failed URL contains {sendkey}")
    ))

    with pytest.raises(RuntimeError, match="ServerChan request failed") as error:
        notify.notify("title", "body")
    assert sendkey not in str(error.value)
