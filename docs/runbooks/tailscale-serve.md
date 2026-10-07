# Private phone access with Tailscale Serve

This runbook describes the intended private access path for a phone on the same tailnet as the host. It does not configure Tailscale or claim a real-device test.

## Readiness gate

**Do not expose the current development stack yet.** As of 2026-10-07, the host binds to `127.0.0.1`, but the device-pairing primitives are not wired into API authentication, and the production host does not serve the PWA. See [STATUS](../STATUS.md). Tailscale access controls are a network layer, not a replacement for application authentication. Use this runbook only after host API routes require a paired device credential and the intended web build is available.

For the current development layout, `pnpm dev` starts the Vite PWA on `127.0.0.1:5173` (Vite's default port) and the API on `127.0.0.1:4318`; Vite proxies `/api` to the API. When that layout is used for a gated private smoke test, Serve the **PWA port** so the phone and API share the same origin. Never bind either service to `0.0.0.0`.

## Preconditions

- The host and Android phone are signed in to the intended Tailscale tailnet.
- Tailnet access rules allow the phone's user/device to reach the host.
- The application has device authentication enabled and a phone has been paired. Do not rely on Tailscale identity headers unless the host explicitly validates them.
- The host is running, the Vite output confirms `127.0.0.1:5173`, and the API health endpoint responds locally at `http://127.0.0.1:4318/api/v1/health`.
- HTTPS certificates are enabled for the tailnet. Serve will prompt for any unmet setup requirement.

## Start and verify

In a terminal on the host, start the application. In the current development layout:

```sh
pnpm dev
```

In another terminal, start a background Serve proxy to the local Vite port:

```sh
tailscale serve --bg 5173
tailscale serve status
```

Use the HTTPS URL printed by Serve (or shown by `tailscale serve status`). The `5173` target is the local HTTP port; Serve supplies the tailnet HTTPS endpoint. The URL is reachable only according to the tailnet's access controls. Serve forwards to a loopback service and does not require opening an inbound router port. On Windows, run the port-forwarding command in a normal terminal; the Tailscale examples state that an Administrator console is not required for forwarding ports.

On Android:

1. Open the Tailscale app and confirm it is connected to the same tailnet.
2. Open the exact HTTPS URL reported by Serve in the browser.
3. Confirm the app loads, the host reports connected, and the paired-device session is accepted.
4. With Wi-Fi off and cellular data on, repeat the check while Tailscale remains connected. This verifies the phone is reaching the host over the tailnet rather than the local Wi-Fi network.

Do not treat desktop responsive emulation as the real-phone acceptance test. Record real-device results in `docs/releases/MVP_ACCEPTANCE.md`; do not mark acceptance complete until the full release scenario passes.

## Stop sharing

For this runbook's single Serve endpoint, stop the proxy with:

```sh
tailscale serve off
tailscale serve status
```

`tailscale serve off` removes the Serve endpoint configuration from this node. If other Serve endpoints are in use, inspect status first and use the matching `off` form for the endpoint you intend to remove; `tailscale serve reset` clears the Serve configuration and should only be used when clearing all endpoints is intended.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Serve reports HTTPS setup is incomplete | Follow the consent flow and enable HTTPS certificates for the tailnet, then rerun `tailscale serve --bg 5173`. |
| Serve URL does not load | Confirm both devices are online in Tailscale, tailnet rules allow this phone to reach the host, and `tailscale serve status` shows the endpoint. |
| Browser connects but the page or API fails | Confirm Vite is still on `127.0.0.1:5173`, the host is on `127.0.0.1:4318`, and the host's `/api` proxy target has not changed. Vite can choose another port if 5173 is occupied; use the port shown in its startup output. |
| The app rejects the phone | Pair the device through the application's pairing flow. Tailscale connectivity alone does not authenticate the app. |
| Android works on Wi-Fi but not cellular | Confirm Tailscale is connected over cellular, the phone is in the expected tailnet, and its access rules permit reaching the host. |

## Upstream references

- [Tailscale Serve overview](https://tailscale.com/docs/features/tailscale-serve) — tailnet access controls, HTTPS setup, and the loopback proxy model.
- [Tailscale `serve` CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve) — current `serve`, `--bg`, `status`, `off`, and `reset` syntax.
- [Tailscale Serve examples](https://tailscale.com/docs/reference/examples/serve) — forwarding a local development port, background mode, and the `tailscale serve off` stop command.

CLI syntax and guidance were checked against these official pages on 2026-10-07. Recheck them before using this runbook after a Tailscale CLI update.
