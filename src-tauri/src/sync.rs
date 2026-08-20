// Mobile sync — a read mirror + capture inbox over a private GitHub repo.
//
// The Mac app stays the single writer of truth. It exports the read model to
// `tasks.json` (deploy) and drains the phone's `captures.json` inbox into real
// items (pull + ingest, done by the frontend so captures go through the normal
// create path and parse `#tag`/`!N` tokens). The phone never touches the
// database: it reads the export and appends captures. The repo is the
// transport, not a second database — no merge logic anywhere.
//
// Invariants:
// - deploy is change-gated: the export's sha256 is compared against
//   `sync_last_push_hash` in meta, so the 60s loop costs one GET+PUT only when
//   something actually changed.
// - pull never double-ingests: capture ids that reached the DB are recorded in
//   `sync_ingested_ids` in meta and filtered forever — even if the
//   captures.json rewrite races a phone write and loses, the next pull just
//   filters them out again.
//
// Auth: a PAT stored in meta (set via ⌘P → Mobile: Configure Sync…), falling
// back to `gh auth token` so a machine with the gh CLI works zero-config.

use crate::db::{now_iso, today_iso, Db};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const TASKS_PATH: &str = "tasks.json";
pub const CAPTURES_PATH: &str = "captures.json";

/// Cap on the remembered-ingested-ids guard list. ULIDs are ~26 chars, so 500
/// entries is ~15KB of meta — plenty of drift room for a capture inbox.
const INGESTED_CAP: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    pub repo: String,          // "owner/name" of the private data repo
    pub branch: String,        // default "main"
    pub token: Option<String>, // fine-grained PAT; None → `gh auth token` fallback
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub configured: bool,
    pub repo: String,
    pub branch: String,
    pub last_push_at: Option<String>,
    pub last_pull_at: Option<String>,
}

/// One inbox entry written by the phone. Section is where the desktop capture
/// path should land it ("today" | "backlog").
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    pub id: String,
    pub text: String,
    pub section: String,
    pub at: String,
}

pub enum DeployOutcome {
    NotConfigured,
    Unchanged,
    Pushed(usize),
}

impl DeployOutcome {
    pub fn describe(&self) -> String {
        match self {
            DeployOutcome::NotConfigured => "not configured — run Mobile: Configure Sync…".into(),
            DeployOutcome::Unchanged => "no changes".into(),
            DeployOutcome::Pushed(n) => format!("pushed {n} items"),
        }
    }
}

// The exported read model. Day-rollover rules (daily grey-out, done-today
// retirement) are render-time date comparisons, so raw dates travel and the
// phone derives display state against its own "today" — a stale export still
// renders correctly overnight.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportItem {
    id: String,
    text: String,
    section: String,
    status: String,
    last_completed_date: Option<String>,
    priority: Option<i64>,
    assigned_to_agent: bool,
    project_id: Option<String>,
    remind_at: Option<String>,
    total_secs: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportDoc {
    generator: String,
    exported_at: String,
    today: String,
    projects: Vec<ExportProject>,
    items: Vec<ExportItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportProject {
    id: String,
    name: String,
}

impl Db {
    pub fn sync_config(&self) -> SyncConfig {
        let repo = self.meta_get("sync_repo").ok().flatten().unwrap_or_default();
        let branch = self
            .meta_get("sync_branch").ok().flatten()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "main".into());
        let token = self
            .meta_get("sync_token").ok().flatten()
            .filter(|s| !s.is_empty());
        SyncConfig { repo, branch, token }
    }

    pub fn sync_set_config(&self, cfg: &SyncConfig) -> anyhow::Result<()> {
        let repo = cfg.repo.trim().to_string();
        if !repo.is_empty() && !repo.contains('/') {
            anyhow::bail!("repo must look like owner/name (got \"{repo}\")");
        }
        let branch = {
            let b = cfg.branch.trim();
            if b.is_empty() { "main".to_string() } else { b.to_string() }
        };
        self.meta_set("sync_repo", &repo)?;
        self.meta_set("sync_branch", &branch)?;
        self.meta_set("sync_token", cfg.token.as_deref().unwrap_or("").trim())?;
        // A different repo (or a fresh save) must not be short-circuited by the
        // previous repo's content hash — force the next deploy.
        self.meta_set("sync_last_push_hash", "")?;
        log::info!(
            "sync: configured repo {repo} (branch {branch}, auth: {})",
            if cfg.token.as_deref().unwrap_or("").trim().is_empty() { "gh fallback" } else { "PAT" }
        );
        Ok(())
    }

    pub fn sync_status(&self) -> SyncStatus {
        let cfg = self.sync_config();
        SyncStatus {
            configured: !cfg.repo.is_empty(),
            repo: cfg.repo,
            branch: cfg.branch,
            last_push_at: self.meta_get("sync_last_push_at").ok().flatten(),
            last_pull_at: self.meta_get("sync_last_pull_at").ok().flatten(),
        }
    }
}

