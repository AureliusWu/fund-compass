"""Real SQLite synthetic candidate transactions; no configured or remote DB."""
from __future__ import annotations

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest

from database.owner_sync_schema import provision_owner_sync_candidate
from database.turso_schema import expected_objects
from models.owner_sync import OwnerSyncRequest, parse_sync_request
from service import owner_sync_repo as repo

KEY = "000001::合成账户"
VALUES = {"name": "合成基金", "shares": 10, "cost": 1, "target_weight": None}


def create_candidate(path=":memory:", *, factory=sqlite3.Connection):
    conn = sqlite3.connect(path, factory=factory)
    conn.execute("PRAGMA foreign_keys=ON")
    for ddl in expected_objects().values():
        conn.execute(ddl)
    conn.execute("PRAGMA user_version=9")
    conn.commit()
    provision_owner_sync_candidate(conn, synthetic_candidate=True)
    return conn


@pytest.fixture
def conn():
    connection = create_candidate()
    yield connection
    connection.close()


def operation(key=KEY, *, kind="holding", deleted=False, changes=None, base=None):
    out = {"key": key, "kind": kind, "deleted": deleted}
    if changes is not None:
        out["changes"] = changes
    if base is not None:
        out["base_values"] = base
    return out


def request(identifier="req-0001", expected=0, *operations):
    return json.dumps({"request_id": identifier, "expected_revision": expected, "operations": list(operations) or [operation(changes=VALUES)]}, ensure_ascii=False).encode()


def head(conn):
    return conn.execute("SELECT revision FROM owner_sync_state").fetchone()[0]


def business(conn):
    return {table: conn.execute(f"SELECT * FROM {table} ORDER BY 1,2").fetchall()
            for table in ("owner_sync_records", "owner_sync_changes", "owner_sync_receipts")}


def seed(conn):
    result = repo.apply_sync_local(conn, request())
    assert result.status == 200
    return result.body["records"][0]


def test_create_confirmed_zero_nulls_and_exact_receipt_replay(conn):
    raw = request("req-zero", 0, operation(changes={**VALUES, "shares": 0, "cost": 0, "target_weight": None}))
    result = repo.apply_sync_local(conn, raw)
    assert result.status == 200
    assert result.body["revision"] == 1
    record = result.body["records"][0]
    assert record["values"] == {**VALUES, "shares": 0, "cost": 0}
    assert record["field_revisions"] == dict.fromkeys(VALUES, 1)
    assert repo.read_sync_receipt(conn, "req-zero") == result
    prior = business(conn)
    assert repo.apply_sync_local(conn, raw) == result
    assert repo.apply_sync_local(conn, json.dumps(json.loads(raw), sort_keys=True).encode()) == result
    assert business(conn) == prior and head(conn) == 1


@pytest.mark.parametrize("mutation", ["expected", "value", "omitted", "number-token", "key-whitespace"])
def test_same_id_changed_original_body_conflicts_without_overwriting_receipt(conn, mutation):
    raw = request("req-exact", 0, operation(changes=VALUES))
    original = repo.apply_sync_local(conn, raw)
    modified = json.loads(raw)
    if mutation == "expected": modified["expected_revision"] = 1
    if mutation == "value": modified["operations"][0]["changes"]["cost"] = 2
    if mutation == "omitted": modified["operations"][0]["base_values"] = {}
    if mutation == "number-token": modified["operations"][0]["changes"]["cost"] = 1.0
    if mutation == "key-whitespace": modified["operations"][0]["key"] += " "
    prior = business(conn)
    result = repo.apply_sync_local(conn, json.dumps(modified).encode())
    assert result.status == 409 and result.body["error"]["code"] == "idempotency_conflict"
    assert repo.read_sync_receipt(conn, "req-exact") == original
    assert business(conn) == prior


