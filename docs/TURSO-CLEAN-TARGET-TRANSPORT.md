# Clean-target transport: explicit operator boundary

`backend/database/turso_clean_target_transport.py` adds two explicit helpers:

- `send_clean_target_once(snapshot, artifact, *, source_origin, target_origin,
  token, expected_source_resource_sha256, expected_source_image_sha256,
  expected_source_archive_sha256, expected_target_resource_sha256,
  expected_repair_sha256, expected_plan_sha256, expected_packet_sha256,
  timeout_seconds=30.0, check=None)`.
- `read_clean_target_once(...)` takes the same bindings and performs only an
  independently requested fixed complete-target readback.

They are not CLI commands, startup hooks, default routes or an authorization
system. The operator must separately establish target writer exclusion,
protected original archive/backup, free quota, correct new candidate identity,
provider support and approval before invoking the write helper. An explicitly
authorized historical consistent snapshot copy into a different, empty,
isolated candidate does not certify or require quiescing the untouched old
source. Production cutover still requires old-source writer drain, final
incremental reconciliation and currentness acceptance. A cancellation or
revalidation callback proves none of those operational gates.

## Immutable binding and transport

Both origins are normalized by the unchanged strict Turso-origin validator.
They must differ, and each must match its independent external resource SHA.
Every original image/archive/repair/plan/packet identity is revalidated through
the new clean-target compiler. Neither URL nor token is discovered from the
environment. Only the target origin is ever contacted.

The exact compiler body must fit the independently enforced **16 MiB** limit.
One explicit helper call performs at most one POST. The shared private physical
adapter provides TLS verification, `trust_env=false`, no ambient proxy/netrc/CA
credentials, no redirects, zero retry, 5-second connect/read bounds, bounded
streaming and local response/session cleanup. It is not called through an old
scope or Owner public sender/profile.

A single cooperative maximum 30-second deadline covers identity admission,
compiler rehydration, POST, response streaming, parsing, final code/permission
checks and cleanup. It rejects non-finite/backward clocks. DNS/socket calls are
not a hard-preemptible process timer. Code fingerprints cover the new compiler,
new transport, unchanged parser and physical adapter graph.

The helper does not prepend unbound session setup or alter the packet. A fresh
provider stream must already satisfy the compiler's FK=1 guard; FK=0 causes a
real rollback before DDL. Confirm this capability separately before real import.

## Response and unknown outcomes

The strict reusable Hrana parser checks the complete conditional batch FSM,
every native integer guard, error slot, COMMIT/ROLLBACK, autocommit and SQL close.
The new profile additionally checks each DML affected count against its compiled
expectation. Missing/extra guards, inconsistent affected counts, missing commit,
lost responses, SQL-close failure, local cleanup failure, code drift, expired
deadline or revoked callback cannot return a simulated success.

HTTP 401/403/429 and exact SQL permission errors are STOP conditions. No identity
switch, fallback, repair attempt or automatic retry follows. A callback exception
propagates as its original exception after cleanup. Other errors contain only
closed diagnostic codes and an unknown outcome, never a token, source payload,
provider body or SQL text.

Version-2 plain-pack INSERTs begin with a fixed `WITH` CTE. The affected-count
validator identifies these from the sealed `backfill:*` statement contract, not
by pretending every `WITH` query is read-only; its original `changes()` count
still has to match exactly.

## Independent full readback

The read helper independently rehydrates the original packet and builds a fixed
`BEGIN DEFERRED` read transaction. It checks all 126 raw schema objects, zero
header, complete typed rows of every target table (including unrelated public
universe/cache and private history), rowids/sequences, FKs, schema markers and
the exact dedicated clean migration receipt. It does not merely look for the
receipt. Pre-receipt journal count=1 is correctly replaced by the complete final
journal guards including marker plus clean receipt.
The independent read-plan serializer remains ASCII JSON; the version-2 write
packet uses UTF-8 JSON. Both exact bodies are separately bounded to 16 MiB.
Before a real write, construct and size-check the original packet's read plan
as well; fitting the writer or a synthetic capacity request is not proof that
the reader has the same byte size or that the provider supports either request.

Perform this exact postimage read **before enabling target business writers**.
Subsequent legitimate cache/history/Owner mutations will intentionally fail an
original-image comparison; that is not proof that the migration never occurred.
Never turn a mismatch, missing receipt or later changed database into replay
permission.

`write_commit_acknowledged` and `target_postimage_acknowledged` are separate
observations. Readback never claims a new write commit and never authorizes
replay or delivery. After unknown, the caller may explicitly request this read;
neither helper automatically calls the other. No global/permanent idempotency
lease is claimed: an operator must not invoke another write merely because a
receipt is absent or a previous call was inconclusive.

Returned immutable observations re-derive safe facts from the original packet
and raw response before exposing a summary. Edited dataclasses, unknown fields
and resealed metadata cannot forge a successful summary. Raw responses and the
private original packet remain excluded from repr and safe metadata.

## Evidence scope

Owned loopback tests send real requests and execute real native SQLite/Hrana SQL,
including accepted-response loss, close errors, nonempty/FK-disabled refusal,
permission STOP, cancellation and full-image corruption after a receipt exists.
They do not prove real Turso support, account quota, TLS/provider infrastructure,
durability, restore, browser holdings synchronization, natural Cron, delivery,
main deployment or formal release.

All remote-applied, provider-capability, restore, durability, retry, delivery,
sender-capability, natural-schedule and formal-release qualification flags remain
literally false. Actual operator evidence must be recorded separately.
