# Maintained controller for the four-agent composition

Accepted in the November 24 implementation handoff. The integration is under development.

Use Happier v0.2.21 as the relay, daemon and phone interface. Remote Agent Console owns the pinned build, restricted policy, Babel ACP bridge, Windows distribution and release qualification. Babel owns native execution and its gateway. Keep the current Remote Agent Console host available for legacy history export until migration and rollback are verified.

| Agent | Controller route |
| --- | --- |
| Command Code | Configured ACP runner with a fixed launcher |
| OpenCode | Native OpenCode server V2 |
| Codex | Native Codex app-server |
| Babel | ACP bridge to Babel's scoped native gateway |

The selected deployment serves the local relay and its bundled web UI over private Tailscale Serve HTTPS. Remote access requires revocable application device grants and local admission for approved projects, launch profiles and RPCs. Enable profiles only after their admission and lifecycle checks pass. Windows process ownership and all four Android-over-cellular journeys remain release gates.

## Provenance

[The composition lock](../../distribution/composition-lock.json) records the audited RAC base, the current Babel base and the selected Happier tree, dependency locks, build tooling, MIT notice hash and upstream archive digests. Babel advances three commits beyond the November 22 audit. [Baseline dispositions](../../qualification/baseline-dispositions.json) record the affected-file comparison and outstanding evidence.

The CLI and server archives come from the versioned v0.2.21 component tags. Both tags resolve to `e992e049ffa7a98ab60740ac60f94918f022ff24`. The server archive contains `ui-web/current/index.html`. The standalone web v0.2.21 archive comes from a different commit, `f6f4032ffe21310f83a652c0c7dc07a205e66ee8`, and is recorded as a reference artifact. Build the downstream web UI from the same patched source tree as its server. Preserve Happier's MIT notice in any distributed build.

All three upstream archive hashes were checked against downloaded bytes on Linux. Native Windows execution, downstream patch integration and candidate hashes require separate evidence.
