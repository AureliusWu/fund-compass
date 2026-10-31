"""Synthetic Actions/ZIP/filesystem contracts. No GitHub, token, or provider IO."""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import struct
import sys
import urllib.error
import zipfile
import zlib

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
import overseas_journal_artifact as store

NOW = "2026-10-31T00:10:00Z"
CURRENT = {"run_id": 200, "attempt": 1, "source_sha": "a" * 40, "mode": "manual"}
SEED = store.journal.encode(store.journal.new_journal(), observed_at=NOW)


def run(run_id=200, *, source="a", status="in_progress", start="2026-10-31T00:09:00Z",
        end="2026-10-31T00:09:00Z", attempt=1, event="workflow_dispatch", conclusion=None, number=85):
    return {"id": run_id, "workflow_id": 310460010, "path": store.WORKFLOW_PATH,
            "head_branch": "main", "head_sha": source * 40, "event": event,
            "repository": {"full_name": store.REPOSITORY}, "head_repository": {"full_name": store.REPOSITORY},
            "run_attempt": attempt, "run_number": number, "created_at": start, "run_started_at": start,
            "updated_at": end, "status": status, "conclusion": conclusion}


def previous(run_id=199, **kwargs):
    kwargs.setdefault("conclusion", "failure")
    return run(run_id, status="completed", start="2026-10-31T00:01:00Z",
               end="2026-10-31T00:02:00Z", source="b", **kwargs)


def manifest():
    return {"profile": store.MANIFEST_PROFILE, "repository": store.REPOSITORY,
            "workflow_id": 310460010, "cutover_utc": "2026-10-31T00:00:00Z",
            "legacy_last_run_number": 84,
            "legacy_tip": "c" * 40, "seed_sha256": hashlib.sha256(SEED).hexdigest(),
            "protocol_blobs": {path: "d" * 40 for path in store.PROTOCOL_PATHS}}


def cutover(tmp_path, *, value=None, raw=SEED):
    for path, body in ((store.MANIFEST_PATH, json.dumps(value or manifest()).encode()), (store.SEED_PATH, raw)):
        target = tmp_path / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
    return tmp_path


def envelope(owner, *, raw=SEED, checkpoint="restored"):
    return {"profile": store.PROFILE, "repository": store.REPOSITORY,
            "workflow_id": owner["workflow_id"], "run_id": owner["id"], "attempt": owner["run_attempt"],
            "source_sha": owner["head_sha"], "mode": "scheduled" if owner["event"] == "schedule" else "manual",
            "checkpoint": checkpoint, "parent_journal_sha256": hashlib.sha256(raw).hexdigest(),
            "journal_sha256": hashlib.sha256(raw).hexdigest(), "journal": raw.decode()}


def zipped(value, *, name=store.FILE_NAME, mode=stat.S_IFREG | 0o644, extra=None,
           compression=zipfile.ZIP_DEFLATED):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=compression) as archive:
        info = zipfile.ZipInfo(name)
        info.external_attr = mode << 16
        info.compress_type = compression
        archive.writestr(info, json.dumps(value).encode())
        if extra:
            archive.writestr(extra, b"foreign")
    return output.getvalue()


