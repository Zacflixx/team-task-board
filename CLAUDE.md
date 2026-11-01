# Team Task Board

Shared kanban board for a small team, hosted on Netlify. Stages: Not started, In progress,
Almost done, Done, Live. Everyone with the team passcode can add, edit, drag and delete tasks.

## Architecture

- `public/index.html` and `public/app.js`: static page, vanilla JS, no framework, no build step.
- `netlify/functions/tasks.mjs`: the only backend. One Netlify Function (v2, Web `Request`/`Response`) at `/api/tasks` (GET, POST, PATCH, DELETE). Every call needs the `x-team-passcode` header, compared in constant time with `process.env.TEAM_PASSCODE`.
- Storage: Netlify Blobs, store `team-task-board`, key `board`, strong consistency. The whole board is one JSON document `{ rev, tasks: [...] }`. Writes read the document, apply one operation, and save with `onlyIfMatch: etag` (or `onlyIfNew`), retrying on conflict.
- `netlify/lib/board.mjs`: pure validation and operations. No I/O. Keep it that way so it stays easy to test.
- `netlify/lib/backup.mjs`: optional commit of the full board to `tasks.json` in a separate GitHub repo after every successful save. Failures are logged and never fail a save.
- `docs/claude-artifact-version.html`: the earlier single-file version that ran inside Claude. Reference only. Do not ship it.

Front end behavior to preserve:
- Own changes appear immediately (optimistic) and are sent through a queue, one at a time. The server's list is only adopted when the queue is empty, so a late reply never undoes a newer move.
- Other people's changes arrive by polling `GET /api/tasks?rev=N` (answers `{ unchanged: true }` when nothing changed). Polling is every 8 s while active, every 30 s after two quiet minutes, and paused while the tab is hidden or a card is being dragged.
- A 401 reopens the passcode gate and clears the saved passcode.

## Commands

```bash
npm install
npm test                    # node --test, no extra dependencies
npx netlify-cli dev         # local site and function; needs TEAM_PASSCODE in .env
```

## Environment variables (set in Netlify, never committed)

`TEAM_PASSCODE` (required). Optional backup: `GITHUB_TOKEN`, `BACKUP_GITHUB_REPO`,
`BACKUP_GITHUB_BRANCH`, `BACKUP_GITHUB_PATH`.

## Rules for working here

- No external database or paid service. Storage stays in Netlify Blobs.
- Never commit `.env`, tokens or the passcode. Never log the passcode.
- The backup repo must stay separate from the deployed repo, or every save triggers a site build.
- Render all user text with `textContent` (the `h()` helper does this). Do not use `innerHTML` for task data.
- Keep dependencies minimal. The only runtime dependency is `@netlify/blobs`.
- Keep the visual design (tokens at the top of the `<style>` in `index.html`) unless asked to change it. Both light and dark themes must keep working.
- Add or update a test in `test/` for any change to `board.mjs`, `tasks.mjs` or `backup.mjs`.
- Ask before pushing to GitHub, deploying, or changing environment variables.