def test_no_change_does_not_advance_revision_but_persists_receipt(conn):
    seed(conn)
    raw = request("req-noop", 1, operation(changes={"cost": 1}, base={"cost": 1}))
    result = repo.apply_sync_local(conn, raw)
    assert result.status == 200 and result.body["revision"] == head(conn) == 1
    assert len(business(conn)["owner_sync_changes"]) == 1
    assert len(business(conn)["owner_sync_receipts"]) == 2
    assert repo.read_sync_receipt(conn, "req-noop") == result


def test_browser_integer_base_matches_stored_integral_float_without_changing_original_hash(conn):
    created = repo.apply_sync_local(conn, request("req-float", 0, operation(changes={**VALUES, "cost": 1.0})))
    assert created.status == 200
    patched = repo.apply_sync_local(conn, request("req-jsbase", 1, operation(changes={"cost": 2}, base={"cost": 1})))
    assert patched.status == 200 and patched.body["revision"] == 2
    assert patched.body["records"][0]["values"]["cost"] == 2
    assert patched.body["records"][0]["field_revisions"]["cost"] == 2


def test_browser_same_numeric_value_does_not_create_change_or_advance_field_revision(conn):
    created = repo.apply_sync_local(conn, request("req-float", 0, operation(changes={**VALUES, "cost": 1.0})))
    before = business(conn)
    noop = repo.apply_sync_local(conn, request("req-jsnoop", 1, operation(changes={"cost": 1}, base={"cost": 1})))
    assert noop.status == 200 and head(conn) == noop.body["revision"] == 1
    assert noop.body["records"] == created.body["records"]
    assert type(noop.body["records"][0]["values"]["cost"]) is float
    after = business(conn)
    assert after["owner_sync_records"] == before["owner_sync_records"]
    assert after["owner_sync_changes"] == before["owner_sync_changes"]
    assert len(after["owner_sync_receipts"]) == len(before["owner_sync_receipts"]) + 1


def test_disjoint_stale_fields_merge_but_same_field_conflicts(conn):
    seed(conn)
    name = repo.apply_sync_local(conn, request("req-name", 1, operation(changes={"name": "新名称"}, base={"name": "合成基金"})))
    assert name.status == 200
    cost = repo.apply_sync_local(conn, request("req-cost", 1, operation(changes={"cost": 2}, base={"cost": 1})))
    assert cost.status == 200 and cost.body["revision"] == 3
    assert cost.body["records"][0]["values"]["name"] == "新名称"
    stale_raw = request("req-stale", 1, operation(changes={"cost": 9}, base={"cost": 1}))
    conflict = repo.apply_sync_local(conn, stale_raw)
    assert conflict.status == 409 and head(conn) == 3
    assert conflict.body["conflicts"][0]["fields"] == ["cost"]
    assert "合成账户" not in json.dumps(conflict.body, ensure_ascii=False)
    assert repo.apply_sync_local(conn, stale_raw) == conflict
    assert repo.read_sync_receipt(conn, "req-stale") == conflict


@pytest.mark.parametrize("incoming,base", [(3, 1), (1, 1), (3, 3)])
def test_aba_stamp_cannot_be_bypassed_by_matching_value_or_forged_base(conn, incoming, base):
    seed(conn)
    assert repo.apply_sync_local(conn, request("req-aba2", 1, operation(changes={"cost": 2}, base={"cost": 1}))).status == 200
    assert repo.apply_sync_local(conn, request("req-aba1", 2, operation(changes={"cost": 1}, base={"cost": 2}))).status == 200
    result = repo.apply_sync_local(conn, request("req-abax", 1, operation(changes={"cost": incoming}, base={"cost": base})))
    assert result.status == 409 and head(conn) == 3
    assert result.body["conflicts"][0]["fields"] == ["cost"]


@pytest.mark.parametrize("base", [{}, {"cost": None}, {"cost": 2}])
def test_missing_base_and_null_are_not_equal_to_current_known_value(conn, base):
    seed(conn)
    result = repo.apply_sync_local(conn, request("req-base", 1, operation(changes={"cost": 3}, base=base)))
    assert result.status == 409 and head(conn) == 1