class API:
    def __init__(self, *, prior=None, current=None, blob=None, entries=None):
        self.current = current or run(number=86 if prior else 85)
        self.prior = prior
        self.runs = ([prior] if prior else []) + [self.current]
        self.payload = blob if blob is not None else zipped(envelope(prior)) if prior else None
        self.metadata = None if prior is None else {"id": 123, "name": f"{store.ARTIFACT_PREFIX}{prior['id']}-{prior['run_attempt']}",
            "size_in_bytes": len(self.payload), "expired": False,
            "digest": "sha256:" + hashlib.sha256(self.payload).hexdigest(),
            "workflow_run": {"id": prior["id"], "head_branch": "main", "head_sha": prior["head_sha"]}}
        self.entries = entries
        self.calls = []
        self.protocol_bad = set()
        self.override = {}

    def json(self, path):
        self.calls.append(("json", path))
        if path in self.override:
            return self.override[path]
        if path.endswith(f"/actions/runs/{self.current['id']}"):
            return copy.deepcopy(self.current)
        if "/contents/" in path:
            source_path = path.split("/contents/")[1].split("?")[0]
            source = path.split("?ref=")[1]
            return {"type": "file", "path": source_path,
                    "sha": ("e" if (source, source_path) in self.protocol_bad else "d") * 40}
        if "/actions/workflows/" in path:
            return {"total_count": len(self.runs), "workflow_runs": copy.deepcopy(self.runs)}
        if "/artifacts?" in path:
            values = self.entries if self.entries is not None else [self.metadata] if self.metadata else []
            return {"total_count": len(values), "artifacts": copy.deepcopy(values)}
        raise AssertionError(path)

    def zip(self, path):
        self.calls.append(("zip", path))
        return self.payload


def restore(tmp_path, api, *, identity=CURRENT):
    return store.restore(cutover(tmp_path), identity, observed_at=NOW, api=api)


def test_only_first_protocol_run_can_restore_exact_seed(tmp_path):
    api = API()
    context, raw = restore(tmp_path, api)
    assert raw == SEED and context.predecessor is None
    assert not any("zip" == method for method, _ in api.calls)


def test_deleted_all_prior_runs_cannot_rebootstrap_a_later_run_number(tmp_path):
    api = API(current=run(number=86))
    with pytest.raises(store.ArtifactError, match="history_missing"):
        restore(tmp_path, api)


def test_deleted_latest_run_number_cannot_fall_back_to_older_cumulative_state(tmp_path):
    api = API(prior=previous(), current=run(number=87))
    with pytest.raises(store.ArtifactError, match="history_missing"):
        restore(tmp_path, api)


@pytest.mark.parametrize("status", ["completed", "cancelled", "queued", "waiting"])
def test_current_run_must_still_be_running_before_any_producer(tmp_path, status):
    current = run(status=status, conclusion="cancelled")
    with pytest.raises(store.ArtifactError, match="binding_invalid"):
        restore(tmp_path, API(current=current))


@pytest.mark.parametrize("conclusion", ["success", "failure", "cancelled", "timed_out", "startup_failure"])
def test_latest_completed_failure_or_cancellation_is_not_skipped(tmp_path, conclusion):
    prior = previous(conclusion=conclusion)
    context, raw = restore(tmp_path, API(prior=prior))
    assert raw == SEED and context.predecessor == prior


def test_latest_older_run_id_wins_by_server_terminal_time_not_run_id(tmp_path):
    latest = previous(150)
    api = API(prior=latest)
    api.runs.insert(0, run(199, status="completed", source="c", start="2026-10-31T00:00:01Z", end="2026-10-31T00:00:30Z", number=84, conclusion="success"))
    context, _ = restore(tmp_path, api)
    assert context.predecessor["id"] == 150


def test_missing_latest_artifact_never_uses_older_success_or_seed(tmp_path):
    api = API(prior=previous(), entries=[])
    api.runs.insert(0, run(198, status="completed", source="c", start="2026-10-31T00:00:01Z", end="2026-10-31T00:00:30Z", number=84, conclusion="success"))
    with pytest.raises(store.ArtifactError, match="history_missing"):
        restore(tmp_path, api)
    assert not any(method == "zip" for method, _ in api.calls)


@pytest.mark.parametrize("path", store.PROTOCOL_PATHS)
def test_latest_protocol_mismatch_never_skips_to_older_run_or_seed(tmp_path, path):
    api = API(prior=previous())
    api.protocol_bad.add(("b" * 40, path))
    with pytest.raises(store.ArtifactError, match="binding_invalid"):
        restore(tmp_path, api)


