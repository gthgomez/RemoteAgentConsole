# Fake ACP Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the Remote Agent Console monorepo and demonstrate a fake ACP agent controlled through host REST/SSE from a mobile-first browser UI.

**Architecture:** The PWA uses shared runtime-neutral contracts and calls only the host API. The host owns session state, sequencing, REST commands, and replayable SSE. A host ACP client talks over stdio to a deterministic fake ACP child, and normalizes protocol updates into domain events.

**Tech Stack:** Node.js 22+, TypeScript strict, pnpm workspaces, Fastify, Zod, Pino, `@agentclientprotocol/sdk` stable v1, React, Vite, Tailwind CSS v4, Vitest, Playwright, Biome.

**Spec:** `docs/CAMPAIGN.md` and the supplied Remote Agent Console architecture brief (initial scope: Milestones 0–1).

## Global Constraints

- Use stable ACP v1; ACP v2 is experimental/draft.
- Runtime processes use `shell: false` and the project directory as cwd.
- The client speaks to our host API, never directly to ACP or a runtime.
- The host enforces one foreground turn per session.
- Persist events before broadcasting them; SSE IDs are monotonic per session and replayable.
- No arbitrary remote filesystem paths, raw remote shell, or public network binding.
- Runtime-supplied permission options are passed through exactly.

## Review Focus

- Concurrent prompt requests for one session: serialize and return a conflict without starting a second turn.
- Repeated mutation request IDs: return the original accepted result without repeating the operation.
- Event reconnect from a sequence cursor: replay only later events and then continue live.
- ACP child death or malformed protocol output: mark the turn interrupted/failed and keep the host responsive.
- Permission response with an unknown option: reject it and leave the pending permission unresolved.

---

### Task 1: Repository foundation and shared contracts

**Files:**
- Create: root pnpm workspace/package configuration, TypeScript/Biome configuration, CI workflow, and package manifests.
- Create: `packages/contracts` shared Zod request/response/event schemas.
- Create: `packages/domain` runtime-neutral session, turn, permission, and event types/state transitions.
- Create: `docs/ROADMAP.md`, architecture README, and root development documentation.
- Test: contract validation and session state transition unit tests.

**Interfaces:**
- Produces: packages `@remote-agent-console/contracts` and `@remote-agent-console/domain`; root scripts `pnpm verify`, `pnpm dev`, and `pnpm build`.

- [ ] Write failing tests for request validation, event envelope validation, legal session transitions, one active turn, and unknown permission-option rejection.
- [ ] Run those tests and confirm the intended failures.
- [ ] Implement workspace/configuration, shared schemas, and domain transitions.
- [ ] Run `pnpm verify` and `pnpm build`.

### Task 2: ACP client and deterministic fake ACP child

**Files:**
- Create: `packages/acp-client` process transport and ACP-to-domain event mapping.
- Create: `packages/runtime-core` adapter/connection interfaces and capability model.
- Create: `packages/testkit` deterministic fake ACP child executable and scenario configuration.
- Test: fake ACP initialize, new session, prompt streaming, tool update, permission response, cancellation, completion, malformed frame, and process exit.

**Interfaces:**
- Consumes: shared domain and contracts from Task 1.
- Produces: runtime-neutral `RuntimeAdapter`, `RuntimeConnection`, `RuntimeSession` interfaces; ACP client emits normalized `RuntimeEvent` values and keeps raw ACP values internal.

- [ ] Write contract tests against a fake ACP child process.
- [ ] Run the contract tests and confirm they fail before implementation.
- [ ] Implement ACP stdio transport and normalized event mapping.
- [ ] Run ACP contract tests and `pnpm verify`.

### Task 3: Host session API and replayable event stream

**Files:**
- Create: `apps/host` Fastify app, in-memory session/event store for this fake slice, session manager, and API routes.
- Create: host-side fake runtime registration using the ACP client from Task 2.
- Test: REST session creation, prompt idempotency/conflicts, permission response, cancellation, SSE replay, and error mapping.

**Interfaces:**
- Consumes: contracts/domain from Task 1 and runtime interfaces from Task 2.
- Produces: `/api/v1/health`, `/api/v1/sessions`, session detail, prompt/cancel/permission commands, and `/api/v1/sessions/:id/events` SSE.

- [ ] Write host API tests for session lifecycle, retries, permissions, and event replay.
- [ ] Run tests and confirm failures.
- [ ] Implement session manager, adapter orchestration, REST, and SSE.
- [ ] Run host tests and `pnpm verify`.

### Task 4: Mobile-first web vertical slice

**Files:**
- Create: `apps/web` React/Vite PWA shell and typed `packages/client-sdk` API/SSE client.
- Create: dashboard/session creation, session activity view, tool activity card, permission sheet, prompt composer, and reconnect state.
- Test: Playwright fake-runtime E2E for prompt streaming, tool activity, permission response, completion, refresh, and reconnect.

**Interfaces:**
- Consumes: contracts from Task 1 and host API from Task 3.
- Produces: PWA UI that only calls the host API and renders capability/event data without runtime-specific branching.

- [ ] Write browser E2E coverage for the complete fake ACP workflow.
- [ ] Run it against the host and confirm the expected workflow fails before UI implementation.
- [ ] Implement typed client and mobile-first views with ~44 CSS pixel touch targets.
- [ ] Run E2E, `pnpm verify`, and `pnpm build`.

### Task 5: Handoff and integration review

**Files:**
- Update: `docs/STATUS.md`, `docs/ROADMAP.md`, `README.md`, and relevant architecture/compatibility notes.

- [ ] Run the full `pnpm verify` and browser E2E on the integrated branch.
- [ ] Confirm host binds to loopback and no shell execution route exists.
- [ ] Record what the fake slice proves and what it does not prove.
- [ ] Update status with current milestone and next three tasks.
