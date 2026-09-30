# RFC: Quota Action Authority (v0)

- **RFC status:** Accepted
- **Supersedes / closes:** none
- **Delivery maturity:** Proposal
- **Authors / owners:** LoopX control-plane maintainers
- **Created:** 2026-09-30
- **Last normative revision:** 2026-09-30
- **Implementation baseline:** `b79bcb1949e470aac3fcee416e96f2f4c468f926`
- **Related contracts:** [Effect interpreter](agent-loop-effect-interpreter-v0.md), [Shared authority](shared-goal-authority-state-provider-v0.md), [TypeScript migration](typescript-control-plane-migration-v0.md)
- **Language mirror:** [中文版](quota-action-authority-v0.zh-CN.md)

## Document map and maintenance contract

Sections 1–10 define the design and acceptance contract; section 11 defines
delivery gates; section 12 records unresolved choices. Appendix A is evidence,
not a delivery claim. Merge accepts this design basis; it does not ship runtime
behavior, change defaults, activate a provider, or approve promotion.
The English and Chinese documents are semantic mirrors; normative changes
must update both.

## 1. Decision summary

Resolve each executable quota action once in the existing TypeScript quota
boundary, after eligibility and selection are known. Derive action-bearing
presentation from that result. Keep recommendation, receipt-bound selection,
current execution admission, and historical settlement as distinct facts.

Start with the inconsistent scoped-gate action projection. Preserve existing
wire fields and receipt identities. A whole quota pipeline rewrite, new
scheduler, and implicit task reservation are outside this decision.

## 2. Problem and motivation

A quota packet can tell an Agent to work on two different Todos. With a user
gate scoped to a peer, a P0 Todo requiring shell and network, a P1 Todo requiring
only shell, and only shell available, the audited builder returns:

| Surface | Observed action |
| --- | --- |
| `selected_todo.todo_id` | P1 shell Todo |
| `interaction_contract.agent_channel.primary_action` | P1 shell Todo |
| `agent_scoped_user_gate_override.selected_action` | P0 network Todo |

The override chooses text from an earlier executable summary before capability
filtering. Packet assembly retains both results. This is a reproducible
presentation inconsistency; the probe does not prove an actual unauthorized
execution or quantify its frequency. P0 here denotes work priority, not a
security severity rating.

### Invariants

- Every action presented as executable refers to the same final action identity.
- Recommendations never grant ownership, capabilities, permission, or a lease.
- An existing Turn receipt keeps its original Todo and settlement identity.
- Current gates can stop new execution without erasing historical recovery.
- No eligible action means no action-bearing override revives an earlier Todo.

## 3. Scope and non-goals

In scope: final quota action projection, compatibility consumers, and the
handoff from a recommendation to existing Todo claim/admission mechanisms.
Non-goals: change ranking policy, remove wire fields, reserve work during a
status read, redesign storage, add a capability/provider, or migrate all Python
orchestration in one batch. Contention work in section 6 is a separate bounded
follow-up under the existing shared-authority contract.

## 4. Current-system contract

- [`agent_scope.py`](../../../loopx/control_plane/agents/agent_scope.py)
  `_agent_scoped_user_todo_override` chooses its own `selected_action`.
- [`should_run_prepare.py`](../../../loopx/control_plane/quota/should_run_prepare.py)
  computes that override before the capability gate; explicit selection and
  receipt recovery have later precedence.
- [`should_run_packet.py`](../../../loopx/control_plane/quota/should_run_packet.py)
  attaches the override separately from `selected_todo` and interaction output.
- [`quota_selection.ts`](../../../loopx/control_plane/todos/quota_selection.ts)
  already owns typed eligibility/ranking facts. Identical profiles and the same
  unclaimed queue can recommend the same first Todo to multiple Agents.
- [`todo_claim.ts`](../../../loopx/control_plane/coordination/todo_claim.ts)
  owns canonical claim plus optional hard lease. Its receipt helper recovers
  accepted operations but does not replan a rejected CAS write.

