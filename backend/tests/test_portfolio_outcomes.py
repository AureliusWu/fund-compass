from database import db
from service import repo


def test_portfolio_snapshot_is_immutable_and_forward_only(monkeypatch, tmp_path):
    monkeypatch.setattr(db, "DB_PATH", str(tmp_path / "portfolio.db"))
    monkeypatch.setattr(repo, "get_conn", db.get_conn)
    db.init_db()
    conn = db.get_conn()
    try:
        for code, daily in (("000001", 0.01), ("000002", -0.005)):
            nav = 1.0
            for day in range(1, 23):
                conn.execute(
                    "INSERT INTO nav_history(code,date,nav,ac_return) VALUES (?,?,?,NULL)",
                    (code, f"2026-01-{day:02d}", nav),
                )
                nav *= 1 + daily
        conn.commit()
    finally:
        conn.close()
    decisions = [
        {"code": "000001", "name": "A", "as_of_nav": 1, "as_of_date": "2026-01-01", "action": "持有"},
        {"code": "000002", "name": "B", "as_of_nav": 1, "as_of_date": "2026-01-01", "action": "持有"},
    ]
    items = [{"code": "000001", "current_weight": 60}, {"code": "000002", "current_weight": 40}]
    assert repo.record_portfolio_decision(items, decisions, "v1") == 1
    assert repo.record_portfolio_decision(items, decisions, "v1") == 0
    result = repo.portfolio_decision_outcomes(horizons=(20,))
    assert result["mature"] == 1
    assert result["items"][0]["returns"]["20"]["components"] == 2
    assert result["items"][0]["returns"]["20"]["return"] > 0
