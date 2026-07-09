"""决策引擎（V6-P0）：单只基金 → 可执行决策卡片。

对外入口 decide_fund(detail, holding?)，内部复用评分 / 择时 / 回测三块算法。
"""
from strategy.backtest import backtest
from strategy.rules import build_decision
from strategy.scoring import score_fund
from strategy.timing import timing_signal


def decide_fund(
    detail: dict,
    holding: dict | None = None,
    *,
    score: dict | None = None,
    signal: dict | None = None,
    backtest_result: dict | None = None,
) -> dict:
    """对单只基金产出决策卡片：动作 / 置信度 / 理由 / 风险 / 仓位规则。"""
    sc = score if score is not None else score_fund(detail)
    sig = signal if signal is not None else timing_signal(detail)
    bt = backtest_result if backtest_result is not None else backtest(detail)
    return build_decision(detail, sc, sig, bt, holding)
