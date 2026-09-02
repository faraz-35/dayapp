// MobileSyncSettings — ⌘P → "Mobile: Configure Sync…". A floating surface
// (backdrop + centered card, like the palette) holding the GitHub repo,
// branch, and PAT that deploy/pull use. Saving validates by force-pushing
// immediately, so a green result means the whole round-trip works.
//
// The token is stored in the db's meta table (single-user, local file). When
// it's empty the backend falls back to `gh auth token` — on this Mac that
// makes desktop sync zero-config; the phone still needs its own PAT because
// it can't reach the keyring.

import { useEffect, useState } from "react";
import { syncApi } from "./lib";
import { log } from "./log";
import { trace } from "./devlog";

export default function MobileSyncSettings({ open, onClose }: {
  open: boolean;
  onClose: () => void;
}) {
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setResult(null);
    Promise.all([syncApi.getConfig(), syncApi.status()])
      .then(([cfg, st]) => {
        setRepo(cfg.repo);
        setBranch(cfg.branch || "main");
        setToken(cfg.token ?? "");
        if (st.configured && st.lastPushAt) {
          setResult({ ok: true, text: `last deploy ${st.lastPushAt.replace("T", " ").slice(0, 16)}` });
        }
      })
      .catch((e) => setResult({ ok: false, text: String(e) }));
  }, [open]);

  if (!open) return null;

  const save = async () => {
    trace("sync.save", { repo: repo.trim() });
    setBusy(true);
    setResult(null);
    try {
      await syncApi.setConfig({ repo: repo.trim(), branch: branch.trim(), token: token.trim() || null });
      const outcome = await syncApi.deploy(true); // validate the round-trip now
      log.info(`sync: configured ${repo.trim()} — ${outcome}`);
      setResult({ ok: true, text: `Saved — ${outcome}` });
    } catch (e) {
      log.error("sync: configure failed", e);
      setResult({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sync-backdrop" onClick={onClose}>
      <div className="sync-card" onClick={(e) => e.stopPropagation()}>
        <div className="sync-head">Mobile Sync</div>
        <label className="sync-field">
          <span>Repo</span>
          <input
            className="menu-input"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="owner/dayapp-sync"
            spellCheck={false}
            autoFocus
          />
        </label>
        <label className="sync-field">
          <span>Branch</span>
          <input
            className="menu-input"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="main"
            spellCheck={false}
          />
        </label>
        <label className="sync-field">
          <span>Token</span>
          <input
            className="menu-input"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="fine-grained PAT (empty = gh CLI token)"
            spellCheck={false}
          />
        </label>
        <div className="sync-hint">
          Phone needs a fine-grained PAT (Contents: read & write, only this
          repo): github.com/settings/personal-access-tokens — the desktop can
          leave this empty and use the gh CLI token.
        </div>
        {result && <div className={`sync-result ${result.ok ? "ok" : "err"}`}>{result.text}</div>}
        <div className="sync-actions">
          <button className="overlay-dismiss" onClick={onClose}>Close</button>
          <button className="sync-save" disabled={busy || !repo.trim()} onClick={save}>
            {busy ? "Saving…" : "Save + Deploy"}
          </button>
        </div>
      </div>
    </div>
  );
}
