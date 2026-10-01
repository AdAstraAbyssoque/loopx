import {parseArgs} from 'node:util';
import {open} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {captureLark} from '../../../extensions/lark/personal_follow_through.ts';
import {buildReview, digest, object, text} from './contract.ts';
import {loadConfig, readPrivateJson, readTodos, applyReview} from './service.ts';
import {propose} from './model.ts';

async function savePrivate(path: string, data: unknown) {
  // Exclusive creation: never overwrite another review or follow a symlink.
  const handle = await open(path, 'wx', 0o600);
  try {await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`); await handle.sync();}
  finally {await handle.close();}
}
export async function main(args: string[]): Promise<unknown> {
  const {values, positionals} = parseArgs({args, allowPositionals: true, options: {
    config: {type: 'string'}, start: {type: 'string'}, end: {type: 'string'}, output: {type: 'string'},
    packet: {type: 'string'}, index: {type: 'string'}, 'approve-digest': {type: 'string'}, 'allow-model': {type: 'boolean'},
  }});
  if (positionals.length !== 1 || !['prepare', 'inspect', 'apply', 'brief'].includes(positionals[0])) throw Error('usage_prepare_inspect_apply_brief_with_config');
  const configPath = text(values.config, 'config_path');
  const c = await loadConfig(configPath);
  if (!c.enabled) return {status: 'disabled'};
  if (positionals[0] === 'brief') {
    const head = await readTodos(c);
    return {status: 'loaded', provider_revision: head.revision, source_freshness: 'not_checked',
      todos: head.todos.filter(t => t.role === 'user').map(t => ({todo_id: t.todo_id, text: t.text, status: t.status, note: t.note ?? null}))};
  }
  if (positionals[0] === 'inspect' || positionals[0] === 'apply') {
    const input = object(await readPrivateJson(text(values.packet, 'packet_path')), 'packet');
    let packet = input;
    if (input.schema_version === 'personal_follow_through_batch_v0') {
      if (!Array.isArray(input.packets)) throw Error('invalid_batch');
      const selected = values.index ?? (input.packets.length === 1 ? '0' : '');
      if (!/^\d+$/.test(selected) || Number(selected) >= input.packets.length) throw Error('select_packet_index');
      packet = object(input.packets[Number(selected)], 'packet');
    }
    if (positionals[0] === 'inspect') return {digest: digest(packet), packet};
    const approval = text(values['approve-digest'], 'approval_digest', 64);
    if (digest(packet) !== approval) throw Error('review_identity_changed');
    const source = object(packet.source, 'source');
    const refreshed = await captureLark(c, text(source.start, 'start'), text(source.end, 'end'));
    // Re-read the whole bounded source window. Any edit/new/deleted input requires review.
    const {capturedAt: _old, ...oldSource} = source;
    const {capturedAt: _fresh, ...newSource} = refreshed;
    if (digest(oldSource) !== digest(newSource)) throw Error('source_changed_review_again');
    return applyReview(configPath, packet, approval);
  }
  if (!values['allow-model']) throw Error('prepare_requires_explicit_allow_model');
  const output = text(values.output, 'output_path');
  const head = await readTodos(c);
  const source = await captureLark(c, text(values.start, 'start'), text(values.end, 'end'));
  if (digest(await loadConfig(configPath)) !== digest(c)) throw Error('profile_changed');
  const candidates = await propose(c, source, head.todos);
  const packets = candidates.map(v => buildReview(c, source, v, head));
  if (new Set(packets.map(p => p.operation_id)).size !== packets.length) throw Error('ambiguous_multiple_commitments');
  if (digest(await loadConfig(configPath)) !== digest(c)) throw Error('profile_changed');
  // One packet per review; mutating canonical state invalidates later stale packets.
  // Re-prepare remaining items after each apply so every review names its state basis.
  await savePrivate(output, {schema_version: 'personal_follow_through_batch_v0', packets});
  return {status: 'prepared', count: packets.length, digests: packets.map(digest),
    next: 'Use inspect --packet FILE --index N, then apply --packet FILE --index N --approve-digest DIGEST. Re-prepare after each mutation.'};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)))}\n`);}
  catch (error) {process.stdout.write(`${JSON.stringify({status: 'failed', error: error instanceof Error ? error.message : 'unexpected_failure'})}\n`); process.exitCode = 1;}
}
