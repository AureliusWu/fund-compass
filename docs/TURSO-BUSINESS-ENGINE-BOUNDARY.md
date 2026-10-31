# Full-profile business engine boundary

`backend/service/turso_business_engine.py` is an explicit, default-off candidate.
`TursoBusinessEngine(url, token)` constructs without external I/O and exposes
only `.sync`, `.analysis`, `.policy`, and `.machine` closed repositories. The
separate candidate composition consumes them; normal `main` and its native-
SQLite guard, deployment hold, app version and old Owner-only profile stay intact.

## Execution contract

1. One owned remote `BEGIN DEFERRED` snapshot verifies the fixed complete
   schema-9 machine profile and complete private/legacy records, markers, Policy,
   journal and references. Bounded fixed rowid pages remain on the same baton and
   transaction. This preserves the existing driver's 400,000 JSON-node limit.
   Each incoming page is type/cell/JSON-validated and charged to one shared
   cross-table row/typed-byte image budget **before** it is retained; an excess
   rolls back and closes immediately without fetching subsequent pages.
2. Public `funds`, `fund_detail`, and `nav_history` alone are limited to the
   **complete original Owner-key code domain**, including tombstone keys. All
   selected dates are retained; unrelated public universe rows are not cloned.
   NULL, non-text, empty or duplicate public PK identities are rejected.
3. Only repository-owned fixed DDL creates an owned actual native SQLite
   workspace. Remote operational optional objects remain independently verified;
   their SQL is never executed from the capture. Local header normalization to 9
   affects only this owned memory image, not the remote header.
4. Existing native business cores perform the operation. Cache public collection
   stays outside their native read/write transaction. Source, Policy and the
   original cache are rechecked before local write and again remotely.
5. A closed per-operation write allow-list compiles typed fixed-column deltas.
   Complete private rows retain rowids; public cache compares and changes fixed
   PKs, never subset-generated rowids. NAV replacement deletes complete changed
   codes and bulk-inserts exact following date sets, not a historical union.
6. One atomic remote batch verifies original raw schema/header, complete business
   preimage, typed PK cache image, each affected count and complete intended
   postimage/FKs. Exact REAL fragments use integer mantissas, not rounded JSON
   float parameters. A one-ULP concurrent change is a conflict, not normalization.
7. Response contracts also require every guard to be exactly one native integer
   `1`, every DML affected count to match and empty pragma results. Missing,
   malformed, lost, close-failed, deadline-expired or revoked outcomes never return
   the privately simulated success. There are no automatic write retries.

Permission callbacks, monotonic rollback/finite checks, dependency fingerprints
and the shared maximum 30-second budget cover capture, native progress, planning,
collection, send, response validation and closing. Original authorization
exceptions propagate unchanged, including revocation after accepted commit.

## Unchanged limits and evidence scope

- 100,000 selected rows, 256 KiB/cell, 64 MiB selected typed snapshot image.
- 900 parameters/statement, 16,384 batch steps, 16 MiB full write request.
- Large writes that exceed any existing bound fail closed before write I/O;
  paging is read-only and does not split an atomic business mutation into commits.
- Owned HTTP/Hrana tests cover 100 Owner codes × 800 NAV rows alongside 29,000
  unrelated universe rows **as a complete read snapshot**. This is not a claim
  that every possible 80,000-row cache replacement fits the 16 MiB write budget.
- Tests exercise real requests/driver/native SQL, CAS rollback, accepted malformed
  responses, source authorization and original receipts. They are not provider
  capability, actual-cloud migration, restore, durability, natural Cron, delivery,
  real-device/PWA or release acceptance.

Actual migration still requires an authorized fresh complete source capture,
reviewed original-resource/plan hashes, an explicit candidate-only sender and
independent remote readback/restore evidence. Read-back task/claim receipts never
authorize a new delivery; normal main must not be enabled from local evidence.
