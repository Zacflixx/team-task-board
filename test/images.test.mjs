import test from "node:test";
import assert from "node:assert/strict";
import { applyOp, emptyBoard } from "../netlify/lib/board.mjs";
import { createHandler } from "../netlify/functions/tasks.mjs";
import { sign, uploadPermission, validImageId, deleteImages, cloudinaryEnabled } from "../netlify/lib/cloudinary.mjs";

const env = {
  TEAM_PASSCODE: "open-sesame",
  CLOUDINARY_CLOUD_NAME: "demo",
  CLOUDINARY_API_KEY: "key123",
  CLOUDINARY_API_SECRET: "s3cret-value"
};
const img = (name) => ({
  id: `team-task-board/${name}`,
  url: `https://res.cloudinary.com/demo/image/upload/v1/team-task-board/${name}.jpg`
});
const noBackup = async () => ({ skipped: true });

function fakeStore() {
  let value = null, etag = null, n = 0;
  return {
    async getWithMetadata() { return value === null ? null : { data: JSON.parse(value), etag }; },
    async setJSON(_k, data, o = {}) {
      if (o.onlyIfNew && value !== null) return { modified: false };
      if (o.onlyIfMatch && o.onlyIfMatch !== etag) return { modified: false };
      value = JSON.stringify(data); etag = `e${++n}`; return { modified: true };
    }
  };
}

function setup(extraEnv = env) {
  const store = fakeStore();
  const removed = [];
  const handler = createHandler({
    openStore: () => store, env: extraEnv, backup: noBackup,
    removeImages: async (ids) => { removed.push(...ids); }
  });
  const call = (method, body, { path = "/api/tasks", passcode = "open-sesame", query = "" } = {}) =>
    handler(new Request(`https://example.test${path}${query}`, {
      method,
      headers: { "x-team-passcode": passcode, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    }));
  return { call, removed };
}

test("signing matches the example in Cloudinary's documentation", () => {
  const signature = sign(
    { eager: "w_400,h_300,c_pad|w_260,h_200,c_crop", public_id: "sample_image", timestamp: "1315060510" },
    "abcd"
  );
  assert.equal(signature, "bfd09f95f331f558cbd1320e67aa8d488770583e");
});

test("the upload permission is signed and never contains the secret", () => {
  const p = uploadPermission(env, 1_700_000_000_000);
  assert.equal(p.signature, sign({ allowed_formats: p.allowed_formats, folder: "team-task-board", timestamp: 1_700_000_000 }, env.CLOUDINARY_API_SECRET));
  assert.equal(p.uploadUrl, "https://api.cloudinary.com/v1_1/demo/image/upload");
  assert.ok(!JSON.stringify(p).includes(env.CLOUDINARY_API_SECRET));
  assert.equal(cloudinaryEnabled({}), false);
});

test("image ids must live in the configured folder", () => {
  assert.equal(validImageId("team-task-board/abc", env), true);
  for (const bad of ["abc", "other/abc", "team-task-board/../x", "team-task-board//x", "team-task-board/a b", 5, undefined]) {
    assert.equal(validImageId(bad, env), false, String(bad));
  }
});

test("board accepts up to 3 Cloudinary images and rejects anything else", () => {
  const ok = applyOp(emptyBoard(), { type: "create", task: { title: "T", images: [img("a"), img("b"), img("c")] } }, 1, () => "t");
  assert.equal(ok.task.images.length, 3);
  assert.deepEqual(applyOp(emptyBoard(), { type: "create", task: { title: "T" } }).task.images, []);
  const make = (images) => () => applyOp(emptyBoard(), { type: "create", task: { title: "T", images } });
  assert.throws(make([img("a"), img("b"), img("c"), img("d")]), /Up to 3/);
  assert.throws(make([img("a"), img("a")]), /twice/);
  assert.throws(make([{ id: "team-task-board/a", url: "https://evil.example/pixel.gif" }]), /not valid/);
  assert.throws(make([{ id: "team-task-board/a", url: "https://res.cloudinary.com/demo/image/upload/other.jpg" }]), /not valid/);
  assert.throws(make("nope"), /must be a list/);
  assert.throws(make([null]), /not valid/);
});

test("deleteImages signs each request, skips bad ids, and never throws or leaks the secret", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => { calls.push({ url, body: init.body.toString() }); return new Response("{}", { status: 200 }); };
  await deleteImages(["team-task-board/a", "elsewhere/b"], env, fakeFetch, 1_700_000_000_000);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/demo\/image\/destroy$/);
  const body = new URLSearchParams(calls[0].body);
  assert.equal(body.get("public_id"), "team-task-board/a");
  assert.equal(body.get("signature"), sign({ public_id: "team-task-board/a", timestamp: 1_700_000_000 }, env.CLOUDINARY_API_SECRET));
  assert.ok(!calls[0].body.includes(env.CLOUDINARY_API_SECRET));

  const logged = [];
  const original = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  const result = await deleteImages(["team-task-board/a"], env, async () => new Response("{}", { status: 500 }));
  console.error = original;
  assert.equal(result.ok, false);
  assert.ok(!logged.join(" ").includes(env.CLOUDINARY_API_SECRET));
  assert.deepEqual(await deleteImages(["team-task-board/a"], {}), { skipped: true });
});