@pytest.mark.parametrize("path", store.PROTOCOL_PATHS)
def test_current_protocol_requires_all_four_fixed_code_blobs(tmp_path, path):
    api = API()
    api.protocol_bad.add(("a" * 40, path))
    with pytest.raises(store.ArtifactError, match="binding_invalid"):
        restore(tmp_path, api)


@pytest.mark.parametrize("attempt", [0, 2, 100, True, "1"])
def test_current_rerun_or_bad_attempt_stops_before_seed_or_api(tmp_path, attempt):
    api = API()
    with pytest.raises(store.ArtifactError, match="binding_invalid"):
        restore(tmp_path, api, identity={**CURRENT, "attempt": attempt})
    assert api.calls == []


def test_completed_previous_rerun_cannot_hide_earlier_attempt_history(tmp_path):
    with pytest.raises(store.ArtifactError, match="history_invalid"):
        restore(tmp_path, API(prior=previous(attempt=2)))


@pytest.mark.parametrize("status", ["in_progress", "queued", "waiting", "pending", "requested"])
def test_preexisting_nonterminal_run_is_not_skipped(tmp_path, status):
    prior = previous()
    prior["status"] = status
    with pytest.raises(store.ArtifactError, match="history_missing"):
        restore(tmp_path, API(prior=prior))


def test_duplicate_server_run_id_is_not_a_valid_complete_page(tmp_path):
    api = API()
    api.runs.append(api.current)
    with pytest.raises(store.ArtifactError):
        restore(tmp_path, api)


def test_missing_current_run_or_incomplete_list_cannot_bootstrap_seed(tmp_path):
    api = API()
    api.runs = []
    with pytest.raises(store.ArtifactError):
        restore(tmp_path, api)


@pytest.mark.parametrize("bad_total", [True, -1, 401, "1"])
def test_run_pagination_is_bounded_and_typed(tmp_path, bad_total):
    api = API()
    def override(path):
        if "/actions/workflows/" in path:
            return {"total_count": bad_total, "workflow_runs": []}
        return API.json(api, path)
    api.json = override
    with pytest.raises(store.ArtifactError):
        restore(tmp_path, api)


def test_complete_second_page_is_read_without_unbounded_search_or_id_order_guess(tmp_path):
    api = API(prior=previous())
    excluded = [{"id": index, "event": "pull_request"} for index in range(1, 101)]
    pages = [excluded, [previous(), api.current]]
    original = api.json
    def page(path):
        if "/actions/workflows/" in path:
            index = int(path.rsplit("page=", 1)[1]) - 1
            assert index in (0, 1)
            return {"total_count": 102, "workflow_runs": copy.deepcopy(pages[index])}
        return original(path)
    api.json = page
    context, raw = restore(tmp_path, api)
    assert raw == SEED and context.predecessor["id"] == 199


def test_page_missing_items_or_changed_total_cannot_be_treated_as_complete_history(tmp_path):
    api = API()
    original = api.json
    def page(path):
        if "/actions/workflows/" in path:
            return {"total_count": 101, "workflow_runs": [api.current]}
        return original(path)
    api.json = page
    with pytest.raises(store.ArtifactError):
        restore(tmp_path, api)


def test_ambiguous_terminal_timestamp_does_not_guess_by_run_id(tmp_path):
    api = API(prior=previous())
    api.runs.append(previous(198))
    with pytest.raises(store.ArtifactError, match="history_invalid"):
        restore(tmp_path, api)


def test_source_tree_change_after_current_start_is_not_a_predecessor(tmp_path):
    prior = previous()
    prior["updated_at"] = "2026-10-31T00:09:01Z"
    with pytest.raises(store.ArtifactError, match="history_invalid"):
        restore(tmp_path, API(prior=prior))


@pytest.mark.parametrize("key,value", [("head_branch", "other"), ("workflow_id", 1),
    ("path", "foreign.yml"), ("head_sha", "short"), ("run_attempt", True), ("run_number", True)])
