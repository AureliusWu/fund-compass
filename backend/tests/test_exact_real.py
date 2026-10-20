"""Purely local exact-REAL binding tests; no files, network or credentials."""
import math
import random
import re
import sqlite3
import struct
import sys

import pytest

from database.exact_real import exact_real_binding


def _bits(value):
    return struct.pack(">d", value)


def test_none_retains_a_null_parameter_without_coercion():
    sql, parameters = exact_real_binding(None)
    assert sql == "?"
    assert parameters == (None,)
    with sqlite3.connect(":memory:") as connection:
        assert connection.execute("SELECT typeof(" + sql + ")," + sql + " IS NULL", parameters * 2).fetchone() == ("null", 1)


@pytest.mark.parametrize("value", [
    0.0, 1.0, -1.0, 2.0, -2.0, 13 / 482, 36 / 312, 55 / 1015,
    sys.float_info.min, -sys.float_info.min, sys.float_info.max, -sys.float_info.max,
    float.fromhex("0x0.0000000000001p-1022"), -float.fromhex("0x0.0000000000001p-1022"),
    float.fromhex("0x0.fffffffffffffp-1022"), float.fromhex("0x1p+1023"),
])
def test_finite_boundaries_keep_real_type_and_exact_bits(value):
    sql, parameters = exact_real_binding(value)
    assert type(sql) is str
    assert type(parameters) is tuple and len(parameters) == 1
    assert type(parameters[0]) is int and abs(parameters[0]) <= (1 << 53) - 1
    assert sql.count("?") == 1
    assert sql.startswith("(+") and sql.endswith(")")
    assert len(sql) < 1024
    for literal in re.findall(r"CAST\(([0-9]+) AS REAL\)", sql):
        factor = int(literal)
        assert 2 <= factor <= 1 << 62
        assert factor & (factor - 1) == 0
    with sqlite3.connect(":memory:") as connection:
        result = connection.execute("SELECT typeof(x),x FROM (SELECT " + sql + " AS x)", parameters).fetchone()
    assert result[0] == "real"
    assert type(result[1]) is float
    assert _bits(result[1]) == _bits(value)


def test_1000_seeded_public_binary64_patterns_roundtrip_in_memory():
    generator = random.Random(20261020)
    values = []
    while len(values) < 1000:
        value = struct.unpack(">d", generator.getrandbits(64).to_bytes(8, "big"))[0]
        if math.isfinite(value) and not (value == 0.0 and math.copysign(1.0, value) < 0):
            values.append(value)
    with sqlite3.connect(":memory:") as connection:
        for value in values:
            sql, parameters = exact_real_binding(value)
            assert len(parameters) == 1 and type(parameters[0]) is int
            result = connection.execute("SELECT " + sql, parameters).fetchone()[0]
            assert type(result) is float
            assert _bits(result) == _bits(value)


@pytest.mark.parametrize("value", [-0.0, float("inf"), -float("inf"), float("nan")])
def test_negative_zero_and_nonfinite_values_are_rejected(value):
    with pytest.raises(ValueError) as error:
        exact_real_binding(value)
    assert str(error.value) in {
        "exact REAL binding does not support negative zero",
        "exact REAL binding requires a finite float",
    }


@pytest.mark.parametrize("value", [False, True, 0, 1, -1, "1.0", b"value", (), [], {}])
def test_other_dbapi_types_are_not_silently_coerced(value):
    with pytest.raises(TypeError, match="^exact REAL binding accepts only native float or None$"):
        exact_real_binding(value)


def test_float_subclass_is_rejected_without_dynamic_conversion_or_repr():
    class UnexpectedFloat(float):
        def __float__(self):
            raise AssertionError("must not convert")

        def __repr__(self):
            raise AssertionError("must not format")

    with pytest.raises(TypeError, match="^exact REAL binding accepts only native float or None$"):
        exact_real_binding(UnexpectedFloat(1.0))


@pytest.mark.parametrize("value", [None, 0.0, 1.0, -1.0, 0.5, 13 / 482, float.fromhex("0x1p+1023")])
def test_no_affinity_comparisons_match_native_real_parameters(value):
    sql, parameters = exact_real_binding(value)
    # CAST alone introduces REAL expression affinity. In particular, a TEXT
    # literal '1' must not become equal to a native REAL-valued parameter 1.0.
    comparisons = ("='1'", " IS '1'", "='0'", " IS '0'", "=1", " IS 1", " IS NULL", " IS TRUE")
    with sqlite3.connect(":memory:") as connection:
        for suffix in comparisons:
            expected = connection.execute("SELECT ?" + suffix, (value,)).fetchone()[0]
            observed = connection.execute("SELECT " + sql + suffix, parameters).fetchone()[0]
            assert observed == expected
        if value == 1.0:
            assert connection.execute("SELECT CAST(? AS REAL)='1'", (1,)).fetchone()[0] == 1
            assert connection.execute("SELECT " + sql + "='1'", parameters).fetchone()[0] == 0


def test_fixed_template_insert_update_and_null_guards_use_only_integer_or_none_args():
    with sqlite3.connect(":memory:") as connection:
        connection.execute("CREATE TABLE sample(identity INTEGER PRIMARY KEY,value REAL)")
        sql, parameters = exact_real_binding(13 / 482)
        connection.execute("INSERT INTO sample(identity,value) VALUES(1," + sql + ")", parameters)
        observed = connection.execute("SELECT typeof(value),value FROM sample WHERE identity=1").fetchone()
        assert observed[0] == "real" and _bits(observed[1]) == _bits(13 / 482)
        sql, parameters = exact_real_binding(None)
        connection.execute("UPDATE sample SET value=" + sql + " WHERE identity=1", parameters)
        assert connection.execute("SELECT value IS " + sql + " FROM sample WHERE identity=1", parameters).fetchone()[0] == 1
        assert connection.execute("SELECT typeof(value) FROM sample WHERE identity=1").fetchone()[0] == "null"
        sql, parameters = exact_real_binding(-0.125)
        connection.execute("UPDATE sample SET value=" + sql + " WHERE identity=1", parameters)
        assert connection.execute("SELECT value IS " + sql + " FROM sample WHERE identity=1", parameters).fetchone()[0] == 1
        observed = connection.execute("SELECT value FROM sample WHERE identity=1").fetchone()[0]
        assert _bits(observed) == _bits(-0.125)


def test_fragment_has_no_sql_names_decimal_float_text_or_statement_terminators():
    sql, parameters = exact_real_binding(13 / 482)
    assert sql.count("?") == len(parameters) == 1
    assert all(type(value) is int for value in parameters)
    assert not any(character in sql for character in ";'\"\\")
    assert re.fullmatch(r"[()+*/?0-9 A-Z]+", sql)
    assert not re.search(r"\b(?:SELECT|INSERT|UPDATE|DELETE|PRAGMA|BEGIN|COMMIT)\b", sql)
