# ADR-0005: REST commands and replayable SSE events

Status: Accepted

Mutations use ordinary HTTP requests with idempotency keys. The host streams normalized events through SSE with per-session sequence IDs and replay after reconnect. This suits mobile browser suspension and network changes.
