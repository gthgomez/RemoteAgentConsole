#!/usr/bin/env node
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const SESSION_ID = 'fake-session';
const MODES = [{ id: 'normal', name: 'Normal' }];
const PERMISSION_OPTIONS = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
];
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const app = acp.agent({ name: 'remote-agent-console-fake', version: '0.1.0' });
const canceledSessions = new Set();
let created = false;
let promptSequence = 0;

app.onRequest('initialize', ({ params }) => ({
  protocolVersion: params.protocolVersion,
  agentCapabilities: { loadSession: false, promptCapabilities: {} },
  agentInfo: { name: 'remote-agent-console-fake', version: '0.1.0' },
}));

app.onRequest('session/new', () => {
  created = true;
  promptSequence = 0;
  return {
    sessionId: SESSION_ID,
    modes: { currentModeId: 'normal', availableModes: MODES },
  };
});

app.onNotification('session/cancel', ({ params }) => {
  canceledSessions.add(params.sessionId);
});

app.onRequest('session/prompt', async ({ params, client, signal }) => {
  if (!created || params.sessionId !== SESSION_ID) throw new Error('Unknown fake session');
  const promptText = params.prompt.filter(part => part.type === 'text').map(part => part.text).join(' ');
  const turnNumber = ++promptSequence;
  canceledSessions.delete(SESSION_ID);
  await client.notify(acp.methods.client.session.update, {
    sessionId: SESSION_ID,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Fake response to: ${promptText}` } },
  });

  // Leave a small deterministic cancellation window after the first update.
  await sleep(60);
  if (signal.aborted || canceledSessions.has(SESSION_ID)) return { stopReason: 'cancelled' };

  const toolCall = {
    toolCallId: `fake-status-tool-${turnNumber}`,
    title: 'Read project status',
    name: 'fake_status',
    kind: 'read',
    status: 'in_progress',
  };
  await client.notify(acp.methods.client.session.update, { sessionId: SESSION_ID, update: { sessionUpdate: 'tool_call', ...toolCall } });
  const permission = await client.request(acp.methods.client.session.requestPermission, {
    sessionId: SESSION_ID,
    toolCall,
    options: PERMISSION_OPTIONS,
  });
  if (signal.aborted || canceledSessions.has(SESSION_ID) || permission.outcome.outcome !== 'selected' || permission.outcome.optionId !== 'allow-once') {
    await client.notify(acp.methods.client.session.update, {
      sessionId: SESSION_ID,
      update: { sessionUpdate: 'tool_call_update', toolCallId: toolCall.toolCallId, status: 'failed' },
    });
    return { stopReason: 'cancelled' };
  }

  await client.notify(acp.methods.client.session.update, {
    sessionId: SESSION_ID,
    update: { sessionUpdate: 'tool_call_update', toolCallId: toolCall.toolCallId, status: 'completed' },
  });
  await client.notify(acp.methods.client.session.update, {
    sessionId: SESSION_ID,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' Permission approved; the fake task is complete.' } },
  });
  return { stopReason: 'end_turn' };
});

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
app.connect(stream);
