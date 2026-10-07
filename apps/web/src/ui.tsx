import type {
  EventEnvelope,
  ProjectSummary,
  RuntimeSummary,
  SessionSummary,
} from "@remote-agent-console/client-sdk";
import { HostClient, makeRequestId } from "@remote-agent-console/client-sdk";
import { useEffect, useMemo, useRef, useState } from "react";

const client = new HostClient({ baseUrl: import.meta.env.VITE_API_BASE_URL ?? "" });
type Activity = { id: string; kind: string; text: string; status?: string };
type Permission = Extract<EventEnvelope, { eventType: "permission.requested" }>["payload"];
const historyKey = "rac-session-history";

function readHistory(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(historyKey) ?? "{}");
  } catch {
    return {};
  }
}

export function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeSummary[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState(() =>
    location.pathname.startsWith("/sessions/")
      ? decodeURIComponent(location.pathname.split("/")[2] ?? "")
      : "",
  );
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [permission, setPermission] = useState<Permission | null>(null);
  const [prompt, setPrompt] = useState("");
  const [sentPrompt, setSentPrompt] = useState(() => readHistory()[sessionId] ?? "");
  const [connected, setConnected] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const applyEventRef = useRef<(event: EventEnvelope) => void>(() => {});
  const permissionDialogRef = useRef<HTMLElement>(null);
  useModalFocus(Boolean(permission), permissionDialogRef);

  useEffect(() => {
    Promise.all([client.getProjects(), client.getRuntimes(), client.getSessions()])
      .then(([p, r, s]) => {
        setProjects(p);
        setRuntimes(r);
        setSessions(s);
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "Could not reach the host"),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!sessionId) {
      setSession(null);
      return;
    }
    let active = true;
    setConnected(false);
    setActivity([]);
    client
      .getSession(sessionId)
      .then((value) => {
        if (active)
          setSession({
            ...value,
            projectDisplayName:
              projects.find((project) => project.id === value.projectId)?.displayName ?? "Project",
          });
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Could not load session");
      });
    const unsubscribe = client.subscribe(sessionId, {
      onEvent: (event) => {
        if (active) applyEventRef.current(event);
      },
      onOpen: () => active && setConnected(true),
      onReconnect: () => active && setConnected(false),
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [sessionId, projects, loading]);

  function applyEvent(event: EventEnvelope) {
    switch (event.eventType) {
      case "message.delta":
        setActivity((items) => {
          const previous = items.find((item) => item.id === `message-${event.payload.turnId}`);
          return previous
            ? items.map((item) =>
                item.id === previous.id ? { ...item, text: item.text + event.payload.text } : item,
              )
            : [
                ...items,
                {
                  id: `message-${event.payload.turnId}`,
                  kind: "message",
                  text: event.payload.text,
                },
              ];
        });
        break;
      case "tool.updated":
        setActivity((items) => {
          const updated = {
            id: `tool-${event.payload.toolCallId}`,
            kind: "tool",
            text: event.payload.title,
            status: event.payload.status,
          };
          return items.some((item) => item.id === updated.id)
            ? items.map((item) => (item.id === updated.id ? updated : item))
            : [...items, updated];
        });
        break;
      case "permission.requested":
        setPermission(event.payload);
        break;
      case "permission.resolved":
        setPermission(null);
        break;
      case "turn.started":
        setSession((current) =>
          current ? { ...current, activeTurnId: event.payload.turnId, status: "running" } : current,
        );
        break;
      case "turn.completed":
        setPermission(null);
        setSession((current) =>
          current ? { ...current, activeTurnId: null, status: "idle" } : current,
        );
        setActivity((items) => [
          ...items,
          { id: `complete-${event.payload.turnId}`, kind: "complete", text: "Turn completed" },
        ]);
        break;
      case "turn.failed":
        setSession((current) =>
          current ? { ...current, activeTurnId: null, status: "failed" } : current,
        );
        setActivity((items) => [
          ...items,
          { id: `failed-${event.payload.turnId}`, kind: "error", text: event.payload.message },
        ]);
        break;
      case "session.status_changed":
        setSession((current) => (current ? { ...current, status: event.payload.status } : current));
        break;
      default:
        break;
    }
  }
  applyEventRef.current = applyEvent;

  const activeRuntime = useMemo(
    () => runtimes.find((runtime) => runtime.id === session?.runtimeId),
    [runtimes, session],
  );

  async function createSession(projectId: string, runtimeId: string) {
    setError("");
    try {
      const result = await client.createSession({
        requestId: makeRequestId(),
        projectId,
        runtimeId,
      });
      const next = {
        ...result,
        projectDisplayName:
          projects.find((project) => project.id === projectId)?.displayName ?? "Project",
      };
      setSessions((items) => [next, ...items]);
      openSession(next.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create session");
    }
  }

  function openSession(id: string) {
    history.pushState({}, "", `/sessions/${encodeURIComponent(id)}`);
    setSessionId(id);
    setSentPrompt(readHistory()[id] ?? "");
    setActivity([]);
  }

  async function sendPrompt() {
    const text = prompt.trim();
    if (!text || !sessionId) return;
    setPrompt("");
    setSentPrompt(text);
    localStorage.setItem(historyKey, JSON.stringify({ ...readHistory(), [sessionId]: text }));
    try {
      await client.sendPrompt(sessionId, { requestId: makeRequestId(), text });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Prompt was not accepted");
    }
  }

  async function respond(optionId: string) {
    if (!permission) return;
    try {
      await client.respondToPermission(permission.permissionId, makeRequestId(), optionId);
      setPermission(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Permission response failed");
    }
  }

  if (loading)
    return (
      <main className="loading" aria-live="polite">
        Connecting to your host…
      </main>
    );
  if (sessionId) return SessionView();
  return (
    <main className="shell dashboard">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">
          F
        </div>
        <div>
          <p className="eyebrow">LOCAL WORKSPACE</p>
          <h1>Fieldwork</h1>
        </div>
        <span className="host-indicator">
          <i /> Host online
        </span>
      </header>
      <section className="welcome">
        <p className="eyebrow">YOUR WORK, IN MOTION</p>
        <h2>Your sessions</h2>
        <p>Pick up a task or start a fresh agent session.</p>
      </section>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <section className="session-list" aria-label="Sessions">
        {sessions.map((item) => (
          <button
            type="button"
            className="session-row"
            key={item.id}
            onClick={() => openSession(item.id)}
          >
            <span className="session-icon">↗</span>
            <span className="session-copy">
              <strong>
                {item.projectDisplayName ??
                  projects.find((project) => project.id === item.projectId)?.displayName ??
                  "Project"}
              </strong>
              <small>
                {item.status.replaceAll("_", " ")} · {new Date(item.updatedAt).toLocaleString()}
              </small>
            </span>
            <span className="arrow">›</span>
          </button>
        ))}
        {!sessions.length && (
          <div className="empty-state">
            <span className="empty-orbit">✳</span>
            <strong>A clear runway</strong>
            <p>Your active sessions will land here.</p>
          </div>
        )}
      </section>
      <button type="button" className="primary new-session" onClick={() => setCreating(true)}>
        ＋ <span>New session</span>
      </button>
      {creating && (
        <CreateSessionDialog
          projects={projects}
          runtimes={runtimes}
          onClose={() => setCreating(false)}
          onCreate={(projectId, runtimeId) => {
            setCreating(false);
            void createSession(projectId, runtimeId);
          }}
        />
      )}
    </main>
  );

  function SessionView() {
    return (
      <main className="shell session-page">
        <header className="topbar session-topbar">
          <button
            type="button"
            className="icon-button"
            aria-label="Back to sessions"
            onClick={() => {
              history.pushState({}, "", "/");
              setSessionId("");
            }}
          >
            ←
          </button>
          <div>
            <p className="eyebrow">SESSION</p>
            <h1>{session?.projectDisplayName ?? "Loading session"}</h1>
          </div>
          <span className={`connection ${connected ? "online" : "offline"}`}>
            <i />
            {connected ? "Live" : "Reconnecting"}
          </span>
        </header>
        <div className="session-meta">
          <span className="status-dot" />
          {session?.status.replaceAll("_", " ") ?? "connecting"}
          <span className="meta-separator">·</span>
          {activeRuntime?.displayName ?? session?.runtimeId}
        </div>
        {activeRuntime && <CapabilityStrip runtime={activeRuntime} />}
        {!connected && (
          <div className="reconnect-banner" role="status">
            <span className="spinner" /> Reconnecting to session…
          </div>
        )}
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        <section className="activity" aria-label="Session activity" aria-live="polite">
          {sentPrompt && (
            <article className="prompt-bubble">
              <span className="activity-label">YOU</span>
              <p>{sentPrompt}</p>
            </article>
          )}
          {!activity.length && !sentPrompt && (
            <div className="activity-empty">
              <span>✳</span>
              <p>Send a prompt to get things moving.</p>
            </div>
          )}
          {activity.map((item) =>
            item.kind === "tool" ? (
              <article className={`tool-card tool-${item.status}`} key={item.id}>
                <div className="tool-icon">⌘</div>
                <div>
                  <span className="activity-label">TOOL ACTIVITY</span>
                  <strong>{item.text}</strong>
                  <small>{item.status}</small>
                </div>
                <span className="tool-check">{item.status === "completed" ? "✓" : "◌"}</span>
              </article>
            ) : (
              <article
                className={
                  item.kind === "complete"
                    ? "completion"
                    : item.kind === "error"
                      ? "event-error"
                      : "agent-message"
                }
                key={item.id}
              >
                <span className="activity-label">
                  {item.kind === "complete"
                    ? "COMPLETE"
                    : item.kind === "error"
                      ? "ISSUE"
                      : "AGENT"}
                </span>
                <p>{item.text}</p>
              </article>
            ),
          )}
        </section>
        {permission && (
          <div className="permission-backdrop">
            <section
              ref={permissionDialogRef}
              className="permission-sheet"
              role="dialog"
              aria-modal="true"
              aria-labelledby="permission-title"
              tabIndex={-1}
            >
              <div className="sheet-handle" />
              <p className="eyebrow">ACTION NEEDED</p>
              <h2 id="permission-title">{permission.title}</h2>
              <p className="permission-explainer">
                Choose an option provided by the runtime to continue.
              </p>
              <div className="permission-options">
                {permission.options.map((option) => (
                  <button
                    type="button"
                    className="secondary"
                    key={option.optionId}
                    onClick={() => void respond(option.optionId)}
                  >
                    {option.name}
                    <span>›</span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        )}
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void sendPrompt();
          }}
        >
          <label className="sr-only" htmlFor="prompt">
            Message the agent
          </label>
          <textarea
            id="prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={session?.activeTurnId ? "Agent is working…" : "Message the agent…"}
            rows={1}
            disabled={Boolean(session?.activeTurnId)}
          />
          <button
            className="send-button"
            type="submit"
            aria-label="Send prompt"
            disabled={!prompt.trim() || Boolean(session?.activeTurnId)}
          >
            ↑
          </button>
        </form>
        <nav className="bottom-nav" aria-label="Session controls">
          <button
            type="button"
            onClick={() => {
              history.pushState({}, "", "/");
              setSessionId("");
            }}
          >
            ⌂<span>Sessions</span>
          </button>
          <span className="nav-session">
            {session?.status.replaceAll("_", " ") ?? "Connecting"}
          </span>
          <button
            type="button"
            disabled={!session?.activeTurnId}
            onClick={() =>
              session?.activeTurnId &&
              void client.cancelTurn(sessionId, makeRequestId(), session.activeTurnId)
            }
          >
            ■<span>Stop</span>
          </button>
        </nav>
      </main>
    );
  }
}

function CreateSessionDialog({
  projects,
  runtimes,
  onClose,
  onCreate,
}: {
  projects: ProjectSummary[];
  runtimes: RuntimeSummary[];
  onClose(): void;
  onCreate(projectId: string, runtimeId: string): void;
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const dialogRef = useRef<HTMLFormElement>(null);
  useModalFocus(true, dialogRef);
  const availableRuntimes = runtimes.filter(
    (runtime) => runtime.installed && runtime.capabilities.sessions.create,
  );
  const [runtimeId, setRuntimeId] = useState(availableRuntimes[0]?.id ?? "");
  return (
    <div className="dialog-backdrop">
      <form
        ref={dialogRef}
        className="create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          onCreate(projectId, runtimeId);
        }}
      >
        <button type="button" className="dialog-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <p className="eyebrow">START SOMETHING</p>
        <h2 id="create-title">New session</h2>
        <p className="dialog-intro">Choose a project and an available runtime.</p>
        <label>
          Project
          <select required value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {projects.map((project) => (
              <option value={project.id} key={project.id}>
                {project.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Runtime
          <select required value={runtimeId} onChange={(event) => setRuntimeId(event.target.value)}>
            {availableRuntimes.map((runtime) => (
              <option value={runtime.id} key={runtime.id}>
                {runtime.displayName}
              </option>
            ))}
          </select>
        </label>
        {!projects.length && <p className="field-help">No allowlisted projects are available.</p>}
        {!availableRuntimes.length && (
          <p className="field-help">No installed runtimes are available.</p>
        )}
        <button className="primary create-submit" type="submit" disabled={!projectId || !runtimeId}>
          Create session <span>→</span>
        </button>
      </form>
    </div>
  );
}

function useModalFocus(active: boolean, dialogRef: { current: HTMLElement | null }) {
  useEffect(() => {
    if (!active) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
    focusable()[0]?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trapFocus);
    return () => {
      document.removeEventListener("keydown", trapFocus);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [active, dialogRef]);
}

function CapabilityStrip({ runtime }: { runtime: RuntimeSummary }) {
  const entries = runtime.capabilities
    ? Object.entries(runtime.capabilities).flatMap(([group, value]) => {
        if (typeof value === "boolean") return value ? [group] : [];
        return Object.entries(value)
          .filter(([, supported]) => supported)
          .map(([capability]) => capability);
      })
    : [];
  if (!entries.length) return null;
  return (
    <section className="capabilities" aria-label="Runtime capabilities">
      {entries.map((name) => (
        <span className="capability" key={name}>
          {name.replaceAll("_", " ")}
        </span>
      ))}
    </section>
  );
}