def test_patch_can_explicitly_preserve_unknown_shares_without_zero_and_history_is_immutable(conn):
    seed(conn)
    result = repo.apply_sync_local(conn, request("req-null", 1, operation(changes={"shares": None}, base={"shares": 10})))
    assert result.status == 200 and result.body["records"][0]["values"]["shares"] is None
    changes = repo.read_sync_changes(conn)["changes"]
    assert changes[0]["values"]["shares"] == 10 and changes[1]["values"]["shares"] is None


def test_future_expected_is_a_deterministic_saved_conflict(conn):
    raw = request("req-future", 1)
    result = repo.apply_sync_local(conn, raw)
    assert result.status == 409 and head(conn) == 0
    assert result.body["conflicts"][0]["fields"] == ["expected_revision"]
    assert repo.apply_sync_local(conn, raw) == result
    assert business(conn)["owner_sync_records"] == []


def test_delete_record_level_conflict_tombstone_and_explicit_fresh_revive(conn):
    seed(conn)
    assert repo.apply_sync_local(conn, request("req-edit", 1, operation(changes={"name": "新名称"}, base={"name": "合成基金"}))).status == 200
    stale = repo.apply_sync_local(conn, request("req-del0", 1, operation(deleted=True)))
    assert stale.status == 409 and head(conn) == 2
    deleted = repo.apply_sync_local(conn, request("req-del1", 2, operation(deleted=True)))
    assert deleted.status == 200 and deleted.body["records"][0]["deleted"] is True
    for identifier, expected, changes, base in [
        ("req-old1", 2, VALUES, {}),
        ("req-old2", 2, VALUES, {"deleted": True}),
        ("req-old3", 3, {"shares": 1}, {"deleted": True}),
    ]:
        assert repo.apply_sync_local(conn, request(identifier, expected, operation(changes=changes, base=base))).status == 409
    revived = repo.apply_sync_local(conn, request("req-revive", 3, operation(changes={**VALUES, "shares": 0, "cost": None}, base={"deleted": True})))
    assert revived.status == 200 and head(conn) == 4
    record = revived.body["records"][0]
    assert record["values"]["cost"] is None and record["values"]["shares"] == 0
    assert record["lifecycle_revision"] == 4
    assert set(record["field_revisions"].values()) == {4}
    assert repo.apply_sync_local(conn, request("req-old4", 1, operation(changes={"cost": 1}, base={"cost": None}))).status == 409


def test_watch_holding_share_identity_and_kind_transition_needs_fresh_full_input(conn):
    raw = request("req-watch", 0, operation(kind="watch", changes={"name": "合成基金"}))
    assert repo.apply_sync_local(conn, raw).status == 200
    assert repo.apply_sync_local(conn, request("req-kind0", 1, operation(changes=VALUES))).status == 409
    transition = repo.apply_sync_local(conn, request("req-kind1", 1, operation(changes=VALUES, base={"kind": "watch"})))
    assert transition.status == 200
    assert len(business(conn)["owner_sync_records"]) == 1
    assert transition.body["records"][0]["kind"] == "holding"
    assert repo.apply_sync_local(conn, request("req-kind2", 2, operation(kind="watch", changes={"name": "合成基金", "shares": 10}, base={"kind": "holding"}))).status == 409


