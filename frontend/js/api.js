// Thin fetch() wrapper for the Flask API.
// Auth rides on the HttpOnly session cookie set at login - nothing is kept in
// browser storage. The X-Requested-With header is required by the server for
// cookie-authenticated writes (CSRF protection).

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

// In-flight request count, broadcast for the global activity bar.
let inFlight = 0;
const announce = () => window.dispatchEvent(new CustomEvent("api:activity", { detail: inFlight }));

export async function api(path, options = {}) {
  inFlight += 1; announce();
  try { return await request(path, options); }
  finally { inFlight -= 1; announce(); }
}

async function request(path, { method = "GET", body, query } = {}) {
  const url = new URL("/api" + path, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
    }
  }

  const headers = { Accept: "application/json", "X-Requested-With": "fetch" };
  // FormData (file uploads) sets its own multipart Content-Type.
  const isForm = body instanceof FormData;
  if (body !== undefined && !isForm) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Cannot reach the server. Check that the Flask app is running.", 0);
  }

  let data = null;
  try { data = await response.json(); } catch { /* empty or non-JSON body */ }

  if (!response.ok) {
    let message = (data && data.error) || `Request failed (${response.status})`;
    if (response.status >= 500 && message === "Internal server error") {
      message = "The server hit an unexpected error. Please try again; if it keeps happening, check the server log.";
    }
    // Session expired / password changed / logged out elsewhere / account deactivated.
    const deactivated = response.status === 403 && /deactivated/i.test(message);
    if ((response.status === 401 || deactivated) && path !== "/auth/login") onUnauthorized(message);
    throw new ApiError(message, response.status, data && data.details);
  }
  return data;
}
