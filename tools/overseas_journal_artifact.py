"""Bounded Actions-only storage for the nonfinancial overseas run journal.

The cutover manifest and archived seed are explicit repository inputs. The
latest completed protocol run (including failure/cancellation) is authoritative;
a missing artifact is an error, never permission to reset history. Checkpoints
only preserve available state: ``restored``/``check_only`` do not claim that the
current run produced an event, financial data, recovery, or a successful window.
No Git ref, database, provider, release or credential file is accessed here.
"""
import datetime as dt
import hashlib
import io
import json
import os
import re
import stat
import struct
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
import zlib
from dataclasses import dataclass
from pathlib import Path

try:
    from tools import overseas_run_journal as journal
except ModuleNotFoundError:
    import overseas_run_journal as journal

REPOSITORY = "AureliusWu/fund-compass"
WORKFLOW_PATH = ".github/workflows/overseas-accuracy.yml"
PROTOCOL_PATHS = ("tools/overseas_journal_artifact.py", "tools/record_overseas_ops.py",
                  "tools/overseas_run_journal.py", WORKFLOW_PATH)
MANIFEST_PATH = "docs/archive/overseas-journal-cutover-20261031.json"
SEED_PATH = "docs/archive/overseas-run-journal-20261031.json"
PROFILE = "overseas-ops-artifact-1"
MANIFEST_PROFILE = "overseas-ops-cutover-1"
ARTIFACT_PREFIX = "overseas-public-journal-"
FILE_NAME = "overseas-run-journal.json"
MAX_JSON = 8 * 1024 * 1024
MAX_ENVELOPE = 2 * 1024 * 1024
MAX_ZIP = 2 * 1024 * 1024
PAGE_SIZE = 100
MAX_PAGES = 4
TOTAL_SECONDS = 30
UTC = dt.timezone.utc
_MANIFEST_KEYS = {"profile", "repository", "workflow_id", "cutover_utc", "legacy_tip",
                  "seed_sha256", "protocol_blobs", "legacy_last_run_number"}
_ENVELOPE_KEYS = {"profile", "repository", "workflow_id", "run_id", "attempt", "source_sha",
                  "mode", "checkpoint", "parent_journal_sha256", "journal_sha256", "journal"}


class ArtifactError(ValueError):
    def __init__(self, reason="history_invalid"):
        if reason not in {"history_invalid", "history_missing", "api_failed", "bounds_exceeded",
                          "binding_invalid", "config_invalid", "output_failed"}:
            reason = "history_invalid"
        self.reason = reason
        super().__init__(reason)


def _reject(reason="history_invalid"):
    raise ArtifactError(reason)


def _sha(value, width=64):
    if type(value) is not str or re.fullmatch(r"[0-9a-f]{" + str(width) + "}", value) is None:
        _reject("binding_invalid")
    return value


def _integer(value, *, high=2**53 - 1):
    if type(value) is not int or not 1 <= value <= high:
        _reject("binding_invalid")
    return value


def _clock(value):
    if type(value) is not str or re.fullmatch(r"20\d\d-\d\d-\d\dT\d\d:\d\d:\d\dZ", value) is None:
        _reject("binding_invalid")
    try:
        return dt.datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        _reject("binding_invalid")


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            _reject()
        result[key] = value
    return result


def _bad_constant(_):
    _reject()


def _json(raw, limit=MAX_JSON):
    if type(raw) is not bytes or not raw or len(raw) > limit:
        _reject("bounds_exceeded")
    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs, parse_constant=_bad_constant)
    except (ValueError, UnicodeError, RecursionError):
        _reject()
    if type(value) is not dict:
        _reject()
    return value


def _regular(root, relative, limit):
    path = root / relative
    for parent in (path, *path.parents):
        if parent == root:
            break
        if parent.is_symlink():
            _reject("config_invalid")
    try:
        if not path.is_file() or not 0 < path.stat().st_size <= limit:
            _reject("config_invalid")
        raw = path.read_bytes()
    except OSError:
        _reject("config_invalid")
    if not raw or len(raw) > limit:
        _reject("config_invalid")
    return raw


