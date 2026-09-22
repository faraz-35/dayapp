// UpdateOverlay — full-screen modal shown while an update runs. Phases driven
// by the "update-status" events from the backend:
//   building    — local rebuild: live compiler output scrolls by, elapsed timer
//   downloading — release update: throttled byte-progress lines, elapsed timer
//   restarting  — succeeded; the app is handing off to the swap/relaunch
//                 (status.message overrides the default line — the release
//                 path names the installed version there)
//   error       — failed; show why, let the user dismiss and keep working
//
// The parent owns the status state and passes it down; this component is purely
// presentational plus a couple of side-effects (auto-scroll, elapsed timer).

import { useEffect, useRef, useState } from "react";
import type { UpdateStatus } from "./App";

export default function UpdateOverlay({
  status, onDismiss,
}: {
  status: UpdateStatus | null;
  onDismiss: () => void;
}) {
  const logRef = useRef<HTMLDivElement>(null);
  const [elapsed, setElapsed] = useState(0);

  // Tick the elapsed seconds while building or downloading.
  const running = status?.phase === "building" || status?.phase === "downloading";
  useEffect(() => {
    if (!running) return;
    setElapsed(0);
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  // Auto-scroll the log to the bottom as new lines arrive.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [status]);

  if (!status) return null;
  const phase = status.phase;

  return (
    <div className="overlay-backdrop">
      <div className="overlay">
        {running && (
          <>
            <div className="overlay-head">
              <span className="spinner" />
              <span className="overlay-title">{phase === "downloading" ? "Downloading…" : "Building…"}</span>
              <span className="overlay-elapsed">{elapsed}s</span>
            </div>
            <div className="overlay-log" ref={logRef}>
              {status.lines.map((line, i) => (
                <div key={i} className="overlay-log-line">{line}</div>
              ))}
            </div>
          </>
        )}

        {phase === "restarting" && (
          <div className="overlay-message">
            <span className="spinner" />
            <span>{status.message || "Build complete — restarting DayApp…"}</span>
          </div>
        )}

        {phase === "error" && (
          <>
            <div className="overlay-head">
              <span className="overlay-title error-text">Update failed</span>
            </div>
            <div className="overlay-log">
              {status.lines.map((line, i) => (
                <div key={i} className="overlay-log-line">{line}</div>
              ))}
              <div className="overlay-log-line error-text">{status.message}</div>
            </div>
            <button className="overlay-dismiss" onClick={onDismiss}>Dismiss</button>
          </>
        )}
      </div>
    </div>
  );
}
