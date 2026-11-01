# Team Task Board

A shared kanban board for a small team. Cards move through five stages:
**Not started, In progress, Almost done, Done (Awaiting approval), Live.** Anyone with the team passcode can add, edit,
drag and delete tasks. No separate database service is needed.

## How it works

| Part | Where | What it does |
| --- | --- | --- |
| Page | `public/index.html`, `public/app.js` | The board. Your own changes show immediately and save in the background. It checks for other people's changes every 8 seconds while active, every 30 seconds when idle, and not at all while the tab is hidden. |
| API | `netlify/functions/tasks.mjs` | One Netlify Function at `/api/tasks`. Checks the passcode, then reads or changes the board. |
| Storage | Netlify Blobs (built in) | The whole board is one JSON document. Saves use ETag checks, so two people saving at the same moment both land. |
| Images (optional) | Cloudinary | Attach up to 3 pictures to a task (paste a screenshot, pick a file, or drop one). The page shrinks them, then uploads straight to your Cloudinary account using a short-lived signed permission from the function. The task keeps only the links. |
| Backup (optional) | `netlify/lib/backup.mjs` | After every saved change, commits the full board to `tasks.json` in a GitHub repo. |

## Set up

You need: a GitHub account, a Netlify account, and about 15 minutes.

### 1. Put the code on GitHub

Create a new **private** repo (for example `team-task-board`), then from this folder:

```bash
git init
git add .
git commit -m "Team Task Board"
git branch -M main
git remote add origin https://github.com/YOUR-NAME/team-task-board.git
git push -u origin main
```

### 2. Create the Netlify site

1. In Netlify, add a new project and import it from GitHub. Pick the repo.
2. Netlify reads `netlify.toml`, so the build settings fill in by themselves (publish folder `public`, functions folder `netlify/functions`). There is no build command.
3. Before the first deploy, add the environment variable below. Menu names may differ slightly, but it is under the project's environment variables. Make sure it is available to **Functions**.

| Variable | Value |
| --- | --- |
| `TEAM_PASSCODE` | A long passcode you share with the team. The function refuses to work without it. |

4. Deploy. Open the site, enter the passcode, add a task.

To change the passcode later, edit the variable and trigger a new deploy.

### 3. Turn on the GitHub backup (optional, recommended)

Use a **separate private repo** for the data, for example `team-task-board-data`. Do not point the
backup at the repo Netlify deploys from, or every task change would trigger a new site build.

1. Create the empty private repo, with a `main` branch (tick "Add a README" when creating it).
2. In GitHub, create a **fine-grained personal access token**: repository access limited to the data repo only, permission **Contents: Read and write**.
3. Add these variables in Netlify, then redeploy:

| Variable | Value |
| --- | --- |
| `GITHUB_TOKEN` | The token from step 2 |
| `BACKUP_GITHUB_REPO` | `owner/team-task-board-data` |
| `BACKUP_GITHUB_BRANCH` | Optional. Defaults to `main` |
| `BACKUP_GITHUB_PATH` | Optional. Defaults to `tasks.json` |

Make a change on the board. A commit named "Board update (revision N)" should appear in the data repo within a few seconds.
If GitHub is unreachable the save still succeeds. The next change writes the full board again.

Tokens expire. Set a reminder to renew yours.

### 4. Turn on image attachments (optional)

Uses your existing Cloudinary account. Images are stored there, not in the board.

| Variable | Value |
| --- | --- |
| `CLOUDINARY_CLOUD_NAME` | Your cloud name (Cloudinary dashboard) |
| `CLOUDINARY_API_KEY` | Your API key |
| `CLOUDINARY_API_SECRET` | Your API secret. Keep it only in Netlify's settings. |
| `CLOUDINARY_FOLDER` | Optional. Defaults to `team-task-board` |

Redeploy. The task dialog now shows an "Images" section. Without these variables the board works as before and the section is hidden.

Good to know: image links are public (long random names, no passcode). Uploads need the team passcode. Deleting a task or removing an image deletes it from Cloudinary. The GitHub backup keeps the image links, not the files.

## Run it on your computer

```bash
npm install
cp .env.example .env      # then edit .env and set TEAM_PASSCODE
npx netlify-cli dev
```

Open the address it prints. Local runs use a local copy of Blobs, so they do not touch the live board.

```bash
npm test                  # unit tests for the board logic and the API handler
```

## Good to know

- **One shared passcode, no personal accounts.** Anyone who has it can change anything. Use a long one, and change it when someone leaves the team.
- **Owner is free text.** It is a name typed on the card, not a login.
- **Updates are not instant for other people.** Your own moves show at once. A teammate sees them within about 8 seconds.
- **Limits.** Up to 5,000 tasks; titles 140 characters, notes 1,000, owner 40.
- **Netlify usage.** Every check is one function call, and Netlify bills from a monthly credit pool. Idle and hidden tabs slow down or stop on their own. Look at Netlify's usage page after the first week and adjust `POLL_MS` and `IDLE_POLL_MS` at the top of `public/app.js` if needed.
- **Images** are limited to 3 per task and are shrunk to 1600 px before upload. Animated GIFs become still images.
- **Restoring.** If the board is ever wiped, `tasks.json` in the backup repo holds the tasks. Each task has `title`, `notes`, `owner`, `status` and `order`.

## Files

```
public/index.html            page and styles
public/app.js                board logic, drag and drop, polling
netlify/functions/tasks.mjs  the API
netlify/lib/board.mjs        validation and the create, update, delete operations
netlify/lib/backup.mjs       GitHub backup
test/board.test.mjs          tests
docs/claude-artifact-version.html   the original single-file version that ran inside Claude (reference only)
```
