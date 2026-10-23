"""Local exact pre/postimage guards; no network or provider qualification."""
import hashlib
import json
import math
import socket
import sqlite3
import sys
import time

import pytest

from database import db, exact_real, turso_scope_packet as c
import turso_scope_packet_fixtures as s


@pytest.fixture(autouse=True)
def no_external_or_configured_access(monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError('external/configured access forbidden in exact guard tests')

    monkeypatch.setattr(socket, 'create_connection', forbidden)
    monkeypatch.setattr(socket, 'socket', forbidden)
    monkeypatch.setattr(db, 'get_conn', forbidden)
    monkeypatch.setattr(db, 'init_db', forbidden)


def budget():
    return c._Budget(time.monotonic() + 30)


def row_guard(value):
    return next(c._row_guards('sample', ('value',), ((1, value),), budget(), include_count=False))


def provider_args(statement):
    """Model a provider that changes every nonzero JSON float by one ULP.

    This is an adversarial local transport simulation, not a claim to model
    every provider behavior. Integer/text/blob/null bindings stay typed.
    """
    wire = json.loads(json.dumps(statement._wire(), allow_nan=False))
    result = []
    for value in wire['args']:
        decoded = s.decode(value)
        if value['type'] == 'float' and decoded != 0.0:
            decoded = math.nextafter(decoded, 0.0)
        result.append(decoded)
    return tuple(result)


@pytest.mark.parametrize('value', [
    13 / 482, 36 / 312, 55 / 1015, 1.0000000000000002, -1.0000000000000002,
    sys.float_info.min, -sys.float_info.min, sys.float_info.max, -sys.float_info.max,
    float.fromhex('0x0.0000000000001p-1022'), -float.fromhex('0x0.0000000000001p-1022'),
    float.fromhex('0x0.fffffffffffffp-1022'), 0.0, -0.0,
])
def test_exact_real_row_guard_survives_adversarial_json_float_rounding(value):
    with sqlite3.connect(':memory:') as conn:
        # No column affinity: both the REAL type and negative zero remain
        # observable. A REAL-affinity table may independently canonicalize 0.
        conn.execute('CREATE TABLE sample(value)')
        conn.execute('INSERT INTO sample VALUES(?)', (value,))
        actual = conn.execute('SELECT typeof(value),value FROM sample').fetchone()
        assert actual[0] == 'real' and actual[1].hex() == value.hex()
        statement = row_guard(value)
        assert not any(type(arg) is float for arg in statement.args)
        assert all(arg['type'] != 'float' for arg in statement._wire()['args'])
        assert conn.execute(statement.sql, provider_args(statement)).fetchone() == (1,)

        if value != 0.0:
            old_guard = c._guard('old-json-guard', '(SELECT ' + c._match('a.value', 'e.e1')
                + ' FROM sample a JOIN expected e ON a.rowid=e.e0)', (1, value),
                'WITH expected(e0,e1) AS (VALUES (?,?)) ')
            assert provider_args(old_guard)[1].hex() != value.hex()
            with pytest.raises(sqlite3.OperationalError, match='integer overflow'):
                conn.execute(old_guard.sql, provider_args(old_guard)).fetchall()


@pytest.mark.parametrize('actual,expected,passes', [
    (None, None, True), (None, 0, False), (0, None, False), (0, 0, True),
    (1, 1.0, False), (1.0, 1, False), (1.0, 1.0, True),
    ('1', 1.0, False), (1.0, '1', False), ('a\x00b', 'a\x00b', True),
    ('a\x00b', 'a\x00c', False), (b'a\x00b', b'a\x00b', True),
    (b'a\x00b', b'a\x00c', False), (b'1', '1', False),
    (-(2**63), -(2**63), True), (2**63-1, 2**63-1, True),
    (0.0, 0.0, True), (-0.0, -0.0, True), (0.0, -0.0, False), (-0.0, 0.0, False),
    (13 / 482, math.nextafter(13 / 482, math.inf), False),
])
def test_row_guard_preserves_native_type_null_bytes_and_zero_sign(actual, expected, passes):
    with sqlite3.connect(':memory:') as conn:
        conn.execute('CREATE TABLE sample(value)')
        conn.execute('INSERT INTO sample VALUES(?)', (actual,))
        statement = row_guard(expected)
        if passes:
            assert conn.execute(statement.sql, provider_args(statement)).fetchone() == (1,)
        else:
            with pytest.raises(sqlite3.OperationalError, match='integer overflow'):
                conn.execute(statement.sql, provider_args(statement)).fetchall()


def test_fixed_negative_zero_literal_does_not_relax_generic_real_primitive():
    negative = row_guard(-0.0)
    positive = row_guard(0.0)
    assert '(-0.0)' in negative.sql and negative.args == (1,)
    assert '(+CAST(? AS REAL))' in positive.sql and positive.args == (1, 0)
    with pytest.raises(ValueError, match='does not support negative zero'):
        exact_real.exact_real_binding(-0.0)
    assert c._wire(-0.0) == {'type': 'float', 'value': -0.0}
    assert c._wire(-0.0)['value'].hex() == '-0x0.0p+0'


@pytest.mark.parametrize('kind', ['mantissa', 'zero-sign', 'null-type'])
def test_changed_bound_value_or_fixed_zero_sign_is_rejected(kind):
    source = {'mantissa': 13 / 482, 'zero-sign': -0.0, 'null-type': None}[kind]
    with sqlite3.connect(':memory:') as conn:
        conn.execute('CREATE TABLE sample(value)')
        conn.execute('INSERT INTO sample VALUES(?)', (source,))
        statement = row_guard(source)
        sql, args = statement.sql, statement.args
        if kind == 'mantissa':
            args = (args[0], args[1] + 1)
        elif kind == 'zero-sign':
            sql = sql.replace('(-0.0)', '(+0.0)')
        else:
            args = (args[0], 0)
        with pytest.raises(sqlite3.OperationalError, match='integer overflow'):
            conn.execute(sql, args).fetchall()


def test_chunked_exact_values_remain_below_bound_and_check_all_rows():
    rows = tuple((i, (13 / 482 if i % 2 else -0.0), 'row-' + str(i)) for i in range(1, 651))
    statements = tuple(c._row_guards('sample', ('value', 'label'), rows, budget()))
    assert [item.label for item in statements] == ['count:sample', 'rows:sample:0',
        'rows:sample:300', 'rows:sample:600']
    assert all(len(item.args) <= c.MAX_ARGS for item in statements)
    assert all(item.sql.count('?') == len(item.args) for item in statements)
    assert all(not any(type(arg) is float for arg in item.args) for item in statements)
    with sqlite3.connect(':memory:') as conn:
        conn.execute('CREATE TABLE sample(value,label)')
        conn.executemany('INSERT INTO sample(rowid,value,label) VALUES(?,?,?)', rows)
        for statement in statements:
            assert conn.execute(statement.sql, provider_args(statement)).fetchone() == (1,)
        conn.execute('UPDATE sample SET value=? WHERE rowid=650', (0.0,))
        with pytest.raises(sqlite3.OperationalError, match='integer overflow'):
            conn.execute(statements[-1].sql, provider_args(statements[-1])).fetchall()


@pytest.mark.parametrize('bad', [True, float('nan'), float('inf'), -float('inf')])
def test_invalid_native_guard_values_fail_before_wire_encoding(bad):
    with pytest.raises(c.CompilerError, match='^source_value_invalid$'):
        row_guard(bad)


def test_exact_helper_source_is_in_compiler_contract_fingerprint():
    assert 'exact_real' in dict(c._LOADED_CODE)
    assert dict(c._current_code())['exact_real'] == dict(c._LOADED_CODE)['exact_real']


def test_full_packet_exact_pre_postimage_and_tamper_recompile():
    def mutation(conn):
        conn.execute("UPDATE fund_detail SET latest_nav=? WHERE code='000001'", (13 / 482,))
        conn.commit()

    with s.captured(mutate=mutation) as (source, snapshot):
        packet = s.compile_packet(snapshot)
        guard_specs = [spec for spec in packet.statement_specs if spec[0].startswith('rows:')]
        assert all(not any(type(arg) is float for arg in spec[2]) for spec in guard_specs)
        target = s.clone(source)
        try:
            assert s.execute_packet(target, packet)['committed'] is True
            actual = target.execute("SELECT latest_nav FROM fund_detail WHERE code='000001'").fetchone()[0]
            assert actual.hex() == (13 / 482).hex()
        finally:
            target.close()
        assert packet.safe_metadata['profile'] == c.PACKET_PROFILE
        assert all(packet.safe_metadata[key] is False for key in c._PACKET_REMOTE_FLAGS)

        artifact = packet.artifact()
        specs = list(artifact['statement_specs'])
        index = next(i for i, spec in enumerate(specs) if spec[0] == 'rows:fund_detail:0')
        selected = list(specs[index])
        args = list(selected[2])
        # The helper mantissa for this public fixture is known independently.
        mantissa = exact_real.exact_real_binding(13 / 482)[1][0]
        arg_index = args.index(mantissa)
        args[arg_index] += 1
        selected[2] = tuple(args)
        specs[index] = tuple(selected)
        artifact['statement_specs'] = tuple(specs)
        assert hashlib.sha256(artifact['body']).hexdigest() == s.identity(packet)['expected_packet_sha256']
        with pytest.raises(c.CompilerError, match='^packet_integrity_invalid$'):
            c.rehydrate_packet(snapshot, artifact, **s.identity(packet))