def test_batch_rename_old_tombstone_new_key_is_atomic(conn):
    seed(conn)
    new_key = "000001::新合成账户"
    assert repo.apply_sync_local(conn, request("req-target", 1, operation(new_key, changes={**VALUES, "cost": 2}))).status == 200
    before = {key: value for key, value in business(conn).items() if key != "owner_sync_receipts"}
    bad = request("req-rename0", 2, operation(deleted=True), operation(new_key, changes=VALUES, base={"cost": None}))
    assert repo.apply_sync_local(conn, bad).status == 409
    assert {key: value for key, value in business(conn).items() if key != "owner_sync_receipts"} == before and head(conn) == 2
    fresh_key = "000001::另一个账户"
    good = request("req-rename1", 2, operation(deleted=True), operation(fresh_key, changes=VALUES))
    result = repo.apply_sync_local(conn, good)
    assert result.status == 200 and result.body["revision"] == 3
    assert [record["deleted"] for record in result.body["records"]] == [True, False]
    assert [row[0] for row in conn.execute("SELECT revision FROM owner_sync_changes WHERE revision=3")] == [3, 3]


def test_append_pages_pin_upper_and_keep_every_same_revision_key_and_old_value(conn):
    keys = ["000001::C", "000001::A", "000001::B"]
    assert repo.apply_sync_local(conn, request("req-page1", 0, *(operation(key, changes=VALUES) for key in keys))).status == 200
    first = repo.read_sync_changes(conn, limit=1)
    assert first["upper_revision"] == 1 and first["complete"] is False
    assert first["changes"][0]["key"] == keys[1]
    assert repo.apply_sync_local(conn, request("req-page2", 1, operation(keys[1], changes={"cost": 2}, base={"cost": 1}))).status == 200
    collected = first["changes"]
    page = first
    while not page["complete"]:
        page = repo.read_sync_changes(conn, upper_revision=first["upper_revision"], cursor=page["next_cursor"], limit=1)
        collected += page["changes"]
    assert [record["key"] for record in collected] == sorted(keys)
    assert all(record["record_revision"] == 1 and record["values"]["cost"] == 1 for record in collected)
    assert page["next_cursor"] is None and page["upper_revision"] == 1
    later = repo.read_sync_changes(conn, since_revision=1)
    assert len(later["changes"]) == 1 and later["changes"][0]["values"]["cost"] == 2
    assert later["complete"] is True and later["upper_revision"] == 2


class FaultConnection(sqlite3.Connection):
    fault = None
    def execute(self, sql, parameters=(), /):
        if self.fault == "schema-before-begin" and sql.startswith("BEGIN"):
            self.fault = None
            super().execute("CREATE TABLE unexpected_schema_drift(id INTEGER)")
        targets = {"record": "INSERT INTO owner_sync_records", "change": "INSERT INTO owner_sync_changes", "head": "UPDATE owner_sync_state", "receipt": "INSERT INTO owner_sync_receipts"}
        if self.fault in targets and sql.startswith(targets[self.fault]):
            self.fault = None
            raise sqlite3.OperationalError("synthetic-private-provider-body")
        return super().execute(sql, parameters)
    def commit(self):
        fault, self.fault = self.fault, None
        if fault == "commit-before":
            raise sqlite3.OperationalError("synthetic-before-commit")
        super().commit()
        if fault == "commit-after":
            raise sqlite3.OperationalError("synthetic-lost-response-after-real-commit")


@pytest.mark.parametrize("point", ["record", "change", "head", "receipt", "commit-before"])
def test_fault_at_each_transaction_step_preserves_whole_previous_database(point):
    conn = create_candidate(factory=FaultConnection)
    try:
        seed(conn)
        before = business(conn)
        conn.fault = point
        result = repo.apply_sync_local(conn, request("req-fault", 1, operation(changes={"cost": 2}, base={"cost": 1}), operation("000002::B", changes=VALUES)))
        assert result.status == 503
        assert result.body["error"]["code"] == ("sync_result_unknown" if point == "commit-before" else "storage_unavailable")
        assert "synthetic" not in json.dumps(result.body)
        assert business(conn) == before and head(conn) == 1
        assert conn.in_transaction is False
        if point == "commit-before":
            unknown = repo.reconcile(conn, "req-fault", parse_sync_request(request("req-fault", 1, operation(changes={"cost": 2}, base={"cost": 1}), operation("000002::B", changes=VALUES))).request_hash())
            assert unknown.state == "absent" and unknown.result is None
    finally:
        conn.close()