class GitHubAPI:
    """Fixed-origin read-only API, one attempt, bounded body/time, no raw errors.

    Only normal configured Actions tokens in the process environment are used.
    The artifact's one signed HTTPS download redirect is followed without the
    API Authorization header; neither that URL nor a response body is logged.
    """
    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    def __init__(self):
        self._token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
        if not self._token or "\r" in self._token or "\n" in self._token:
            _reject("config_invalid")
        self._start = time.monotonic()
        # Do not inherit a potentially rewriting proxy or ambient auth handler.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), self._NoRedirect())

    def _budget(self):
        remaining = TOTAL_SECONDS - (time.monotonic() - self._start)
        if not 0 < remaining <= TOTAL_SECONDS:
            _reject("api_failed")
        return min(5.0, remaining)

    def _read(self, response, limit):
        length = response.headers.get("Content-Length")
        if length is not None and (not length.isdigit() or int(length) > limit):
            _reject("bounds_exceeded")
        raw = bytearray()
        while True:
            self._budget()
            piece = response.read(min(65536, limit + 1 - len(raw)))
            if not piece:
                break
            raw.extend(piece)
            if len(raw) > limit:
                _reject("bounds_exceeded")
        self._budget()
        return bytes(raw)

    def _request(self, path, *, binary=False):
        if type(path) is not str or not path.startswith(f"/repos/{REPOSITORY}/") or any(
            byte in path for byte in ("\r", "\n", "#", "\\")
        ):
            _reject("binding_invalid")
        request = urllib.request.Request("https://api.github.com" + path, headers={
            "Authorization": "Bearer " + self._token, "User-Agent": "fund-compass-overseas-ops",
            "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10",
        }, method="GET")
        try:
            try:
                response = self._opener.open(request, timeout=self._budget())
            except urllib.error.HTTPError as error:
                if error.code == 404 and not binary:
                    error.close()
                    return None
                if error.code != 302 or not binary:
                    error.close()
                    _reject("api_failed")
                location = error.headers.get("Location", "")
                error.close()
                parsed = urllib.parse.urlsplit(location)
                host = parsed.hostname or ""
                if (parsed.scheme != "https" or parsed.username or parsed.password or parsed.fragment
                    or parsed.port not in (None, 443) or not parsed.path or not (
                        host.endswith(".blob.core.windows.net") or host.endswith(".actions.githubusercontent.com")
                    )):
                    _reject("api_failed")
                # Signed storage URL only; never forward the bearer token.
                response = self._opener.open(urllib.request.Request(location, headers={
                    "User-Agent": "fund-compass-overseas-ops"}, method="GET"), timeout=self._budget())
            with response:
                if response.status != 200:
                    _reject("api_failed")
                return self._read(response, MAX_ZIP if binary else MAX_JSON)
        except ArtifactError:
            raise
        except (OSError, ValueError, urllib.error.URLError, TimeoutError):
            _reject("api_failed")

    def json(self, path):
        raw = self._request(path)
        return None if raw is None else _json(raw)

    def zip(self, path):
        return self._request(path, binary=True)


def load_cutover(root, *, observed_at):
    manifest = _json(_regular(root, MANIFEST_PATH, 4096), 4096)
    if set(manifest) != _MANIFEST_KEYS or manifest["profile"] != MANIFEST_PROFILE or manifest["repository"] != REPOSITORY:
        _reject("config_invalid")
    _integer(manifest["workflow_id"])
    _integer(manifest["legacy_last_run_number"])
    if _clock(manifest["cutover_utc"]) > _clock(observed_at):
        _reject("config_invalid")
    _sha(manifest["legacy_tip"], 40)
    if type(manifest["protocol_blobs"]) is not dict or set(manifest["protocol_blobs"]) != set(PROTOCOL_PATHS):
        _reject("config_invalid")
    for blob in manifest["protocol_blobs"].values():
        _sha(blob, 40)
    _sha(manifest["seed_sha256"])
    raw = _regular(root, SEED_PATH, journal.MAX_BYTES)
    if hashlib.sha256(raw).hexdigest() != manifest["seed_sha256"]:
        _reject("config_invalid")
    journal.decode(raw, observed_at=observed_at)
    return manifest, raw


