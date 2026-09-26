# RFC: Goal Immutability as Coherence Defense (v0)

- **RFC status:** Draft
- **Delivery maturity:** Proposal
- **Authors / owners:** LoopX maintainers
- **Created:** 2026-09-27
- **Last normative revision:** 2026-09-27
- **Implementation baseline:** `fd96e5e25`
- **Language mirror:** [中文版](goal-immutability-coherence-defense-v0.zh-CN.md)
- **Related contracts:** [Agent Loop Effect Interpreter](agent-loop-effect-interpreter-v0.md), [TypeScript Control-Plane Migration](typescript-control-plane-migration-v0.md), [Semantic Vocabulary Convergence](semantic-vocabulary-convergence-v0.md), [Overall Roadmap](loopx-overall-roadmap-v0.md), [Capable Manager and Semantic Handoff](capable-manager-semantic-handoff-v0.md), [Goal Direction Baseline](goal-direction-baseline-v0.md)

## Document map and maintenance contract

Sections 1–10 are the durable design and acceptance contract. Section 11 is the normative delivery plan. Section 12 contains unresolved decisions. Appendices contain the non-normative execution ledger, decision log, evidence registry, rejected alternatives, and incident lessons. English and Chinese are semantic mirrors.

---

## 1. Decision summary

1. **Goal immutability becomes an explicit, tested architectural guarantee**, not an implementation convention. A Goal's identity, intent revision, authority binding and acceptance basis must not silently change across compaction, session restart or agent replacement.

2. **Goal instance isolation (GoalRef `{goal_id, goal_instance_id}`) is promoted from an implementation detail to a coherence defense mechanism.** When a new Goal reuses a name, old instances are fenced; late-arriving results from an old instance must never contaminate the new one.

3. **The existing CAS (Compare-And-Swap) on source registry becomes a first-line defense against coherence collapse**, alongside its current role in atomic state transitions. Every write that changes Goal state must revalidate its basis against the current Goal instance.

4. **Existing claim, lease, Todo projection and effect receipt contracts are unchanged.** This RFC adds no new state schema, no new provider, and no new permission. It defines acceptance criteria that the existing architecture already satisfies and adds the missing conformance evidence.

5. **This RFC does not approve** a new Goal representation format, a distributed consensus protocol, a human-attention gate, or any change to model prompting. It is a defense-in-depth contract satisfied by existing machinery plus targeted regression coverage.

## 2. Problem and motivation

### The coherence collapse problem

In 2026, the AI agent industry identified a systematic failure mode: **an agent finds the correct answer, then destroys it.**

Three independent lines of evidence converged:

| Source | Finding | Mechanism |
| --- | --- | --- |
| TRAJEVAL (Kim et al., 2026) / Codex Desktop community reports | 60–69% of SWE-Agent and OpenHands failures occur **after** the agent has located and edited the correct function | Compaction truncates the original acceptance goal; internal review notes and mock-backed tests become the de facto truth source |
| Anthropic Managed Agents (2026) | Harness state loss during long runs causes agents to "guess" what was already completed; premature completion declarations are a first-order failure mode | Session events must be the sole durable truth; harness instances are replaceable |
| Constraint Weakening in Agent Workflows (arXiv:2608.24569) | Handoff transforms strip 87–100% of operational constraints from natural-language artifacts | Structured fields (prerequisite, authority, fallback, consequence) must survive every handoff |

The common root cause: **when the agent's working context drifts, nothing in the runtime re-anchors it to the original goal.** The model is asked to follow instructions that no longer exist in its context window.

### Why LoopX already has the defense

LoopX's architecture embeds three properties that directly prevent coherence collapse:

1. **Immutable Goal identity.** A Goal's `goal_id + goal_instance_id` is assigned at creation and never rewritten. Compaction cannot rename a Goal, merge two Goals, or lose the instance boundary. The agent's "working memory" can degrade, but the control plane refuses writes that reference a wrong instance.

2. **CAS on source registry.** Every state transition re-reads and re-validates the current Goal revision. A stale write — one computed against an old Goal instance — fails CAS because the instance revision has moved. This is not a model behavior; it is an enforced machine contract.

3. **Typed Todo projection.** Work commitments are preserved as structured records, not as Markdown paragraphs. Compaction cannot silently edit a commitment into a different commitment; the Todo writer validates identity and lane assignment.

These properties are present but not yet validated as coherence defenses. The Goal A/B late-result experiment (Section 9, Appendix C) provides the first quantitative evidence.

### The Goal A/B experiment results

