"""Fixed-slot and real-Connection synthetic tests; no remote/provider evidence."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import re
import sqlite3
import struct

import pytest

from database import db, turso
from database.v8_insert import prepare_v8_insert
from models.v8 import EvidenceSnapshot, SourceState, payload_sha256, stable_id
from service import repository_scopes as scopes, v8_repo
from strategy.decision_v2 import build_decision_snapshot, build_holding_version, build_portfolio_policy


T0 = datetime(2026, 8, 25, 6, 30, tzinfo=timezone.utc)
T1 = datetime(2026, 8, 25, 7, 30, tzinfo=timezone.utc)
TABLES = (
    "evidence_snapshots", "source_health_events", "holding_versions", "portfolio_policy_versions",
    "decision_snapshots", "portfolio_decision_snapshots", "outcome_evaluations",
    "portfolio_outcome_evaluations", "notification_events", "idempotency_responses",
)
REAL_COUNTS = (14, 2, 5, 3, 0, 3, 8, 5, 0, 0)
FIXTURE_REAL = 13 / 482  # Public binary64 fixture, not private production data.


def bits(value):
    return struct.pack(">d", value)


def schema_columns(table):
    """Independent schema source, not the compiler's private allowlist."""
    conn = sqlite3.connect(":memory:")
    try:
        for statement in db.V8_SCHEMA_STATEMENTS:
            if re.match(r"\s*CREATE TABLE IF NOT EXISTS " + table + r"\s*\(", statement):
                conn.execute(statement)
                return [(row[1], row[2]) for row in conn.execute("PRAGMA table_info(" + table + ")")]
        pytest.fail("missing fixed repository schema")
    finally:
        conn.close()


def params_for(table, real=FIXTURE_REAL):
    return tuple(
        real if kind == "REAL" else 1 if kind == "INTEGER" else "literal ? ' -- /* */"
        for name, kind in schema_columns(table)
        if not (table == "idempotency_responses" and name in {"state", "response_json", "completed_at"})
    )


@pytest.mark.parametrize("table,real_count", tuple(zip(TABLES, REAL_COUNTS)))
@pytest.mark.parametrize("real", [FIXTURE_REAL, -FIXTURE_REAL, 0.0, -0.0, None, 5e-324, float.fromhex("0x1.fffffffffffffp+1023")])
def test_fixed_slots_match_repository_schema_and_evaluate_exactly(table, real_count, real):
    parameters = params_for(table, real)
    sql, bound = prepare_v8_insert(object(), table, parameters)
    columns = schema_columns(table)
    assert sum(kind == "REAL" for _, kind in columns) == real_count
    assert "INSERT INTO " + table + "(" + ",".join(name for name, _ in columns) + ")" in sql
    assert not any(isinstance(value, float) for value in bound)
    assert len(bound) == len(parameters)
    # Deliberately constraint-free table tests the fixed value projection. The
    # actual repositories below use the complete unmodified schema/guards.
    conn = sqlite3.connect(":memory:")
    try:
        conn.execute("CREATE TABLE " + table + "(" + ",".join(name + " " + kind for name, kind in columns) + ")")
        conn.execute(sql, bound)
        row = conn.execute("SELECT * FROM " + table).fetchone()
        for index, (name, kind) in enumerate(columns):
            actual = row[index]
            if table == "idempotency_responses" and name in {"state", "response_json", "completed_at"}:
                assert actual == ("in_progress" if name == "state" else None)
            elif kind == "REAL":
                canonical_real = 0.0 if real == 0 else real
                assert actual is None if real is None else type(actual) is float and bits(actual) == bits(canonical_real)
            elif kind == "INTEGER":
                assert type(actual) is int and actual == 1
            else:
                assert actual == "literal ? ' -- /* */"
    finally:
        conn.close()