test("/api/images needs the passcode and is switched off without Cloudinary settings", async () => {
  const on = setup();
  assert.equal((await on.call("POST", undefined, { path: "/api/images", passcode: "wrong" })).status, 401);
  const res = await on.call("POST", undefined, { path: "/api/images" });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes(env.CLOUDINARY_API_SECRET));
  assert.ok(JSON.parse(text).signature);

  const off = setup({ TEAM_PASSCODE: "open-sesame" });
  assert.equal((await off.call("POST", undefined, { path: "/api/images" })).status, 501);
  assert.equal((await off.call("POST", { title: "x", images: [img("a")] })).status, 400);
});

test("the board reports image support only when it is configured", async () => {
  const on = setup();
  assert.deepEqual((await (await on.call("GET")).json()).features, { images: true });
  const off = setup({ TEAM_PASSCODE: "open-sesame" });
  assert.equal((await (await off.call("GET")).json()).features, undefined);
});

test("attached images are validated against the folder, and detached ones are deleted", async () => {
  const { call, removed } = setup();
  assert.equal((await call("POST", { title: "x", images: [{ id: "other/a", url: "https://res.cloudinary.com/demo/other/a" }] })).status, 400);

  const created = await (await call("POST", { title: "With pics", images: [img("a"), img("b")] })).json();
  const id = created.task.id;
  assert.equal(created.task.images.length, 2);

  // Replacing the list removes b from Cloudinary but keeps a.
  const updated = await (await call("PATCH", { id, patch: { images: [img("a")] } })).json();
  assert.equal(updated.task.images.length, 1);
  assert.deepEqual(removed, ["team-task-board/b"]);

  // Editing something else deletes nothing.
  await call("PATCH", { id, patch: { title: "Renamed" } });
  assert.deepEqual(removed, ["team-task-board/b"]);

  // Deleting the task deletes its remaining images.
  await call("DELETE", { id });
  assert.deepEqual(removed, ["team-task-board/b", "team-task-board/a"]);
});

test("an uploaded-but-unsaved image can be removed, but one in use cannot", async () => {
  const { call, removed } = setup();
  await call("POST", { title: "Uses a", images: [img("a")] });
  const inUse = await call("DELETE", { id: "team-task-board/a" }, { path: "/api/images" });
  assert.equal(inUse.status, 409);
  assert.deepEqual(removed, []);

  const free = await call("DELETE", { id: "team-task-board/unused" }, { path: "/api/images" });
  assert.equal(free.status, 200);
  assert.deepEqual(removed, ["team-task-board/unused"]);
  assert.equal((await call("DELETE", { id: "not-ours/x" }, { path: "/api/images" })).status, 400);
});

test("an image shared by a duplicated task is only deleted once no task uses it", async () => {
  const { call, removed } = setup();
  const first = await (await call("POST", { title: "Original", images: [img("shared")] })).json();
  const copy = await (await call("POST", { title: "Original (copy)", images: [img("shared")] })).json();

  // Deleting one of the two must not remove the picture the other still uses.
  await call("DELETE", { id: first.task.id });
  assert.deepEqual(removed, []);
  const board = await (await call("GET")).json();
  assert.equal(board.tasks[0].images[0].id, "team-task-board/shared");

  // Deleting the last user finally removes it.
  await call("DELETE", { id: copy.task.id });
  assert.deepEqual(removed, ["team-task-board/shared"]);
});
