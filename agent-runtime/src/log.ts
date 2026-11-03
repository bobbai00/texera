/**
 * A minimal structured logger: one JSON line per record on stderr.
 * Kept dependency-free so it can be replaced by an OpenTelemetry log bridge later.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(
  level: LogLevel = (process.env.TEXERA_LOG_LEVEL as LogLevel) ?? "info",
  base: Record<string, unknown> = {},
  sink: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Logger {
  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (order[lvl] < order[level]) return;
    sink(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...base, ...fields }));
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) => createLogger(level, { ...base, ...fields }, sink),
  };
}

/** A logger that records nothing; for tests. */
export const silentLogger: Logger = createLogger("error", {}, () => {});
