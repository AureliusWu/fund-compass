from database import db
from service import repo


def test_decision_outcomes_are_forward_only(monkeypatch, tmp_path):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "outcomes.db"))
    monkeypatch.setattr(repo, "get_conn", db.get_conn)
    db.init_db()
    conn = db.get_conn()
    try:
        conn.executemany(
            "INSERT INTO nav_history(code,date,nav,ac_return) VALUES (?,?,?,NULL)",
            [
                ("000001", "2026-01-01", 1.0),
                ("000001", "2026-01-02", 1.01),
                ("000001", "2026-01-03", 1.02),
                ("000001", "2026-01-04", 1.03),
                ("000001", "2026-01-05", 1.04),
                ("000001", "2026-01-06", 1.05),
                ("000002", "2026-01-01", 1.0),
                ("000002", "2026-01-02", 0.99),
                ("000002", "2026-01-03", 0.98),
                ("000002", "2026-01-04", 0.97),
                ("000002", "2026-01-05", 0.96),
                ("000002", "2026-01-06", 0.95),
                ("000003", "2026-01-01", 1.0),
                ("000003", "2026-01-02", 1.00),
                ("000003", "2026-01-03", 1.00),
                ("000003", "2026-01-04", 1.00),
                ("000003", "2026-01-05", 1.00),
                ("000003", "2026-01-06", 1.00),
            ],
        )
        conn.commit()
    finally:
        conn.close()

    written = repo.record_decisions([{
        "code": "000001",
        "name": "测试基金",
        "type": "混合型",
        "as_of_date": "2026-01-01",
        "as_of_nav": 1.0,
        "action": "分批买入",
        "confidence": "中",
    }], "v1")
    duplicate = repo.record_decisions([{
        "code": "000001", "as_of_date": "2026-01-01", "as_of_nav": 9.0,
        "action": "停止加仓", "confidence": "低",
    }], "v1")
    repo.record_decisions([{
        "code": "000002", "name": "同类基金", "type": "混合型",
        "as_of_date": "2026-01-01", "as_of_nav": 1.0,
        "action": "停止加仓", "confidence": "高",
    }], "v1")
    repo.record_decisions([{
        "code": "000003", "name": "第二只同类", "type": "混合型",
        "as_of_date": "2026-01-01", "as_of_nav": 1.0,
        "action": "持有观望", "confidence": "中",
    }], "v1")
    result = repo.decision_outcomes(horizons=(5,))

    assert written == 1
    assert duplicate == 0
    assert result["items"][0]["base_nav"] == 1.0
    first = next(row for row in result["items"] if row["code"] == "000001")
    assert first["returns"]["5"]["return"] == 5.0
    assert first["returns"]["5"]["max_drawdown"] == 0.0
    assert first["returns"]["5"]["excess_return"] == 7.5
    assert first["returns"]["5"]["benchmark_samples"] == 2
    assert result["mature"] == 3
    assert result["pending"] == 0
    assert result["breakdowns"]["confidence"][0]["horizon"] == 5
    assert all(row["hit_rate"] == 100.0 for row in result["summary"])


def test_version_comparison_is_read_only_and_sample_gated(monkeypatch, tmp_path):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "comparison.db"))
    monkeypatch.setattr(repo, "get_conn", db.get_conn)
    db.init_db()
    repo.record_decisions([{
        "code": "000001", "name": "新模型基金", "type": "混合型",
        "as_of_date": "2026-01-01", "as_of_nav": 1.0,
        "action": "观察", "confidence": "低",
        "methodology": {
            "score_version": "v3-risk-adjusted", "signal_version": "v3-coverage-gated",
            "score_coverage": 0.8, "signal_coverage": 0.75, "evidence_strength": "中",
        },
    }], "registry-v1")
    result = repo.version_comparison()
    assert result["frozen"] is True
    assert result["accepted"] is False
    assert result["guardrails"]["auto_tuning"] is False
    assert any("样本不足" in reason for reason in result["reasons"])