def test_native_sqlite_keeps_original_parameter_objects_and_zero_behavior():
    conn = sqlite3.connect(":memory:")
    try:
        parameters = params_for("holding_versions", -0.0)
        sql, bound = prepare_v8_insert(conn, "holding_versions", parameters)
        assert bound is parameters
        assert sql.count("?") == 14 and "CAST" not in sql
        assert bits(bound[3]) == bits(-0.0)
        conn.execute("CREATE TABLE holding_versions(" + ",".join(name + " " + kind for name, kind in schema_columns("holding_versions")) + ")")
        conn.execute(sql, bound)
        # Physical REAL storage may normalize zero; do not assert its sign.
        assert conn.execute("SELECT shares,typeof(shares) FROM holding_versions").fetchone() == (0.0, "real")
    finally:
        conn.close()


@pytest.mark.parametrize("table", TABLES)
def test_native_sqlite_reuses_only_fixed_sql_never_private_parameter_tuples(table):
    conn = sqlite3.connect(":memory:")
    try:
        first = params_for(table, FIXTURE_REAL)
        second = params_for(table, -0.0)
        first_sql, first_bound = prepare_v8_insert(conn, table, first)
        second_sql, second_bound = prepare_v8_insert(conn, table, second)
        assert first_sql is second_sql
        assert first_bound is first and second_bound is second
        assert first_bound is not second_bound
        assert "CAST" not in first_sql
        assert first_sql.count("?") == len(first)
        if any(kind == "REAL" for _, kind in schema_columns(table)):
            assert any(type(value) is float and bits(value) == bits(-0.0) for value in second_bound)
    finally:
        conn.close()


@pytest.mark.parametrize("bad", [float("inf"), float("-inf"), float("nan"), 1, True, "0.1"])
def test_exact_real_slots_fail_closed_without_normalizing(bad):
    with pytest.raises((TypeError, ValueError)):
        prepare_v8_insert(object(), "holding_versions", params_for("holding_versions", bad))


@pytest.mark.parametrize("column", [8, 9])
def test_decision_strength_and_confidence_remain_integer_slots(column):
    parameters = list(params_for("decision_snapshots"))
    parameters[column] = 1.0
    with pytest.raises(TypeError, match="outside fixed V8 REAL"):
        prepare_v8_insert(object(), "decision_snapshots", tuple(parameters))
    parameters[column] = 1
    sql, args = prepare_v8_insert(object(), "decision_snapshots", tuple(parameters))
    assert "CAST" not in sql and type(args[column]) is int


@pytest.mark.parametrize("table,parameters", [
    ("evidence_snapshots; DROP TABLE holding_versions", ()), ("production_evidence_snapshots", ()),
    ("holding_versions", ()), ("holding_versions", []), (None, ()),
])
def test_compiler_has_no_input_sql_or_schema_escape(table, parameters):
    with pytest.raises(ValueError, match="fixed V8 INSERT"):
        prepare_v8_insert(object(), table, parameters)


class Response:
    status_code = 200

    def __init__(self, payload):
        self.payload = payload
        self.closed = False

    def json(self):
        return self.payload

    def close(self):
        self.closed = True


