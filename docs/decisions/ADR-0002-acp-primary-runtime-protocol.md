# ADR-0002: ACP is the primary runtime protocol

Status: Accepted

Use Agent Client Protocol for runtimes that support it. Add a dedicated adapter only when ACP cannot provide a required feature. This avoids duplicating session, permission, and streaming logic for each harness.
