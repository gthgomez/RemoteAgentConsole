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

### Task 1: Repository foundation

**Files:**
- Create: root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, Biome config, GitHub Actions workflow, and `.gitignore` updates.
- Create: root README and empty package/app manifests needed for a strict TypeScript workspace.

**Interfaces:**
- Produces root commands `pnpm verify`, `pnpm dev`, and `pnpm build`; packages use ESM and strict TypeScript.

- [ ] Add configuration validation/documentation checks for the workspace scripts and supported Node range.
- [ ] Run the checks to confirm the fresh workspace is incomplete.
- [ ] Implement the pnpm workspace, shared tooling config, and Windows/Ubuntu CI.
- [ ] Run `pnpm install`, `pnpm verify`, and `pnpm build`.

### Task 2: Shared contracts and domain model

**Files:**
- Create: `packages/contracts` shared Zod request, response, and event schemas.
- Create: `packages/domain` runtime-neutral session, turn, permission, and event types/state transitions.
- Test: request/event validation, legal session transitions, one active turn, and exact permission option validation.

**Interfaces:**
- Produces workspace packages `@remote-agent-console/contracts` and `@remote-agent-console/domain`.
- Event envelope fields are `eventId`, per-session monotonic `sequence`, `machineId`, `sessionId`, ISO timestamp, `eventType`, and typed payload.
- Session status values are `creating`, `idle`, `running`, `waiting_permission`, `waiting_input`, `stopping`, `disconnected`, `failed`, `completed`, and `closed`.

- [ ] Write failing tests for event/request schemas, state transitions, one-active-turn conflict, and unknown permission-option rejection.
- [ ] Run those tests and confirm the intended failures.
- [ ] Implement schemas and domain transitions.
- [ ] Run package tests and `pnpm verify`.

### Task 3: Deterministic fake ACP child

**Files:**
- Create: `packages/testkit` ACP agent process using `@agentclientprotocol/sdk` and a deterministic fake scenario.
- Test: initialize, new session, prompt text stream, tool activity, permission request/response, cancel, completion, malformed frame, and child exit.

**Interfaces:**
- Produces an executable child entry point suitable for host ACP stdio integration tests.
- The fake agent uses ACP session/update/permission methods and has no shell or filesystem tool.

- [ ] Write subprocess contract tests for the fake agent's ACP behavior.
- [ ] Run them and confirm failure before implementation.
- [ ] Implement the fake ACP child and deterministic scenario.
- [ ] Run contract tests and `pnpm verify`.

### Task 4: ACP client and runtime-neutral adapter

**Files:**
- Create: `packages/acp-client` ACP v1 process transport and ACP-to-domain event mapping.
- Create: `packages/runtime-core` adapter/connection/session interfaces and capability model.
- Test: stdio framing, event normalization, permission response, cancellation, and process failure.

**Interfaces:**
- Consumes: domain/contracts from Task 2 and fake process from Task 3.
- Produces: runtime-neutral `RuntimeAdapter`, `RuntimeConnection`, and `RuntimeSession`; raw ACP values remain inside this package.

- [ ] Write adapter contract tests against the fake ACP child.
- [ ] Run the tests and confirm failure before implementation.
- [ ] Implement ACP transport and normalized event mapping.
- [ ] Run package tests and `pnpm verify`.

### Task 5: Host session API and event stream

**Files:**
- Create: `apps/host` Fastify app, in-memory session/event store, session manager, and API routes.
- Test: REST session creation, prompt idempotency/conflicts, permission response, cancellation, SSE replay, and error mapping.

**Interfaces:**
- Consumes: contracts/domain from Task 2 and runtime interfaces from Task 4.
- Produces: `/api/v1/health`, `/api/v1/sessions`, session detail, prompt/cancel/permission commands, and `/api/v1/sessions/:id/events` SSE.

- [ ] Write API tests for lifecycle, retry behavior, permission handling, and event replay.
- [ ] Run tests and confirm failures.
- [ ] Implement host session orchestration, REST, and SSE.
- [ ] Run host tests and `pnpm verify`.

### Task 6: Mobile-first web vertical slice

**Files:**
- Create: `apps/web` React/Vite PWA shell and typed `packages/client-sdk` host API/SSE client.
- Create: dashboard/session creation, session activity view, tool activity card, permission sheet, prompt composer, and reconnect state.
- Test: Playwright E2E for prompt streaming, tool activity, permission response, completion, refresh, and reconnect.

**Interfaces:**
- Consumes contracts from Task 2 and host API from Task 5.
- UI only calls the host API and renders capability/event data without runtime-specific branching.

- [ ] Write browser E2E coverage for the complete fake ACP workflow.
- [ ] Run it against the host and confirm the workflow fails before implementation.
- [ ] Implement the typed client and mobile-first views with ~44 CSS pixel touch targets.
- [ ] Run E2E, `pnpm verify`, and `pnpm build`.

### Task 7: Handoff and integration review

**Files:**
- Create/update: `docs/ROADMAP.md`, `docs/STATUS.md`, `README.md`, and architecture notes.

- [ ] Run the full `pnpm verify`, browser E2E, and production build on the integrated branch.
- [ ] Confirm host binds to loopback and no shell execution route exists.
- [ ] Record what the fake slice proves and what it does not prove.
- [ ] Update status with current milestone and next three tasks.