def test_predecessor_metadata_must_match_fixed_server_identity(tmp_path, key, value):
    prior = previous()
    prior[key] = value
    with pytest.raises(store.ArtifactError):
        restore(tmp_path, API(prior=prior))


def test_pr_run_is_excluded_but_not_executed_as_history(tmp_path):
    api = API()
    api.runs.append(previous(event="pull_request"))
    context, raw = restore(tmp_path, api)
    assert context.predecessor is None and raw == SEED


@pytest.mark.parametrize("patch", [
    {"expired": True}, {"expired": 0}, {"digest": "sha256:" + "f" * 64},
    {"digest": None}, {"size_in_bytes": True}, {"size_in_bytes": store.MAX_ZIP + 1},
    {"workflow_run": {"id": 198, "head_branch": "main", "head_sha": "b" * 40}},
    {"name": store.ARTIFACT_PREFIX + "199-2"},
])
def test_artifact_metadata_cannot_substitute_other_attempt_or_unknown_digest(tmp_path, patch):
    api = API(prior=previous())
    api.metadata.update(patch)
    with pytest.raises(store.ArtifactError):
        restore(tmp_path, api)


def test_duplicate_exact_artifact_name_is_not_resolved_arbitrarily(tmp_path):
    api = API(prior=previous())
    api.entries = [api.metadata, api.metadata]
    with pytest.raises(store.ArtifactError, match="history_missing"):
        restore(tmp_path, api)


def test_actual_zip_digest_checked_not_just_manifest_claim(tmp_path):
    api = API(prior=previous())
    api.payload = b"x" * api.metadata["size_in_bytes"]
    with pytest.raises(store.ArtifactError):
        restore(tmp_path, api)


@pytest.mark.parametrize("name,mode,extra", [
    ("../" + store.FILE_NAME, stat.S_IFREG | 0o644, None),
    ("nested/" + store.FILE_NAME, stat.S_IFREG | 0o644, None),
    (store.FILE_NAME, stat.S_IFLNK | 0o777, None),
    (store.FILE_NAME, stat.S_IFREG | 0o755, None),
    (store.FILE_NAME, stat.S_IFIFO | 0o644, None),
    (store.FILE_NAME, stat.S_IFREG | 0o644, "foreign.py"),
])
def test_zip_is_exactly_one_nonexecutable_regular_fixed_json(tmp_path, name, mode, extra):
    prior = previous()
    payload = zipped(envelope(prior), name=name, mode=mode, extra=extra)
    with pytest.raises(store.ArtifactError):
        restore(tmp_path, API(prior=prior, blob=payload))


def test_forged_small_zip_size_cannot_hide_a_larger_deflate_stream(tmp_path):
    prior = previous()
    prefix = json.dumps(envelope(prior)).encode()
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(store.FILE_NAME, prefix + b"x" * (store.MAX_ENVELOPE + 65536))
    raw = bytearray(output.getvalue())
    central = raw.index(b"PK\x01\x02")
    # Forge both advertised uncompressed size and CRC to the valid prefix.
    # ZipExtFile alone can honor this header and hide the deflate remainder.
    struct.pack_into("<I", raw, 14, zlib.crc32(prefix))
    struct.pack_into("<I", raw, 22, len(prefix))
    struct.pack_into("<I", raw, central + 16, zlib.crc32(prefix))
    struct.pack_into("<I", raw, central + 24, len(prefix))
    with pytest.raises(store.ArtifactError):
        restore(tmp_path, API(prior=prior, blob=bytes(raw)))


def test_zip_member_reads_are_always_explicitly_bounded(tmp_path, monkeypatch):
    reads = []
    original = zipfile.ZipExtFile.read
    def bounded(member, size=-1):
        reads.append(size)
        assert 0 < size <= store.MAX_ENVELOPE + 1
        return original(member, size)
    monkeypatch.setattr(zipfile.ZipExtFile, "read", bounded)
    restore(tmp_path, API(prior=previous()))
    assert reads == [store.MAX_ENVELOPE + 1, 1]


