import { describe, expect, it } from 'vitest';
import { beginTurn, createSession, respondToPermission, transitionSession } from '../src/index.js';

describe('session domain', () => {
  it('allows legal transitions and rejects illegal ones', () => {
    const session = createSession({ id: 's1', machineId: 'm1', projectId: 'p1', runtimeId: 'fake' });
    expect(transitionSession(session, 'idle').status).toBe('idle');
    expect(() => transitionSession(session, 'running')).toThrow();
  });
  it('enforces one active turn', () => {
    const session = transitionSession(createSession({ id: 's1', machineId: 'm1', projectId: 'p1', runtimeId: 'fake' }), 'idle');
    const active = beginTurn(session, { id: 't1', prompt: 'hello' });
    expect(() => beginTurn(active, { id: 't2', prompt: 'again' })).toThrow(/active turn/i);
  });
  it('rejects permission choices not offered by the runtime', () => {
    const result = respondToPermission({ permissionId: 'perm1', options: [{ optionId: 'allow', name: 'Allow' }] }, 'deny');
    expect(result).toEqual({ success: false });
    expect(respondToPermission({ permissionId: 'perm1', options: [{ optionId: 'allow', name: 'Allow' }] }, 'allow')).toEqual({ success: true, optionId: 'allow' });
  });
});