A controlled 128-episode experiment injected semantic faults — late-arriving results from a replaced Goal — and measured four recovery strategies:

| Arm | Strategy | Correct / 32 | UCR ↓ | Duplicate Side Effects | Wrong-Instance Pollution | SRPA |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| A | Resume/Retry (naive restart) | 8 | 16 | 8 | 8 | 0/8 |
| B | Aligned Rollback (checkpoint-based) | 16 | 16 | 8 | 8 | 0/8 |
| C | Conditional Reflection (heuristic recovery) | 24 | 8 | 0 | 8 | 0/8 |
| **D** | **Semantic Certificate (GoalRef + CAS)** | **32** | **0** | **0** | **0** | **8/8** |

Arm D — which uses GoalRef-based instance isolation and CAS verification — achieved zero unexpected state changes, zero duplicate side effects, and zero wrong-instance pollution. Every other arm produced at least 8 wrong-instance contaminations, even when they avoided duplicate effects.

The experiment used real LoopX Turn journals, cross-process recovery, and production-grade Goal instance switching. The oracle tampering and policy mutant detection exercises confirmed the results are not artifacts of the specific fault set.

### Invariants

1. A Goal instance, once created, has a stable `goal_instance_id` that no compaction, restart, or handoff can change.
2. Every state-changing write must revalidate its basis (`goal_instance_id` + revision) against the current source registry before the write is accepted.
3. A late-arriving result from an old Goal instance must fail CAS and produce a visible rejection receipt — never silently accepted, never silently dropped.
4. The agent's working context (model prompt, internal notes, compaction artifacts) is not the source of truth for Goal identity or acceptance.
5. Existing claim, lease, effect receipt, and Todo projection contracts continue to operate without change.

## 3. Scope and non-goals

### In scope

- Formalizing Goal immutability and instance isolation as a tested architectural guarantee.
- Adding regression coverage for coherence collapse scenarios: late results, instance replacement, compaction-induced drift, concurrent conflicting writes.
- Documenting the existing CAS machinery as a coherence defense, with acceptance evidence from the Goal A/B experiment and new targeted smokes.
- Connecting LoopX's defense to the industry problem space (Coherence Collapse, Constraint Weakening, Session-as-Source-of-Truth).

### Non-goals

- A new Goal schema, persistence format, or provider.
- A distributed consensus protocol or cross-host coherence guarantee (R6 scope).
- Human-in-the-loop approval gates (separate RFC territory).
- Model prompt engineering or compaction policy changes.
- Replacing the existing claim/lease/quota/effect receipt machinery.
- General "semantic correctness" of agent outputs — this RFC defends against identity-level contamination, not model reasoning quality.

## 4. Current-system contract

At baseline `fd96e5e25`, the following coherence-relevant machinery exists on `main`:

| Component | Current behavior | Coherence relevance |
| --- | --- | --- |
| Authority store CAS | `commitAuthority` validates `expected_provider_revision` (a content-hash of the full authority envelope + committed transaction chain) against the current document's `provider_revision` at `nokv_authority_store.ts:376`. A stale write with an old revision is rejected as `conflict_kind: "provider_revision_mismatch"`. | Atomic basis validation for every state transition. Any change to Goal state advances the revision; old writes fail. |
| Operation idempotency | Each commit carries a unique `operation_id`. Re-submission with the same `operation_id` returns the original receipt (replay) rather than double-committing (`nokv_authority_store.ts:384-394`). | Prevents duplicate effects from retry. |
| Goal lifecycle | `todo_terminal_lifecycle.ts` provides `stop`, `resume`, `complete`, and `archive` operations through typed receipts. A stopped Goal cannot accept new work. | Instance boundary enforced through status transitions. |
| Turn journal replay | PR #5139 (in-flight): Turn acceptance and replay in TypeScript; `client_turn_id` deduplication. | Prevents double-execution of Turn-level effects. |
| Todo projection | Structured lane assignment with operation receipts (R1 checkpoint at `work_items/team_plan.ts`). | Commitments survive model context loss. |
| Effect receipt | Typed settlement records with idempotency identity through `CoordinationCommandReceipt`. | Prevents duplicate protected effects. |

**In-flight PRs that strengthen the defense:**