/// Build the tasks.json body. Returns the body plus the item count (for logs).
pub fn build_export(db: &Db) -> anyhow::Result<(String, usize)> {
    let items: Vec<ExportItem> = {
        let conn = db.0.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, text, section, status, last_completed_date, priority, assigned_to_agent, project_id, remind_at
             FROM items WHERE hidden = 0
             ORDER BY CASE section WHEN 'today' THEN 0 WHEN 'daily' THEN 1 ELSE 2 END,
                      CASE WHEN section = 'backlog' THEN COALESCE(priority, 99) ELSE 0 END,
                      sort_order, created_at",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(ExportItem {
                id: r.get(0)?,
                text: r.get(1)?,
                section: r.get(2)?,
                status: r.get(3)?,
                last_completed_date: r.get(4)?,
                priority: r.get(5)?,
                assigned_to_agent: r.get::<_, i64>(6)? != 0,
                project_id: r.get(7)?,
                remind_at: r.get(8)?,
                total_secs: 0,
            })
        })?;
        let mut v = Vec::new();
        for row in rows { v.push(row?); }
        v
    };
    let ids: Vec<String> = items.iter().map(|i| i.id.clone()).collect();
    let totals = db.time_totals(&ids)?;
    let mut items = items;
    for it in &mut items {
        it.total_secs = totals.get(&it.id).copied().unwrap_or(0);
    }
    let projects = db
        .list_projects()?
        .into_iter()
        .map(|p| ExportProject { id: p.id, name: p.name })
        .collect();
    let doc = ExportDoc {
        generator: "dayapp".into(),
        exported_at: now_iso(),
        today: today_iso(),
        projects,
        items,
    };
    let n = doc.items.len();
    Ok((serde_json::to_string_pretty(&doc)?, n))
}

/// Push tasks.json when it changed since the last push (or always, forced).
pub fn deploy(db: &Db, force: bool) -> anyhow::Result<DeployOutcome> {
    let cfg = db.sync_config();
    if cfg.repo.is_empty() {
        return Ok(DeployOutcome::NotConfigured);
    }
    let (body, n) = build_export(db)?;
    let hash = sha256_hex(body.as_bytes());
    let last = db.meta_get("sync_last_push_hash")?.unwrap_or_default();
    if !force && last == hash {
        return Ok(DeployOutcome::Unchanged);
    }
    let token = resolve_token(&cfg)?;
    let sha = gh_get_file(&token, &cfg, TASKS_PATH)?.map(|f| f.sha);
    gh_put_file(&token, &cfg, TASKS_PATH, body.as_bytes(), sha, "dayapp: export task list")?;
    db.meta_set("sync_last_push_hash", &hash)?;
    db.meta_set("sync_last_push_at", &now_iso())?;
    Ok(DeployOutcome::Pushed(n))
}

/// New, never-ingested captures from the phone's inbox. Empty when unconfigured
/// or when the repo has no captures.json yet — pulling is always safe to call.
pub fn pull_captures(db: &Db) -> anyhow::Result<Vec<Capture>> {
    let cfg = db.sync_config();
    if cfg.repo.is_empty() {
        return Ok(Vec::new());
    }
    let Some(file) = gh_get_file(&resolve_token(&cfg)?, &cfg, CAPTURES_PATH)? else {
        return Ok(Vec::new());
    };
    let all: Vec<Capture> = serde_json::from_slice(&file.content)?;
    let ingested: Vec<String> = db
        .meta_get("sync_ingested_ids")?.and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    Ok(all.into_iter().filter(|c| !ingested.contains(&c.id)).collect())
}

