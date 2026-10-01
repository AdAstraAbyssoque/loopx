import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, writeFile, readFile, rm, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {FileAuthorityStore} from '../../loopx/control_plane/coordination/file_authority_store.ts';
import {projection} from './shadow_file_fixture.ts';
import {buildReview, config, digest, instant, type FollowThroughConfig, type SourceWindow} from '../../loopx/control_plane/work_items/personal_follow_through/contract.ts';
import {applyReview, readTodos} from '../../loopx/control_plane/work_items/personal_follow_through/service.ts';
import {captureLark} from '../../loopx/extensions/lark/personal_follow_through.ts';

const execute = promisify(execFile);
const source: SourceWindow = {binding: 'selected-group', chat: 'oc_test', start: '2026-10-01T00:00:00Z', end: '2026-10-02T00:00:00Z',
  capturedAt: '2026-10-02T00:00:00Z', complete: true,
  messages: [{id: 'om_promise', revision: 'r1', sender: 'ou_owner', text: 'I will prepare the draft by 2026-10-03T10:00:00Z.'}]};
const proposal = {kind: 'create', title: 'Prepare draft', responsible_id: 'ou_owner', source_ids: ['om_promise'],
  target_todo_id: null, due_at: '2026-10-03T10:00:00Z', due_basis: 'by 2026-10-03T10:00:00Z'};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'loopx-personal-'));
  const c: FollowThroughConfig = {schema_version: 'personal_follow_through_config_v0', enabled: true, runtime_root: root,
    goal_id: 'goal-a', owner_id: 'ou_owner', binding: 'selected-group', chat_id: 'oc_test', lark_profile: 'test',
    model: {endpoint: 'http://127.0.0.1:1/chat/completions', name: 'fixture', key_env: 'FOLLOW_THROUGH_TEST_KEY'}};
  const configPath = join(root, 'profile.json');
  await writeFile(configPath, JSON.stringify(c), {mode: 0o600});
  const store = new FileAuthorityStore(join(root, 'authority', 'file-v0'), 'goal-a');
  const seeded = await store.commitAuthority({expected_provider_revision: null, operation_id: 'fixture-seed', events: [], receipts: [], next_projection: projection([], [], 'soft_claim')});
  assert.equal(seeded.status, 'applied');
  return {root, c, configPath};
}

test('reviewed commitment survives retry and a deadline correction in the canonical store', async t => {
  const f = await fixture(); t.after(() => rm(f.root, {recursive: true, force: true}));
  const first = buildReview(f.c, source, proposal, await readTodos(f.c));
  const applied = await applyReview(f.configPath, first, digest(first));
  assert.notEqual(applied.status, 'failed', JSON.stringify(applied));
  assert.notEqual((await applyReview(f.configPath, first, digest(first))).status, 'failed');
  const created = await readTodos(f.c);
  assert.equal(created.todos.length, 1);
  assert.equal(created.todos[0].text, 'Prepare draft');
  assert.equal(created.todos[0].role, 'user');
  const changed = {...source, messages: [...source.messages,
    {id: 'om_update', revision: 'r1', sender: 'ou_owner', text: 'Change that deadline to 2026-10-05T10:00:00Z.'}]};
  const amendment = buildReview(f.c, changed, {...proposal, kind: 'amend', target_todo_id: first.todo_id,
    source_ids: ['om_promise', 'om_update'], due_at: '2026-10-05T10:00:00Z', due_basis: '2026-10-05T10:00:00Z'}, created);
  assert.notEqual((await applyReview(f.configPath, amendment, digest(amendment))).status, 'failed');
  assert.notEqual((await applyReview(f.configPath, amendment, digest(amendment))).status, 'failed');
  const reopened = await readTodos(f.c);
  assert.equal(reopened.todos.length, 1);
  assert.equal(reopened.todos[0].todo_id, first.todo_id);
  assert.equal(reopened.todos[0].status, 'open');
  assert.match(String(reopened.todos[0].note), /2026-10-05T10:00:00Z/);
});

test('unapproved, wrong-owner, incomplete, stale and revoked inputs cannot write', async t => {
  const f = await fixture(); t.after(() => rm(f.root, {recursive: true, force: true}));
  const before = await readTodos(f.c);
  for (const bad of [{...proposal, responsible_id: 'ou_other'}, {...proposal, source_ids: ['invented']},
    {...proposal, kind: 'complete'}, {...proposal, due_at: 'tomorrow'}]) {
    assert.throws(() => buildReview(f.c, source, bad, before));
  }
  assert.throws(() => buildReview(f.c, {...source, complete: false}, proposal, before), /incomplete/);
  const packet = buildReview(f.c, source, proposal, before);
  await assert.rejects(applyReview(f.configPath, packet, 'wrong'), /identity/);
  assert.equal((await readTodos(f.c)).todos.length, 0);
  await applyReview(f.configPath, packet, digest(packet));
  const other = buildReview(f.c, {...source, messages: [{...source.messages[0], id: 'om_second'}]},
    {...proposal, source_ids: ['om_second'], title: 'A separate promise'}, before);
  await assert.rejects(applyReview(f.configPath, other, digest(other)), /stale/);
  await writeFile(f.configPath, JSON.stringify({...f.c, enabled: false}));
  await assert.rejects(applyReview(f.configPath, packet, digest(packet)), /disabled/);
  assert.equal((await readTodos(f.c)).todos.length, 1);
});

