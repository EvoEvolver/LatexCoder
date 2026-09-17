import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";

export type LogFields = Record<string, unknown>;
export type Logger = {
  info(event: string, fields?: LogFields): void;
  error(event: string, error: unknown, fields?: LogFields): void;
};

export function createLogger(enabled = true): Logger {
  const write = (level: "info" | "error", event: string, fields: LogFields = {}): void => {
    if (!enabled) return;
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields });
    (level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    info: (event, fields) => write("info", event, fields),
    error: (event, error, fields) => write("error", event, {
      ...fields,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
    }),
  };
}

export function requestLogger(logger: Logger) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const requestId = request.header("x-request-id") || randomUUID();
    const startedAt = performance.now();
    response.setHeader("x-request-id", requestId);
    response.once("finish", () => logger.info("http.request", {
      requestId,
      method: request.method,
      path: request.path,
      status: response.statusCode,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    }));
    next();
  };
}