/// Record captures as ingested (the guard against double-creating items), then
/// best-effort rewrite captures.json without them. If the rewrite loses a race
/// against the phone, the guard still holds — next pull filters the same ids.
pub fn mark_ingested(db: &Db, ids: &[String]) -> anyhow::Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let mut known: Vec<String> = db
        .meta_get("sync_ingested_ids")?.and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    for id in ids {
        if !known.contains(id) {
            known.push(id.clone());
        }
    }
    let start = known.len().saturating_sub(INGESTED_CAP);
    db.meta_set("sync_ingested_ids", &serde_json::to_string(&known[start..])?)?;
    db.meta_set("sync_last_pull_at", &now_iso())?;

    let cfg = db.sync_config();
    if cfg.repo.is_empty() {
        return Ok(());
    }
    let token = resolve_token(&cfg)?;
    if let Some(file) = gh_get_file(&token, &cfg, CAPTURES_PATH)? {
        let all: Vec<Capture> = serde_json::from_slice(&file.content).map_err(|e| anyhow::anyhow!("captures.json unreadable: {e}"))?;
        let remaining: Vec<&Capture> = all.iter().filter(|c| !ids.contains(&c.id)).collect();
        if remaining.len() != all.len() {
            let body = serde_json::to_string_pretty(&remaining)?;
            gh_put_file(&token, &cfg, CAPTURES_PATH, body.as_bytes(), Some(file.sha), "dayapp: drain capture inbox")?;
        }
    }
    Ok(())
}

// ---- GitHub Contents API ----------------------------------------------------

struct GhFile {
    sha: String,
    content: Vec<u8>,
}

fn gh_client() -> anyhow::Result<reqwest::blocking::Client> {
    Ok(reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("dayapp-sync")
        .build()?)
}

fn resolve_token(cfg: &SyncConfig) -> anyhow::Result<String> {
    if let Some(t) = cfg.token.as_deref().filter(|t| !t.trim().is_empty()) {
        return Ok(t.trim().to_string());
    }
    // Zero-config fallback: reuse the local gh CLI's token. Stays on this
    // machine (keyring) and is only used in-memory for the API calls.
    let out = std::process::Command::new("gh")
        .args(["auth", "token"])
        .output()
        .map_err(|_| anyhow::anyhow!("no PAT configured and the gh CLI wasn't found"))?;
    if !out.status.success() {
        anyhow::bail!("no PAT configured and `gh auth token` failed — set one via Mobile: Configure Sync…");
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn gh_get_file(token: &str, cfg: &SyncConfig, path: &str) -> anyhow::Result<Option<GhFile>> {
    let url = format!("https://api.github.com/repos/{}/contents/{}", cfg.repo, path);
    let resp = gh_client()?
        .get(url)
        .query(&[("ref", cfg.branch.as_str())])
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .send()?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("GET {path} → {}", err_body(status, &resp.text().unwrap_or_default()));
    }
    #[derive(Deserialize)]
    struct Body {
        sha: String,
        content: Option<String>,
    }
    let body: Body = resp.json()?;
    let b64 = body.content.unwrap_or_default().replace('\n', "");
    let content = base64::engine::general_purpose::STANDARD.decode(b64)
        .map_err(|e| anyhow::anyhow!("base64 decode of {path} failed: {e}"))?;
    Ok(Some(GhFile { sha: body.sha, content }))
}

fn gh_put_file(
    token: &str, cfg: &SyncConfig, path: &str, content: &[u8],
    sha: Option<String>, message: &str,
) -> anyhow::Result<()> {
    let url = format!("https://api.github.com/repos/{}/contents/{}", cfg.repo, path);
    let b64 = base64::engine::general_purpose::STANDARD.encode(content);
    let mut body = serde_json::json!({ "message": message, "content": b64, "branch": cfg.branch });
    if let Some(sha) = sha {
        body["sha"] = serde_json::Value::String(sha);
    }
    let resp = gh_client()?
        .put(url)
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .json(&body)
        .send()?;
    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("PUT {path} → {}", err_body(status, &resp.text().unwrap_or_default()));
    }
    Ok(())
}

fn err_body(status: reqwest::StatusCode, text: &str) -> String {
    let short: String = text.chars().take(200).collect::<String>().replace('\n', " ");
    format!("{status} {short}")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}