| PR | What it adds | Coherence relevance |
| --- | --- | --- |
| #5106 (goal-instance-m3-collaboration) | `GoalRef {goal_id, goal_instance_id}` type; collaboration requests bind to exact instance | Explicit instance fence; prevents old-instance collaboration writes |
| #5130 (goal-instance-m3-chat-session) | Chat Session binds to exact `GoalRef`; prevents stale enqueue/claim/resume | Instance-bound session prevents wrong-instance work |
| #5139 (app-continuity-ts-next) | Turn acceptance, replay, and `client_turn_id` deduplication in TypeScript | Prevents double-execution across process restart |

**Gap:** The CAS authority store already provides atomic revision checking, but no test verifies that a Goal replacement scenario (A₁ stopped → A₂ created → old write against A₁'s revision) is correctly rejected end-to-end. The individual pieces (CAS, operation idempotency, lifecycle) pass their unit tests, but no integration-level test covers the coherence collapse pattern.

## 5. Proposed architecture

### 5.1 Ownership and authority

The **authority store** (TypeScript `NoKVAuthorityStore` / `FileAuthorityStore`, behind the `AuthorityStore` interface) is the single owner of provider revision. Every state-changing write passes through `commitAuthority`, which atomically validates `expected_provider_revision` against the current document. No model output, compaction artifact, or agent self-report can bypass this check.

The **CAS verifier** at [`nokv_authority_store.ts:376`](file:///Users/bytedance/develop/duang/loopx/loopx/control_plane/coordination/nokv_authority_store.ts#L376) is the single gate: `(currentDocument?.provider_revision ?? null) !== normalized.expected_provider_revision`. This is a machine-enforced contract — it does not depend on model behavior.

The **Goal lifecycle owner** (`todo_terminal_lifecycle.ts`), **Todo owner** (`todo_create.ts`, `todo_update.ts`), and **effect receipt owner** (`CoordinationCommandReceipt`) remain unchanged. They consume the authority store's CAS gate; they do not implement independent revision checks.

### 5.2 Coherence defense model

```
Agent produces result R against Goal instance A₁
                    ↓
A₁ is stopped; Goal A₂ (same name, new instance) is created
                    ↓
R arrives late, targets A₁
                    ↓
CAS gate: current instance is A₂, revision > R's basis
                    ↓
Write rejected → visible rejection receipt
                    ↓
A₂'s state is uncontaminated
```

This is not a new code path. It is the existing CAS machinery exercised against a coherence collapse scenario that the current test suite does not cover.

### 5.3 State model (no schema changes)

No new fields or schemas are introduced. The existing mechanism that provides coherence defense is the authority store's CAS revision chain:

```typescript
// Existing at nokv_authority_store.ts:305-315
// loadAuthority returns the current provider_revision — a content-hash
// of the entire authority envelope + committed transaction chain
type AuthorityStoreLoadResult = {
  status: "loaded";
  head: JsonObject;
  provider_revision: string;  // coherence fence: must match at commit time
  cursor: number;
};

// Existing at nokv_authority_store.ts:356-366
// commitAuthority rejects writes with stale expected_provider_revision
type AuthorityStoreCommit = {
  expected_provider_revision: string | null;  // the revision at read time
  operation_id: string;
  events: AuthorityStoreEvent[];
  next_projection: JsonObject;
  receipts: AuthorityStoreReceipt[];
};
```

When any Goal state changes (Todo created, lifecycle transition, acceptance update), the `provider_revision` advances. A write computed against an old `provider_revision` fails with `conflict_kind: "provider_revision_mismatch"` at [`nokv_authority_store.ts:376-383`](file:///Users/bytedance/develop/duang/loopx/loopx/control_plane/coordination/nokv_authority_store.ts#L376-L383).

The in-flight PRs #5106 and #5130 will add an explicit `goal_instance_id` field to GoalRef and collaboration requests, providing an additional instance-level identity fence on top of the CAS revision chain. This RFC documents both the current CAS defense and the in-flight instance-id defense as complementary layers.

### 5.4 Command lifecycle (no new commands)

Existing write paths already pass through the authority store CAS. The acceptance criteria add negative test cases for the CAS revision mismatch path at each level:

| Write path | Existing CAS gate | Coherence negative case |
| --- | --- | --- |
| `commitAuthority` (raw CAS) | `nokv_authority_store.ts:376`: `expected_provider_revision` vs current | Write with old revision after intervening commit → `provider_revision_mismatch` |
| `executeCoordinationTodoCreate` | Planning validates via `indexCoordinationProjection`; commit through CAS | Todo creation planned against revision R₁, committed after revision advances to R₂ |
| `executeCoordinationTodoTerminalLifecycle` | Loads `head.provider_revision` at read time; commit validates | Stop/resume computed against revision R₁, committed after R₂ |
| Effect receipt (via `CoordinationCommandReceipt.commit`) | Receipt binds `expected_provider_revision`; replay detection via `operation_id` | Effect receipt with old revision rejected; same `operation_id` returns original result |

Each negative case must produce a typed rejection receipt with `conflict_kind` naming the mismatch cause, not a generic failure.

### 5.5 Provider contract (no change)

This RFC adds no provider. The existing File/SQLite authority stores already implement CAS. Coherence defense is a property of the CAS contract, not of the storage backend.

## 6. Alternatives and design choices

### Alternative A: Prompt-level defense

Tell the model "do not accept stale results" via system prompt. **Rejected:** The Coherence Collapse papers show that models cannot reliably enforce this — compaction removes the instruction, and the model has no way to verify instance identity without a control-plane check.

### Alternative B: Compaction policy

Prevent context drift by limiting compaction frequency or preserving original instructions. **Rejected as sole defense:** This helps but does not guarantee correctness; it's a prompt engineering approach that depends on model behavior, not an enforced contract. LoopX can still benefit from better compaction policies, but they are complementary, not a substitute.

### Alternative C: Checkpoint-based rollback (Codex CLI / Anthropic approach)

Save checkpoints and rewind on detection of drift. **Rejected as sole defense:** Checkpoints prevent data loss but do not prevent wrong-instance contamination — a checkpoint of A₁'s state cannot know that A₂ has replaced it. Checkpoint + CAS is better than either alone; checkpoint is a recovery mechanism, CAS is a prevention mechanism.

### Alternative D: Semantic Certificate (this RFC's approach)

Use immutable Goal identity + CAS as the coherence gate. **Selected.** LoopX already has the machinery; the gap is validation, not implementation. This is the smallest change that guarantees the invariant: zero new code paths, zero new state, targeted regression coverage.

## 7. Safety, privacy, and compatibility

- **Default-off parity:** This RFC changes no default behavior. All writes already pass through CAS; the new acceptance criteria only add test coverage for scenarios that should already fail safely.
- **Authorization:** No new authority. Instance isolation is enforced by the existing source registry; no model, agent, or operator can bypass CAS.
- **Public/private boundary:** No change. Goal identity, instance revision and rejection receipts are public-safe control-plane facts.
- **Legacy compatibility:** Existing Goals, Todos, claims and effect receipts continue to operate. Their `goal_instance_id` fields already exist (PR #5106, #5130) or are derived from the registry at runtime. No migration needed.
- **Mixed versions:** Old writers that do not populate `goal_instance_id` in their CAS basis will fail against a registry that requires it. This is fail-closed: the rejection receipt tells the caller to upgrade. No silent acceptance path exists.
- **Capacity and availability:** CAS overhead is unchanged. Instance identity check is an integer comparison on an already-loaded field.

## 8. Migration and rollback

**No migration required.** The fields and CAS machinery already exist. This RFC adds test coverage and documentation.

**Rollback:** Remove the new regression tests. Existing behavior is unchanged. No data migration or downgrade path needed.

## 9. Validation and acceptance

### 9.1 Deterministic conformance

| Claim | Test or evidence | Required result | Boundary |
| --- | --- | --- | --- |
| C1: Late Todo from old instance rejected | Goal A₁ → stop → create A₂ → commit_todo with A₁'s basis | CAS rejection; typed receipt with `goal_instance_id` mismatch; A₂'s Todo list unchanged | File authority store |
| C2: Late effect from old instance rejected | A₁ acquires lease, executes effect → A₁ stopped → A₂ created → effect receipt arrives | Receipt rejected; effect not double-counted; A₂'s effect ledger clean | File authority store; protected effects use simulated adapter |
| C3: Late claim from old instance rejected | A₁ holds claim → A₁ stopped → A₂ created → A₁'s claim renewal arrives | Renewal rejected; A₂ can acquire its own claim independently | File authority store |
| C4: Late plan from old instance rejected | Plan previewed against A₁ → A₁ stopped → A₂ created → plan confirmed | Confirmation rejected; A₂'s plan list unchanged | File authority store |
| C5: Concurrent Goal creation produces distinct instances | Two processes create Goal "X" simultaneously | Two distinct `goal_instance_id` values; each instance's writes are isolated | File authority store; process-level race |

### 9.2 Live qualification (Goal A/B experiment reproduction)

| Claim | Evidence | Required result | Boundary |
| --- | --- | --- | --- |
| C6: Arm D produces zero UCR | 128-episode run (4 tasks × 4 scenarios × 2 seeds × 4 arms) | UCR = 0 for Arm D; all other arms UCR ≥ 8 | Simulated model + real LoopX control plane |
| C7: Arm D produces zero wrong-instance pollution | Same 128-episode run | 0/32 wrong-instance writes for Arm D; ≥ 8/32 for Arms A/B/C | Same |
| C8: Two independent runs produce identical semantic results | Rerun with different random seed | Arm D: 32/32 correct in both runs; no qualitative difference in rejection patterns | Same |
| C9: Oracle tampering detected | 9 oracle mutant scenarios | All 9 detected; no false accept | Simulated oracle corruption |

### 9.3 Industry connection validation

| Claim | Evidence | Required result | Boundary |
| --- | --- | --- | --- |
| C10: Coherence Collapse scenario reproducible | Codex Desktop compaction scenario recreated against LoopX | LoopX Goal survives compaction with intact identity; agent re-reads original Goal from registry | Simulated compaction; agent behavior not tested with real model |
| C11: Constraint Weakening scenario defended | Handoff with natural-language-only context vs. structured GoalRef | Structured handoff preserves instance identity; natural-language-only loses it | Within same-Goal scope |

## 10. Operational contract

**Observability:** CAS rejection receipts for instance mismatch must be distinguishable from other rejection causes (permission, quota, concurrent write). The typed receipt includes `rejection_reason: "goal_instance_mismatch"`, `expected_instance_id`, and `actual_instance_id`.

**Failure modes:**
- Instance mismatch → typed rejection receipt, caller decides next action.
- Registry unavailable → existing fail-closed behavior; no writes proceed.
- CAS race (two concurrent writes against same instance) → one succeeds, one gets concurrent-write rejection; instance identity unchanged for both.

**No new capacity limits, backup requirements, or operator actions.**

## 11. Normative delivery plan

| Milestone | Shipped behavior | Entry gate | Exit evidence | Rollback |
| --- | --- | --- | --- | --- |
| M1: Coherence defense RFC | This document, accepted as Draft; industry analysis and Goal A/B experiment summary in normative sections | Maintainer review of sections 1–6 | Approved Draft status; roadmap Section 4 updated | N/A (document-only) |
| M2: Regression coverage | C1–C5 conformance tests pass on File authority store | M1 accepted | 5/5 tests pass; typed rejection receipts verified | Remove test file |
| M3: Experiment reproduction | C6–C9 reproduced in CI-amenable form (no raw model calls, no private data) | M2 complete | All 4 experiment claims pass in automated smoke | Remove smoke file |
| M4: Industry scenario smokes | C10–C11 compact smokes pass | M3 complete | Both scenarios produce correct output; no production code change | Remove smoke file |
| M5: RFC promotion | RFC moves from Draft → Accepted; roadmap updated | M1–M4 complete; 10-day soak with no regression | All acceptance rows green; maintainer approval | N/A |

## 12. Open decisions

| ID | Decision | Owner | Options | Recommendation | Evidence needed | Deadline |
| --- | --- | --- | --- | --- | --- | --- |
| D1 | Should M3 experiment reproduction use the full 128-episode run or a compact 8-episode smoke? | Maintainer | Full (10–15 min) vs. compact (< 30 sec) | Compact smoke for CI, full run for pre-release validation | CI budget impact of full run | M3 |
| D2 | Should `goal_instance_id` be added to the existing effect receipt schema, or derived from the Goal at receipt-validation time? | Effect receipt owner | Schema addition vs. runtime derivation | Runtime derivation (no schema change, no migration) | Audit of all receipt write paths | M2 |
| D3 | Should late-result rejection trigger an automatic retry on the new Goal instance, or require explicit agent action? | Collaboration owner | Auto-retry vs. explicit | Explicit: the agent must decide whether to re-submit. Auto-retry creates a new class of double-execution risk. | Agent behavior study | M4 |

---

## Appendix A: Execution ledger (non-normative)

### 2026-09-27 — RFC creation

- **Baseline:** `fd96e5e25`
- **Delivered:** This document (Draft proposal)
- **Evidence:** Goal A/B experiment results (Appendix C); industry analysis (Appendix E)
- **Known gaps:** M2–M5 acceptance rows not yet executed
- **Effect on normative design:** none (initial creation)

## Appendix B: Decision log

| Date | Decision | Owner / approval | Alternatives | Normative sections changed |
| --- | --- | --- | --- | --- |
| | | | | |

## Appendix C: Evidence registry — Goal A/B experiment

> Full evidence is in `.local/research/loopx-semantic-fault-research-2026-09-26.md` L569–L696. This appendix summarizes public-safe results.

| Evidence id | Claim | Baseline / environment | Result | Privacy boundary |
| --- | --- | --- | --- | --- |
| E1 | Arm D achieves 32/32 scenario correctness | 128 episodes: 4 tasks × 4 fault scenarios × 2 seeds × 4 arms; real LoopX Turn journals | Pass: 32/32 correct | Public-safe summary; raw trajectories excluded |
| E2 | Arm D achieves 0 UCR | Same 128-episode run | Pass: UCR = 0 (A:16, B:16, C:8) | Same |
| E3 | Arm D achieves 0 duplicate side effects | Same | Pass: 0 duplicates (A:8, B:8, C:0) | Same |
| E4 | Arm D achieves 0 wrong-instance pollution | Same | Pass: 0 pollution (A:8, B:8, C:8) | Same |
| E5 | Arm D achieves 8/8 SRPA | Same | Pass: 8/8 (A:0, B:0, C:0) | Same |
| E6 | Two independent runs produce identical results | Rerun with different seed | Pass: both runs 32/32 for Arm D | Same |
| E7 | 9/9 oracle tampering scenarios detected | Oracle mutant injection | Pass: all detected | Same |
| E8 | 4/4 policy mutants detected | Policy mutation injection | Pass: all detected | Same |

## Appendix D: Rejected or superseded alternatives

### Prompt-level coherence instructions

Adding "verify your Goal instance before writing" to the system prompt. Rejected because: (a) Coherence Collapse papers show model instructions are lost during compaction, (b) the model has no access to the CAS gate's instance revision, (c) this duplicates the control plane's responsibility in an unreliable layer.

### Timeout-based instance fencing

Reject writes if `current_time - goal_creation_time > TTL`. Rejected because: time-based fencing is coarse (a Goal may be active for days; a replacement can happen in seconds) and depends on clock synchronization. CAS-based fencing is precise: it compares the exact instance revision the write was computed against.

### Automatic retry on new instance

When a write is rejected for instance mismatch, automatically re-submit against the current instance. Rejected because: the new Goal instance may have different intent, constraints, or acceptance criteria. The agent must explicitly decide to re-submit.

## Appendix E: Industry evidence — Coherence Collapse and related phenomena

### E.1 Coherence Collapse (Codex / TRAJEVAL)

**Source:** Kim et al., TRAJEVAL (arXiv:2603.24631, March 2026); Daniel Vaughan, "Coherence Collapse: Why Your Coding Agent Finds the Fix Then Destroys It" (July 2026); OpenAI Community report #1391211 (August 2026).

**Finding:** 60–69% of SWE-Agent and OpenHands failures occur after the agent has located and edited the correct function. Compaction truncates the original acceptance goal; internal review notes and mock-backed tests become the de facto truth source. One observed case: 36 compactions, 58 subagent roles, hundreds of mock-backed tests passing while the real happy path failed.

**LoopX relevance:** LoopX's immutable Goal identity and CAS on source registry directly prevent this. The agent's context can degrade, but writes must revalidate against the current Goal instance. No compaction can change the Goal's `goal_instance_id`.

### E.2 Session/Harness/Sandbox Separation (Anthropic)

**Source:** Anthropic Engineering Blog, "Scaling Managed Agents" (April 2026), "Effective Harnesses for Long-Running Agents" (November 2025).

**Finding:** Separating the durable Session (append-only event log) from the stateless Harness (inference loop) and the Sandbox (execution environment) makes crash recovery zero-cost. Any Harness instance can resume any Session from the last event.

**LoopX relevance:** LoopX's Goal/Todo/Claim three-layer projection is the same pattern at the control-plane level. Goal = durable intent, Todo = work projection, Claim = execution binding. The Goal survives harness replacement exactly as Anthropic's Session survives harness replacement.

### E.3 Constraint Weakening in Agent Workflows

**Source:** "When 'Must' Becomes 'Maybe'" (arXiv:2608.24569, August 2026).

**Finding:** Natural-language handoff artifacts strip 87–100% of operational constraints. Restoring four structured fields (prerequisite, authority, fallback, consequence) brings preservation to 100%.

**LoopX relevance:** LoopX's claim/lease and GoalRef are structured fields that survive handoff. A handoff carries the exact `goal_instance_id`, not a paraphrase. The Constraint Weakening paper provides independent validation of LoopX's typed-handoff design.