@pytest.mark.parametrize("key,value", [("attempt", 2), ("source_sha", "c" * 40),
    ("run_id", 198), ("profile", "foreign"), ("repository", "other/repo"),
    ("checkpoint", "success"), ("mode", "scheduled"), ("journal_sha256", "f" * 64),
    ("parent_journal_sha256", "f" * 64), ("extra", True), ("attempt", True)])
def test_envelope_is_closed_and_bound_to_actual_completed_run(tmp_path, key, value):
    prior = previous()
    body = envelope(prior)
    body[key] = value
    with pytest.raises(store.ArtifactError):
        restore(tmp_path, API(prior=prior, blob=zipped(body)))


def test_terminal_artifact_must_really_contain_current_run_event(tmp_path):
    prior = previous()
    with pytest.raises(store.ArtifactError, match="binding_invalid"):
        restore(tmp_path, API(prior=prior, blob=zipped(envelope(prior, checkpoint="terminal"))))


def manual_event(owner):
    return {"run_id": owner["id"], "attempt": owner["run_attempt"], "source_sha": owner["head_sha"],
            "mode": "manual", "date": "2026-10-31", "expectation": "non_trading",
            "expected_window": "2026-10-31T06:35:00Z", "window_status": "non_trading_day",
            "started_at": owner["run_started_at"], "finished_at": owner["updated_at"],
            "outcome": "skipped", "reason": "manual_observation_only", "qualified_data": None,
            "workflow_status": "succeeded", "workflow_reason": "workflow_completed"}


@pytest.mark.parametrize("conclusion", ["failure", "cancelled", "timed_out", "neutral"])
def test_terminal_success_claim_cannot_wash_actual_actions_failure(tmp_path, conclusion):
    prior = previous(conclusion=conclusion)
    raw = store.journal.encode({"profile": store.journal.PROFILE, "events": [manual_event(prior)]}, observed_at=NOW)
    body = envelope(prior, raw=raw, checkpoint="terminal")
    body["parent_journal_sha256"] = hashlib.sha256(SEED).hexdigest()
    with pytest.raises(store.ArtifactError, match="history_invalid"):
        restore(tmp_path, API(prior=prior, blob=zipped(body)))


def test_terminal_event_and_server_success_preserve_real_original_event(tmp_path):
    prior = previous(conclusion="success")
    raw = store.journal.encode({"profile": store.journal.PROFILE, "events": [manual_event(prior)]}, observed_at=NOW)
    body = envelope(prior, raw=raw, checkpoint="terminal")
    body["parent_journal_sha256"] = hashlib.sha256(SEED).hexdigest()
    context, restored = restore(tmp_path, API(prior=prior, blob=zipped(body)))
    assert restored == raw and context.predecessor["conclusion"] == "success"


def test_downloaded_cumulative_history_cannot_drop_any_archived_seed_event(tmp_path):
    archived = store.journal.encode({"profile": store.journal.PROFILE, "events": [manual_event(previous(100))]}, observed_at=NOW)
    document = manifest()
    document["seed_sha256"] = hashlib.sha256(archived).hexdigest()
    root = cutover(tmp_path, value=document, raw=archived)
    with pytest.raises(store.ArtifactError):
        store.restore(root, CURRENT, observed_at=NOW, api=API(prior=previous()))


@pytest.mark.parametrize("key,value", [("extra", True), ("profile", "wrong"), ("repository", "foreign/repo"),
    ("workflow_id", True), ("seed_sha256", "f" * 64), ("cutover_utc", "2027-01-01T00:00:00Z"),
    ("protocol_blobs", {}), ("legacy_tip", "short"), ("legacy_last_run_number", True),
    ("legacy_last_run_number", 0)])
