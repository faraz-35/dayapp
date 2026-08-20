// MobileView — the Android client. A read-only mirror of the task list plus
// the capture inbox: it fetches tasks.json from the private GitHub repo and
// appends new captures to captures.json. It never talks to the database — the
// Mac app is the single writer of truth (see AGENTS.md "Mobile sync").
//
// Day rollovers render correctly even on a stale export: daily grey-out and
// done-today retirement are render-time date comparisons (the same trick the
// desktop uses), computed here against the phone's local "today".
//
// The list reuses the desktop row language (.item, .item-check, .priority-bars,
// .tier-divider, .project-label, .reminder-chip) — read-only, no hover actions,
// tap targets instead. The last fetched export is cached in memory, so an
// offline open still shows the list.

import { useEffect, useRef, useState } from "react";
import { formatDuration, formatReminder, localDateStr, projectColor } from "./lib";

interface MobileConfig {
  repo: string;
  branch: string;
  token: string;
}

interface ExportItem {
  id: string;
  text: string;
  section: "today" | "daily" | "backlog";
  status: "active" | "done";
  lastCompletedDate: string | null;
  priority: 1 | 2 | 3 | null;
  /** Carried for mirror completeness; the phone doesn't render it (yet). */
  assignedToAgent: boolean;
  projectId: string | null;
  remindAt: string | null;
  totalSecs: number;
}

interface ExportDoc {
  exportedAt: string;
  today: string;
  projects: { id: string; name: string }[];
  items: ExportItem[];
}

interface Capture {
  id: string;
  text: string;
  section: "today" | "backlog";
  at: string;
}

const TASKS_PATH = "tasks.json";
const CAPTURES_PATH = "captures.json";
const CONFIG_KEY = "dayapp-mobile-config";

// ---- GitHub Contents API (browser fetch; api.github.com is CORS-open) ----

const b64encode = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

