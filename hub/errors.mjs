// Shared HTTP error type (own module so hub.mjs and the workflow engine can both import it without a cycle).
export class HttpError extends Error {
  /** `extra` is merged into the JSON error body, e.g. { issues: [...] } for a graph that failed validation. */
  constructor(status, message, extra = undefined) { super(message); this.status = status; this.extra = extra; }
}