class FakeSession:
    """Hrana JSON execute/get_autocommit/close over fresh synthetic SQLite."""

    def __init__(self, path, statements):
        self.headers = {}
        self.conn = sqlite3.connect(path)
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.statements = statements
        self.closed = False
        self.responses = []

    def post(self, url, **options):
        assert url == "https://synthetic.example.invalid/v3/pipeline"
        assert options["allow_redirects"] is False
        frame = options["json"]
        results = []
        closing = False
        for request in frame["requests"]:
            kind = request["type"]
            if kind == "execute":
                statement = request["stmt"]
                sql = statement["sql"]
                wire_args = statement.get("args", [])
                args = tuple(turso._decode(value) for value in wire_args)
                self.statements.append((sql, args, tuple(value["type"] for value in wire_args)))
                # Every repository statement in this fixture must avoid the
                # vulnerable native float request path, not just Evidence.
                assert not any(isinstance(value, float) for value in args)
                try:
                    cursor = self.conn.execute(sql, args)
                    names = [item[0] for item in cursor.description or ()]
                    result = {
                        "cols": [{"name": name, "decltype": None} for name in names],
                        "rows": [[turso._encode(value) for value in row] for row in cursor.fetchall()],
                        "affected_row_count": max(cursor.rowcount, 0),
                        "last_insert_rowid": str(cursor.lastrowid) if cursor.lastrowid is not None else None,
                    }
                    results.append({"type": "ok", "response": {"type": kind, "result": result}})
                except sqlite3.Error as error:
                    results.append({"type": "error", "error": {"code": error.sqlite_errorname}})
            elif kind == "get_autocommit":
                results.append({"type": "ok", "response": {"type": kind, "is_autocommit": not self.conn.in_transaction}})
            elif kind == "close":
                closing = True
                results.append({"type": "ok", "response": {"type": kind}})
            else:
                pytest.fail("unexpected synthetic operation")
        response = Response({"baton": None if closing else "synthetic-baton", "base_url": None, "results": results})
        self.responses.append(response)
        return response

    def close(self):
        self.closed = True
        self.conn.close()


@pytest.fixture
def synthetic_db(tmp_path, monkeypatch):
    path = tmp_path / "v8-exact.sqlite3"
    monkeypatch.setenv("FUND_DB_BACKEND", "sqlite")
    monkeypatch.setattr(db, "DB_PATH", str(path))
    db.init_db()
    return path


def use_turso(path, monkeypatch):
    statements, sessions = [], []

    def get_conn():
        conn = turso.Connection("libsql://synthetic.example.invalid", "synthetic-test-token")
        conn._session.close()
        session = FakeSession(path, statements)
        sessions.append(session)
        conn._session = session
        assert type(conn) is turso.Connection
        return conn

    monkeypatch.setattr(db, "get_conn", get_conn)
    return statements, sessions


def evidence(**updates):
    payload = {
        "evidence_id": "ev_" + "0" * 64, "fund_code": "510300", "fund_name": "Synthetic fixture",
        "fund_type": "指数型", "created_at": T0, "market_time": T0,
        "official_nav": 1.0, "official_nav_date": "2026-08-25", "target_nav_date": "2026-08-26",
        "valuation_percentile": FIXTURE_REAL, "drawdown": -FIXTURE_REAL, "volatility": FIXTURE_REAL,
        "market_temperature": FIXTURE_REAL, "score": 82.0, "score_version": "synthetic-exact",
        "score_coverage": 1.0, "timing_signal": "买入", "timing_coverage": 1.0,
        "estimate": FIXTURE_REAL, "estimate_status": "fresh", "estimate_coverage": FIXTURE_REAL,
        "estimate_model_version": "synthetic-exact", "estimate_error_p80": FIXTURE_REAL,
        "estimate_sample_count": 30, "estimate_mae": FIXTURE_REAL,
        "estimate_direction_accuracy": FIXTURE_REAL, "evidence_strength": 80.0,
        "source_states": [SourceState(source_id="synthetic", state="healthy", latency_ms=FIXTURE_REAL,
                                      data_age_seconds=0.0, stale=False)],
    }
    payload.update(updates)
    snapshot = EvidenceSnapshot.model_validate(payload)
    return snapshot.model_copy(update={"evidence_id": stable_id("ev", v8_repo._evidence_identity(snapshot))})


def snapshot_rows(path):
    conn = sqlite3.connect(path)
    try:
        return {table: list(conn.execute("SELECT * FROM " + table + " ORDER BY rowid"))
                for table in (*TABLES, "v8_repository_scopes", "v8_record_scopes")}
    finally:
        conn.close()


