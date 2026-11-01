import test from "node:test";
import assert from "node:assert/strict";
import { applyOp, emptyBoard, HttpError } from "../netlify/lib/board.mjs";
import { createHandler } from "../netlify/functions/tasks.mjs";
import { snapshot, backupToGitHub } from "../netlify/lib/backup.mjs";

/* An in-memory stand-in for Netlify Blobs with the same ETag rules. */
function fakeStore() {
  let value = null;
  let etag = null;
  let counter = 0;
  return {
    async getWithMetadata() {
      return value === null ? null : { data: JSON.parse(value), etag };
    },
    async setJSON(_key, data, options = {}) {
      if (options.onlyIfNew && value !== null) return { modified: false };
      if (options.onlyIfMatch && options.onlyIfMatch !== etag) return { modified: false };
      value = JSON.stringify(data);
      etag = `etag-${++counter}`;
      return { modified: true, etag };
    },
    _raw: () => JSON.parse(value)
  };
}

const env = { TEAM_PASSCODE: "open-sesame" };
const noBackup = async () => ({ skipped: true });

function call(handler, method, body, { passcode = "open-sesame", query = "" } = {}) {
  return handler(
    new Request(`https://example.test/api/tasks${query}`, {
      method,
      headers: { "x-team-passcode": passcode, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  );
}

test("create trims text, defaults to Not started and bumps the revision", () => {
  const { board, task } = applyOp(emptyBoard(), { type: "create", task: { title: "  Ship it  ", owner: " Sam " } }, 1000, () => "a");
  assert.equal(board.rev, 1);
  assert.deepEqual(task, { id: "a", title: "Ship it", notes: "", owner: "Sam", date: "", deadline: "", images: [], status: "todo", order: 1000, createdAt: 1000, updatedAt: 1000 });
});

test("create rejects an empty title and an unknown stage", () => {
  assert.throws(() => applyOp(emptyBoard(), { type: "create", task: { title: "  " } }), HttpError);
  assert.throws(() => applyOp(emptyBoard(), { type: "create", task: { title: "x", status: "archived" } }), /Unknown stage/);
});

test("update changes only the fields given and leaves the input untouched", () => {
  const start = applyOp(emptyBoard(), { type: "create", task: { title: "One" } }, 1, () => "a").board;
  const { board } = applyOp(start, { type: "update", id: "a", patch: { status: "live", order: 5 } }, 9);
  assert.equal(start.tasks[0].status, "todo");
  assert.equal(board.tasks[0].status, "live");
  assert.equal(board.tasks[0].order, 5);
  assert.equal(board.tasks[0].title, "One");
  assert.equal(board.tasks[0].updatedAt, 9);
});

test("update and delete report a missing task", () => {
  assert.throws(() => applyOp(emptyBoard(), { type: "update", id: "nope", patch: {} }), /no longer exists/);
  assert.throws(() => applyOp(emptyBoard(), { type: "delete", id: "nope" }), /no longer exists/);
});

test("delete removes the task", () => {
  const start = applyOp(emptyBoard(), { type: "create", task: { title: "One" } }, 1, () => "a").board;
  const { board } = applyOp(start, { type: "delete", id: "a" });
  assert.equal(board.tasks.length, 0);
  assert.equal(board.rev, 2);
});

test("handler refuses to run without a server passcode", async () => {
  const handler = createHandler({ openStore: fakeStore, env: {}, backup: noBackup });
  assert.equal((await call(handler, "GET")).status, 500);
});

test("handler rejects a wrong or missing passcode", async () => {
  const handler = createHandler({ openStore: () => fakeStore(), env, backup: noBackup });
  assert.equal((await call(handler, "GET", undefined, { passcode: "nope" })).status, 401);
  assert.equal((await call(handler, "GET", undefined, { passcode: "" })).status, 401);
});

test("full flow: create, move, poll for changes, delete", async () => {
  const store = fakeStore();
  const handler = createHandler({ openStore: () => store, env, backup: noBackup });

  let res = await call(handler, "GET");
  assert.deepEqual(await res.json(), { rev: 0, tasks: [] });

  res = await call(handler, "POST", { title: "Write copy", owner: "Dana" });
  const created = await res.json();
  assert.equal(res.status, 200);
  assert.equal(created.tasks.length, 1);
  const id = created.task.id;

  res = await call(handler, "PATCH", { id, patch: { status: "progress" } });
  assert.equal((await res.json()).tasks[0].status, "progress");

  res = await call(handler, "GET", undefined, { query: "?rev=2" });
  assert.deepEqual(await res.json(), { rev: 2, unchanged: true });
  res = await call(handler, "GET", undefined, { query: "?rev=1" });
  assert.equal((await res.json()).tasks.length, 1);

  res = await call(handler, "DELETE", { id });
  assert.equal((await res.json()).tasks.length, 0);
});

test("two saves at the same moment both land", async () => {
  const store = fakeStore();
  const handler = createHandler({ openStore: () => store, env, backup: noBackup });
  const results = await Promise.all([
    call(handler, "POST", { title: "From Sam" }),
    call(handler, "POST", { title: "From Dana" })
  ]);
  assert.deepEqual(results.map((r) => r.status), [200, 200]);
  assert.equal(store._raw().tasks.length, 2);
});

test("a failing backup does not fail the save", async () => {
  let called = 0;
  const handler = createHandler({
    openStore: () => fakeStore(),
    env,
    backup: async () => { called++; return { ok: false }; }
  });
  const res = await call(handler, "POST", { title: "Still saves" });
  assert.equal(res.status, 200);
  assert.equal(called, 1);
});

test("snapshot is stable and sorted by stage then order", () => {
  const board = {
    rev: 3,
    tasks: [
      { id: "b", status: "todo", order: 2 },
      { id: "a", status: "todo", order: 1 },
      { id: "c", status: "live", order: 0 }
    ]
  };
  const parsed = JSON.parse(snapshot(board, "2026-01-01T00:00:00.000Z"));
  assert.deepEqual(parsed.tasks.map((t) => t.id), ["c", "a", "b"]);
  assert.equal(parsed.rev, 3);
});

test("backup writes through the GitHub contents API and survives errors", async () => {
  const calls = [];
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET" });
    if (!init.method) return new Response("{}", { status: 404 });
    return new Response("{}", { status: 201 });
  };
  const result = await backupToGitHub(
    { rev: 1, tasks: [] },
    { GITHUB_TOKEN: "t", BACKUP_GITHUB_REPO: "acme/data" },
    fakeFetch
  );
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((c) => c.method), ["GET", "PUT"]);
  assert.match(calls[1].url, /repos\/acme\/data\/contents\/tasks\.json$/);

  const failed = await backupToGitHub(
    { rev: 1, tasks: [] },
    { GITHUB_TOKEN: "t", BACKUP_GITHUB_REPO: "acme/data" },
    async () => { throw new Error("offline"); }
  );
  assert.equal(failed.ok, false);

  assert.deepEqual(await backupToGitHub({ rev: 1, tasks: [] }, {}), { skipped: true });
});

test("non-object bodies are a 400, not a server error", async () => {
  const handler = createHandler({ openStore: () => fakeStore(), env, backup: noBackup });
  for (const method of ["POST", "PATCH", "DELETE"]) {
    for (const body of [null, "text", 5, [1]]) {
      assert.equal((await call(handler, method, body)).status, 400, `${method} ${JSON.stringify(body)}`);
    }
  }
  assert.throws(() => applyOp({ rev: 0, tasks: [{ id: "a" }] }, { type: "update", id: "a", patch: "x" }), HttpError);
  assert.throws(() => applyOp(emptyBoard(), { type: "create", task: null }), HttpError);
});

test("an oversized body is refused", async () => {
  const handler = createHandler({ openStore: () => fakeStore(), env, backup: noBackup });
  assert.equal((await call(handler, "POST", { title: "x".repeat(200 * 1024) })).status, 413);
});

test("the passcode never appears in a response", async () => {
  const handler = createHandler({ openStore: () => fakeStore(), env, backup: noBackup });
  for (const res of [await call(handler, "GET", undefined, { passcode: "wrong" }), await call(handler, "POST", null)]) {
    assert.ok(!(await res.text()).includes("open-sesame"));
  }
});

test("backup never replaces a newer stored revision with an older one", async () => {
  const stored = Buffer.from(JSON.stringify({ rev: 9, tasks: [] })).toString("base64");
  const methods = [];
  const fakeFetch = async (_url, init = {}) => {
    methods.push(init.method || "GET");
    return new Response(JSON.stringify({ sha: "s1", content: stored }), { status: 200 });
  };
  const result = await backupToGitHub({ rev: 5, tasks: [] }, { GITHUB_TOKEN: "t", BACKUP_GITHUB_REPO: "a/b" }, fakeFetch);
  assert.equal(result.ok, true);
  assert.deepEqual(methods, ["GET"]);
});

test("backup retries once after a write conflict and does not leak the token on failure", async () => {
  let puts = 0;
  const fakeFetch = async (_url, init = {}) => {
    if (!init.method) return new Response(JSON.stringify({ sha: "s" + puts, content: "" }), { status: 200 });
    puts++;
    return new Response("{}", { status: puts === 1 ? 409 : 200 });
  };
  const env2 = { GITHUB_TOKEN: "ghp_secret", BACKUP_GITHUB_REPO: "a/b" };
  assert.equal((await backupToGitHub({ rev: 1, tasks: [] }, env2, fakeFetch)).ok, true);
  assert.equal(puts, 2);

  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  const bad = await backupToGitHub({ rev: 1, tasks: [] }, env2, async () => new Response("{}", { status: 401 }));
  console.error = original;
  assert.equal(bad.ok, false);
  assert.ok(!JSON.stringify([bad, logged]).includes("ghp_secret"));
});

test("date is optional, validated, and stamped automatically when a task changes stage", () => {
  const day = (iso) => Date.parse(iso + "T12:00:00Z");
  const start = applyOp(emptyBoard(), { type: "create", task: { title: "One", date: "2026-03-01" } }, 1, () => "a").board;
  assert.equal(start.tasks[0].date, "2026-03-01");
  assert.equal(applyOp(emptyBoard(), { type: "create", task: { title: "No date" } }, 1, () => "b").task.date, "");

  for (const bad of ["tomorrow", "2026-13-01", "2026-02-30", 5, "2026-3-1"]) {
    assert.throws(() => applyOp(start, { type: "update", id: "a", patch: { date: bad } }), /Date must look like/, String(bad));
  }

  // Editing other fields leaves the date alone.
  assert.equal(applyOp(start, { type: "update", id: "a", patch: { title: "Two" } }, day("2026-04-01")).task.date, "2026-03-01");
  // Same stage again does not stamp.
  assert.equal(applyOp(start, { type: "update", id: "a", patch: { status: "todo" } }, day("2026-04-01")).task.date, "2026-03-01");
  // A move to another stage stamps the day of the move.
  assert.equal(applyOp(start, { type: "update", id: "a", patch: { status: "progress" } }, day("2026-04-01")).task.date, "2026-04-01");
  // A date sent together with the move wins, and "" clears it.
  assert.equal(applyOp(start, { type: "update", id: "a", patch: { status: "done", date: "2026-05-05" } }, day("2026-04-01")).task.date, "2026-05-05");
  assert.equal(applyOp(start, { type: "update", id: "a", patch: { date: "" } }).task.date, "");
});

test("deadline is optional, validated, and never changed by moving a task", () => {
  const start = applyOp(emptyBoard(), { type: "create", task: { title: "One", deadline: "2026-06-30" } }, 1, () => "a").board;
  assert.equal(start.tasks[0].deadline, "2026-06-30");
  assert.equal(applyOp(emptyBoard(), { type: "create", task: { title: "No deadline" } }, 1, () => "b").task.deadline, "");

  for (const bad of ["soon", "2026-02-30", "2026-13-01", 7]) {
    assert.throws(() => applyOp(start, { type: "update", id: "a", patch: { deadline: bad } }), /Date must look like/, String(bad));
  }

  // A move stamps the date but leaves the deadline alone.
  const moved = applyOp(start, { type: "update", id: "a", patch: { status: "done" } }, Date.parse("2026-04-01T12:00:00Z")).task;
  assert.equal(moved.date, "2026-04-01");
  assert.equal(moved.deadline, "2026-06-30");

  // It can be changed or cleared by hand.
  assert.equal(applyOp(start, { type: "update", id: "a", patch: { deadline: "2026-07-15" } }).task.deadline, "2026-07-15");
  assert.equal(applyOp(start, { type: "update", id: "a", patch: { deadline: "" } }).task.deadline, "");
});

test("deadline accepts the relaxed choice, which is never changed by a move and is exact-match only", () => {
  const start = applyOp(emptyBoard(), { type: "create", task: { title: "One", deadline: "relaxed" } }, 1, () => "a").board;
  assert.equal(start.tasks[0].deadline, "relaxed");
  const moved = applyOp(start, { type: "update", id: "a", patch: { status: "done" } }, Date.parse("2026-04-01T12:00:00Z")).task;
  assert.equal(moved.deadline, "relaxed");
  assert.equal(applyOp(start, { type: "update", id: "a", patch: { deadline: "2026-09-01" } }).task.deadline, "2026-09-01");
  for (const bad of ["Relaxed", "RELAXED", "relaxed ", "whenever"]) {
    assert.throws(() => applyOp(start, { type: "update", id: "a", patch: { deadline: bad } }), /Date must look like/, bad);
  }
});

test("a new task may ask for a position, and rejects a bad one", () => {
  assert.equal(applyOp(emptyBoard(), { type: "create", task: { title: "Copy", order: 42.5 } }, 1000, () => "a").task.order, 42.5);
  assert.equal(applyOp(emptyBoard(), { type: "create", task: { title: "Normal" } }, 1000, () => "b").task.order, 1000);
  assert.throws(() => applyOp(emptyBoard(), { type: "create", task: { title: "Bad", order: "first" } }), /Order must be a number/);
});
