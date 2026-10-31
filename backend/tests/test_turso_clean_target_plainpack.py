"""Synthetic JSON1 compaction, native independent guards and fixed budgets."""
from contextlib import closing
import math
import sqlite3
import time

import pytest

from database import turso_clean_target as compiler, turso_scope_packet as kernel


def execute(conn, statements):
    for statement in statements:
        result = tuple(tuple(row) for row in conn.execute(statement.sql, statement.args))
        if statement.want_rows:
            assert result == ((1,),) and type(result[0][0]) is int
        else:
            assert not result


def test_capability_probe_and_plain_i64_utf8_null_are_exact_under_original_independent_guards():
    columns = ('number', 'text', 'nullable')
    rows = [(-9223372036854775808, -9223372036854775808, '汉字Ω😀e\u0301é', None),
            (0, 9007199254740993, '"slash\\line\n\t\x01', ''),
            (9007199254740993, 0, '', None),
            (9223372036854775807, 9223372036854775807, 'null', '0.0 -0.0')]
    with closing(sqlite3.connect(':memory:')) as conn:
        conn.execute('CREATE TABLE sample(number INTEGER,text TEXT,nullable TEXT)')
        execute(conn, [compiler.compact_capability_probe()])
        execute(conn, compiler._insert('sample', columns, rows, compiler._Budget()))
        execute(conn, compiler._row_guards('sample', columns, rows, compiler._Budget()))
        # Deliberately use the unchanged native VALUES/exact-real implementation,
        # NOT the JSON1 decoder, as independent original-image authority.
        execute(conn, kernel._row_guards('sample', columns, rows, compiler._Budget()))
        actual = tuple(tuple(row) for row in conn.execute('SELECT rowid,* FROM sample ORDER BY rowid'))
        assert kernel._same_native(actual, tuple(rows))


@pytest.mark.parametrize('value', [True, 0.0, -0.0, math.nextafter(1.0, math.inf), b'\x00\xff', 'A\x00B'])
def test_one_nonplain_cell_keeps_the_whole_chunk_on_original_exact_path(value):
    rows = [(1, value)]
    assert compiler._plain_pack(rows) is None
    if type(value) is not bool and not (type(value) is float and value == 0 and math.copysign(1, value) < 0):
        insert = next(compiler._insert('sample', ('value',), rows, compiler._Budget()))
        guard = next(compiler._row_guards('sample', ('value',), rows, compiler._Budget(), include_count=False))
        assert insert.sql.startswith('INSERT INTO') and 'json_each' not in guard.sql


@pytest.mark.parametrize('value', ['x' * 262144, '\\' * 131072, '汉' * 87381], ids=['ascii-limit', 'escape-limit', 'utf8-limit'])
def test_packed_single_parameter_never_bypasses_old_256k_byte_limit(value):
    assert len(value.encode('utf-8')) <= kernel.MAX_CELL_BYTES
    assert compiler._plain_pack([(1, value)]) is None
    assert next(compiler._insert('sample', ('value',), [(1, value)], compiler._Budget())).sql.startswith('INSERT INTO')


def test_two_logical_chunks_mixed_pack_and_original_path_keep_global_row_count_and_labels():
    columns = ('value',)
    # size=900//2=450. First chunk is plain, second has a BLOB and must
    # preserve the old typed guard, without COUNT(table)=len(second chunk).
    rows = [(index, 'plain') for index in range(1, 451)] + [(451, b'\x00'), (452, None)]
    statements = tuple(compiler._insert('sample', columns, rows, compiler._Budget()))
    guards = tuple(compiler._row_guards('sample', columns, rows, compiler._Budget()))
    assert [step.label for step in guards] == ['count:sample', 'rows:sample:0', 'rows:sample:450']
    assert 'json_each' in guards[1].sql and 'json_each' not in guards[2].sql
    with closing(sqlite3.connect(':memory:')) as conn:
        conn.execute('CREATE TABLE sample(value)')
        execute(conn, statements); execute(conn, guards)
        execute(conn, kernel._row_guards('sample', columns, rows, compiler._Budget()))
        assert conn.execute('SELECT COUNT(*) FROM sqlite_temp_master').fetchone()[0] == 0