def test_real_turso_connection_repository_writes_exact_projections_and_replays(synthetic_db, monkeypatch):
    statements, sessions = use_turso(synthetic_db, monkeypatch)
    candidate = evidence()
    assert v8_repo.save_evidence(candidate) == candidate
    holding = v8_repo.save_holding(build_holding_version(
        "510300", is_held=True, shares=FIXTURE_REAL, cost=0.0, market_value=None,
        current_weight=15.0, target_weight=20.0, source="synthetic-exact", created_at=T0,
    ))
    policy = v8_repo.save_policy(build_portfolio_policy(
        name="Synthetic policy", max_single_fund_weight=40.0, max_theme_weight=50.0,
        rebalance_band=FIXTURE_REAL, source="synthetic-exact", effective_at=T0, created_at=T0,
    ))
    decision = v8_repo.save_decision(build_decision_snapshot(candidate, holding, policy, created_at=T1))
    before = snapshot_rows(synthetic_db)
    assert v8_repo.save_evidence(candidate.model_copy(update={"created_at": T1})) == candidate
    assert v8_repo.save_holding(holding.model_copy(update={"created_at": T1})) == holding
    assert v8_repo.save_decision(decision.model_copy(update={"created_at": T1})) == decision
    assert snapshot_rows(synthetic_db) == before
    reader = sqlite3.connect(synthetic_db)
    try:
        row = reader.execute("SELECT estimate,estimate_coverage,payload_json,payload_sha256 FROM evidence_snapshots").fetchone()
        assert bits(row[0]) == bits(FIXTURE_REAL) and bits(row[1]) == bits(FIXTURE_REAL)
        assert row[2] == v8_repo._json(candidate.model_dump(mode="python"))
        assert row[3] == payload_sha256(v8_repo._evidence_identity(candidate))
        assert reader.execute("SELECT shares,cost,market_value FROM holding_versions").fetchone() == (FIXTURE_REAL, 0.0, None)
        assert reader.execute("SELECT typeof(strength),typeof(confidence) FROM decision_snapshots").fetchone() == ("integer", "integer")
    finally:
        reader.close()
    writes = [sql for sql, _, _ in statements if sql.startswith("INSERT INTO ")]
    assert {table for table in TABLES if any(sql.startswith("INSERT INTO " + table + "(") for sql in writes)} >= {
        "evidence_snapshots", "source_health_events", "holding_versions", "portfolio_policy_versions", "decision_snapshots",
    }
    assert sessions and all(session.closed and all(response.closed for response in session.responses) for session in sessions)


def test_real_turso_connection_reaches_all_ten_repository_inserts(synthetic_db, monkeypatch):
    native = sqlite3.connect(synthetic_db)
    try:
        native.executemany("INSERT INTO nav_history(code,date,nav) VALUES(?,?,?)", [
            ("510300", (T0.date() + timedelta(days=offset)).isoformat(), 1.0 + offset / 100)
            for offset in range(6)
        ])
        native.commit()
    finally:
        native.close()
    monkeypatch.setattr(v8_repo, "_now", lambda: datetime(2026, 9, 1, 6, 30, tzinfo=timezone.utc))
    statements, sessions = use_turso(synthetic_db, monkeypatch)
    candidate = v8_repo.save_evidence(evidence())
    policy = v8_repo.save_policy(build_portfolio_policy(
        name="Synthetic policy", target_allocations={"510300": 20.0},
        max_single_fund_weight=40.0, max_theme_weight=50.0, rebalance_band=FIXTURE_REAL,
        source="synthetic-exact", effective_at=T0, created_at=T0,
    ))
    holding = v8_repo.save_holding(build_holding_version(
        "510300", is_held=True, shares=FIXTURE_REAL, cost=0.0, current_weight=15.0,
        target_weight=20.0, source="synthetic-exact", created_at=T0,
    ))
    decision = v8_repo.save_decision(build_decision_snapshot(candidate, holding, policy, created_at=T1))
    portfolio = v8_repo.save_portfolio_decision(v8_repo.build_portfolio_decision_snapshot(
        [{"code": "510300", "theme": None}],
        {
            "complete": True, "errors": [], "policy_version": policy.policy_version,
            "strategy_version": decision.strategy_version,
            "decisions": [{"code": "510300", "name": candidate.fund_name, "action": decision.action,
                           "decision": decision.model_dump(mode="json"), "evidence": candidate.model_dump(mode="json"),
                           "holding": holding.model_dump(mode="json")}],
            "rebalance": [{"code": "510300", "theme": None, "current_weight": 15.0,
                           "target_weight": decision.position_guidance.target_weight}],
        },
        portfolio_value=FIXTURE_REAL,
    ))
    assert len(v8_repo.settle_outcomes(decision.decision_id, horizons=(5,))) == 2
    assert len(v8_repo.settle_portfolio_outcomes(portfolio.portfolio_decision_id, horizons=(5,))) == 1
    claimed = v8_repo.claim_idempotency("synthetic-request", "synthetic-endpoint", {"value": FIXTURE_REAL})
    assert claimed["state"] == "claimed"
    v8_repo.complete_idempotency("synthetic-request", "synthetic-endpoint", {"ok": True})
    v8_repo.record_notification_event(
        decision_id=decision.decision_id, scheduled_window="2026-08-25T14:30+08:00",
        status="scheduled", attempt_no=0, natural_schedule=False, occurred_at=T1,
    )
    writes = [(sql, args, kinds) for sql, args, kinds in statements if sql.startswith("INSERT INTO ")]
    assert {table for table in TABLES if any(sql.startswith("INSERT INTO " + table + "(") for sql, _, _ in writes)} == set(TABLES)
    assert all("float" not in kinds and not any(isinstance(value, float) for value in args) for _, args, kinds in writes)
    claim_sql, claim_args, _ = next(row for row in writes if row[0].startswith("INSERT INTO idempotency_responses("))
    assert "VALUES (?,?,?,'in_progress',NULL,?,?,?,NULL)" in claim_sql and len(claim_args) == 6
    assert all(session.closed and all(response.closed for response in session.responses) for session in sessions)


