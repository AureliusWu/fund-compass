"""指数估值数据加载器：乐咕乐股 PE/PB 分位 + 基金→指数映射。

模块导入时一次性加载到内存，后续请求纯字典查询。文件缺失或解析失败静默降级
（所有 lookup 返回 None），由调用方 valuation_layer 回退到去趋势净值分位代理。

V3-5 步骤2：步骤1 产出的 index-valuation.json + fund_index_map.json 在此消费。
"""
import json
import logging
import os

log = logging.getLogger(__name__)

# ── 模块级缓存（导入时初始化，此后只读）──
_valuation_data: dict | None = None
_index_map: dict[str, str] | None = None


def _init():
    global _valuation_data, _index_map
    base = os.path.dirname(__file__)  # backend/strategy/

    # 1. 指数估值数据 → 来自 tools/enrich_index_valuation.py（CI 产出）
    val_path = os.path.join(base, "..", "..", "frontend", "public", "data", "index-valuation.json")
    try:
        with open(val_path, encoding="utf-8") as f:
            _valuation_data = json.load(f)
        n = len(_valuation_data.get("indices", []))  # type: ignore[union-attr]
        log.info("加载指数估值数据: %d 个指数, 更新于 %s", n, _valuation_data.get("updated", "?"))  # type: ignore[union-attr]
    except FileNotFoundError:
        log.warning("指数估值文件不存在: %s，估值层将使用去趋势代理", val_path)
    except (json.JSONDecodeError, OSError) as e:
        log.warning("指数估值文件加载失败: %s", e)

    # 2. 基金→指数映射
    map_path = os.path.join(base, "..", "..", "tools", "fund_index_map.json")
    try:
        with open(map_path, encoding="utf-8") as f:
            raw = json.load(f)
        _index_map = {k: v for k, v in raw.items() if not k.startswith("_")}
        log.info("加载基金→指数映射: %d 条", len(_index_map))
    except FileNotFoundError:
        log.warning("基金指数映射文件不存在: %s", map_path)
    except (json.JSONDecodeError, OSError) as e:
        log.warning("基金指数映射文件加载失败: %s", e)


_init()


def lookup(fund_code: str) -> dict | None:
    """根据基金代码查找指数 PE/PB 估值数据。

    返回值::

        {
            "index_name": "沪深300",
            "pe": 13.76, "pe_pct": 66.2,
            "pb": 1.44, "pb_pct": 31.2,
            "date": "2026-06-29",
            "source": "legulegu",
            "updated": "2026-06-29",
        }

    若该基金无映射、映射的指数无估值数据、或 PE 分位缺失（主信号不可用）→ 返回 None，
    由调用方回退到去趋势净值分位代理。
    """
    if not _valuation_data or not _index_map:
        return None
    index_name = _index_map.get(fund_code)
    if not index_name:
        return None
    indices = _valuation_data.get("indices", [])
    for idx in indices:
        if idx.get("name") == index_name:
            if idx.get("pe_pct") is None:
                return None  # PE 分位缺失则回退
            return {
                "index_name": index_name,
                "pe": idx.get("pe"),
                "pe_pct": idx.get("pe_pct"),
                "pb": idx.get("pb"),
                "pb_pct": idx.get("pb_pct"),
                "date": idx.get("date"),
                "source": _valuation_data.get("source", "legulegu"),
                "updated": _valuation_data.get("updated"),
            }
    log.debug("指数 %s 在估值数据中未找到（已映射但数据源未覆盖）", index_name)
    return None
