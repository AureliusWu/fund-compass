# Clean-target compiler: local-only boundary

`backend/database/turso_clean_target.py` prepares a separate, genuinely empty
candidate from a strict original schema8 capture. It has **no sender**, configured
database access, credential lookup, network, startup hook or main-app switch.
The current wire/artifact profile is version 2; version-1 capacity failures do
not authorize reusing or editing an earlier packet.

## Fixed API

- `archive_clean_source(snapshot, *, expected_source_resource_sha256,
  expected_source_image_sha256)` returns a private `SourceArchive`.
- `plan_clean_target(snapshot, *, expected_source_resource_sha256,
  expected_source_image_sha256, expected_source_archive_sha256,
  expected_target_resource_sha256, created_at)` returns safe local facts.
- `compile_clean_target(..., expected_repair_sha256)` returns a private immutable
  `CompiledCleanTarget` with `body`, `statement_specs`, `request_specs`,
  `safe_metadata`, and `artifact()`.
- `rehydrate_clean_target(snapshot, artifact, *, expected_source_resource_sha256,
  expected_source_image_sha256, expected_source_archive_sha256,
  expected_target_resource_sha256, expected_plan_sha256,
  expected_packet_sha256)` independently rebuilds the whole packet.
- `rehearse_clean_target(snapshot, packet)` executes fixed statements only in a
  fresh owned native SQLite memory database, comparing the complete final image.

Source/target resource hashes must differ. A future sender must additionally
bind the actual target URL and credential, reject the source URL, verify the
chosen request budget, send once and independently read back. This compiler is
not authorization to create a database, transmit a packet or change production.

## Archive and preservation

The private archive contains the complete original native SQLite image, original
raw schema inventory and strict capture metadata. Both fixed operational tables
and all their rows remain in this archive and the original source. The archive's
external SHA is separate from the original source image/resource/typed-row SHA.
Never log, upload publicly or put archive/packet bodies in a safe report.

Only the new target omits `turso_candidate_probe_v1` and
`universe_import_state`. No other source table is silently omitted. In particular,
an unexpected statistics table is refused rather than hidden to fit the manifest.
Every remaining public row is copied, including unrelated universe/cache rows;
this migration does not use the business engine's Owner-code subset.

Existing exact one-ULP Evidence projection repair validates immutable payloads,
IDs and hashes and records a typed delta hash. Zero repairs are an explicit zero
delta. A difference beyond the admitted columns/one ULP is refused. Complete
original Policy/Holding/Decision/derived lineage validation and production scope
backfill remain mandatory. Validated rows are housed in fixed canonical core9
DDL, then receive only new Owner/Analysis/Machine schema markers. This does not
relax the unchanged native verifiers or execute captured DDL.

All original rowids and native values are preserved except the explicitly
declared Evidence repair cells and `_schema_version` 8→9. Native sequence rows
and high-water values are restored **last**, after clearing sequence rows created
by target AUTOINCREMENT seed inserts. NULL, integer/REAL distinctions, binary
payloads, zero values and original JSON text are not normalized.

## Fixed target and receipt

The target is exactly the baseline 126-object complete machine profile. The
atomic plan begins with FK/connection/temp-state, empty `sqlite_master` and zero
header guards. Only repository-owned DDL creates objects. Fixed typed bulk
INSERTs use exact REAL integer mantissas, per-DML affected guards, complete schema
and row postimage guards and an FK check. The remote physical header remains 0;
the schema-table version is 9.

Version 2 removes repeated Hrana per-cell envelopes only for a complete old-sized
chunk whose cells are exact native int, NUL-free text or NULL. JSON1 packs this
chunk into one bounded text parameter; statement-local materialized CTEs decode
once, with fixed shape/native-type checks and the same full rowid/count/typed
byte comparisons. There are no new named TEMP tables, hashes replacing values,
new REAL/blob decoders or extra commit phases. Any float, BLOB, NUL text or JSON
pack above the unchanged 256 KiB single-cell limit uses the original exact
INSERT/native VALUES guards for that whole chunk. Streaming encoding stops at
the first limit instead of first constructing an oversized aggregate cell.

