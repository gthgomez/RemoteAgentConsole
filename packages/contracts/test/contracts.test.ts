import { describe, expect, it } from 'vitest';
import { createSessionRequestSchema, eventEnvelopeSchema, promptRequestSchema } from '../src/index.js';

describe('contracts', () => {
  it('validates session and prompt requests', () => {
    expect(createSessionRequestSchema.safeParse({ projectId: 'project-1', runtimeId: 'fake' }).success).toBe(true);
    expect(promptRequestSchema.safeParse({ requestId: 'req-1', text: 'hello' }).success).toBe(true);
    expect(promptRequestSchema.safeParse({ requestId: '', text: '' }).success).toBe(false);
  });
  it('validates typed event envelopes and ISO timestamps', () => {
    const event = { eventId: 'e1', sequence: 1, machineId: 'm1', sessionId: 's1', timestamp: '2026-10-07T00:00:00.000Z', eventType: 'turn.completed', payload: { turnId: 't1' } };
    expect(eventEnvelopeSchema.safeParse(event).success).toBe(true);
    expect(eventEnvelopeSchema.safeParse({ ...event, sequence: 0 }).success).toBe(false);
    expect(eventEnvelopeSchema.safeParse({ ...event, timestamp: 'yesterday' }).success).toBe(false);
  });
});