def test_natural_small_decline_settles_fund_and_portfolio_rounded_zeros_without_changing_producers(synthetic_db, monkeypatch):
    # A genuine small decline, not an artificial signed-zero input. Existing
    # outcome rounding yields -0.0; this test does not change that finance rule.
    native = sqlite3.connect(synthetic_db)
    try:
        native.executemany("INSERT INTO nav_history(code,date,nav) VALUES(?,?,?)", [
            ("510300", (T0.date() + timedelta(days=offset)).isoformat(), 999.9999 if offset == 5 else 1000.0)
            for offset in range(6)
        ])
        native.commit()
    finally:
        native.close()
    monkeypatch.setattr(v8_repo, "_now", lambda: datetime(2026, 9, 1, 6, 30, tzinfo=timezone.utc))
    statements, sessions = use_turso(synthetic_db, monkeypatch)
    candidate = v8_repo.save_evidence(evidence(official_nav=1000.0))
    policy = v8_repo.save_policy(build_portfolio_policy(
        name="Synthetic rounded-zero policy", target_allocations={"510300": 20.0},
        max_single_fund_weight=40.0, max_theme_weight=50.0,
        source="synthetic-exact", effective_at=T0, created_at=T0,
    ))
    holding = v8_repo.save_holding(build_holding_version(
        "510300", is_held=True, shares=1.0, current_weight=15.0, target_weight=20.0,
        source="synthetic-exact", created_at=T0,
    ))
    decision = v8_repo.save_decision(build_decision_snapshot(candidate, holding, policy, created_at=T1))
    portfolio = v8_repo.save_portfolio_decision(v8_repo.build_portfolio_decision_snapshot(
        [{"code": "510300", "theme": None}],
        {"complete": True, "errors": [], "policy_version": policy.policy_version,
         "strategy_version": decision.strategy_version,
         "decisions": [{"code": "510300", "name": candidate.fund_name, "action": decision.action,
                        "decision": decision.model_dump(mode="json"), "evidence": candidate.model_dump(mode="json"),
                        "holding": holding.model_dump(mode="json")}],
         "rebalance": [{"code": "510300", "theme": None, "current_weight": 15.0,
                        "target_weight": decision.position_guidance.target_weight}]},
    ))
    produced = []
    make = v8_repo._make_outcome
    calculate = v8_repo._calculate_portfolio_outcome

    def observe_make(*args, **kwargs):
        result = make(*args, **kwargs)
        produced.append(result)
        return result

    def observe_calculate(*args, **kwargs):
        result = calculate(*args, **kwargs)
        if result is not None:
            produced.append(result)
        return result

    monkeypatch.setattr(v8_repo, "_make_outcome", observe_make)
    monkeypatch.setattr(v8_repo, "_calculate_portfolio_outcome", observe_calculate)
    settled = v8_repo.settle_outcomes(decision.decision_id, horizons=(5,))
    portfolio_settled = v8_repo.settle_portfolio_outcomes(portfolio.portfolio_decision_id, horizons=(5,))
    assert len(settled) == 2 and len(portfolio_settled) == 1
    horizon = next(value for value in produced if getattr(value, "evaluation_kind", None) == "horizon")
    portfolio_raw = next(value for value in produced if hasattr(value, "portfolio_decision_id"))
    assert horizon.base_nav == 1000.0 and horizon.evaluated_nav == 999.9999
    for raw in (horizon, portfolio_raw):
        assert bits(raw.absolute_return) == bits(-0.0)
        assert bits(raw.max_drawdown) == bits(-0.0)
    reader = sqlite3.connect(synthetic_db)
    try:
        for table, raw in (("outcome_evaluations", horizon), ("portfolio_outcome_evaluations", portfolio_raw)):
            row = reader.execute("SELECT absolute_return,max_drawdown,typeof(absolute_return),typeof(max_drawdown),payload_json,payload_sha256 FROM "
                                 + table + " WHERE outcome_id=?", (raw.outcome_id,)).fetchone()
            assert bits(row[0]) == bits(0.0) and bits(row[1]) == bits(0.0)
            assert row[2:4] == ("real", "real")
            assert row[4] == v8_repo._json(raw.model_dump(mode="python"))
            assert row[5] == payload_sha256(v8_repo._without(raw.model_dump(mode="python"), "created_at"))
    finally:
        reader.close()
    before = snapshot_rows(synthetic_db)
    assert v8_repo.settle_outcomes(decision.decision_id, horizons=(5,)) == settled
    assert v8_repo.settle_portfolio_outcomes(portfolio.portfolio_decision_id, horizons=(5,)) == portfolio_settled
    assert snapshot_rows(synthetic_db) == before
    for raw in (horizon, portfolio_raw):
        assert bits(raw.absolute_return) == bits(-0.0) and bits(raw.max_drawdown) == bits(-0.0)
    assert all("float" not in kinds for sql, _, kinds in statements if sql.startswith("INSERT INTO "))
    assert all(session.closed and all(response.closed for response in session.responses) for session in sessions)