def test_cutover_manifest_is_closed_hash_bound_and_bounded(tmp_path, key, value):
    document = manifest()
    document[key] = value
    root = cutover(tmp_path, value=document)
    with pytest.raises(store.ArtifactError):
        store.load_cutover(root, observed_at=NOW)


def test_manifest_duplicate_keys_and_nonfinite_json_rejected(tmp_path):
    root = cutover(tmp_path)
    path = root / store.MANIFEST_PATH
    for raw in (b'{"profile":"x","profile":"y"}', b'{"x":NaN}', b"x" * 4097):
        path.write_bytes(raw)
        with pytest.raises(store.ArtifactError):
            store.load_cutover(root, observed_at=NOW)


def test_check_only_preserves_exact_journal_bytes_and_records_no_event(tmp_path, monkeypatch):
    context, raw = restore(tmp_path / "repo", API())
    runner = tmp_path / "runner"
    runner.mkdir()
    monkeypatch.setenv("RUNNER_TEMP", str(runner))
    first = store.publish(context, raw, checkpoint="restored", observed_at=NOW)
    result = store.publish(context, raw, checkpoint="check_only", observed_at=NOW)
    body = json.loads((runner / "overseas-ops" / store.FILE_NAME).read_bytes())
    assert body["journal"].encode() == SEED and body["checkpoint"] == "check_only"
    assert result["event_recorded"] is first["event_recorded"] is False
    assert result["event_count"] == 0 and result["journal_sha256"] == hashlib.sha256(SEED).hexdigest()
    assert not any(path.name == ".git" for path in runner.rglob("*"))


def test_existing_foreign_output_is_never_overwritten(tmp_path, monkeypatch):
    context, raw = restore(tmp_path / "repo", API())
    directory = tmp_path / "runner" / "overseas-ops"
    directory.mkdir(parents=True)
    target = directory / store.FILE_NAME
    target.write_bytes(b"foreign")
    monkeypatch.setenv("RUNNER_TEMP", str(directory.parent))
    with pytest.raises(store.ArtifactError, match="output_failed"):
        store.publish(context, raw, checkpoint="restored", observed_at=NOW)
    assert target.read_bytes() == b"foreign"


def test_changed_owned_output_keeps_original_unknown_state(tmp_path, monkeypatch):
    context, raw = restore(tmp_path / "repo", API())
    runner = tmp_path / "runner"
    runner.mkdir()
    monkeypatch.setenv("RUNNER_TEMP", str(runner))
    store.publish(context, raw, checkpoint="restored", observed_at=NOW)
    target = runner / "overseas-ops" / store.FILE_NAME
    target.write_bytes(b"newer")
    with pytest.raises(store.ArtifactError, match="output_failed"):
        store.publish(context, raw, checkpoint="check_only", observed_at=NOW)
    assert target.read_bytes() == b"newer"


def test_raw_output_cannot_change_during_check_only(tmp_path, monkeypatch):
    context, raw = restore(tmp_path, API())
    with pytest.raises(store.ArtifactError):
        store.publish(context, b" " + raw, checkpoint="check_only", observed_at=NOW)


def test_terminal_output_cannot_fake_event_or_drop_history(tmp_path):
    context, raw = restore(tmp_path, API())
    with pytest.raises(store.ArtifactError, match="binding_invalid"):
        store.publish(context, raw, checkpoint="terminal", observed_at=NOW)


def test_terminal_output_can_only_append_current_exact_event_to_original_state(tmp_path, monkeypatch):
    context, raw = restore(tmp_path / "repo", API())
    runner = tmp_path / "runner"
    runner.mkdir()
    monkeypatch.setenv("RUNNER_TEMP", str(runner))
    store.publish(context, raw, checkpoint="restored", observed_at=NOW)
    current = run()
    current["updated_at"] = NOW
    event = manual_event(current)
    terminal = store.journal.encode({"profile": store.journal.PROFILE, "events": [event]}, observed_at=NOW)
    result = store.publish(context, terminal, checkpoint="terminal", observed_at=NOW)
    body = json.loads((runner / "overseas-ops" / store.FILE_NAME).read_bytes())
    assert result["event_recorded"] is True and result["event_count"] == 1
    assert body["journal"].encode() == terminal and body["parent_journal_sha256"] == hashlib.sha256(raw).hexdigest()