def _run(value, manifest):
    if type(value) is not dict:
        _reject("binding_invalid")
    if (value.get("workflow_id") != manifest["workflow_id"]
        or value.get("path") != WORKFLOW_PATH or value.get("head_branch") != "main"
        or value.get("event") not in ("schedule", "workflow_dispatch")
        or type(value.get("repository")) is not dict or value["repository"].get("full_name") != REPOSITORY
        or type(value.get("head_repository")) is not dict or value["head_repository"].get("full_name") != REPOSITORY):
        _reject("binding_invalid")
    _integer(value.get("id"))
    _integer(value.get("run_attempt"), high=100)
    _integer(value.get("run_number"))
    _sha(value.get("head_sha"), 40)
    for key in ("created_at", "updated_at", "run_started_at"):
        _clock(value.get(key))
    if not _clock(value["created_at"]) <= _clock(value["run_started_at"]) <= _clock(value["updated_at"]):
        _reject("binding_invalid")
    if value.get("status") not in ("queued", "in_progress", "completed", "waiting", "pending", "requested"):
        _reject("binding_invalid")
    if value["status"] == "completed" and value.get("conclusion") not in (
        "success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "startup_failure", "stale"
    ):
        _reject("binding_invalid")
    return value


def _protocol(api, run, manifest):
    # Contents API also returns base64 content; it is never imported, executed,
    # written to disk or used. Only each immutable metadata Git blob OID is
    # compared with the frozen protocol. This is not a source signature.
    for path in PROTOCOL_PATHS:
        result = api.json(f"/repos/{REPOSITORY}/contents/{path}?ref={run['head_sha']}")
        if result is None:
            return False
        if type(result) is not dict or result.get("type") != "file" or result.get("path") != path:
            _reject("binding_invalid")
        if _sha(result.get("sha"), 40) != manifest["protocol_blobs"][path]:
            return False
    return True


def _runs(api, manifest):
    runs, seen, expected = [], set(), None
    cutover = urllib.parse.quote(">=" + manifest["cutover_utc"], safe="")
    for page in range(1, MAX_PAGES + 1):
        result = api.json(f"/repos/{REPOSITORY}/actions/workflows/{manifest['workflow_id']}/runs"
                          f"?branch=main&created={cutover}&per_page={PAGE_SIZE}&page={page}")
        if type(result) is not dict or type(result.get("workflow_runs")) is not list:
            _reject("api_failed")
        total = result.get("total_count")
        if type(total) is not int or not 0 <= total <= PAGE_SIZE * MAX_PAGES or (expected is not None and total != expected):
            _reject("bounds_exceeded")
        expected = total
        items = result["workflow_runs"]
        if len(items) != min(PAGE_SIZE, max(0, total - len(runs))):
            _reject("history_invalid")
        for item in items:
            # Repository/workflow/main identities are checked even though the
            # fixed server query already requested them. PR runs are excluded.
            if type(item) is dict and item.get("event") not in ("schedule", "workflow_dispatch"):
                _integer(item.get("id"))
                if item["id"] in seen:
                    _reject()
                seen.add(item["id"])
                runs.append(None)
                continue
            run = _run(item, manifest)
            if run["id"] in seen or _clock(run["created_at"]) < _clock(manifest["cutover_utc"]):
                _reject()
            seen.add(run["id"])
            runs.append(run)
        if len(runs) == total:
            return [run for run in runs if run is not None]
    _reject("bounds_exceeded")