@pytest.mark.parametrize("field", ["estimate", "health"])
def test_fixed_v8_zero_projection_matches_native_sqlite_without_mutating_model_payload_or_identity(synthetic_db, tmp_path, monkeypatch, field):
    candidate = evidence(**({"estimate": -0.0} if field == "estimate" else {
        "source_states": [SourceState(source_id="synthetic", state="healthy", latency_ms=-0.0, stale=False)],
    }))
    original_id = candidate.evidence_id
    original_payload = v8_repo._json(candidate.model_dump(mode="python"))
    original_hash = payload_sha256(v8_repo._evidence_identity(candidate))
    negative = lambda: candidate.estimate if field == "estimate" else candidate.source_states[0].latency_ms
    assert bits(negative()) == bits(-0.0)
    native_path = tmp_path / "native-zero.sqlite3"
    with monkeypatch.context() as native:
        native.setattr(db, "DB_PATH", str(native_path))
        db.init_db()
        assert v8_repo.save_evidence(candidate) == candidate
    native_rows = snapshot_rows(native_path)
    statements, sessions = use_turso(synthetic_db, monkeypatch)
    assert v8_repo.save_evidence(candidate) == candidate
    assert snapshot_rows(synthetic_db) == native_rows
    assert bits(negative()) == bits(-0.0)
    assert candidate.evidence_id == original_id
    assert v8_repo._json(candidate.model_dump(mode="python")) == original_payload
    assert payload_sha256(v8_repo._evidence_identity(candidate)) == original_hash
    reader = sqlite3.connect(synthetic_db)
    try:
        row = reader.execute("SELECT estimate,typeof(estimate),payload_json,payload_sha256,benchmark_id FROM evidence_snapshots").fetchone()
        assert bits(row[0]) == bits(0.0 if field == "estimate" else FIXTURE_REAL)
        assert row[1:] == ("real", original_payload, original_hash, None)
        health = reader.execute("SELECT latency_ms,typeof(latency_ms),last_success,last_failure FROM source_health_events").fetchone()
        assert bits(health[0]) == bits(0.0 if field == "health" else FIXTURE_REAL)
        assert health[1:] == ("real", None, None)
    finally:
        reader.close()
    assert any(sql.startswith("INSERT INTO evidence_snapshots(") for sql, _, _ in statements)
    assert all(session.closed and all(response.closed for response in session.responses) for session in sessions)


