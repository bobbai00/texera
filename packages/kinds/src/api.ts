// Turning the generated client's `{data, error, response}` results into values or a typed
// error that carries the HTTP status, so callers can tell a conflict from a failure.

export class CatalogError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "CatalogError";
    this.status = status;
    this.code = code;
  }
}

interface Result<T> {
  data?: T;
  error?: unknown;
  response?: Response;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The data of a client call, or a CatalogError with the response status and the API's message. */
export async function unwrap<T>(call: Promise<Result<T>>): Promise<T> {
  const r = await call;
  const status = r.response?.status ?? 0;
  if (r.error !== undefined || (r.response && !r.response.ok)) {
    const e = r.error;
    const message = isRecord(e) && typeof e.message === "string" ? e.message : typeof e === "string" ? e : (r.response?.statusText ?? "");
    const code = isRecord(e) && typeof e.code === "string" ? e.code : undefined;
    throw new CatalogError(status, message || `HTTP ${status}`, code);
  }
  return r.data as T;
}