def _artifact(api, run):
    name = f"{ARTIFACT_PREFIX}{run['id']}-{run['run_attempt']}"
    artifacts, total_seen, expected = [], 0, None
    for page in range(1, MAX_PAGES + 1):
        result = api.json(f"/repos/{REPOSITORY}/actions/runs/{run['id']}/artifacts?per_page={PAGE_SIZE}&page={page}")
        if type(result) is not dict or type(result.get("artifacts")) is not list:
            _reject("api_failed")
        total = result.get("total_count")
        if type(total) is not int or not 0 <= total <= PAGE_SIZE * MAX_PAGES or (expected is not None and total != expected):
            _reject("bounds_exceeded")
        expected = total
        items = result["artifacts"]
        if len(items) != min(PAGE_SIZE, max(0, total - total_seen)):
            _reject()
        total_seen += len(items)
        for value in items:
            if type(value) is not dict:
                _reject()
            if value.get("name") == name:
                artifacts.append(value)
        if total_seen == total:
            break
    else:
        _reject("bounds_exceeded")
    if len(artifacts) != 1:
        _reject("history_missing")
    value = artifacts[0]
    _integer(value.get("id"))
    size = value.get("size_in_bytes")
    owner = value.get("workflow_run")
    if (type(size) is not int or not 0 < size <= MAX_ZIP or value.get("expired") is not False
        or type(owner) is not dict or owner.get("id") != run["id"]
        or owner.get("head_branch") != "main" or owner.get("head_sha") != run["head_sha"]):
        _reject("binding_invalid")
    digest = value.get("digest")
    if type(digest) is not str or not digest.startswith("sha256:"):
        _reject("binding_invalid")
    _sha(digest[7:])
    raw = api.zip(f"/repos/{REPOSITORY}/actions/artifacts/{value['id']}/zip")
    if (type(raw) is not bytes or len(raw) != size or len(raw) > MAX_ZIP
        or hashlib.sha256(raw).hexdigest() != digest[7:]):
        _reject()
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            entries = archive.infolist()
            if len(entries) != 1:
                _reject()
            info = entries[0]
            mode = info.external_attr >> 16
            if (info.filename != FILE_NAME or info.is_dir() or info.flag_bits & 1
                or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                or not 0 < info.file_size <= MAX_ENVELOPE or info.compress_size > MAX_ZIP
                or mode & 0o111 or stat.S_IFMT(mode) not in (0, stat.S_IFREG)):
                _reject()
            with archive.open(info) as member:
                envelope = member.read(MAX_ENVELOPE + 1)
                if len(envelope) != info.file_size or len(envelope) > MAX_ENVELOPE or member.read(1):
                    _reject("bounds_exceeded")
            # ZipExtFile can honor a forged small central-directory file_size
            # and truncate a larger DEFLATE stream. Independently check the
            # complete compressed member with a bounded zlib output, exact EOF,
            # size and CRC; do not flush/decompress an unbounded remainder.
            header = raw[info.header_offset:info.header_offset + 30]
            if len(header) != 30:
                _reject()
            local = struct.unpack("<4s5H3I2H", header)
            if local[0] != b"PK\x03\x04" or local[2] != info.flag_bits or local[3] != info.compress_type:
                _reject()
            name_at = info.header_offset + 30
            if raw[name_at:name_at + local[9]] != FILE_NAME.encode("ascii"):
                _reject()
            data_at = name_at + local[9] + local[10]
            if data_at + info.compress_size > archive.start_dir:
                _reject()
            compressed = raw[data_at:data_at + info.compress_size]
            if info.compress_type == zipfile.ZIP_DEFLATED:
                decoder = zlib.decompressobj(-zlib.MAX_WBITS)
                complete = decoder.decompress(compressed, MAX_ENVELOPE + 1)
                if not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
                    _reject("bounds_exceeded")
            else:
                complete = compressed
            if (len(complete) > MAX_ENVELOPE or len(complete) != info.file_size
                or complete != envelope or zlib.crc32(complete) != info.CRC):
                _reject()
    except ArtifactError:
        raise
    except (OSError, ValueError, zipfile.BadZipFile, RuntimeError, NotImplementedError, struct.error, zlib.error):
        _reject()
    return _json(envelope, MAX_ENVELOPE)


