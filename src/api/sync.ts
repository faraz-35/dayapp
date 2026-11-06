// Mobile sync — GitHub-file transport for the Android client (see
// src-tauri/src/sync.rs). The Mac is the single writer: deploy pushes
// tasks.json; pull drains the phone's captures.json inbox for ingestion
// through the normal create path.

import { invoke } from "@tauri-apps/api/core";
import type { SyncCapture, SyncConfig, SyncStatus } from "../types/sync";

export const syncApi = {
  getConfig: () => invoke<SyncConfig>("sync_get_config"),
  setConfig: (config: SyncConfig) => invoke<void>("sync_set_config", { config }),
  /** Force-push the export; resolves with a human-readable outcome. */
  deploy: (force: boolean) => invoke<string>("sync_deploy", { force }),
  pull: () => invoke<SyncCapture[]>("sync_pull_captures"),
  markIngested: (ids: string[]) => invoke<void>("sync_mark_ingested", { ids }),
  status: () => invoke<SyncStatus>("sync_status"),
};
