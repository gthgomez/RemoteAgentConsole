import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const entry = fileURLToPath(new URL('../src/fake-agent.js', import.meta.url));

function startAgent() {
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const messages = [];
  const waiters = [];
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        messages.push(message);
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i].match(message)) waiters.splice(i, 1)[0].resolve(message);
        }
      } catch { /* malformed output is asserted through child failure */ }
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  let nextId = 1;
  const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method, params = {}) => {
    const id = nextId++;
    send({ jsonrpc: '2.0', id, method, params });
    return waitFor(message => message.id === id);
  };
  const waitFor = (match, timeout = 1500) => {
    const found = messages.find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.findIndex(w => w.resolve === resolve);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error(`Timed out waiting for ACP message; messages=${JSON.stringify(messages)}; stderr=${stderr}`));
      }, timeout);
      waiters.push({ match, resolve: value => { clearTimeout(timer); resolve(value); } });
    });
  };
  const close = async () => {
    child.stdin.end();
    if (child.exitCode === null) await once(child, 'exit');
  };
  return { child, send, request, waitFor, close, messages, get stderr() { return stderr; } };
}

test('initializes and creates a session with deterministic capabilities', async t => {
  const agent = startAgent();
  t.after(() => agent.close());
  const initialized = await agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.equal(initialized.result.protocolVersion, 1);
  const session = await agent.request('session/new', { cwd: process.cwd(), mcpServers: [] });
  assert.equal(session.result.sessionId, 'fake-session');
  assert.deepEqual(session.result.modes?.availableModes?.map(mode => mode.id), ['normal']);
});

test('streams assistant text, tool activity, waits for permission, and completes after allow', async t => {
  const agent = startAgent();
  t.after(() => agent.close());
  await agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  await agent.request('session/new', { cwd: process.cwd(), mcpServers: [] });
  const prompt = agent.request('session/prompt', {
    sessionId: 'fake-session', prompt: [{ type: 'text', text: 'run deterministic demo' }],
  });
  const text = await agent.waitFor(message => message.method === 'session/update' && message.params.update.sessionUpdate === 'agent_message_chunk');
  assert.match(text.params.update.content.text, /deterministic demo/);
  const tool = await agent.waitFor(message => message.method === 'session/update' && message.params.update.sessionUpdate === 'tool_call');
  assert.equal(tool.params.update.title, 'Read project status');
  const permission = await agent.waitFor(message => message.method === 'session/request_permission');
  assert.deepEqual(permission.params.options.map(option => option.optionId), ['allow-once', 'reject-once']);
  agent.send({ jsonrpc: '2.0', id: permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } });
  const answer = await prompt;
  assert.equal(answer.result.stopReason, 'end_turn');
  assert.ok(agent.messages.some(message => message.method === 'session/update' && message.params.update.sessionUpdate === 'agent_message_chunk' && message.params.update.content.text.includes('Permission approved')));
  assert.ok(agent.messages.some(message => message.method === 'session/update' && message.params.update.sessionUpdate === 'tool_call_update' && message.params.update.toolCallId === tool.params.update.toolCallId && message.params.update.status === 'completed'));
});

test('uses a distinct deterministic tool call id for each prompt in one session', async t => {
  const agent = startAgent();
  t.after(() => agent.close());
  await agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  await agent.request('session/new', { cwd: process.cwd(), mcpServers: [] });

  const toolIds = [];
  for (const [turn, promptText] of ['first turn', 'second turn'].entries()) {
    const prompt = agent.request('session/prompt', { sessionId: 'fake-session', prompt: [{ type: 'text', text: promptText }] });
    const expectedId = `fake-status-tool-${turn + 1}`;
    const permission = await agent.waitFor(message => message.method === 'session/request_permission' && message.params.toolCall.toolCallId === expectedId);
    toolIds.push(permission.params.toolCall.toolCallId);
    agent.send({ jsonrpc: '2.0', id: permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } });
    assert.equal((await prompt).result.stopReason, 'end_turn');
  }

  assert.deepEqual(toolIds, ['fake-status-tool-1', 'fake-status-tool-2']);
  assert.notEqual(toolIds[0], toolIds[1]);
});

test('keeps tool call ids unique when session/new returns the same session id again', async t => {
  const agent = startAgent();
  t.after(() => agent.close());
  await agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const session1 = await agent.request('session/new', { cwd: process.cwd(), mcpServers: [] });
  const toolIds = [];
  const runApprovedPrompt = async (turn, promptText) => {
    const prompt = agent.request('session/prompt', { sessionId: session1.result.sessionId, prompt: [{ type: 'text', text: promptText }] });
    const expectedId = `fake-status-tool-${turn}`;
    const permission = await agent.waitFor(message => message.method === 'session/request_permission' && message.params.toolCall.toolCallId === expectedId);
    toolIds.push(permission.params.toolCall.toolCallId);
    agent.send({ jsonrpc: '2.0', id: permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } });
    assert.equal((await prompt).result.stopReason, 'end_turn');
  };

  await runApprovedPrompt(1, 'after first new');
  const session2 = await agent.request('session/new', { cwd: process.cwd(), mcpServers: [] });
  assert.equal(session1.result.sessionId, session2.result.sessionId);
  await runApprovedPrompt(2, 'after second new');
  assert.deepEqual(toolIds, ['fake-status-tool-1', 'fake-status-tool-2']);
});

test('cancels an in-flight prompt', async t => {
  const agent = startAgent();
  t.after(() => agent.close());
  await agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  await agent.request('session/new', { cwd: process.cwd(), mcpServers: [] });
  const prompt = agent.request('session/prompt', { sessionId: 'fake-session', prompt: [{ type: 'text', text: 'please cancel' }] });
  await agent.waitFor(message => message.method === 'session/update' && message.params.update.sessionUpdate === 'agent_message_chunk');
  agent.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'fake-session' } });
  assert.equal((await prompt).result.stopReason, 'cancelled');
});

test('ignores a malformed frame, remains usable, and exits cleanly on stdin close', async () => {
  const agent = startAgent();
  agent.child.stdin.write('{bad-json}\n');
  const initialized = await agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.equal(initialized.result.protocolVersion, 1);
  agent.child.stdin.end();
  const [code] = await once(agent.child, 'exit');
  assert.equal(code, 0);
});
