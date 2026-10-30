"""Explicit, opt-in full-profile Turso business repositories.

This is not a connection adapter. Fixed SELECTs capture one bounded snapshot;
repository-owned DDL builds an owned *native* SQLite business workspace. Only
the closed operations below can produce a fixed-column mutation plan. A single
conditional remote transaction checks the complete original business image and
the intended postimage. No captured SQL, configured credential, automatic DDL,
retry, sender, main-app switch, or release/durability assertion lives here.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import time

from database import exact_real, turso, turso_machine_profile as profile
from database import turso_machine_upgrade as upgrade, turso_scope_packet as kernel
from database import turso_scope_upgrade as offline
from service import owner_analysis_repo as analysis, owner_sync_repo as sync
from service import owner_machine_repo as machine, owner_machine_cache as cache
from service import owner_machine_evidence as evidence, owner_policy_state as policy

MAX_ROWS = 100_000
MAX_BYTES = 64 * 1024 * 1024
MAX_CELL = 256 * 1024
MAX_ARGS = 900
MAX_STEPS = 16_384
MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_PAGE_ROWS = 5000
_PUBLIC = frozenset({'funds', 'fund_detail', 'nav_history'})
_CODE_DOMAIN = ("SELECT DISTINCT substr(sync_key,1,6) FROM main.owner_sync_records "
                "WHERE substr(sync_key,1,6) NOT GLOB '*[^0-9]*' "
                "AND length(substr(sync_key,1,6))=6 AND substr(sync_key,7,2)='::'")
_SYNC = frozenset({'owner_sync_records', 'owner_sync_changes', 'owner_sync_receipts', 'owner_sync_state'})
_V8 = frozenset({'holding_versions', 'decision_snapshots', 'evidence_snapshots',
    'idempotency_requests', 'idempotency_responses', 'source_health_events',
    'notification_events', 'outcome_evaluations', 'portfolio_decision_snapshots',
    'portfolio_outcome_evaluations', 'v8_record_scopes', 'owner_analysis_runs',
    'owner_analysis_components'})
_WRITES = {'sync_apply': _SYNC, 'analysis_create': _V8,
    'machine_prepare': _V8 | {'owner_machine_journal'},
    'machine_claim': _V8 | {'owner_machine_journal'},
    'machine_finish': _V8 | {'owner_machine_journal'},
    'machine_evidence': frozenset({'evidence_snapshots', 'source_health_events',
        'v8_record_scopes', 'owner_machine_journal'}),
    'machine_cache': frozenset({'fund_detail', 'nav_history', 'owner_machine_journal'})}
_PIN_MODULES = (profile, upgrade, kernel, offline, exact_real, analysis, sync, machine,
                cache, evidence, policy, turso)


def _fingerprints():
    paths = [Path(module.__file__).resolve() for module in _PIN_MODULES]
    # Include every schema and business dependency used by the native cores.
    root = Path(__file__).resolve().parents[1]
    paths += list((root / 'database').glob('*.py'))
    paths += list((root / 'models').glob('*.py'))
    paths += list((root / 'service').glob('*.py'))
    paths += list((root / 'strategy').glob('*.py'))
    paths += [Path(__file__).resolve()]
    return tuple((str(path), hashlib.sha256(path.read_bytes()).hexdigest())
                 for path in sorted(set(paths)))


_LOADED = _fingerprints()


class TursoBusinessError(sqlite3.OperationalError):
    """Sanitized, non-retryable storage/unknown-result boundary."""

    def __init__(self):
        super().__init__('Turso business operation unavailable; reconcile original request before retrying')


class TursoBusinessConflict(TursoBusinessError):
    """The server explicitly acknowledged rolling back the conditional batch."""


class _Budget:
    def __init__(self, seconds, callback):
        self.last = time.monotonic()
        if not math.isfinite(self.last):
            raise TursoBusinessError()
        self.deadline = self.last + seconds
        self.callback, self.original = callback, None

    def _tick(self):
        now = time.monotonic()
        if not math.isfinite(now) or now < self.last or now >= self.deadline:
            raise TursoBusinessError()
        self.last = now

    def check(self):
        self._tick()
        if self.callback is not None:
            try:
                self.callback()
            except Exception as error:
                self.original = error
                raise
        self._tick()

    def remaining(self):
        self.check()
        return max(0.000001, self.deadline - self.last)


@dataclass(frozen=True)
class _Table:
    name: str
    columns: tuple[str, ...]
    primary: tuple[int, ...]


class _Rows:
    def __init__(self, rows): self.rows = iter(rows)
    def fetchmany(self, amount):
        from itertools import islice
        return list(islice(self.rows, amount))
    def fetchone(self): return next(self.rows, None)
    def fetchall(self): return list(self.rows)


def _tables(conn):
    result = []
    for (name,) in conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
        info = tuple(conn.execute(f'PRAGMA table_info("{name}")'))
        columns = tuple(row[1] for row in info)
        # All private rowids are complete and retain legacy equal-time order.
        # Public cache rowids are NOT identities in a partial public workspace.
        primary = tuple(index + 1 for index, row in sorted(enumerate(info), key=lambda item: item[1][5]) if row[5])
        if name in _PUBLIC and not primary:
            raise TursoBusinessError()
        result.append(_Table(name, columns, primary if name in _PUBLIC else (0,)))
    return tuple(result)


def _capture_reads(tables):
    result = list(profile.machine_profile_reads())
    # Each result is independently bounded before transfer. Oversize cells are
    # signalled separately, never silently accepted as SQL NULL.
    for table in tables:
        where = f' WHERE code IN ({_CODE_DOMAIN})' if table.name in _PUBLIC else ''
        bad = ' OR '.join(f'(typeof("{name}") IN (\'text\',\'blob\') AND length(CAST("{name}" AS BLOB))>{MAX_CELL})'
                          for name in table.columns) or '0'
        result.append((f'SELECT COUNT(*),COALESCE(MAX(CASE WHEN {bad} THEN 1 ELSE 0 END),0) '
                       f'FROM main."{table.name}"{where}', ()))
        values = ','.join(f'CASE WHEN typeof("{name}") NOT IN (\'text\',\'blob\') OR '
            f'length(CAST("{name}" AS BLOB))<={MAX_CELL} THEN "{name}" ELSE NULL END'
            for name in table.columns)
        result.append((f'SELECT rowid,{values} FROM main."{table.name}"{where} ORDER BY rowid LIMIT {MAX_ROWS + 1}', ()))
    return result


def _checked_row_size(table, row, budget):
    budget.check()
    if len(row) != len(table.columns) + 1 or type(row[0]) is not int:
        raise TursoBusinessError()
    for value in row:
        kernel._value(value)
    for name, value in zip(table.columns, row[1:]):
        if value is not None and (name.endswith('_json') or name == 'detail_json'):
            offline._validate_json(value)
    return len(kernel._json([offline._typed(value) for value in row]))


def _checked_records(tables, cursors, budget):
    records, count, size = {}, 0, 0
    for index, table in enumerate(tables):
        budget.check()
        stats = cursors[2 * index].fetchall()
        if len(stats) != 1 or type(stats[0][0]) is not int or stats[0][1] != 0:
            raise TursoBusinessError()
        rows = tuple(tuple(row) for row in cursors[2 * index + 1].fetchall())
        if len(rows) != stats[0][0]:
            raise TursoBusinessError()
        _check_keys(table, rows)
        count += len(rows)
        if count > MAX_ROWS:
            raise TursoBusinessError()
        for row in rows:
            size += _checked_row_size(table, row, budget)
            if size > MAX_BYTES:
                raise TursoBusinessError()
        records[table.name] = (table.columns, rows)
    return records


def _read_owned(conn, tables, budget):
    records, count, size = {}, 0, 0
    for table in tables:
        rows = []
        for raw in conn.execute(f'SELECT rowid,* FROM "{table.name}" ORDER BY rowid'):
            budget.check()
            row = tuple(raw)
            for value in row:
                kernel._value(value)
            count += 1
            size += len(kernel._json([offline._typed(value) for value in row]))
            if count > MAX_ROWS or size > MAX_BYTES:
                raise TursoBusinessError()
            rows.append(row)
        records[table.name] = (table.columns, tuple(rows))
        _check_keys(table, rows)
    return records


def _same(left, right):
    return kernel._same_native(left, right)


def _key(table, row):
    return tuple(tuple(offline._typed(row[index])) for index in table.primary)


def _check_keys(table, rows):
    if table.name not in _PUBLIC:
        return
    # SQLite composite PRIMARY KEY declarations can still admit NULL and
    # duplicate NULL-containing identities. A dict/EXISTS guard cannot prove
    # that multiset: reject it before either local planning or remote sending.
    keys = set()
    for row in rows:
        if any(type(row[index]) is not str or not row[index] for index in table.primary):
            raise TursoBusinessError()
        key = _key(table, row)
        if key in keys:
            raise TursoBusinessError()
        keys.add(key)


def _fragment(value):
    kernel._value(value)
    if type(value) is float:
        if value == 0 and math.copysign(1, value) < 0:
            # A comparison can preserve -0.0. SQLite REAL-column persistence
            # itself does not promise sign preservation; the local core owns it.
            return '(-0.0)', ()
        return exact_real.exact_real_binding(value)
    return '?', (value,)


def _values(rows):
    slots, args = [], []
    for row in rows:
        expressions = []
        for value in row:
            fragment, parameters = _fragment(value)
            expressions.append(fragment)
            args.extend(parameters)
        slots.append('(' + ','.join(expressions) + ')')
    return ','.join(slots), tuple(args)


def _guard(predicate, args=(), prefix=''):
    return prefix + 'SELECT CASE WHEN (' + predicate + ') THEN 1 ELSE abs(-9223372036854775808) END', tuple(args)


def _public_guards(table, rows, codes, budget):
    names = table.columns
    selected = tuple(tuple(row[1:]) for row in rows)
    scope = 'code IN (' + ','.join('?' for _ in codes) + ')' if codes else '0'
    yield _guard(f'(SELECT COUNT(*) FROM main."{table.name}" WHERE {scope})=?', (*codes, len(rows)))
    aliases = tuple('e' + str(index) for index in range(len(names)))
    matching = ' AND '.join(kernel._match(f'a."{name}"', f'e.{alias}') for name, alias in zip(names, aliases))
    joins = ' AND '.join(kernel._match(f'a."{names[index - 1]}"', f'e.e{index - 1}') for index in table.primary)
    for offset in range(0, len(selected), max(1, MAX_ARGS // len(names))):
        budget.check()
        slots, args = _values(selected[offset:offset + MAX_ARGS // len(names)])
        yield _guard('NOT EXISTS (SELECT 1 FROM expected e WHERE NOT EXISTS '
            f'(SELECT 1 FROM main."{table.name}" a WHERE {joins} AND {matching}))', args,
            f'WITH expected({",".join(aliases)}) AS (VALUES {slots}) ')


def _guards(tables, records, codes, budget):
    for table in tables:
        budget.check()
        columns, rows = records[table.name]
        if table.name in _PUBLIC:
            yield from _public_guards(table, rows, codes, budget)
        else:
            for statement in kernel._row_guards(table.name, columns, rows, budget):
                yield statement.sql, statement.args


def _mutations(operation, tables, before, after, budget):
    allowed = _WRITES.get(operation, frozenset())
    result = []
    for table in tables:
        old = {_key(table, row): row for row in before[table.name][1]}
        new = {_key(table, row): row for row in after[table.name][1]}
        changed = set(old) ^ set(new) | {key for key in old.keys() & new.keys() if not _same(old[key], new[key])}
        if not changed:
            continue
        if table.name not in allowed:
            raise TursoBusinessError()
        names = ('rowid', *table.columns) if table.name not in _PUBLIC else table.columns
        def payload(row):
            return row if table.name not in _PUBLIC else row[1:]
        if table.name == 'nav_history':
            # Replacement is exact per code, including removal of old-only
            # dates. Never compile 100*800 individual UPDATE/DELETE pairs or
            # bind a private/subset rowid as a public-cache identity.
            code_index = table.columns.index('code') + 1
            affected_codes = sorted({(new.get(key) or old[key])[code_index] for key in changed})
            for code in affected_codes:
                previous = [row for row in old.values() if row[code_index] == code]
                following = [payload(row) for row in new.values() if row[code_index] == code]
                result += [(f'DELETE FROM main."{table.name}" WHERE code=?', (code,)),
                           _guard('changes()=?', (len(previous),))]
                width = len(names)
                for offset in range(0, len(following), MAX_ARGS // width):
                    budget.check()
                    chunk = following[offset:offset + MAX_ARGS // width]
                    slots, args = _values(chunk)
                    result += [(f'INSERT INTO main."{table.name}"({",".join(chr(34)+name+chr(34) for name in names)}) VALUES {slots}', args),
                               _guard('changes()=?', (len(chunk),))]
            continue
        for key in old.keys() - new.keys():
            row = old[key]
            pk_names = tuple(('rowid', *table.columns)[index] for index in table.primary)
            where = ' AND '.join(f'"{name}" IS ?' for name in pk_names)
            result += [(f'DELETE FROM main."{table.name}" WHERE {where}', tuple(row[index] for index in table.primary)), _guard('changes()=1')]
        for key in old.keys() & new.keys():
            if _same(payload(old[key]), payload(new[key])):
                continue
            row = new[key]
            expressions, args = [], []
            for name, value in zip(names, payload(row)):
                fragment, parameters = _fragment(value)
                expressions.append(f'"{name}"={fragment}')
                args.extend(parameters)
            pk_names = tuple(('rowid', *table.columns)[index] for index in table.primary)
            where = ' AND '.join(f'"{name}" IS ?' for name in pk_names)
            args.extend(old[key][index] for index in table.primary)
            result += [(f'UPDATE main."{table.name}" SET {",".join(expressions)} WHERE {where}', tuple(args)), _guard('changes()=1')]
        added = [payload(new[key]) for key in new.keys() - old.keys()]
        width = len(names)
        for offset in range(0, len(added), max(1, MAX_ARGS // width)):
            budget.check()
            chunk = added[offset:offset + MAX_ARGS // width]
            slots, args = _values(chunk)
            result += [(f'INSERT INTO main."{table.name}"({",".join(chr(34)+name+chr(34) for name in names)}) VALUES {slots}', args),
                       _guard('changes()=?', (len(chunk),))]
    return result


def _codes(records):
    columns, rows = records['owner_sync_records']
    index = columns.index('sync_key') + 1
    return tuple(sorted({row[index][:6] for row in rows if type(row[index]) is str and
        len(row[index]) >= 8 and row[index][:6].isascii() and row[index][:6].isdigit() and row[index][6:8] == '::'}))


def _invoke(name, conn, value, check, collector):
    if name == 'sync_apply': return sync.apply_sync_local(conn, value, before_commit=check)
    if name == 'sync_changes': return sync.read_sync_changes(conn, **value)
    if name == 'sync_receipt': return sync.reconcile_sync_local(conn, *value)
    if name == 'analysis_create': return analysis.create_analysis_local(conn, value, before_commit=check)
    if name == 'analysis_receipt': return analysis.reconcile_analysis_local(conn, *value)
    if name == 'policy_state': return policy.read_owner_policy_state(conn, before_return=check)
    if name == 'machine_source': return machine.read_source_local(conn)
    if name == 'machine_status': return machine.read_status_local(conn, value)
    if name == 'machine_prepare': return machine.prepare_local(conn, value, before_commit=check)
    if name == 'machine_claim': return machine.claim_local(conn, value, before_commit=check)
    if name == 'machine_finish': return machine.finish_local(conn, value, before_commit=check)
    if name == 'machine_evidence': return evidence.ingest_evidence_local(conn, value, before_commit=check)
    if name == 'machine_evidence_receipt': return evidence.read_evidence_receipt_local(conn, *value, before_read=check)
    if name == 'machine_cache': return cache.prepare_cache_local(conn, value, before_commit=check, collector=collector)
    if name == 'machine_cache_receipt': return cache.read_cache_receipt_local(conn, *value, before_read=check)
    raise TursoBusinessError()


def _checked_write_results(statements, cursors, budget):
    if len(cursors) != len(statements):
        raise TursoBusinessError()
    for index, ((sql, args), cursor) in enumerate(zip(statements, cursors)):
        budget.check()
        rows = tuple(tuple(row) for row in cursor.fetchall())
        keyword = sql.lstrip().split(None, 1)[0].upper()
        if keyword in {'SELECT', 'WITH'}:
            if rows != ((1,),) or type(rows[0][0]) is not int:
                raise TursoBusinessError()
        elif keyword in {'INSERT', 'UPDATE', 'DELETE'}:
            if index + 1 >= len(statements):
                raise TursoBusinessError()
            next_sql, next_args = statements[index + 1]
            expected = next_args[0] if next_args else 1
            if ('changes()=' not in next_sql or type(cursor.rowcount) is not int
                    or cursor.rowcount != expected or rows):
                raise TursoBusinessError()
        elif keyword == 'PRAGMA':
            if rows:
                raise TursoBusinessError()
        else:
            raise TursoBusinessError()


class TursoBusinessEngine:
    """Zero-I/O construction; explicit task credential; default main stays off."""

    def __init__(self, url, token, *, timeout_seconds=8.0, operation_seconds=30.0):
        self._url = turso._base_url(url)
        if (type(token) is not str or not 1 <= len(token) <= 8192 or not token.isascii()
                or any(ord(char) < 33 or ord(char) > 126 for char in token)):
            raise ValueError('Explicit business database credential required')
        if (type(timeout_seconds) not in (int, float) or not math.isfinite(timeout_seconds)
                or not 0 < timeout_seconds <= 60 or type(operation_seconds) not in (int, float)
                or not math.isfinite(operation_seconds) or not 0 < operation_seconds <= 30):
            raise ValueError('Invalid explicit business operation budget')
        self._token, self._timeout, self._seconds = token, float(timeout_seconds), float(operation_seconds)
        self.sync, self.analysis = _Sync(self), _Analysis(self)
        self.policy, self.machine = _Policy(self), _Machine(self)

    def _connection(self, budget):
        conn = turso.connect(self._url, self._token, min(self._timeout, budget.remaining()),
            http_limits=turso.HttpLimits(budget.remaining(), MAX_BYTES, MAX_REQUEST_BYTES))
        try:
            budget.check()
            conn.execute('PRAGMA foreign_keys=ON')
            budget.check()
            return conn
        except Exception:
            conn.close()
            raise

    def _snapshot(self, tables, budget):
        conn = self._connection(budget)
        try:
            # A consistent snapshot is one owned read transaction, not one
            # unbounded HTTP response. Keep the driver's existing 400k JSON-
            # node parser limit; page inside this SAME baton/transaction.
            reads = _capture_reads(tables)
            conn.execute('BEGIN DEFERRED')
            cursors = conn.execute_batch([*reads[:12], *reads[12::2]], atomic=False)
            budget.check()
            metadata = [tuple(tuple(row) for row in cursor.fetchall()) for cursor in cursors[:12]]
            inspection = profile.inspect_machine_profile_snapshot([_Rows(rows) for rows in metadata])
            objects = tuple(row[:4] for row in metadata[0])
            stats = [tuple(tuple(row) for row in cursor.fetchall()) for cursor in cursors[12:]]
            if (any(len(rows) != 1 or type(rows[0][0]) is not int or rows[0][0] < 0
                    or type(rows[0][1]) is not int or rows[0][1] != 0 for rows in stats)
                    or sum(rows[0][0] for rows in stats) > MAX_ROWS):
                raise TursoBusinessError()
            materialized, image_rows, image_bytes = [], 0, 0
            for index, table in enumerate(tables):
                budget.check()
                count, rows, last = stats[index][0][0], [], None
                # Width-derived paging also bounds the widest fixed schema.
                page_size = min(MAX_PAGE_ROWS, 200_000 // (3 * (len(table.columns) + 1) + 1))
                base_sql = reads[13 + 2 * index][0].split(' ORDER BY rowid LIMIT ', 1)[0]
                while len(rows) < count:
                    budget.check()
                    sql = base_sql
                    args = ()
                    if last is not None:
                        sql += (' AND ' if table.name in _PUBLIC else ' WHERE ') + 'rowid>?'
                        args = (last,)
                    sql += ' ORDER BY rowid LIMIT ?'
                    page = tuple(tuple(row) for row in conn.execute_batch([(sql, (*args, page_size))], atomic=False)[0].fetchall())
                    if (not page or len(page) > page_size or len(rows) + len(page) > count
                            or any(type(row[0]) is not int for row in page)
                            or any(a[0] >= b[0] for a, b in zip(page, page[1:]))
                            or last is not None and page[0][0] <= last):
                        raise TursoBusinessError()
                    # The response limit is per HTTP request, NOT the whole
                    # image. Validate every row and charge the shared image
                    # budget before retaining ANY portion of another page.
                    # Never materialize gigabytes and only reject at the end.
                    for row in page:
                        image_rows += 1
                        image_bytes += _checked_row_size(table, row, budget)
                        if image_rows > MAX_ROWS or image_bytes > MAX_BYTES:
                            raise TursoBusinessError()
                    rows.extend(page)
                    last = page[-1][0]
                materialized.extend((_Rows(stats[index]), _Rows(rows)))
            records = _checked_records(tables, materialized, budget)
            conn.commit()
            budget.check()
            return inspection, objects, records
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
            budget.check()

    def _run(self, name, value=None, callback=None, collector=None):
        budget = _Budget(self._seconds, callback)
        owned = None
        try:
            budget.check()
            if _fingerprints() != _LOADED:
                raise TursoBusinessError()
            owned = upgrade._reference(profile.machine_profile_manifest().objects)
            def progress():
                budget.check()
                return 0
            owned.set_progress_handler(progress, 1000)
            tables = _tables(owned)
            # No captured DDL is executed. Optional operational tables remain
            # guarded remotely but are not exposed to local business cores.
            inspection, raw, before = self._snapshot(tables, budget)
            offline._seed_memory(owned, before)
            owned.execute('PRAGMA user_version=9')
            if owned.execute('PRAGMA foreign_key_check').fetchone() is not None:
                raise TursoBusinessError()
            fault = None
            try:
                result = _invoke(name, owned, value, budget.check, collector)
            except (machine.MachineFault, analysis._Fault) as error:
                fault, result = error, None
            budget.check()
            after = _read_owned(owned, tables, budget)
            changes = _mutations(name, tables, before, after, budget)
            if changes:
                codes = _codes(before)
                statements = []
                # Remote raw DDL was already fixed-manifest checked; compare
                # exact original representation, not a source SQL execution.
                for statement in kernel._schema_guards(raw):
                    statements.append((statement.sql, statement.args))
                statements += [_guard('(SELECT foreign_keys FROM pragma_foreign_keys)=1 AND '
                    "(SELECT COUNT(*) FROM pragma_database_list WHERE name NOT IN ('main','temp'))=0 AND NOT EXISTS (SELECT 1 FROM sqlite_temp_master)"),
                    _guard('(SELECT user_version FROM pragma_user_version)=?', (inspection.header_user_version,)),
                    _guard("typeof(atan2(0.0,-1.0))='real' AND atan2(0.0,-1.0)>0 AND atan2(-0.0,-1.0)<0")]
                statements += list(_guards(tables, before, codes, budget))
                statements += [('PRAGMA defer_foreign_keys=ON', ())] + changes
                statements += list(_guards(tables, after, codes, budget))
                statements += [_guard('NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)')]
                if len(statements) + 3 > MAX_STEPS or any(len(args) > MAX_ARGS for _sql, args in statements):
                    raise TursoBusinessError()
                if _fingerprints() != _LOADED:
                    raise TursoBusinessError()
                conn = self._connection(budget)
                try:
                    budget.check()
                    # Driver bounds the complete serialized request BEFORE I/O.
                    returned = conn.execute_batch(statements, atomic=True, classify_errors=True)
                    _checked_write_results(statements, returned, budget)
                    budget.check()
                except turso.TursoBatchError:
                    raise TursoBusinessConflict() from None
                finally:
                    conn.close()
                    budget.check()
            budget.check()
            if _fingerprints() != _LOADED:
                raise TursoBusinessError()
            if fault is not None:
                raise fault
            return result
        except (machine.MachineFault, analysis._Fault):
            if budget.original is not None:
                raise budget.original from None
            raise
        except Exception as error:
            if budget.original is not None:
                raise budget.original from None
            if isinstance(error, TursoBusinessError):
                raise
            raise TursoBusinessError() from None
        finally:
            if owned is not None:
                try:
                    owned.close()
                except Exception:
                    raise TursoBusinessError() from None
                finally:
                    budget.check()


class _Sync:
    def __init__(self, engine): self._engine = engine
    def apply(self, raw_request, *, before_commit=None):
        return self._engine._run('sync_apply', raw_request, before_commit)
    def read_changes(self, **parameters):
        return self._engine._run('sync_changes', parameters)
    def reconcile(self, request_id, request_hash):
        return self._engine._run('sync_receipt', (request_id, request_hash))


class _Analysis:
    def __init__(self, engine): self._engine = engine
    def create(self, raw_request, *, before_commit=None):
        return self._engine._run('analysis_create', raw_request, before_commit)
    def reconcile(self, request_id, request_hash):
        return self._engine._run('analysis_receipt', (request_id, request_hash))


class _Policy:
    def __init__(self, engine): self._engine = engine
    def read_state(self, *, before_return=None):
        return self._engine._run('policy_state', callback=before_return)


class _Machine:
    def __init__(self, engine): self._engine = engine
    def read_source(self, *, before_read=None):
        return self._engine._run('machine_source', callback=before_read)
    def prepare_cache(self, request, *, before_commit=None):
        return self._engine._run('machine_cache', request, before_commit)
    def cache_receipt(self, day, request_id, request_hash, *, before_read=None):
        return self._engine._run('machine_cache_receipt', (day, request_id, request_hash), before_read)
    def ingest_evidence(self, request, *, before_commit=None):
        return self._engine._run('machine_evidence', request, before_commit)
    def evidence_receipt(self, day, request_id, request_hash, *, before_read=None):
        return self._engine._run('machine_evidence_receipt', (day, request_id, request_hash), before_read)
    def prepare_task(self, request, *, before_commit=None):
        return self._engine._run('machine_prepare', request, before_commit)
    def claim_task(self, request, *, before_commit=None):
        return self._engine._run('machine_claim', request, before_commit)
    def finish_task(self, request, *, before_commit=None):
        return self._engine._run('machine_finish', request, before_commit)
    def read_status(self, day, *, before_read=None):
        return self._engine._run('machine_status', day, before_read)