def test_existing_negative_zero_idempotent_evidence_returns_without_recompile(synthetic_db, monkeypatch):
    candidate = evidence(estimate=-0.0)
    first = v8_repo.save_evidence(candidate)
    before = snapshot_rows(synthetic_db)
    statements, _ = use_turso(synthetic_db, monkeypatch)
    # Existing canonical JSON behavior is unchanged; no new normalization is
    # introduced to make a remote new-write pass.
    replay = v8_repo.save_evidence(candidate.model_copy(update={"created_at": T1}))
    assert replay.evidence_id == first.evidence_id and replay.created_at == first.created_at
    assert snapshot_rows(synthetic_db) == before
    assert not any(sql.startswith("INSERT ") for sql, _, _ in statements)


def test_evidence_sql_failure_rolls_back_evidence_health_and_scope(synthetic_db, monkeypatch):
    conn = sqlite3.connect(synthetic_db)
    conn.execute("CREATE TRIGGER synthetic_deny_health BEFORE INSERT ON source_health_events BEGIN SELECT RAISE(ABORT,'synthetic failure'); END")
    conn.close()
    before = snapshot_rows(synthetic_db)
    statements, _ = use_turso(synthetic_db, monkeypatch)
    with pytest.raises(sqlite3.IntegrityError):
        v8_repo.save_evidence(evidence())
    assert any(sql.startswith("INSERT INTO evidence_snapshots(") for sql, _, _ in statements)
    assert any(sql == "ROLLBACK" for sql, _, _ in statements)
    assert snapshot_rows(synthetic_db) == before


@pytest.mark.parametrize("kind", ["evidence", "holding", "policy", "decision"])
def test_actual_turso_path_keeps_cross_scope_replay_guard(synthetic_db, monkeypatch, kind):
    candidate = v8_repo.save_evidence(evidence())
    policy = v8_repo.save_policy(build_portfolio_policy(
        name="Synthetic policy", effective_at=T0, created_at=T0, source="synthetic-exact",
    ))
    holding = v8_repo.save_holding(build_holding_version(
        "510300", is_held=True, shares=FIXTURE_REAL, source="synthetic-exact", created_at=T0,
    ))
    decision = v8_repo.save_decision(build_decision_snapshot(candidate, holding, policy, created_at=T1))
    models = {"evidence": candidate, "policy": policy, "holding": holding, "decision": decision}
    synthetic_scope = scopes.acceptance_scope("v9-acceptance-exact-insert-scope-fixture")
    native = sqlite3.connect(synthetic_db)
    try:
        # Explicit local test tampering, never a repository or cloud operation.
        native.execute("DROP TRIGGER immutable_v8_record_scopes_update")
        native.execute("INSERT INTO v8_repository_scopes VALUES(?,?,?)",
                       (synthetic_scope.key, "acceptance", synthetic_scope.namespace))
        native.execute("UPDATE v8_record_scopes SET scope_key=? WHERE record_kind=?", (synthetic_scope.key, kind))
        native.commit()
    finally:
        native.close()
    before = snapshot_rows(synthetic_db)
    statements, _ = use_turso(synthetic_db, monkeypatch)
    with pytest.raises(ValueError, match="cross-scope write forbidden"):
        getattr(v8_repo, "save_" + kind)(models[kind])
    assert snapshot_rows(synthetic_db) == before
    assert not any(sql.startswith("INSERT ") for sql, _, _ in statements)


