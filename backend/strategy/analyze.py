"""策略层集成门面：把评分 / 择时 / 回测三块算法收敛到一个入口。

三者都只吃 M1 的详情字典（含 nav_history），彼此独立、互不依赖；分散在各端点里调用时，
每块都要单独把详情取一遍、再各自跑一次。这里把它们拼成 analyze_fund(detail)，
同一份净值历史只解析一次，上层（端点 / 脚本 / 回测批处理）拿单一对象即可，
不必关心内部由哪几支算法拼出来。
"""
from strategy.scoring import score_fund
from strategy.timing import timing_signal
from strategy.backtest import backtest


def analyze_fund(detail: dict) -> dict:
    """对单只基金详情一次性产出：综合评分 + 择时信号 + 策略回测。

    入参为 repo.get_detail(code) 的返回；三块算法共享同一 nav_history，
    回测内部按月重切片自行处理历史，与此处无耦合。
    """
    return {
        "score": score_fund(detail),
        "signal": timing_signal(detail),
        "backtest": backtest(detail),
    }
