"""指数估值加载器测试：lookup 命中 / 未映射 / PE缺失 / 数据为空。"""
import pytest


# 人造估值数据（与 index-valuation.json 结构一致）
SAMPLE_VALUATION = {
    "updated": "2026-06-29",
    "source": "legulegu",
    "indices": [
        {"name": "沪深300", "pe": 13.76, "pe_pct": 66.2, "pb": 1.44, "pb_pct": 31.2, "date": "2026-06-29"},
        {"name": "中证500", "pe": 33.19, "pe_pct": 71.0, "pb": 2.73, "pb_pct": 64.7, "date": "2026-06-29"},
        # 创业板指：有映射但 PE 分位缺失 → lookup 应返回 None
        {"name": "创业板指", "pe": None, "pe_pct": None, "pb": None, "pb_pct": None, "date": None},
    ],
}

SAMPLE_MAP = {"510300": "沪深300", "510500": "中证500", "159915": "创业板指"}


@pytest.fixture
def seeded_lookup(monkeypatch):
    """向 index_valuation 模块注入人造数据，测试后恢复原始值。"""
    import strategy.index_valuation as iv

    orig_val = iv._valuation_data
    orig_map = iv._index_map
    iv._valuation_data = SAMPLE_VALUATION
    iv._index_map = SAMPLE_MAP
    yield iv.lookup
    iv._valuation_data = orig_val
    iv._index_map = orig_map


class TestLookupHit:
    def test_hs300_etf(self, seeded_lookup):
        """沪深300 ETF 找到完整估值数据"""
        r = seeded_lookup("510300")
        assert r is not None
        assert r["index_name"] == "沪深300"
        assert r["pe"] == 13.76
        assert r["pe_pct"] == 66.2
        assert r["pb"] == 1.44
        assert r["pb_pct"] == 31.2
        assert r["source"] == "legulegu"
        assert r["updated"] == "2026-06-29"

    def test_zz500_etf(self, seeded_lookup):
        """中证500 ETF 找到估值数据"""
        r = seeded_lookup("510500")
        assert r is not None
        assert r["pe_pct"] == 71.0
        assert r["index_name"] == "中证500"

    def test_unmapped_fund(self, seeded_lookup):
        """未映射的基金返回 None"""
        assert seeded_lookup("000001") is None

    def test_mapped_but_pe_missing(self, seeded_lookup):
        """映射存在但 PE 分位为 None → 返回 None（回退到代理）"""
        assert seeded_lookup("159915") is None

    def test_unknown_code(self, seeded_lookup):
        """不存在的基金代码返回 None"""
        assert seeded_lookup("999999") is None


class TestLookupFallback:
    def test_empty_data(self, monkeypatch):
        """估值数据为空时所有 lookup 返回 None"""
        import strategy.index_valuation as iv

        orig_val = iv._valuation_data
        orig_map = iv._index_map
        iv._valuation_data = None
        iv._index_map = None
        try:
            assert iv.lookup("510300") is None
        finally:
            iv._valuation_data = orig_val
            iv._index_map = orig_map

    def test_empty_map(self, monkeypatch):
        """映射为空时返回 None"""
        import strategy.index_valuation as iv

        orig_map = iv._index_map
        iv._index_map = {}
        try:
            assert iv.lookup("510300") is None
        finally:
            iv._index_map = orig_map

    def test_map_has_index_not_in_valuation(self, monkeypatch):
        """映射指向的指数不在估值数据中 → 返回 None"""
        import strategy.index_valuation as iv

        orig_val = iv._valuation_data
        orig_map = iv._index_map
        iv._valuation_data = SAMPLE_VALUATION
        iv._index_map = {"588000": "科创50"}  # 映射存在但估值数据里没有
        try:
            assert iv.lookup("588000") is None
        finally:
            iv._valuation_data = orig_val
            iv._index_map = orig_map
