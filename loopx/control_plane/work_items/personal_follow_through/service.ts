import {readFile, lstat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import type {JsonObject} from '../../effect_program.ts';
import {withCanonicalWriter} from '../../coordination/local_authority_write.ts';
import {openLocalAuthorityStore} from '../../coordination/local_authority_provider.ts';
import {executeCoordinationTodoCreate} from '../../coordination/todo_create.ts';
import {executeCoordinationTodoUpdate} from '../../coordination/todo_update.ts';
import {canonicalTodoCollection} from '../../coordination/local_authority_read.ts';
import {TODO_DOMAIN_ITEM_SCHEMA} from '../../coordination/coordination_state_contract.ts';
import {config, digest, object, buildReview, type ReviewPacket, type FollowThroughConfig} from './contract.ts';

export async function readPrivateJson(path: string): Promise<unknown> {
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || (process.platform !== 'win32' && (st.mode & 0o077) !== 0) || st.size > 2_000_000) throw Error('private_file_required');
  return JSON.parse(await readFile(path, 'utf8'));
}
export async function loadConfig(path: string): Promise<FollowThroughConfig> {
  const c = config(await readPrivateJson(path));
  if (!isAbsolute(c.runtime_root)) throw Error('absolute_runtime_root_required');
  // This profile is owner-local. Never adopt a shared permissive runtime silently.
  const st = await lstat(c.runtime_root);
  if (!st.isDirectory() || st.isSymbolicLink() || (process.platform !== 'win32' && (st.mode & 0o077) !== 0)) throw Error('private_runtime_required');
  return c;
}
export async function readTodos(c: FollowThroughConfig) {
  if (!c.enabled) throw Error('profile_disabled');
  const store = await openLocalAuthorityStore(c.runtime_root, c.goal_id, {}, {existingOnly: true});
  const head = await store.loadAuthority();
  if (head.status !== 'loaded') throw Error('canonical_authority_unavailable');
  const collection = canonicalTodoCollection(head.head, c.goal_id, false);
  return {revision: head.provider_revision, todos: collection.projection.todo_ids.map(id => collection.projection.todos.get(id)!)};
}
export async function applyReview(configPath: string, value: unknown, approvedDigest: string): Promise<JsonObject> {
  const c = await loadConfig(configPath);
  if (!c.enabled) throw Error('profile_disabled');
  const packet = object(value, 'review') as unknown as ReviewPacket;
  if (packet.schema_version !== 'personal_follow_through_review_v0' || digest(packet) !== approvedDigest || packet.config_digest !== digest(c)) throw Error('review_identity_changed');
  // Revalidate all model-derived data and bind generated fields to the original review.
  const reconstructed = buildReview(c, packet.source, packet.candidate,
    {revision: packet.expected_provider_revision, todos: packet.candidate.kind === 'amend'
      ? [{schema_version: TODO_DOMAIN_ITEM_SCHEMA, todo_id: packet.todo_id, role: 'user', status: 'open', archive_state: 'active'}] : []}, packet.observed_at);
  for (const field of ['operation_id', 'todo_id', 'config_digest'] as const) if (reconstructed[field] !== packet[field]) throw Error('review_identity_changed');
  if (typeof packet.note !== 'string' || packet.note.length > 8000) throw Error('invalid_review_note');
  const currentGrant = async () => {try { const current = await loadConfig(configPath); return current.enabled && digest(current) === packet.config_digest; } catch {return false;}};
  return withCanonicalWriter(c.runtime_root, c.goal_id, false, async () => {
    if (!await currentGrant()) throw Error('profile_revoked');
    const store = await openLocalAuthorityStore(c.runtime_root, c.goal_id, {}, {existingOnly: true});
    const common = {goal_id: c.goal_id, actor_agent_id: null, registered_agents: [],
      operation_id: packet.operation_id, dry_run: false, now: new Date(packet.observed_at)};
    // Canonical receipt reconciliation precedes revision checks for exact retries.
    let result: JsonObject;
    if (packet.candidate.kind === 'create') {
      const receipt = await store.readReceipt(packet.operation_id);
      if (receipt.status === 'missing') {
        const current = await store.loadAuthority();
        if (current.status !== 'loaded' || current.provider_revision !== packet.expected_provider_revision) throw Error('review_stale');
      }
      result = await executeCoordinationTodoCreate(store, {...common,
        todo: {schema_version: TODO_DOMAIN_ITEM_SCHEMA, todo_id: packet.todo_id, role: 'user',
          status: 'open', done: false, archive_state: 'active', text: packet.candidate.title, note: packet.note}}, currentGrant);
    } else {
      result = await executeCoordinationTodoUpdate(store, {...common, todo_id: packet.todo_id,
        expected_role: 'user', expected_provider_revision: packet.expected_provider_revision,
        patch: {text: packet.candidate.title, note: packet.note}, clear_fields: []}, currentGrant);
    }
    return result;
  });
}