const b64decode = (s: string): string => {
  const bin = atob(s.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

async function ghGet(cfg: MobileConfig, path: string): Promise<{ sha: string; text: string } | null> {
  const r = await fetch(
    `https://api.github.com/repos/${cfg.repo}/contents/${path}?ref=${encodeURIComponent(cfg.branch)}`,
    {
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: "application/vnd.github+json",
      },
    },
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const j = await r.json();
  return { sha: j.sha, text: b64decode(j.content ?? "") };
}

async function ghPut(cfg: MobileConfig, path: string, text: string, sha: string | null, message: string) {
  const r = await fetch(`https://api.github.com/repos/${cfg.repo}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
    },
    body: JSON.stringify({
      message,
      content: b64encode(text),
      branch: cfg.branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!r.ok) throw new Error((await r.text()).slice(0, 120));
}

// ---- Component -------------------------------------------------------------

function loadConfig(): MobileConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw) as MobileConfig;
    return cfg.repo && cfg.token ? cfg : null;
  } catch {
    return null;
  }
}

export default function MobileView() {
  const [cfg, setCfg] = useState<MobileConfig | null>(() => loadConfig());
  const [doc, setDoc] = useState<ExportDoc | null>(null);
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [captureText, setCaptureText] = useState("");
  const [capSection, setCapSection] = useState<"today" | "backlog">("today");
  const [sending, setSending] = useState(false);
  // The refresh closure depends on cfg; the effects below need a stable call,
  // so they go through this ref (the same pattern App.tsx uses for ingest).
  const refreshRef = useRef<() => void>(() => {});

  const refresh = async (config: MobileConfig) => {
    setRefreshing(true);
    try {
      const [tasks, caps] = await Promise.all([
        ghGet(config, TASKS_PATH),
        ghGet(config, CAPTURES_PATH),
      ]);
      if (tasks) setDoc(JSON.parse(tasks.text) as ExportDoc);
      setCaptures(caps ? (JSON.parse(caps.text) as Capture[]) : []);
      setSyncedAt(new Date());
      setError(null);
    } catch (e) {
      setError(`sync failed: ${String(e)}`);
    } finally {
      setRefreshing(false);
    }
  };

  refreshRef.current = () => { if (cfg) void refresh(cfg); };

  // Refresh on launch, on foreground (picking the phone back up), and every
  // 5 minutes in the background of a walk.
  useEffect(() => {
    if (!cfg) return;
    refreshRef.current();
    const onVis = () => { if (document.visibilityState === "visible") refreshRef.current(); };
    document.addEventListener("visibilitychange", onVis);
    const iv = setInterval(() => refreshRef.current(), 5 * 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(iv);
    };
  }, [cfg]);

  const sendCapture = async () => {
    if (!cfg) return;
    const text = captureText.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      const file = await ghGet(cfg, CAPTURES_PATH);
      const list: Capture[] = file ? (JSON.parse(file.text) as Capture[]) : [];
      list.push({
        id: crypto.randomUUID(),
        text,
        section: capSection,
        at: new Date().toISOString(),
      });
      await ghPut(cfg, CAPTURES_PATH, JSON.stringify(list, null, 2) + "\n", file?.sha ?? null, "capture from mobile");
      setCaptureText("");
      await refresh(cfg);
    } catch (e) {
      setError(`capture failed: ${String(e)} — text kept`);
    } finally {
      setSending(false);
    }
  };

  if (!cfg) return <Setup onConnect={setCfg} />;

  return (
    <div className="mobile">
      <header className="mobile-header">
        <span className="mobile-brand">Live @ Faraz</span>
        <div className="mobile-header-right">
          {syncedAt && (
            <span className="mobile-synced" title={doc ? `exported ${doc.exportedAt}` : ""}>
              {syncedAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
            </span>
          )}
          <button className={`icon-btn ${refreshing ? "active" : ""}`} onClick={() => refreshRef.current()} title="Refresh">⟳</button>
          <button className="icon-btn" onClick={() => setCfg(null)} title="Settings">⚙</button>
        </div>
      </header>

      <div className="mobile-scroll">
        {error && <div className="mobile-error">{error}</div>}

        {captures.length > 0 && (
          <div className="mobile-queued">
            <div className="section-name">Queued ({captures.length}) · lands when the Mac syncs</div>
            {captures.map((c) => (
              <div className="item queued" key={c.id}>
                <span className="item-check pending" />
                <span className="item-text">{c.text}</span>
                <span className="mobile-queued-sec">{c.section}</span>
              </div>
            ))}
          </div>
        )}

        {!doc && !error && (
          <div className="mobile-hint">
            No task list yet — run "Mobile: Deploy Task List Now" in the Mac app.
          </div>
        )}

        {doc && (["today", "daily", "backlog"] as const).map((sec) => {
          const rows = doc.items
            .filter((i) => i.section === sec)
            .map((i) => ({ i, state: rowState(i) }))
            .filter((r): r is { i: ExportItem; state: "active" | "done" } => r.state !== "gone");
          return (
            <div className="mobile-section" key={sec}>
              <div className="section-name">{sec}</div>
              {sec === "backlog"
                ? withTierDividers(rows.map((r) => r.i), (i) => <MobileRow key={i.id} item={i} state="active" projects={doc.projects} />)
                : rows.map((r) => <MobileRow key={r.i.id} item={r.i} state={r.state} projects={doc.projects} />)}
              {rows.length === 0 && <div className="empty">Nothing here.</div>}
            </div>
          );
        })}
      </div>

      <div className="mobile-capture">
        <div className="mobile-seg">
          <button className={capSection === "today" ? "on" : ""} onClick={() => setCapSection("today")}>Today</button>
          <button className={capSection === "backlog" ? "on" : ""} onClick={() => setCapSection("backlog")}>Backlog</button>
        </div>
        <input
          value={captureText}
          onChange={(e) => setCaptureText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void sendCapture(); } }}
          placeholder="Capture a task…"
          spellCheck={false}
        />
        <button className="mobile-send" onClick={() => void sendCapture()} disabled={!captureText.trim() || sending} title="Send">↵</button>
      </div>
    </div>
  );
}

// ---- Rows -------------------------------------------------------------------

function MobileRow({ item, state, projects }: {
  item: ExportItem;
  state: "active" | "done";
  projects: { id: string; name: string }[];
}) {
  const project = projects.find((p) => p.id === item.projectId);
  return (
    <div className={`item${state === "done" ? " done" : ""}`}>
      <span className={`item-check${state === "done" ? " checked" : ""}`} />
      <span className="item-text">{item.text}</span>
      <span className="item-meta">
        {item.section !== "backlog" && item.priority !== null && <Bars priority={item.priority} />}
        {item.totalSecs > 0 && <span className="time-label">⏱ {formatDuration(item.totalSecs)}</span>}
        {item.remindAt && <span className="reminder-chip">→ {formatReminder(item.remindAt)}</span>}
        {project && (
          <span className="project-label" style={{ color: projectColor(project.id) }}>{project.name}</span>
        )}
      </span>
    </div>
  );
}

function Bars({ priority }: { priority: 1 | 2 | 3 }) {
  // Same rule as the desktop: filled count = urgency (P1 = 3 filled).
  const filled = 4 - priority;
  return (
    <span className="priority-bars">
      {[1, 2, 3].map((n) => (
        <span key={n} className={`bar${n <= filled ? " filled" : ""}`} />
      ))}
    </span>
  );
}

/** Render-time day rollovers against the phone's local "today" — the same
 *  comparisons the desktop renderer makes, so a stale export still shows the
 *  right thing after midnight. */
function rowState(i: ExportItem): "active" | "done" | "gone" {
  const today = localDateStr();
  if (i.section === "daily") {
    return i.lastCompletedDate === today ? "done" : "active";
  }
  if (i.section === "today" && i.status === "done") {
    // Completed-before-today rows are retired by the Mac's sweep; if the
    // export predates that, just don't show them.
    return i.lastCompletedDate === today ? "done" : "gone";
  }
  return "active";
}

/** Group backlog rows by priority tier, inserting the desktop's hairline
 *  dividers (their label is the group's signal bars). Export order is already
 *  priority-sorted, so groups are consecutive runs. */
function withTierDividers(items: ExportItem[], renderRow: (i: ExportItem) => React.ReactNode) {
  const out: React.ReactNode[] = [];
  let lastKey: number | string | undefined;
  for (const i of items) {
    const key = i.priority ?? "none";
    if (key !== lastKey) {
      out.push(
        <div className="tier-divider" key={`tier-${key}-${i.id}`}>
          <BarsOrTrack priority={i.priority} />
        </div>,
      );
      lastKey = key;
    }
    out.push(renderRow(i));
  }
  return out;
}

function BarsOrTrack({ priority }: { priority: 1 | 2 | 3 | null }) {
  if (priority === null) {
    return (
      <span className="priority-bars">
        <span className="bar" /><span className="bar" /><span className="bar" />
      </span>
    );
  }
  return <Bars priority={priority} />;
}

// ---- First-run setup ---------------------------------------------------------

function Setup({ onConnect }: { onConnect: (cfg: MobileConfig) => void }) {
  // Prefill from any saved config so ⚙ (re-open setup) never forces a full re-entry.
  const existing = loadConfig();
  const [repo, setRepo] = useState(existing?.repo ?? "");
  const [branch, setBranch] = useState(existing?.branch ?? "main");
  const [token, setToken] = useState(existing?.token ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    const cfg: MobileConfig = { repo: repo.trim(), branch: branch.trim() || "main", token: token.trim() };
    if (!cfg.repo || !cfg.token) {
      setError("repo and token are required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await ghGet(cfg, TASKS_PATH); // null (404) is fine — repo just not deployed yet
      localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
      onConnect(cfg);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mobile-setup">
      <div className="mobile-brand">Live @ Faraz</div>
      <div className="mobile-setup-sub">Connect to your private sync repo</div>
      <input className="menu-input" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/dayapp-sync" spellCheck={false} />
      <input className="menu-input" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="branch (main)" spellCheck={false} />
      <input className="menu-input" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="GitHub token" spellCheck={false} />
      <div className="mobile-setup-hint">
        Create a fine-grained PAT with Contents read &amp; write on just this
        repo: github.com/settings/personal-access-tokens
      </div>
      {error && <div className="mobile-error">{error}</div>}
      <button className="mobile-connect" disabled={busy} onClick={() => void connect()}>
        {busy ? "Connecting…" : "Connect"}
      </button>
    </div>
  );
}