def _decode_envelope(value, run, *, observed_at, seed):
    for key in ("workflow_id", "run_id", "attempt"):
        _integer(value.get(key), high=100 if key == "attempt" else 2**53 - 1)
    if (set(value) != _ENVELOPE_KEYS or value.get("profile") != PROFILE
        or value.get("repository") != REPOSITORY or value.get("workflow_id") != run["workflow_id"]
        or value.get("run_id") != run["id"] or value.get("attempt") != run["run_attempt"]
        or value.get("source_sha") != run["head_sha"]
        or value.get("mode") != ("scheduled" if run["event"] == "schedule" else "manual")
        or value.get("checkpoint") not in ("restored", "terminal", "check_only")
        or type(value.get("journal")) is not str):
        _reject("binding_invalid")
    try:
        raw = value["journal"].encode("utf-8")
    except UnicodeError:
        _reject()
    _sha(value["journal_sha256"])
    _sha(value["parent_journal_sha256"])
    if hashlib.sha256(raw).hexdigest() != value["journal_sha256"]:
        _reject()
    events = journal.decode(raw, observed_at=observed_at)["events"]
    baseline = journal.decode(seed, observed_at=observed_at)["events"]
    if events[:len(baseline)] != baseline:
        _reject()
    if value["checkpoint"] != "terminal":
        if (value["parent_journal_sha256"] != value["journal_sha256"]
            or any(event["run_id"] == run["id"] and event["attempt"] == run["run_attempt"] for event in events)):
            _reject()
    elif not events or any(events[-1][key] != expected for key, expected in (
        ("run_id", run["id"]), ("attempt", run["run_attempt"]),
        ("source_sha", run["head_sha"]), ("mode", value["mode"]),
    )):
        _reject("binding_invalid")
    elif events[-1]["workflow_status"] == "succeeded" and run.get("conclusion") != "success":
        # The immutable event predates the final upload/main postcheck. Do not
        # rewrite that event, or grant a successful window after Actions failed.
        _reject("history_invalid")
    return raw


@dataclass
class Context:
    identity: dict
    workflow_id: int
    history: bytes
    predecessor: dict | None
    _written: bytes | None = None
    _output: Path | None = None


def restore(root, identity, *, observed_at, api=None):
    """Read latest completed new-protocol attempt or explicit first-run seed."""
    if (type(identity) is not dict or set(identity) != {"run_id", "attempt", "source_sha", "mode"}
        or identity.get("attempt") != 1 or type(identity.get("attempt")) is not int
        or identity.get("mode") not in ("scheduled", "manual")):
        _reject("binding_invalid")
    _integer(identity["run_id"])
    _sha(identity["source_sha"], 40)
    manifest, seed = load_cutover(Path(root), observed_at=observed_at)
    api = api or GitHubAPI()
    current = _run(api.json(f"/repos/{REPOSITORY}/actions/runs/{identity['run_id']}"), manifest)
    if (current["run_attempt"] != identity["attempt"] or current["head_sha"] != identity["source_sha"]
        or ("scheduled" if current["event"] == "schedule" else "manual") != identity["mode"]
        or _clock(current["created_at"]) < _clock(manifest["cutover_utc"])
        or current["status"] != "in_progress"
        or _clock(current["run_started_at"]) > _clock(observed_at) or not _protocol(api, current, manifest)):
        _reject("binding_invalid")
    candidates = []
    listed = _runs(api, manifest)
    if not any(run["id"] == current["id"] for run in listed):
        _reject()
    for run in listed:
        if run["id"] == current["id"]:
            continue
        if run["status"] != "completed":
            if _clock(run["run_started_at"]) <= _clock(current["run_started_at"]):
                _reject("history_missing")
            continue
        if run["run_attempt"] != 1:
            _reject("history_invalid")
        if _clock(run["updated_at"]) > _clock(current["run_started_at"]):
            _reject("history_invalid")
        candidates.append(run)
    candidates.sort(key=lambda run: (run["updated_at"], run["id"], run["run_attempt"]), reverse=True)
    selected = candidates[0] if candidates else None
    if len(candidates) > 1 and candidates[0]["updated_at"] == candidates[1]["updated_at"]:
        _reject("history_invalid")
    if selected is None:
        if current["run_number"] != manifest["legacy_last_run_number"] + 1:
            _reject("history_missing")
    elif selected["run_number"] != current["run_number"] - 1:
        # Run records can be deleted too. Never use an older available run as
        # proof that the immediately previous cumulative state did not exist.
        # A non-main/excluded run-number gap is deliberately fail-closed.
        _reject("history_missing")
    if selected is not None and not _protocol(api, selected, manifest):
        _reject("binding_invalid")
    raw = seed if selected is None else _decode_envelope(
        _artifact(api, selected), selected, observed_at=observed_at, seed=seed)
    return Context(dict(identity), manifest["workflow_id"], raw, selected), raw


