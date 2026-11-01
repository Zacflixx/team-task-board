// Pure board logic: validation and the three operations (create, update, delete).
// No network and no storage here, so it can be unit tested on its own.

export const STATUSES = ["todo", "progress", "almost", "done", "live"];
export const LIMITS = { title: 140, notes: 1000, owner: 40, tasks: 5000, images: 3 };

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function emptyBoard() {
  return { rev: 0, tasks: [] };
}

function text(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// Optional calendar date as "YYYY-MM-DD"; "" means no date.
function optionalDate(value) {
  if (value === undefined || value === null || value === "") return "";
  let ok = false;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(value + "T00:00:00Z");
    // Reject impossible dates: the parse must be valid and round-trip to the same text.
    ok = !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }
  if (!ok) throw new HttpError(400, "Date must look like 2026-01-31.");
  return value;
}

// A deadline is a calendar date, "" (none), or "relaxed" ("Take Your Time!": no fixed date, never overdue).
function optionalDeadline(value) {
  return value === "relaxed" ? "relaxed" : optionalDate(value);
}

// Images are stored on Cloudinary; a task keeps only [{ id, url }]. Only Cloudinary links are accepted.
function optionalImages(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "Images must be a list.");
  if (value.length > LIMITS.images) throw new HttpError(400, `Up to ${LIMITS.images} images per task.`);
  const seen = new Set();
  return value.map((item) => {
    const ok =
      item && typeof item.id === "string" && typeof item.url === "string" &&
      /^[A-Za-z0-9_\-/]{1,200}$/.test(item.id) &&
      /^https:\/\/res\.cloudinary\.com\/\S{1,450}$/.test(item.url) &&
      item.url.includes(item.id);
    if (!ok) throw new HttpError(400, "That image is not valid.");
    if (seen.has(item.id)) throw new HttpError(400, "The same image was added twice.");
    seen.add(item.id);
    return { id: item.id, url: item.url };
  });
}

function requireObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  return value;
}

function requireStatus(value) {
  if (!STATUSES.includes(value)) throw new HttpError(400, "Unknown stage.");
  return value;
}

function requireOrder(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, "Order must be a number.");
  }
  return value;
}

/**
 * Apply one operation to a board and return { board, task }.
 * Never mutates the board it is given.
 *   op = { type: "create", task: { title, notes, owner, status } }
 *   op = { type: "update", id, patch: { title?, notes?, owner?, status?, order? } }
 *   op = { type: "delete", id }
 */
export function applyOp(board, op, now = Date.now(), makeId = () => crypto.randomUUID()) {
  const tasks = board.tasks.slice();

  if (op.type === "create") {
    if (tasks.length >= LIMITS.tasks) throw new HttpError(409, "The board is full. Delete finished tasks first.");
    const input = op.task === undefined ? {} : requireObject(op.task);
    const title = text(input.title, LIMITS.title);
    if (!title) throw new HttpError(400, "Give the task a title.");
    const task = {
      id: makeId(),
      title,
      notes: text(input.notes, LIMITS.notes),
      owner: text(input.owner, LIMITS.owner),
      date: optionalDate(input.date),
      deadline: optionalDeadline(input.deadline),
      images: optionalImages(input.images),
      status: input.status === undefined ? "todo" : requireStatus(input.status),
      order: now,
      createdAt: now,
      updatedAt: now
    };
    tasks.push(task);
    return { board: { rev: board.rev + 1, tasks }, task };
  }

  if (op.type === "update") {
    const index = tasks.findIndex((t) => t.id === op.id);
    if (index < 0) throw new HttpError(404, "That task no longer exists.");
    const patch = op.patch === undefined ? {} : requireObject(op.patch);
    const next = { ...tasks[index] };
    if ("title" in patch) {
      const title = text(patch.title, LIMITS.title);
      if (!title) throw new HttpError(400, "Give the task a title.");
      next.title = title;
    }
    if ("notes" in patch) next.notes = text(patch.notes, LIMITS.notes);
    if ("owner" in patch) next.owner = text(patch.owner, LIMITS.owner);
    if ("status" in patch) next.status = requireStatus(patch.status);
    if ("date" in patch) next.date = optionalDate(patch.date);
    // The deadline is only ever changed by hand; moving a task never touches it.
    if ("deadline" in patch) next.deadline = optionalDeadline(patch.deadline);
    if ("images" in patch) next.images = optionalImages(patch.images);
    // A move to another stage stamps today's date, unless the caller set a date itself.
    if (next.status !== tasks[index].status && !("date" in patch)) {
      next.date = new Date(now).toISOString().slice(0, 10);
    }
    if ("order" in patch) next.order = requireOrder(patch.order);
    next.updatedAt = now;
    tasks[index] = next;
    return { board: { rev: board.rev + 1, tasks }, task: next };
  }

  if (op.type === "delete") {
    const index = tasks.findIndex((t) => t.id === op.id);
    if (index < 0) throw new HttpError(404, "That task no longer exists.");
    const [removed] = tasks.splice(index, 1);
    return { board: { rev: board.rev + 1, tasks }, task: removed };
  }

  throw new HttpError(400, "Unknown operation.");
}
