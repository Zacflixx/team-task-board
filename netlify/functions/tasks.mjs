// The whole backend: one Netlify Function at /api/tasks.
//   GET    /api/tasks?rev=N   -> the board, or { unchanged: true } if rev N is still current
//   POST   /api/tasks         -> create   body: { title, notes, owner, status }
//   PATCH  /api/tasks         -> update   body: { id, patch: { ... } }
//   DELETE /api/tasks         -> delete   body: { id }
// Every request needs the team passcode in the "x-team-passcode" header.
// The board is stored as one JSON document in Netlify Blobs and written with
// ETag checks, so two people saving at the same moment cannot overwrite each other.

import { createHash, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { applyOp, emptyBoard, HttpError } from "../lib/board.mjs";
import { backupToGitHub } from "../lib/backup.mjs";

const STORE_NAME = "team-task-board";
const KEY = "board";
const MAX_BODY = 100 * 1024;
const MAX_ATTEMPTS = 6;

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest();
}

function passcodeMatches(given, expected) {
  return timingSafeEqual(digest(given || ""), digest(expected));
}

async function readJson(req) {
  const raw = await req.text();
  if (raw.length > MAX_BODY) throw new HttpError(413, "Request is too large.");
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  return body;
}

export function createHandler({
  openStore = () => getStore({ name: STORE_NAME, consistency: "strong" }),
  env = process.env,
  backup = backupToGitHub
} = {}) {
  return async function handler(req) {
    try {
      if (!env.TEAM_PASSCODE) {
        return reply(500, { error: "TEAM_PASSCODE is not set on the server." });
      }
      if (!passcodeMatches(req.headers.get("x-team-passcode"), env.TEAM_PASSCODE)) {
        return reply(401, { error: "Wrong passcode." });
      }

      const store = openStore();

      if (req.method === "GET") {
        const current = await store.getWithMetadata(KEY, { type: "json" });
        const board = current ? current.data : emptyBoard();
        const since = Number(new URL(req.url).searchParams.get("rev"));
        if (Number.isFinite(since) && since === board.rev && current) {
          return reply(200, { rev: board.rev, unchanged: true });
        }
        return reply(200, board);
      }

      let op;
      if (req.method === "POST") {
        const body = await readJson(req);
        op = { type: "create", task: body };
      } else if (req.method === "PATCH") {
        const body = await readJson(req);
        op = { type: "update", id: body.id, patch: body.patch };
      } else if (req.method === "DELETE") {
        const body = await readJson(req);
        op = { type: "delete", id: body.id };
      } else {
        return reply(405, { error: "Method not allowed." });
      }

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const current = await store.getWithMetadata(KEY, { type: "json" });
        const board = current ? current.data : emptyBoard();
        const { board: next, task } = applyOp(board, op);
        const result = await store.setJSON(
          KEY,
          next,
          current ? { onlyIfMatch: current.etag } : { onlyIfNew: true }
        );
        if (result.modified) {
          await backup(next, env);
          return reply(200, { ...next, task });
        }
        // Someone else saved first. Read again and re-apply.
      }
      return reply(503, { error: "The board is busy. Try again in a moment." });
    } catch (error) {
      if (error instanceof HttpError) return reply(error.status, { error: error.message });
      console.error("Unexpected error:", error);
      return reply(500, { error: "Something went wrong on the server." });
    }
  };
}

export default createHandler();

export const config = { path: "/api/tasks" };