test('Lark capture stops on pagination gaps, changed identities and disabled scope', async () => {
  const c = config({schema_version: 'personal_follow_through_config_v0', enabled: true, runtime_root: '/unused',
    goal_id: 'a', owner_id: 'ou_owner', binding: 'b', chat_id: 'oc_test', lark_profile: 'test',
    model: {endpoint: 'https://example.com/chat/completions', name: 'test', key_env: 'TEST_KEY'}});
  let calls = 0;
  const reader = async () => {calls++; return {ok: true, identity: 'bot', data: {messages: [], has_more: true, page_token: 'same'}};};
  await assert.rejects(captureLark({...c, enabled: false}, source.start, source.end, reader), /disabled/);
  assert.equal(calls, 0);
  await assert.rejects(captureLark(c, source.start, source.end, reader), /cursor/);
  assert.equal(calls, 2);
  await assert.rejects(captureLark(c, source.start, source.end, async () => ({ok: true, identity: 'user', data: {messages: [], has_more: false}})), /identity/);
});

test('CLI end-to-end uses Node processes, HTTP model transport and real durable authority', async t => {
  const f = await fixture(); t.after(() => rm(f.root, {recursive: true, force: true}));
  let modelCalls = 0;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); assert.equal(request.model, 'fixture');
    assert.equal(req.headers.authorization, 'Bearer synthetic-test-key');
    assert.equal(request.tools, undefined);
    modelCalls++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({choices: [{finish_reason: 'stop', message: {content: JSON.stringify({candidates: [proposal]})}}]}));
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  t.after(() => {server.closeAllConnections(); server.close();});
  const address = server.address(); assert.ok(address && typeof address === 'object');
  f.c.model.endpoint = `http://127.0.0.1:${address.port}/chat/completions`;
  await writeFile(f.configPath, JSON.stringify(f.c));
  const larkData = join(f.root, 'lark.json');
  await writeFile(larkData, JSON.stringify({ok: true, identity: 'bot', data: {has_more: false, messages: [
    {message_id: 'om_promise', chat_id: 'oc_test', msg_type: 'text', sender: {id: 'ou_owner'}, content: source.messages[0].text, create_time: '100'}]}}));
  const binary = join(f.root, 'lark-cli');
  await writeFile(binary, `#!${process.execPath}\nconst fs = require('node:fs'); const a=process.argv.slice(2); if(a.includes('--execute') || !a.includes('+chat-messages-list') || !a.includes('oc_test')) process.exit(9); process.stdout.write(fs.readFileSync(process.env.TEST_LARK_DATA,'utf8'));\n`, {mode: 0o700});
  const cli = resolve('loopx/control_plane/work_items/personal_follow_through/cli.ts');
  const run = async (...args: string[]) => {
    try {
      const {stdout} = await execute(process.execPath, ['--no-warnings', '--experimental-sqlite', '--experimental-strip-types', cli, ...args, '--config', f.configPath],
        {env: {PATH: f.root, FOLLOW_THROUGH_TEST_KEY: 'synthetic-test-key', TEST_LARK_DATA: larkData}, timeout: 30_000});
      return JSON.parse(stdout);
    } catch (e) {
      const stdout = (e as {stdout?: string}).stdout;
      if (stdout) return JSON.parse(stdout);
      throw e;
    }
  };
  const batch = join(f.root, 'review.json');
  const prepared = await run('prepare', '--start', source.start, '--end', source.end, '--output', batch, '--allow-model');
  assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
  assert.equal(prepared.count, 1);
  assert.equal(modelCalls, 1);
  const inspected = await run('inspect', '--packet', batch);
  assert.equal(inspected.packet.candidate.title, 'Prepare draft');
  assert.equal((await run('brief')).todos.length, 0);
  const apply = await run('apply', '--packet', batch, '--approve-digest', inspected.digest);
  assert.notEqual(apply.status, 'failed', JSON.stringify(apply));
  const replay = await run('apply', '--packet', batch, '--approve-digest', inspected.digest);
  assert.notEqual(replay.status, 'failed', JSON.stringify(replay));
  assert.equal((await run('brief')).todos.length, 1);
  // A changed provider source cannot use an old reviewed packet.
  const external = JSON.parse(await readFile(larkData, 'utf8'));
  external.data.messages[0].content = 'This promise was withdrawn.';
  await writeFile(larkData, JSON.stringify(external));
  assert.equal((await run('apply', '--packet', batch, '--approve-digest', inspected.digest)).error, 'source_changed_review_again');
  await writeFile(f.configPath, JSON.stringify({...f.c, enabled: false}));
  assert.equal((await run('prepare', '--allow-model')).status, 'disabled');
  assert.equal(modelCalls, 1);
});
