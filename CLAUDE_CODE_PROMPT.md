# Prompt for Claude Code

Open this folder in Claude Code, then paste everything below the line.

---

This folder is a finished first version of a shared team kanban board that I want to host on Netlify
(I have a Netlify Pro plan) with the code on GitHub. Read `CLAUDE.md` and `README.md` first. They describe
the architecture, the rules for working here, and the setup steps.

What exists: a static page (`public/`), one Netlify Function (`netlify/functions/tasks.mjs`) that checks a
shared team passcode and stores the board in Netlify Blobs, and an optional backup that commits the board
to a separate GitHub repo after every change. Unit tests and an earlier smoke test passed, but the real
Netlify Blobs, the real GitHub backup, and real browser drag and drop have not been tested yet. That is
your main job.

Please do the following, in order, and tell me briefly what you found at each step:

1. Run `npm install` and `npm test`. Fix anything that fails.

2. Review the code for bugs and security problems, especially in `netlify/functions/tasks.mjs`,
   `netlify/lib/board.mjs` and `netlify/lib/backup.mjs` (passcode handling, input validation, concurrent
   saves, the GitHub backup path, anything that could leak the passcode or token). Fix real problems and
   add tests for them. Do not rewrite things that work.

3. Run it locally with `npx netlify-cli dev` using a test `TEAM_PASSCODE` in a `.env` file (make sure `.env`
   is git-ignored). Open it in a browser and check, with real mouse interaction:
   - the passcode gate (wrong passcode, right passcode)
   - add, edit, delete a task
   - dragging a card between all five columns and reordering inside a column
   - the ‹ › buttons on each card
   - a second browser window sees changes within about 10 seconds
   - phone width (about 400px) and dark mode both look right
   Fix what is broken. Do not change the visual design unless something is clearly wrong.

4. Set up git for this folder (initial commit, `main` branch). Do not push yet. Tell me the exact commands
   to create the private GitHub repo and push, or do it for me if I confirm the repo name.

5. Walk me through connecting the repo to Netlify and setting the environment variables (`TEAM_PASSCODE`
   first; the backup variables after). Do not deploy or change any Netlify settings without asking me.

6. After it is deployed, test the live site the same way as step 3, then turn on the GitHub backup
   (a separate private repo and a fine-grained token limited to that repo) and confirm a commit appears
   in that repo after a change on the board.

7. Finish with a short report: what works, what you changed, anything still risky or unverified, and what
   I should check on the Netlify usage page after a week.

Constraints: no external database or paid service, keep dependencies minimal, never commit secrets,
and ask before pushing, deploying, or touching environment variables.
