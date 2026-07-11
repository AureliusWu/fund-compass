"""指数估值数据加载器：乐咕乐股 PE/PB 分位 + 基金→指数映射。

模块导入时一次性加载到内存，后续请求纯字典查询。文件缺失或解析失败静默降级
（所有 lookup 返回 None），由调用方 valuation_layer 回退到去趋势净值分位代理。

V3-5 步骤2：步骤1 产出的 index-valuation.json + fund_index_map.json 在此消费。
"""
import json
import logging
import os
from datetime import date, datetime

log = logging.getLogger(__name__)

# ── 模块级缓存（导入时初始化，此后只读）──
_valuation_data: dict | None = None
_index_map: dict[str, str] | None = None
MAX_VALUATION_AGE_DAYS = 7


def _is_fresh(raw_date: str | None, today: date | None = None) -> bool:
    if not raw_date:
        return False
    try:
        observed = datetime.strptime(raw_date[:10], "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return False
    age = ((today or date.today()) - observed).days
    return 0 <= age <= MAX_VALUATION_AGE_DAYS

INDEX_ALIASES = {
    "创业板指数": "创业板指",
    "创业板综": "创业板指",
    "上证科创板50成份指数": "科创50",
    "中证消费": "中证主要消费",
    "消费指数": "中证主要消费",
    "中证酒": "中证白酒",
    "中证医药卫生": "中证医药",
    "全指医药": "中证医药",
    "中证全指证券公司": "证券公司",
    "证券指数": "证券公司",
    "中证全指半导体": "半导体",
    "国证芯片": "半导体",
}


def _canonical_index_name(name: str | None) -> str | None:
    if not name:
        return None
    return INDEX_ALIASES.get(name, name)


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
        _index_map = {k: _canonical_index_name(v) or v for k, v in raw.items() if not k.startswith("_")}
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
    if not _is_fresh(_valuation_data.get("updated")):
        return None
    index_name = _canonical_index_name(_index_map.get(fund_code))
    if not index_name:
        return None
    indices = _valuation_data.get("indices", [])
    for idx in indices:
        if _canonical_index_name(idx.get("name")) == index_name:
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


def unavailable_reason(fund_code: str) -> str | None:
    """说明已映射但无法使用真实 PE/PB 的原因，用于回退提示。"""
    if not _index_map:
        return None
    index_name = _canonical_index_name(_index_map.get(fund_code))
    if not index_name:
        return None
    if not _valuation_data:
        return f"已映射至 {index_name}，但指数估值数据尚未加载"
    if not _is_fresh(_valuation_data.get("updated")):
        return f"已映射至 {index_name}，但指数估值数据已过期"

    for item in _valuation_data.get("unsupported", []) or []:
        if _canonical_index_name(item.get("name")) == index_name:
            reason = item.get("reason")
            return f"已映射至 {index_name}，{reason}" if reason else f"已映射至 {index_name}，但该指数 PE/PB 暂未覆盖"

    indices = _valuation_data.get("indices", [])
    for idx in indices:
        if _canonical_index_name(idx.get("name")) == index_name:
            if idx.get("pe_pct") is None:
                return f"已映射至 {index_name}，但 PE 分位缺失"
            return None
    return f"已映射至 {index_name}，但估值数据源暂未覆盖"