The unchanged conditional FSM/spec builder is serialized as standard UTF-8 JSON
in this new profile, not double Unicode escapes. Exact body/spec/source hashes
are still independently rebuilt. `compact_capability_probe()` returns the exact
fixed public-data read-only JSON1/MATERIALIZED/I64/UTF8 guard also placed before
target DDL; run it separately on the real provider before considering a write.
Local rehearsal independently compares the final native `_records` typed digest
to the complete intended image, rather than trusting decoder self-consistency.
`local_transaction_seconds` measures only the bounded local BEGIN→COMMIT, not
compilation or a claim about a remote transaction timeout.

Exactly one dedicated immutable clean-target migration receipt is appended to
`owner_machine_journal` under occurrence `profile:clean-target`. It binds the
source archive, dual resources, exact repair, plan and full target facts. No fake
in-place Owner/machine migration receipts are synthesized. The initial Owner
sync revision and record count are both 0. Browser holdings have **not** been
synced merely because legacy cloud history was retained. This receipt is not a
natural Cron observation, delivery claim or restore certificate.

Every safe metadata getter independently re-derives its complete facts from the
private original archive; a body hash, edited dataclass, resealed JSON or unknown
metadata field cannot manufacture a trusted summary. Rehydration also compares
all exact native metadata, recipe, statements and packet bytes to external hashes.

Original-source rehydration performs one complete strict source-derived build.
Its internally fresh immutable output then passes the full native frame,
controls/pipeline/body/spec/recipe checks and exact input-artifact comparison;
it does not scan that same source again solely to authenticate its own output.
This private structural path is never authority for an external packet. Public
safe getters retain full original-archive re-derivation. Fresh archive creation
also strictly decodes its JSON/base64 serialization, comparing native metadata,
raw schema and exact image bytes/SHA to the already admitted source without
creating another SQLite decoder or charging an unnecessary duplicate source scan.

Rehearsal treats supplied frozen fields only as a proposal, rehydrates against
the actual original capture, then compares all six original members (including
statement/request specs and private archive) to the canonical result before
opening the rehearsal writer. Forged fields are rejected, not silently repaired.
The final complete native `_records` typed digest remains independent of JSON1.
Only the restricted plain matcher uses equal native type plus exact BLOB casts;
integer canonical decimal bytes, text bytes and SQL NULL are injective in this
closed domain. REAL/BLOB/NUL fallback still uses the untouched original matcher.

## Limits and non-claims

The unchanged row/cell limits are 100,000 rows, 256 KiB/cell and 64 MiB source
image/archive. This clean-target profile independently enforces a **16 MiB exact
serialized packet/request ceiling**, 900 parameters/statement, 16,384 steps and a shared
30-second operation budget. Base64 and metadata make the 64 MiB archive limit
stricter than a bare 64 MiB image. Rehydration and rehearsal do not reset the
overall deadline, and source-code fingerprints are checked for drift.
Shared row/SQL-progress counters are not reset to obtain PASS. Local rehearsal
reports charged verification rows and operation/transaction SQL-progress samples
alongside transaction seconds; these are local resource observations, not remote
timeout or capacity guarantees.

Although the reused legacy pipeline primitive itself permits 64 MiB, this new
profile rejects the exact final body above 16 MiB during compile, getter and
rehydration. It does not split the transaction or raise a limit to obtain PASS.
Size fitting still does not establish provider/sender capability; metadata keeps
`sender_request_budget_verified=false`. A future sender must preserve the same
16 MiB ceiling (or a stricter known provider limit) before transmitting.

Local success leaves remote-applied, provider-capability, restore, durability,
retry, natural-schedule and formal-release flags literally false. Tests and
rehearsal do not perform a real cloud migration or authorize replay after unknown.