def test_real_commit_lost_response_then_readonly_reconcile_exact_receipt_after_restart(tmp_path):
    path = tmp_path / "synthetic-owner-sync.sqlite3"
    conn = create_candidate(path, factory=FaultConnection)
    raw = request("req-unknown")
    conn.fault = "commit-after"
    result = repo.apply_sync_local(conn, raw)
    assert result.status == 503 and result.body["error"]["code"] == "sync_result_unknown"
    assert head(conn) == 1 and len(business(conn)["owner_sync_receipts"]) == 1
    conn.close()
    reopened = sqlite3.connect(path)
    try:
        before = business(reopened)
        reconciled = repo.reconcile(reopened, "req-unknown", parse_sync_request(raw).request_hash())
        assert reconciled.state == "matched" and reconciled.result.status == 200
        assert reconciled.result == repo.read_sync_receipt(reopened, "req-unknown")
        assert repo.apply_sync_local(reopened, raw) == reconciled.result
        assert business(reopened) == before
        assert repo.reconcile(reopened, "req-unknown", "0" * 64).state == "unavailable"
    finally:
        reopened.close()


def test_trusted_authorization_callback_rolls_back_and_preserves_exception(conn):
    class AuthorizationLost(Exception): pass
    def check(): raise AuthorizationLost("fixed-no-authorization")
    with pytest.raises(AuthorizationLost):
        repo.apply_sync_local(conn, request(), before_commit=check)
    assert head(conn) == 0 and all(not rows for rows in business(conn).values())


@pytest.mark.parametrize("reader", ["apply", "receipt", "changes", "reconcile"])
def test_schema_drift_between_preflight_and_begin_is_rejected_under_transaction(reader):
    conn = create_candidate(factory=FaultConnection)
    try:
        conn.fault = "schema-before-begin"
        if reader == "apply":
            result = repo.apply_sync_local(conn, request())
            assert result.body["error"]["code"] == "schema_unavailable"
        elif reader == "reconcile":
            assert repo.reconcile(conn, "req-0001", parse_sync_request(request()).request_hash()).state == "unavailable"
        else:
            with pytest.raises(repo.SyncReadError) as caught:
                (repo.read_sync_receipt(conn, "req-0001") if reader == "receipt" else repo.read_sync_changes(conn))
            assert caught.value.code == "schema_unavailable"
        assert not conn.in_transaction and head(conn) == 0
        assert all(not rows for rows in business(conn).values())
    finally: conn.close()


def test_authorization_recheck_also_applies_to_exact_receipt_replay(conn):
    original = repo.apply_sync_local(conn, request())
    before = business(conn)
    class AuthorizationLost(Exception): pass
    def check(): raise AuthorizationLost()
    with pytest.raises(AuthorizationLost):
        repo.apply_sync_local(conn, request(), before_commit=check)
    assert business(conn) == before
    assert repo.read_sync_receipt(conn, "req-0001") == original


@pytest.mark.parametrize("constant", ["MAX_RECORDS", "MAX_CHANGES", "MAX_RECEIPTS"])
def test_capacity_exhaustion_is_explicit_and_never_deletes_or_partially_writes(conn, monkeypatch, constant):
    seed(conn)
    before = business(conn)
    monkeypatch.setattr(repo, constant, 1)
    result = repo.apply_sync_local(conn, request("req-full", 1, operation("000002::B", changes=VALUES)))
    assert result.status == 503 and result.body["error"]["code"] == "capacity_exhausted"
    assert business(conn) == before and head(conn) == 1


def test_revision_capacity_exhaustion_is_not_an_implicit_history_reset(conn, monkeypatch):
    seed(conn)
    before = business(conn)
    monkeypatch.setattr(repo, "MAX_SAFE_REVISION", 1)
    result = repo.apply_sync_local(conn, request("req-revfull", 1, operation(changes={"cost": 2}, base={"cost": 1})))
    assert result.body["error"]["code"] == "capacity_exhausted"
    assert business(conn) == before and head(conn) == 1


