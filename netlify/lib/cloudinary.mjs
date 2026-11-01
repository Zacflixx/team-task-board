// Optional image support through Cloudinary. Images never pass through our function:
// the browser asks for a signed upload permission, then uploads straight to Cloudinary.
// The task only stores { id, url } for each image.
//
// Environment variables (Netlify site settings, never in the code):
//   CLOUDINARY_CLOUD_NAME   your cloud name
//   CLOUDINARY_API_KEY      API key
//   CLOUDINARY_API_SECRET   API secret (stays on the server, never sent to the page)
//   CLOUDINARY_FOLDER       optional, defaults to "team-task-board"

import { createHash } from "node:crypto";

const API = "https://api.cloudinary.com/v1_1";
const ALLOWED_FORMATS = "jpg,png,webp,gif";

export function cloudinaryEnabled(env) {
  return Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
}

export function imageFolder(env) {
  return (env.CLOUDINARY_FOLDER || "team-task-board").replace(/^\/+|\/+$/g, "");
}

// Cloudinary signs the parameters sorted by name, joined as "a=1&b=2", with the secret appended.
export function sign(params, secret) {
  const text = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createHash("sha1").update(text + secret).digest("hex");
}

// What the browser needs to upload one image straight to Cloudinary.
export function uploadPermission(env, now = Date.now()) {
  const params = {
    allowed_formats: ALLOWED_FORMATS,
    folder: imageFolder(env),
    timestamp: Math.floor(now / 1000)
  };
  return {
    uploadUrl: `${API}/${env.CLOUDINARY_CLOUD_NAME}/image/upload`,
    apiKey: env.CLOUDINARY_API_KEY,
    signature: sign(params, env.CLOUDINARY_API_SECRET),
    ...params
  };
}

// An image id must live in our folder and look like a plain Cloudinary public id.
export function validImageId(id, env) {
  return (
    typeof id === "string" &&
    id.length <= 200 &&
    id.startsWith(imageFolder(env) + "/") &&
    /^[A-Za-z0-9_\-/]+$/.test(id) &&
    !id.includes("//")
  );
}

// Delete images from Cloudinary. Never throws: a failed delete only leaves an unused file behind.
export async function deleteImages(ids, env, fetchFn = fetch, now = Date.now()) {
  if (!cloudinaryEnabled(env) || !ids.length) return { skipped: true };
  const results = await Promise.allSettled(
    ids.filter((id) => validImageId(id, env)).map(async (id) => {
      const params = { public_id: id, timestamp: Math.floor(now / 1000) };
      const body = new URLSearchParams({
        ...params,
        api_key: env.CLOUDINARY_API_KEY,
        signature: sign(params, env.CLOUDINARY_API_SECRET)
      });
      const res = await fetchFn(`${API}/${env.CLOUDINARY_CLOUD_NAME}/image/destroy`, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(4000)
      });
      if (!res.ok) throw new Error(`Cloudinary delete failed (${res.status})`);
    })
  );
  const failed = results.filter((r) => r.status === "rejected");
  failed.forEach((r) => console.error("Cloudinary cleanup:", r.reason && r.reason.message));
  return { ok: failed.length === 0 };
}
