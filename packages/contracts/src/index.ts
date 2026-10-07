import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const exactNonEmpty = z.string().refine((value) => value.trim().length > 0, 'Must not be empty or whitespace-only');
export const sessionStatusSchema = z.enum([
  'creating', 'idle', 'running', 'waiting_permission', 'waiting_input', 'stopping',
  'disconnected', 'failed', 'completed', 'closed',
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const createSessionRequestSchema = z.object({
  projectId: nonEmpty,
  runtimeId: nonEmpty,
}).strict();
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const promptRequestSchema = z.object({ requestId: nonEmpty, text: nonEmpty }).strict();
export type PromptRequest = z.infer<typeof promptRequestSchema>;
export const cancelTurnRequestSchema = z.object({ requestId: nonEmpty, turnId: nonEmpty }).strict();
export type CancelTurnRequest = z.infer<typeof cancelTurnRequestSchema>;
export const permissionResponseRequestSchema = z.object({ requestId: nonEmpty, permissionId: nonEmpty, optionId: exactNonEmpty }).strict();
export type PermissionResponseRequest = z.infer<typeof permissionResponseRequestSchema>;

export const sessionSchema = z.object({
  id: nonEmpty, machineId: nonEmpty, projectId: nonEmpty, runtimeId: nonEmpty,
  status: sessionStatusSchema, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  activeTurnId: nonEmpty.nullable(),
}).strict();
export type Session = z.infer<typeof sessionSchema>;

export const sessionCreatedPayloadSchema = z.object({ projectId: nonEmpty, runtimeId: nonEmpty }).strict();
export const sessionStatusPayloadSchema = z.object({ status: sessionStatusSchema }).strict();
export const turnStartedPayloadSchema = z.object({ turnId: nonEmpty }).strict();
export const messageDeltaPayloadSchema = z.object({ turnId: nonEmpty, text: z.string() }).strict();
export const toolUpdatedPayloadSchema = z.object({ turnId: nonEmpty, toolCallId: nonEmpty, title: nonEmpty, status: z.enum(['pending', 'running', 'completed', 'failed']) }).strict();
export const permissionRequestedPayloadSchema = z.object({
  turnId: nonEmpty, permissionId: nonEmpty, title: nonEmpty,
  options: z.array(z.object({ optionId: exactNonEmpty, name: exactNonEmpty, kind: z.string().optional() }).passthrough()).min(1),
}).strict();
export const permissionResolvedPayloadSchema = z.object({ permissionId: nonEmpty, optionId: exactNonEmpty }).strict();
export const turnCompletedPayloadSchema = z.object({ turnId: nonEmpty }).strict();
export const turnFailedPayloadSchema = z.object({ turnId: nonEmpty, message: nonEmpty }).strict();
export const sessionErrorPayloadSchema = z.object({ message: nonEmpty }).strict();

export const eventTypeSchema = z.enum([
  'session.created', 'session.status_changed', 'turn.started', 'message.delta', 'tool.updated',
  'permission.requested', 'permission.resolved', 'turn.completed', 'turn.failed', 'session.error',
]);
export type EventType = z.infer<typeof eventTypeSchema>;
const eventPayloadSchemas = {
  'session.created': sessionCreatedPayloadSchema,
  'session.status_changed': sessionStatusPayloadSchema,
  'turn.started': turnStartedPayloadSchema,
  'message.delta': messageDeltaPayloadSchema,
  'tool.updated': toolUpdatedPayloadSchema,
  'permission.requested': permissionRequestedPayloadSchema,
  'permission.resolved': permissionResolvedPayloadSchema,
  'turn.completed': turnCompletedPayloadSchema,
  'turn.failed': turnFailedPayloadSchema,
  'session.error': sessionErrorPayloadSchema,
} as const;
const commonEventFields = {
  eventId: nonEmpty,
  sequence: z.number().int().positive(),
  machineId: nonEmpty,
  sessionId: nonEmpty,
  timestamp: z.iso.datetime(),
};
export const eventEnvelopeSchema = z.discriminatedUnion('eventType', [
  z.object({ ...commonEventFields, eventType: z.literal('session.created'), payload: sessionCreatedPayloadSchema }).strict(),
  z.object({ ...commonEventFields, eventType: z.literal('session.status_changed'), payload: sessionStatusPayloadSchema }).strict(),
  z.object({ ...commonEventFields, eventType: z.literal('turn.started'), payload: turnStartedPayloadSchema }).strict(),
  z.object({ ...commonEventFields, eventType: z.literal('message.delta'), payload: messageDeltaPayloadSchema }).strict(),
  z.object({ ...commonEventFields, eventType: z.literal('tool.updated'), payload: toolUpdatedPayloadSchema }).strict(),
  z.object({ ...commonEventFields, eventType: z.literal('permission.requested'), payload: permissionRequestedPayloadSchema }).strict(),
  z.object({ ...commonEventFields, eventType: z.literal('permission.resolved'), payload: permissionResolvedPayloadSchema }).strict(),
  z.object({ ...commonEventFields, eventType: z.literal('turn.completed'), payload: turnCompletedPayloadSchema }).strict(),
  z.object({ ...commonEventFields, eventType: z.literal('turn.failed'), payload: turnFailedPayloadSchema }).strict(),
  z.object({ ...commonEventFields, eventType: z.literal('session.error'), payload: sessionErrorPayloadSchema }).strict(),
]);
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export const acceptedResponseSchema = z.object({ accepted: z.literal(true), requestId: nonEmpty }).strict();
export type AcceptedResponse = z.infer<typeof acceptedResponseSchema>;
export const apiErrorSchema = z.object({ error: z.object({ code: nonEmpty, message: nonEmpty }).strict() }).strict();
export type ApiError = z.infer<typeof apiErrorSchema>;

export { eventPayloadSchemas };
