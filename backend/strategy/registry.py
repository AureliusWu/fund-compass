"""策略参数注册表：集中读取已通过验证的线上参数，异常时回退内置默认值。"""
import json
import os
from pathlib import Path


DEFAULT_WEIGHTS = {"买入": 1.0, "定投": 0.75, "持有": 0.5, "减仓": 0.25}
REGISTRY_PATH = Path(os.environ.get(
    "STRATEGY_REGISTRY_PATH",
    Path(__file__).resolve().parents[1] / "data" / "strategy-params.json",
))


def load_registry() -> dict:
    try:
        data = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
        active = data.get("active") or {}
        weights = active.get("weights")
        if not isinstance(weights, dict) or set(weights) != set(DEFAULT_WEIGHTS):
            raise ValueError("invalid active weights")
        active["weights"] = {key: float(weights[key]) for key in DEFAULT_WEIGHTS}
        return data
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return {
            "schema": 1,
            "active": {
                "version": "builtin-default",
                "weights": DEFAULT_WEIGHTS.copy(),
                "source": "fallback",
            },
            "candidate": None,
        }


def active_weights() -> dict:
    return load_registry()["active"]["weights"].copy()


def registry_summary() -> dict:
    data = load_registry()
    return {
        "active": data.get("active"),
        "candidate": data.get("candidate"),
        "history": data.get("history") or [],
        "updated_at": data.get("updated_at"),
    }