@pytest.mark.parametrize('mutation', ['null_zero', 'text_blob', 'i64_round', 'normalize_unicode', 'extra', 'missing'])
def test_original_independent_guard_rejects_data_damage_after_plain_insert(mutation):
    columns = ('number', 'text', 'nullable')
    rows = [(1, 9007199254740993, 'e\u0301', None)]
    with closing(sqlite3.connect(':memory:')) as conn:
        conn.execute('CREATE TABLE sample(number,text,nullable)')
        execute(conn, compiler._insert('sample', columns, rows, compiler._Budget()))
        if mutation == 'null_zero': conn.execute('UPDATE sample SET nullable=0')
        elif mutation == 'text_blob': conn.execute('UPDATE sample SET text=CAST(text AS BLOB)')
        elif mutation == 'i64_round': conn.execute('UPDATE sample SET number=9007199254740992')
        elif mutation == 'normalize_unicode': conn.execute("UPDATE sample SET text='é'")
        elif mutation == 'extra': conn.execute("INSERT INTO sample VALUES(1,'extra',NULL)")
        else: conn.execute('DELETE FROM sample')
        with pytest.raises(sqlite3.DatabaseError):
            execute(conn, kernel._row_guards('sample', columns, rows, compiler._Budget()))
        with pytest.raises(sqlite3.DatabaseError):
            execute(conn, compiler._row_guards('sample', columns, rows, compiler._Budget()))


def test_plain_byte_matcher_preserves_random_i64_unicode_and_ignores_nocase_collation():
    import random
    rng = random.Random(20261030)
    numbers = [-9223372036854775808, 9223372036854775807, 9007199254740993, 0]
    numbers += [rng.getrandbits(64) - (1 << 63) for _ in range(1000)]
    texts = ['Case', '', '汉字😀', 'e\u0301', 'é', 'slash\\quote"\n\x01']
    rows = [(index + 1, number, texts[index % len(texts)], None if index % 2 else '')
            for index, number in enumerate(numbers)]
    columns = ('number', 'text', 'nullable')
    with closing(sqlite3.connect(':memory:')) as conn:
        conn.execute('CREATE TABLE sample(number,text COLLATE NOCASE,nullable)')
        execute(conn, compiler._insert('sample', columns, rows, compiler._Budget()))
        execute(conn, compiler._row_guards('sample', columns, rows, compiler._Budget()))
        execute(conn, kernel._row_guards('sample', columns, rows, compiler._Budget()))
        conn.execute("UPDATE sample SET text='case' WHERE rowid=1")
        for guards in (compiler._row_guards, kernel._row_guards):
            with pytest.raises(sqlite3.DatabaseError): execute(conn, guards('sample', columns, rows, compiler._Budget()))


def test_28169_fund_rows_compact_insert_and_full_guard_fit_original_sql_budget(record_property):
    columns = ('code', 'name', 'type', 'pinyin')
    rows = [(index, f'{index:06d}', '合成基金名称用于完整字节检查'[:15], '混合型', 'abcd')
            for index in range(1, 28170)]
    budget = compiler._Budget()
    statements = (compiler.compact_capability_probe(), *compiler._insert('funds', columns, rows, budget),
                  *compiler._row_guards('funds', columns, rows, budget))
    body, _specs, _requests = compiler._pipeline(statements)
    assert len(body) < compiler.MAX_REQUEST_BYTES
    assert all(len(step.args) <= kernel.MAX_ARGS for step in statements)
    with closing(sqlite3.connect(':memory:')) as conn:
        conn.execute('CREATE TABLE funds(code TEXT PRIMARY KEY,name TEXT,type TEXT,pinyin TEXT)')
        conn.set_progress_handler(budget.progress, 1000)
        started = time.monotonic(); conn.execute('BEGIN IMMEDIATE')
        execute(conn, statements); conn.commit(); elapsed = time.monotonic() - started
        assert budget.sql_steps <= 10_000_000
        assert conn.execute('SELECT COUNT(*) FROM funds').fetchone()[0] == 28169
        assert conn.execute('SELECT COUNT(*) FROM sqlite_temp_master').fetchone()[0] == 0
        record_property('compact_statement_count', len(statements))
        record_property('compact_wire_bytes', len(body))
        record_property('local_transaction_seconds', elapsed)
        record_property('transaction_sql_steps', budget.sql_steps)
        # Independent VALUES guards execute after the measured transaction with
        # their own unchanged budget: no compact self-consistency shortcut.
        independent = compiler._Budget(); conn.set_progress_handler(independent.progress, 1000)
        execute(conn, kernel._row_guards('funds', columns, rows, independent))
