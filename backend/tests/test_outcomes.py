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
    result = repo.decision_outcomes(horizons=(5,))

    assert written == 1
    assert duplicate == 0
    assert result["items"][0]["base_nav"] == 1.0
    assert result["items"][0]["returns"]["5"]["return"] == 5.0
    assert result["summary"][0]["hit_rate"] == 100.0
