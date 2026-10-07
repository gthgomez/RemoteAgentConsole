# ADR-0008: Use Tailscale Serve for private MVP access

Status: Accepted

Tailscale Serve exposes the loopback host over the user's tailnet. The application adds device authentication as defense in depth. Funnel and other public exposure are excluded from the MVP.