@pytest.mark.parametrize("raw", [b"not-json", b"[]", request("req-bool", 0, operation(changes={**VALUES, "shares": True})), request("req-dupe", 0, operation(changes=VALUES), operation(KEY + " ", changes=VALUES)), b'{"request_id":"req-0001","request_id":"req-0002"}'])
def test_invalid_requests_never_open_business_transaction_or_echo_inputs(conn, raw):
    trace = []
    conn.set_trace_callback(trace.append)
    result = repo.apply_sync_local(conn, raw)
    assert result.status == 422 and result.body["error"]["code"] == "invalid_request"
    assert not any(sql.startswith("BEGIN") for sql in trace)
    assert head(conn) == 0


def test_unprovenanced_model_cannot_supply_request_hash(conn):
    model = OwnerSyncRequest.model_validate(json.loads(request()))
    assert repo.apply_sync_local(conn, model).status == 422
    parsed = parse_sync_request(request())
    assert repo.apply_sync_local(conn, parsed).status == 422
    assert repo.apply_sync_local(conn, parsed.model_copy(update={"expected_revision": 1})).status == 422
    assert head(conn) == 0
    assert repo.apply_sync_local(conn, request()).status == 200


@pytest.mark.parametrize("expected", [0, 2])
def test_missing_current_tombstone_with_retained_history_is_not_a_new_identity(conn, expected):
    seed(conn)
    assert repo.apply_sync_local(conn, request("req-removed", 1, operation(deleted=True))).status == 200
    conn.execute("DELETE FROM owner_sync_records WHERE sync_key=?", (KEY,))
    conn.commit()
    before = business(conn)
    result = repo.apply_sync_local(conn, request("req-recreate", expected, operation(changes=VALUES)))
    assert result.status == 503 and result.body["error"]["code"] == "integrity_unavailable"
    assert business(conn) == before and head(conn) == 2


def test_missing_schema_not_created_and_external_transaction_not_touched():
    empty = sqlite3.connect(":memory:")
    try:
        assert repo.apply_sync_local(empty, request()).body["error"]["code"] == "schema_unavailable"
        assert empty.execute("SELECT name FROM sqlite_master").fetchall() == []
        empty.execute("BEGIN")
        assert repo.apply_sync_local(empty, request()).body["error"]["code"] == "storage_unavailable"
        assert empty.in_transaction
    finally: empty.close()


@pytest.mark.parametrize("table,column,expression", [
    ("owner_sync_records", "payload_json", "'{}'"),
    ("owner_sync_records", "field_revisions_json", "'{}'"),
    ("owner_sync_records", "field_revisions_json", "'{\"cost\":true}'"),
    ("owner_sync_receipts", "response_json", "'{}'"),
])
def test_corrupt_typed_record_or_receipt_fail_closed_without_business_mutation(conn, table, column, expression):
    seed(conn)
    conn.execute(f"UPDATE {table} SET {column}={expression}")
    conn.commit()
    before = business(conn)
    raw = request() if table == "owner_sync_receipts" else request("req-corrupt", 1, operation(changes={"cost": 2}, base={"cost": 1}))
    result = repo.apply_sync_local(conn, raw)
    assert result.status == 503 and result.body["error"]["code"] == "integrity_unavailable"
    assert business(conn) == before


@pytest.mark.parametrize("kwargs", [{"since_revision": True}, {"upper_revision": 2}, {"limit": 0}, {"cursor": (True, "")}, {"cursor": (2, KEY)}, {"since_revision": 1, "cursor": (0, "")}])
def test_paging_parameters_reject_invalid_or_future_watermarks(conn, kwargs):
    seed(conn)
    with pytest.raises(repo.SyncReadError) as caught:
        repo.read_sync_changes(conn, **kwargs)
    assert caught.value.status == 422
    assert not conn.in_transaction


