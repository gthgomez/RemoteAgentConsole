export type SessionStatus = 'creating' | 'idle' | 'running' | 'waiting_permission' | 'waiting_input' | 'stopping' | 'disconnected' | 'failed' | 'completed' | 'closed';

export interface Turn { id: string; prompt: string; status: 'running' | 'waiting_permission' | 'waiting_input' | 'completed' | 'failed' | 'cancelled'; }
export interface DomainSession {
  id: string; machineId: string; projectId: string; runtimeId: string;
  status: SessionStatus; createdAt: string; updatedAt: string;
  activeTurn: Turn | null;
}
export interface PermissionOption { optionId: string; name: string; kind?: string; }
export interface PendingPermission { permissionId: string; options: readonly PermissionOption[]; }

const transitions: Record<SessionStatus, readonly SessionStatus[]> = {
  creating: ['idle', 'failed', 'disconnected'], idle: ['running', 'stopping', 'disconnected', 'failed', 'closed'],
  running: ['waiting_permission', 'waiting_input', 'idle', 'completed', 'failed', 'stopping', 'disconnected'],
  waiting_permission: ['running', 'idle', 'failed', 'stopping', 'disconnected'],
  waiting_input: ['running', 'idle', 'failed', 'stopping', 'disconnected'],
  stopping: ['idle', 'completed', 'failed', 'disconnected', 'closed'], disconnected: ['idle', 'failed', 'closed'],
  failed: ['closed'], completed: ['closed'], closed: [],
};

export function createSession(input: { id: string; machineId: string; projectId: string; runtimeId: string; now?: string }): DomainSession {
  const now = input.now ?? new Date().toISOString();
  return { id: input.id, machineId: input.machineId, projectId: input.projectId, runtimeId: input.runtimeId, status: 'creating', createdAt: now, updatedAt: now, activeTurn: null };
}

export function transitionSession(session: DomainSession, next: SessionStatus, now = new Date().toISOString()): DomainSession {
  if (!transitions[session.status].includes(next)) throw new Error(`Illegal session transition: ${session.status} -> ${next}`);
  return { ...session, status: next, updatedAt: now };
}

export function beginTurn(session: DomainSession, input: { id: string; prompt: string }): DomainSession {
  if (session.activeTurn && ['running', 'waiting_permission', 'waiting_input'].includes(session.activeTurn.status)) {
    throw new Error(`Session ${session.id} already has an active turn`);
  }
  if (session.status !== 'idle' && session.status !== 'completed') throw new Error(`Cannot start turn while session is ${session.status}`);
  return { ...session, status: 'running', updatedAt: new Date().toISOString(), activeTurn: { id: input.id, prompt: input.prompt, status: 'running' } };
}

export function setTurnStatus(session: DomainSession, status: Turn['status'], now = new Date().toISOString()): DomainSession {
  if (!session.activeTurn) throw new Error('Session has no active turn');
  const sessionStatus: SessionStatus = status === 'waiting_permission' || status === 'waiting_input' ? status : status === 'running' ? 'running' : status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'idle';
  return { ...session, status: sessionStatus, updatedAt: now, activeTurn: { ...session.activeTurn, status } };
}

export function respondToPermission(permission: PendingPermission, optionId: string): { success: true; optionId: string } | { success: false } {
  return permission.options.some((option) => option.optionId === optionId) ? { success: true, optionId } : { success: false };
}

export function assertNextSequence(previousSequence: number, sequence: number): void {
  if (!Number.isInteger(previousSequence) || previousSequence < 0 || sequence !== previousSequence + 1) {
    throw new Error(`Expected event sequence ${previousSequence + 1}, received ${sequence}`);
  }
}
