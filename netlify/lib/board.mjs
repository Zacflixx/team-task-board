// Pure board logic: validation and the three operations (create, update, delete).
// No network and no storage here, so it can be unit tested on its own.

export const STATUSES = ["todo", "progress", "almost", "done", "live"];
export const LIMITS = { title: 140, notes: 1000, owner: 40, tasks: 5000 };

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