def test_changes_corruption_rejects_history_not_current_join(conn):
    seed(conn)
    conn.execute("UPDATE owner_sync_changes SET snapshot_json='{}'")
    conn.commit()
    with pytest.raises(repo.SyncReadError) as caught:
        repo.read_sync_changes(conn)
    assert caught.value.code == "integrity_unavailable"


@pytest.mark.parametrize("corruption", ["head-gap", "record-event-drift", "history-gap"])
def test_valid_shaped_but_inconsistent_history_and_current_record_fail_closed(conn, corruption):
    seed(conn)
    if corruption == "head-gap":
        conn.execute("UPDATE owner_sync_state SET revision=2")
    if corruption == "record-event-drift":
        conn.execute("UPDATE owner_sync_records SET payload_json=?", (repo._json({**VALUES, "cost": 9}),))
    if corruption == "history-gap":
        conn.execute("DELETE FROM owner_sync_changes")
    conn.commit()
    before = business(conn)
    result = repo.apply_sync_local(conn, request("req-integrity", 1, operation(changes={"cost": 2}, base={"cost": 1})))
    assert result.body["error"]["code"] == "integrity_unavailable"
    assert business(conn) == before


def test_receipt_reads_use_one_real_wal_snapshot_under_a_concurrent_committed_write(tmp_path):
    path = tmp_path / "synthetic-read-snapshot.sqlite3"
    setup = create_candidate(path)
    seed(setup)
    setup.execute("PRAGMA journal_mode=WAL")
    setup.close()
    writer = sqlite3.connect(path)
    class ReadInterleave(sqlite3.Connection):
        once = False
        def execute(self, sql, parameters=(), /):
            if not self.once and sql.startswith("SELECT request_id, request_hash"):
                self.once = True
                assert repo.apply_sync_local(writer, request("req-between", 1, operation(changes={"cost": 2}, base={"cost": 1}))).status == 200
            return super().execute(sql, parameters)
    reader = sqlite3.connect(path, factory=ReadInterleave)
    try:
        assert repo.read_sync_receipt(reader, "req-between") is None  # Snapshot existed before writer commit.
        assert repo.read_sync_receipt(reader, "req-between").body["revision"] == 2
        assert repo.read_sync_changes(reader)["upper_revision"] == 2
    finally:
        reader.close(); writer.close()


def test_reconcile_absent_and_unavailable_do_not_allocate_or_mutate_requests(conn):
    raw = request("req-pending")
    assert repo.reconcile(conn, "req-pending", parse_sync_request(raw).request_hash()).state == "absent"
    before = business(conn)
    conn.close()
    result = repo.reconcile(conn, "req-pending", parse_sync_request(raw).request_hash())
    assert result.state == "unavailable" and result.request_id == "req-pending" and result.result is None
    assert all(not rows for rows in before.values())


def test_two_real_connections_serialize_conflicts_and_exact_same_id(tmp_path):
    path = tmp_path / "synthetic-two-devices.sqlite3"
    creator = create_candidate(path)
    seed(creator)
    creator.close()
    raw = request("req-shared", 1, operation(changes={"cost": 2}, base={"cost": 1}))
    def call(payload):
        conn = sqlite3.connect(path, timeout=5)
        try: return repo.apply_sync_local(conn, payload)
        finally: conn.close()
    with ThreadPoolExecutor(max_workers=2) as pool:
        first, second = list(pool.map(call, [raw, raw]))
    assert first == second and first.status == 200
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(call, [request("req-device1", 2, operation(changes={"cost": 3}, base={"cost": 2})), request("req-device2", 2, operation(changes={"cost": 4}, base={"cost": 2}))]))
    assert sorted(result.status for result in outcomes) == [200, 409]
    final = sqlite3.connect(path)
    try:
        assert head(final) == 3
        assert len(business(final)["owner_sync_receipts"]) == 4
    finally: final.close()
