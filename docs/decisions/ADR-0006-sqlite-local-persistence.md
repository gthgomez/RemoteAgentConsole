# ADR-0006: Use local SQLite for durable state

Status: Accepted

The host uses SQLite for remote-control state and event replay. Runtime transcripts remain authoritative in their harness. The initial fake slice may use an in-memory store; durable SQLite arrives in the persistence milestone.
