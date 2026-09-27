/** Logger mínimo con timestamp + ámbito, usado en todo el backend para poder depurar el flujo completo */
type LogLevel = "info" | "warn" | "error" | "debug";

function write(level: LogLevel, scope: string, message: string, meta?: unknown): void {
  const prefix = `[${new Date().toISOString()}] [${scope}] [${level.toUpperCase()}]`;
  const consoleMethod = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (meta !== undefined) {
    consoleMethod(prefix, message, meta);
  } else {
    consoleMethod(prefix, message);
  }
}

export const logger = {
  info: (scope: string, message: string, meta?: unknown) => write("info", scope, message, meta),
  warn: (scope: string, message: string, meta?: unknown) => write("warn", scope, message, meta),
  error: (scope: string, message: string, meta?: unknown) => write("error", scope, message, meta),
  debug: (scope: string, message: string, meta?: unknown) => write("debug", scope, message, meta),
};
