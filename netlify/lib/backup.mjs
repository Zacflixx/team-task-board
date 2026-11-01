// Optional backup: after every saved change, write the whole board to tasks.json
// in a GitHub repository, so the repo history shows every change.
//
// Use a SEPARATE private repo for this (BACKUP_GITHUB_REPO). If you point it at the
// repo that Netlify deploys from, every task change would trigger a new site build.
//
// Environment variables (all in Netlify's site settings, never in the code):
//   GITHUB_TOKEN         fine-grained token with "Contents: read and write" on the backup repo
//   BACKUP_GITHUB_REPO   "owner/name" of the backup repo
//   BACKUP_GITHUB_BRANCH optional, defaults to "main"
//   BACKUP_GITHUB_PATH   optional, defaults to "tasks.json"

const API = "https://api.github.com";

export function backupEnabled(env) {
  return Boolean(env.GITHUB_TOKEN && env.BACKUP_GITHUB_REPO);
}

export function snapshot(board, savedAt = new Date().toISOString()) {
  // Stable order keeps the git diffs small and readable.
  const tasks = board.tasks.slice().sort((a, b) => {
    return a.status === b.status ? a.order - b.order : a.status < b.status ? -1 : 1;
  });
  return JSON.stringify({ rev: board.rev, savedAt, tasks }, null, 2) + "\n";
}

// Revision stored in the file GitHub returned, or -1 if it cannot be read.
function storedRev(file) {
  try {
    const parsed = JSON.parse(Buffer.from(file.content || "", "base64").toString("utf8"));
    return Number.isFinite(parsed.rev) ? parsed.rev : -1;
  } catch {
    return -1;
  }
}

export async function backupToGitHub(board, env = process.env, fetchFn = fetch) {
  if (!backupEnabled(env)) return { skipped: true };
  const repo = env.BACKUP_GITHUB_REPO;
  const branch = env.BACKUP_GITHUB_BRANCH || "main";
  const path = env.BACKUP_GITHUB_PATH || "tasks.json";
  const url = `${API}/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`;
  const headers = {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "team-task-board-backup"
  };

  // One deadline for the whole backup, so a slow GitHub cannot push the save past
  // the function's time limit.
  const signal = AbortSignal.timeout(6000);

  try {
    // Two saves close together can race. Read the file first and never replace a newer
    // revision with an older one. A 409/422 means someone else wrote in between: try once more.
    for (let attempt = 0; attempt < 2; attempt++) {
      let sha;
      const current = await fetchFn(`${url}?ref=${encodeURIComponent(branch)}`, { headers, signal });
      if (current.ok) {
        const file = await current.json();
        sha = file.sha;
        if (storedRev(file) >= board.rev) return { ok: true, skipped: "newer revision already stored" };
      } else if (current.status !== 404) {
        throw new Error(`GitHub read failed (${current.status})`);
      }

      const put = await fetchFn(url, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          message: `Board update (revision ${board.rev})`,
          content: Buffer.from(snapshot(board)).toString("base64"),
          branch,
          sha
        })
      });
      if (put.ok) return { ok: true };
      if ((put.status === 409 || put.status === 422) && attempt === 0) continue;
      throw new Error(`GitHub write failed (${put.status})`);
    }
    return { ok: false, error: "GitHub write conflicted twice" };
  } catch (error) {
    // A failed backup must never fail the save. The next change writes the full board again.
    console.error("Backup to GitHub failed:", error.message);
    return { ok: false, error: error.message };
  }
}
