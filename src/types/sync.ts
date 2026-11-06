// Mobile sync's GitHub-file transport (see src-tauri/src/sync.rs). The Mac is
// the single writer; the phone is a read-only mirror + capture inbox.

export interface SyncConfig {
  repo: string;           // "owner/name" of the private data repo
  branch: string;         // "main"
  token: string | null;   // PAT; null → the backend falls back to `gh auth token`
}

export interface SyncStatus {
  configured: boolean;
  repo: string;
  branch: string;
  lastPushAt: string | null;
  lastPullAt: string | null;
}

export interface SyncCapture {
  id: string;
  text: string;
  section: "today" | "backlog";
  at: string;
}
