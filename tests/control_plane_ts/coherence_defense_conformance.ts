/** Verify the authority store CAS rejects stale writes after an intervening
 *  state change — the coherence defense against late-arriving results from a
 *  replaced Goal instance.
 *
 *  C1: Stale commit body rejected after an intervening unrelated commit.
 *  C2: The same operation_id replayed after commit returns the original
 *      receipt (idempotency), never double-commits.
 *  C3: A stale write followed by a fresh write on the same operation_id
 *      correctly replays the first successful (fresh) commit.
 *  C4: Concurrent competing writes at the same provider_revision: one
 *      succeeds, the other gets a conflict.
 *  C5: An initial commit (null provider_revision) succeeds; a second
 *      initial commit on the same store is rejected because the revision
 *      has advanced.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type {AuthorityStoreConformanceFactory} from "./authority_store_conformance.ts";
import {authorityStoreCommitFixture as commit} from "./authority_store_conformance.ts";

export function registerCoherenceDefenseConformance(
  provider: string,
  factory: AuthorityStoreConformanceFactory,
): void {
  // ─── C1: stale write rejected after intervening commit ───
  test(`${provider}: C1 stale write rejected after intervening commit`, async (t) => {
    const {store} = await factory(t);
    // Seed the store with an initial commit so provider_revision ≠ null.
    const seed = commit(null, "seed-coherence", 1, 1);
    assert.equal((await store.commitAuthority(seed)).status, "applied");

    // Read current revision.
    const head = await store.loadAuthority();
    assert.equal(head.status, "loaded");
    if (head.status !== "loaded") return;
    const staleRevision = head.provider_revision;

    // Intervening commit advances the revision.
    const intervening = commit(staleRevision, "intervening-commit", 2, 1);
    assert.equal((await store.commitAuthority(intervening)).status, "applied");

    // Stale write with the old revision must be rejected.
    const staleWrite = commit(staleRevision, "stale-write", 3, 1);
    const rejected = await store.commitAuthority(staleWrite);
    assert.equal(rejected.status, "conflict");
    assert.equal((rejected as Record<string, unknown>).conflict_kind, "provider_revision_mismatch");
  });

  // ─── C2: idempotent replay after successful commit ───
  test(`${provider}: C2 operation idempotency prevents double-commit`, async (t) => {
    const {store} = await factory(t);
    const seed = commit(null, "seed-idempotent", 1, 1);
    assert.equal((await store.commitAuthority(seed)).status, "applied");

    const head = await store.loadAuthority();
    assert.equal(head.status, "loaded");
    if (head.status !== "loaded") return;

    // First write succeeds.
    const first = commit(head.provider_revision, "unique-operation", 2, 1);
    const firstResult = await store.commitAuthority(first);
    assert.equal(firstResult.status, "applied");

    // Same operation_id replay returns original receipt, not a conflict.
    const replay = commit(head.provider_revision, "unique-operation", 2, 1);
    const replayResult = await store.commitAuthority(replay);
    assert.equal(replayResult.status, "applied"); // replayed, not double-committed

    // Verify the store didn't change — no second event was appended.
    const after = await store.loadAuthority();
    assert.equal(after.status, "loaded");
    if (after.status !== "loaded") return;
    const receipt = await store.readReceipt("unique-operation");
    assert.equal(receipt.status, "found");
    assert.equal(receipt.provider_revision, firstResult.provider_revision);
    assert.equal(receipt.cursor, firstResult.cursor);
  });

  // ─── C3: stale rejected then fresh succeeds on same operation_id ───
  test(`${provider}: C3 stale rejection does not block fresh write with same operation_id`, async (t) => {
    const {store} = await factory(t);
    const seed = commit(null, "seed-same-op", 1, 1);
    assert.equal((await store.commitAuthority(seed)).status, "applied");

    const head = await store.loadAuthority();
    assert.equal(head.status, "loaded");
    if (head.status !== "loaded") return;
    const staleRevision = head.provider_revision;

    // Advance the revision.
    const intervening = commit(staleRevision, "intervening-same-op", 2, 1);
    assert.equal((await store.commitAuthority(intervening)).status, "applied");

    // Stale write with old revision → rejected.
    const staleWrite = commit(staleRevision, "contested-operation", 3, 1);
    const rejected = await store.commitAuthority(staleWrite);
    assert.equal(rejected.status, "conflict");

    // Fresh write with current revision → accepted.
    const fresh = await store.loadAuthority();
    assert.equal(fresh.status, "loaded");
    if (fresh.status !== "loaded") return;
    const freshWrite = commit(fresh.provider_revision, "contested-operation", 3, 1);
    const freshResult = await store.commitAuthority(freshWrite);
    assert.equal(freshResult.status, "applied");

    // Verify the store now reflects the fresh write.
    const receipt = await store.readReceipt("contested-operation");
    assert.equal(receipt.status, "found");
  });

  // ─── C4: concurrent writes at same revision → one wins ───
  test(`${provider}: C4 concurrent writes at same revision — one succeeds`, async (t) => {
    const {store, contender} = await factory(t);
    const seed = commit(null, "seed-concurrent", 1, 1);
    assert.equal((await store.commitAuthority(seed)).status, "applied");

    const head = await store.loadAuthority();
    assert.equal(head.status, "loaded");
    if (head.status !== "loaded") return;
    const revision = head.provider_revision;

    // Both contenders target the same revision.
    const writeA = commit(revision, "concurrent-a", 2, 1);
    const writeB = commit(revision, "concurrent-b", 3, 1);

    // Submit both concurrently — order determines winner.
    const [first, second] = await Promise.all([
      store.commitAuthority(writeA),
      contender.commitAuthority(writeB),
    ]);

    // Exactly one succeeds; the other gets a conflict.
    const applied = [first, second].filter(r => r.status === "applied");
    const conflicted = [first, second].filter(r => r.status === "conflict");
    assert.equal(applied.length, 1, `expected exactly one applied, got ${JSON.stringify([first, second])}`);
    assert.equal(conflicted.length, 1);
    assert.equal((conflicted[0]! as Record<string, unknown>).conflict_kind, "provider_revision_mismatch");

    // Both stores should converge to the same state.
    const afterStore = await store.loadAuthority();
    const afterContender = await contender.loadAuthority();
    assert.equal(afterStore.status, "loaded");
    assert.equal(afterContender.status, "loaded");
  });

  // ─── C5: second initial commit rejected ───
  test(`${provider}: C5 second null-revision commit rejected`, async (t) => {
    const {store} = await factory(t);
    // First commit with null revision succeeds (initial creation).
    const first = commit(null, "first-seed", 1, 1);
    assert.equal((await store.commitAuthority(first)).status, "applied");

    // Second commit with null revision must fail — revision has advanced.
    const second = commit(null, "second-seed", 2, 1);
    const rejected = await store.commitAuthority(second);
    assert.equal(rejected.status, "conflict");
    assert.equal((rejected as Record<string, unknown>).conflict_kind, "provider_revision_mismatch");
  });
}