def test_internal_context_identity_cannot_use_bool_attempt_or_extra_fields(tmp_path):
    context, raw = restore(tmp_path, API())
    context.identity["attempt"] = True
    with pytest.raises(store.ArtifactError, match="binding_invalid"):
        store.publish(context, raw, checkpoint="restored", observed_at=NOW)
    context.identity["attempt"] = 1
    context.identity["extra"] = True
    with pytest.raises(store.ArtifactError, match="binding_invalid"):
        store.publish(context, raw, checkpoint="restored", observed_at=NOW)


def test_api_token_never_appears_in_exception_or_retry(monkeypatch):
    monkeypatch.setenv("GH_TOKEN", "synthetic-secret")
    api = store.GitHubAPI()
    calls = []
    class Failing:
        def open(self, request, timeout):
            calls.append(request)
            raise urllib.error.URLError("synthetic-secret raw provider error")
    api._opener = Failing()
    with pytest.raises(store.ArtifactError, match="api_failed") as error:
        api.json(f"/repos/{store.REPOSITORY}/actions/runs/200")
    assert len(calls) == 1
    assert "synthetic-secret" not in str(error.value)


def test_api_download_redirect_never_forwards_authorization(monkeypatch):
    monkeypatch.setenv("GH_TOKEN", "synthetic-secret")
    api = store.GitHubAPI()
    calls = []
    class Response(io.BytesIO):
        status = 200
        headers = {"Content-Length": "3"}
    class Redirect:
        def open(self, request, timeout):
            calls.append(request)
            if len(calls) == 1:
                raise urllib.error.HTTPError(request.full_url, 302, "redirect", {
                    "Location": "https://example.blob.core.windows.net/fixed?signature=opaque"}, None)
            return Response(b"zip")
    api._opener = Redirect()
    assert api.zip(f"/repos/{store.REPOSITORY}/actions/artifacts/123/zip") == b"zip"
    assert calls[0].get_header("Authorization") == "Bearer synthetic-secret"
    assert calls[1].get_header("Authorization") is None


@pytest.mark.parametrize("url", ["http://example.blob.core.windows.net/x", "https://evil.test/x",
    "https://blob.core.windows.net/x", "https://u:p@example.blob.core.windows.net/x",
    "https://example.blob.core.windows.net:8443/x", "https://example.blob.core.windows.net/x#fragment"])
def test_api_redirect_is_one_allowed_signed_storage_origin_only(monkeypatch, url):
    monkeypatch.setenv("GH_TOKEN", "synthetic-secret")
    api = store.GitHubAPI()
    calls = []
    class Redirect:
        def open(self, request, timeout):
            calls.append(request)
            raise urllib.error.HTTPError(request.full_url, 302, "redirect", {"Location": url}, None)
    api._opener = Redirect()
    with pytest.raises(store.ArtifactError, match="api_failed"):
        api.zip(f"/repos/{store.REPOSITORY}/actions/artifacts/123/zip")
    assert len(calls) == 1


def test_api_read_body_and_shared_clock_budgets_are_not_reset(monkeypatch):
    monkeypatch.setenv("GH_TOKEN", "synthetic-secret")
    api = store.GitHubAPI()
    class Response(io.BytesIO):
        headers = {}
    with pytest.raises(store.ArtifactError, match="bounds_exceeded"):
        api._read(Response(b"x" * 11), 10)
    api._start -= store.TOTAL_SECONDS + 1
    with pytest.raises(store.ArtifactError, match="api_failed"):
        api._read(Response(b"x"), 10)
