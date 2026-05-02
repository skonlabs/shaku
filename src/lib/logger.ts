// Minimal logger that silences info/warn in production while always letting
// errors through. Use this instead of bare console.* in server code so Worker
// logs stay quiet in prod but rich in dev.
//
// Usage:
//   import { logger } from "@/lib/logger";
//   logger.warn("[scope] something fishy", details);
//   logger.error("[scope] failed", err);

const isProd = process.env.NODE_ENV === "production";

export const logger = {
  log: (...args: unknown[]) => {
    if (!isProd) console.log(...args);
  },
  info: (...args: unknown[]) => {
    if (!isProd) console.info(...args);
  },
  warn: (...args: unknown[]) => {
    if (!isProd) console.warn(...args);
  },
  // Errors always log — they're needed for production debugging.
  error: (...args: unknown[]) => {
    console.error(...args);
  },
};