def publish(context, raw, *, checkpoint, observed_at):
    """Checkpoint only an owned local output; upload is a separate workflow step."""
    if not isinstance(context, Context) or checkpoint not in ("restored", "terminal", "check_only"):
        _reject("binding_invalid")
    identity = context.identity
    if (type(identity) is not dict or set(identity) != {"run_id", "attempt", "source_sha", "mode"}
        or type(identity.get("attempt")) is not int or identity["attempt"] != 1
        or identity.get("mode") not in ("scheduled", "manual")):
        _reject("binding_invalid")
    _integer(identity["run_id"])
    _integer(context.workflow_id)
    _sha(identity["source_sha"], 40)
    original = journal.decode(context.history, observed_at=observed_at)["events"]
    events = journal.decode(raw, observed_at=observed_at)["events"]
    if checkpoint in ("restored", "check_only"):
        if raw != context.history:
            _reject()
    elif (len(events) != len(original) + 1 or events[:-1] != original
          or any(events[-1][key] != value for key, value in context.identity.items())):
        _reject("binding_invalid")
    value = {"profile": PROFILE, "repository": REPOSITORY, "workflow_id": context.workflow_id,
             **context.identity, "checkpoint": checkpoint,
             "parent_journal_sha256": hashlib.sha256(context.history).hexdigest(),
             "journal_sha256": hashlib.sha256(raw).hexdigest(), "journal": raw.decode("utf-8")}
    encoded = json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("ascii") + b"\n"
    if len(encoded) > MAX_ENVELOPE:
        _reject("bounds_exceeded")
    try:
        base = Path(os.environ.get("RUNNER_TEMP", ""))
        if not base.is_absolute() or str(base).startswith(("\\\\", "//")) or not base.is_dir() or base.is_symlink():
            _reject("output_failed")
        directory = base / "overseas-ops"
        if directory.exists():
            if not directory.is_dir() or directory.is_symlink():
                _reject("output_failed")
        else:
            directory.mkdir(mode=0o700)
        output = directory / FILE_NAME
        if context._written is None:
            with output.open("xb") as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            context._output = output
        else:
            if output != context._output or output.is_symlink() or output.read_bytes() != context._written:
                _reject("output_failed")
            with tempfile.NamedTemporaryFile(prefix=".checkpoint-", dir=directory, delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            # Only this invocation's previously owned output may be replaced.
            if output.is_symlink() or output.read_bytes() != context._written:
                temporary.unlink()
                _reject("output_failed")
            os.replace(temporary, output)
        context._written = encoded
    except ArtifactError:
        raise
    except (OSError, ValueError):
        _reject("output_failed")
    return {"checkpoint": checkpoint, "event_recorded": checkpoint == "terminal",
            "journal_sha256": value["journal_sha256"], "journal_bytes": len(raw),
            "event_count": len(events), "predecessor_run_id": context.predecessor["id"] if context.predecessor else None,
            "predecessor_attempt": context.predecessor["run_attempt"] if context.predecessor else None}