[PR #4061](https://github.com/loopx-project/loopx/pull/4061) concerns the snapshot
for fallback declarations and their direct dependencies. It explicitly does
not provide an atomic snapshot of the entire quota/status packet. This RFC
complements that work; neither needs to absorb the other's implementation.

## 5. Proposed architecture

### Ownership and placement

Keep final action meaning in `control_plane/quota`, composing existing typed
Todo selection and gate rules. Python may gather facts and render compatibility
output; it must not rank or select a second executable action. Claim/lease
admission stays in `control_plane/coordination` and `control_plane/work_items`.
Capability id: no new capability. Provider id: existing configured authority
provider. Delivery: built-in control-plane implementation, no extension.

### State and identity

Use a small internal discriminated result at final packet composition:

| Kind | Meaning | Action-bearing output |
| --- | --- | --- |
| Recommendation | Eligible candidate, no durable Turn selection | Explicitly advisory candidate |
| Selected | Existing selection contract binds the Turn to a Todo | That exact Todo; execution still needs current admission |
| Settlement | Recover or finish an existing receipt | Original receipt identity and permitted recovery steps |
| Gated | No currently admitted delivery action | Typed reason and allowed resolution; no stale work instruction |

These are proposed internal states, not new wire enums or persisted fields.
Preserve all `quota_selected_todo_v0` fields, override schemas, source labels,
selection markers, and settlement receipts. Derive legacy `selected_action`
text from the resolved action when present. When absent, follow the existing
schema's optional-field behavior; if a consumer requires nonempty text, define
its compatible gated representation before implementation. Never substitute a
new Todo merely to make old receipt fields match current recommendations.

The owner must retain legitimate distinctions: a preferred candidate can
coexist with an unbound Turn, and a completed Todo can still need settlement.
Identity comparison must use the existing structured identity, never action
text, display index, or a substring classification rule.

### Lifecycle and effects

Observation produces recommendations without mutation. Explicit selection
binds the existing Turn identity. Claim and current permission/capability/lease
checks admit execution. Validation, writeback, and spend use the bound identity.
Replay consults the original receipt and separately validates any present-tense
execution proof. A gate appearing between these stages stops new work through
the current admission owner; it does not delete an accepted result.

This is a coherence boundary, not a claim that all facts came from one database
transaction. Each effect continues to revalidate the facts it owns.

## 6. Alternatives, contention, and ROI

Copying the final action text into one override is the cheapest repair, but
needs a shared final projection rule to cover explicit selection, empty
candidates, and receipt replay. Replacing the entire quota pipeline has a much
larger compatibility surface and no measured incremental benefit yet.

Todo contention has separate causes and remedies:

| Observation or risk | Bounded response | Evidence boundary |
| --- | --- | --- |
| Two equal-profile Agents see the same first unclaimed Todo | Claim before work; after a definitive competing-owner rejection, refresh eligibility and select another candidate through the existing selection contract | Confirmed synthetic recommendation collision; no production rate measured |
| Independent canonical claims expose provider CAS conflict | At the typed claim owner, re-read receipt/head, revalidate relevant facts, rebuild the mutation and retry within a bound | Confirmed command-level File/SQLite interleaving; same-root local CLI writer lock can serialize this case |
| Same Todo or overlapping required write scopes | Preserve ownership/lease rejection; do not retry into a takeover | Same-Todo exclusion confirmed; overlap is a required acceptance row |
| Different sessions reuse one Agent id | Retain execution-key/lease-generation checks; inspect session binding before attributing duplication to ranking | Diagnostic hypothesis, not established incident cause |

The shared-authority RFC already requires Todo-scoped semantic conflicts.
Implement its remaining canonical claim adoption locally. Do not put domain
retry rules in the generic receipt helper or weaken provider CAS. Check receipt
recovery before a replan; preserve request identity, source authorization,
explicit revision/transfer preconditions, dependencies, gates, and write scopes.
An ambiguous commit is recovered by the same operation identity, not by picking
a new Todo. A definitive no-write rejection can permit reselection; a bound
Turn must first use its existing reconciliation contract, never silent retargeting.

Equal-rank distribution, jitter, or a new atomic claim-next API should wait for
measurements showing that refresh/reselection remains costly. Hashing across
priority classes or randomizing every poll would silently alter scheduling.

The following are planning estimates, not measured labor or production savings:

| Slice | Estimated effort including focused regression review | Expected ROI | Decision |
| --- | --- | --- | --- |
| Final action projection plus compatibility matrix | 1–3 engineer-days | High: removes a reproduced contradiction with a small ownership change | Implement first |
| Canonical claim revalidation/retry | 2–4 engineer-days | Medium to high for independent cross-runtime writers; smaller with one serialized local writer | Separate PR after negative/replay fixtures |
| Ranking distribution or claim-next API | Unestimated until contention measurements | Unknown; adds fairness, selection and recovery semantics | Defer |
| Whole quota orchestration rewrite | Multi-week change | Unproven over the bounded slice | Defer |

Evaluate savings as avoided failed attempts × average recovery time plus avoided
wrong-action recovery, against implementation and ongoing maintenance cost.
Collect rates and p50/p95 time-to-success before claiming a payback period.

## 7. Safety, privacy, and compatibility

Status remains read-only. No default changes to authority provider, hard-lease
mode, Agent identity, scheduling, permissions, or capability activation are
approved. Existing readers must keep parsing existing fields. Disclose the
intentional correction to contradictory action text in the implementation PR
and release notes; do not call changed output universally behavior-preserving.
Use synthetic Todo ids and aggregate counters in public evidence. Private
Goal contents, host paths, raw logs, and credentials are excluded.

## 8. Migration and rollback

No persisted-state migration is planned. First characterize existing legal
selection/replay cases, then replace one action projection and its active
consumers. Compare compatibility output before widening adoption. Revert that
bounded projection change if the matrix fails; receipts and provider state
remain readable. Claim retries ship independently and can be reverted without
changing stored operation or lease identities.

## 9. Validation and acceptance

| Claim | Test or evidence | Required result | Boundary |
| --- | --- | --- | --- |
| One executable action | Peer-scoped gate × missing/full capabilities × empty candidates × explicit selection | All executable surfaces resolve to the final identity; no stale action | Current mismatch is known failing behavior |
| Recovery identity survives gates | Bound Turn, completed Todo, capability loss, settled/unsettled replay | Original settlement identity retained; no newly granted execution | Must be added before runtime delivery |
| Independent claims progress | Barrier before provider commit; two distinct Todos and operation ids | Both succeed after bounded internal revalidation | File/SQLite first; other profiles retain qualification gates |
| Same-target exclusion | Same Todo, foreign owner, overlapping write scopes, changed authorization/dependency | One winner or typed rejection; no unauthorized receipt | Not satisfied by success-only retry tests |
| Recovery is idempotent | Lost acknowledgement, found/missing/unavailable receipt, request drift | Original accepted receipt recovered; ambiguity never becomes a new claim | Generic receipt semantics unchanged |
| Compatibility | Existing quota smoke, focused tests, mixed legacy consumers | Wire shape retained; documented correction only | Green existing tests alone do not close the mismatch |

All rows are implementation gates, not claims that this documentation PR has
passed runtime qualification.

## 10. Operational contract

Use existing diagnostic/evidence surfaces to distinguish recommendation
collision, competing owner, provider-head contention, exhausted retry, and
ambiguous receipt recovery. Count attempts per successful claim and latency;
avoid a new telemetry subsystem. Never present a failed claim as execution
admission. The host consumes the existing typed recovery path rather than
looping on the same stale first candidate.

## 11. Normative delivery plan

| Milestone | Shipped behavior | Entry gate | Exit evidence | Rollback |
| --- | --- | --- | --- | --- |
| M0 | Coherent final action projection | Consumer inventory and characterization matrix | Mismatch fixed; negative/selection/replay cases and quota checks pass | Revert projection slice |
| M1 | Independent claims absorb unrelated CAS misses | Existing shared-authority rules; fixtures before code movement | Bounded retry, same-Todo/scope exclusion, current gates and lost-response recovery | Revert retry slice |
| M2 | Optional collision reduction, only if justified | Measured residual collision cost and agreed fairness policy | Better attempts/latency without starvation or priority inversion | Restore ranking policy |

M0 and M1 are independent reviewable changes. M2 requires a new explicit design
decision; this RFC does not approve an API or default-ranking change.

## 12. Open decisions

1. Quota maintainers choose the smallest internal result shape and compatible
   representation for absent action text before M0, based on actual consumer
   inventory. Recommendation: reuse current codecs and omit only already
   optional fields; no public-field removal.
2. Coordination maintainers choose the retry/time budget before M1, based on
   forced interleavings and provider latency. Recommendation: bounded retry
   with typed exhaustion and unchanged operation identity; no unbounded loop.
3. Maintainers decide whether M2 is justified after observing residual failed
   attempts and fairness. Recommendation: defer without measured evidence.

## Appendix A: Evidence registry (non-normative)

All observations use the implementation baseline in the header and synthetic
inputs; they establish mechanisms, not incidence in a deployed Goal.

| Evidence | Setup and result | Limit |
| --- | --- | --- |
| Action projection | `build_quota_should_run` with the section 2 fixture: shell-only selects P1 but override names P0; adding network removes that mismatch | No live action executed |
| Existing regression | `uv run --extra test python examples/control_plane/quota-agent-scoped-user-gate-smoke.py` passes while the combined fixture fails identity coherence | Demonstrates missing combined coverage |
| Recommendation | `projectQuotaSelection`: two unclaimed equal-rank rows, same profile, Agent A/B both get the first row | Recommendation is not reservation |
| Claim interleaving | Real File and SQLite stores; native two-Todo head in hard-lease mode; distinct operations/lease keys; barrier before `commitAuthority`: independent targets produce applied/conflict, same-operation retry applies | Bypasses outer local writer serialization; no deployed throughput claim |
| Exclusion control | Same setup with the same target: one applied, one conflict; same-operation retry yields `claim_owner_mismatch` | No evidence of double ownership |

Keep temporary probes outside the product surface. Promote their semantic
cases into the existing focused suites with M0/M1; do not preserve raw logs or
an experiment-specific runner as a permanent smoke.
