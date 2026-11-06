/** One line of JSON per event, on stdout: what the stack's other services write. */
export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(write: (line: string) => void = console.log): Logger {
  const at =
    (level: string) =>
    (message: string, fields: Record<string, unknown> = {}) =>
      write(JSON.stringify({ time: new Date().toISOString(), level, service: "live", message, ...fields }));
  return { info: at("info"), warn: at("warn"), error: at("error") };
}