def test_actual_turso_pair_rolls_back_both_roots_and_scopes(synthetic_db, monkeypatch):
    statements, _ = use_turso(synthetic_db, monkeypatch)
    candidate = v8_repo.save_evidence(evidence())
    policy = v8_repo.save_policy(build_portfolio_policy(
        name="Synthetic policy", effective_at=T0, created_at=T0, source="synthetic-exact",
    ))
    holding = build_holding_version(
        "510300", is_held=True, shares=FIXTURE_REAL, cost=0.0, current_weight=15.0,
        target_weight=20.0, source="synthetic-exact", created_at=T0,
    )
    decision = build_decision_snapshot(candidate, holding, policy, created_at=T1)
    before = snapshot_rows(synthetic_db)
    register = scopes.register_record

    def fail_after_registration(conn, kind, identifier, scope):
        register(conn, kind, identifier, scope)
        if kind == "decision":
            raise RuntimeError("synthetic-after-decision-registration")

    monkeypatch.setattr(scopes, "register_record", fail_after_registration)
    with pytest.raises(RuntimeError, match="synthetic-after-decision-registration"):
        v8_repo.save_holding_and_decision(holding, decision)
    assert snapshot_rows(synthetic_db) == before
    assert any(sql.startswith("INSERT INTO holding_versions(") for sql, _, _ in statements)
    assert any(sql.startswith("INSERT INTO decision_snapshots(") for sql, _, _ in statements)
    assert any(sql == "ROLLBACK" for sql, _, _ in statements)


def test_transaction_protocol_preserved_and_has_no_float_parameters(synthetic_db):
    conn = sqlite3.connect(synthetic_db)
    conn.row_factory = sqlite3.Row
    candidate = build_holding_version(
        "510300", is_held=True, shares=FIXTURE_REAL, cost=0.0, current_weight=15.0,
        target_weight=20.0, source="synthetic-wrapper", created_at=T0,
    )
    seen = []

    class TransactionView:
        @property
        def in_transaction(self):
            return conn.in_transaction

        def execute(self, sql, args=()):
            seen.append((sql, args))
            assert not any(isinstance(value, float) for value in args)
            return conn.execute(sql, args)

        def commit(self):
            pytest.fail("kernel cannot commit")

        def rollback(self):
            pytest.fail("kernel cannot roll back")

        def close(self):
            pytest.fail("kernel cannot close")

    try:
        conn.execute("BEGIN IMMEDIATE")
        assert v8_repo._save_holding_in_transaction(TransactionView(), candidate) == candidate
        assert conn.in_transaction
        row = conn.execute("SELECT shares,cost,market_value FROM holding_versions").fetchone()
        assert bits(row[0]) == bits(FIXTURE_REAL) and row[1] == 0.0 and row[2] is None
        assert any("CAST" in sql for sql, _ in seen if sql.startswith("INSERT INTO holding_versions"))
        conn.rollback()
    finally:
        conn.close()


def test_native_sqlite_subclass_also_uses_fixed_exact_slots():
    class NativeSubclass(sqlite3.Connection):
        pass

    conn = sqlite3.connect(":memory:", factory=NativeSubclass)
    try:
        _, args = prepare_v8_insert(conn, "holding_versions", params_for("holding_versions"))
        assert not any(isinstance(value, float) for value in args)
    finally:
        conn.close()
