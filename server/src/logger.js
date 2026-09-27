import pino from 'pino';
import { requestContextStore } from './request-context.js';

/**
 * Create a structured JSON logger using pino.
 * 
 * Log levels: trace, debug, info, warn, error, fatal
 * Default level: info
 * 
 * Controlled by LOG_LEVEL env var.
 */
function createLogger() {
  const level = process.env.LOG_LEVEL?.toLowerCase() || 'info';
  
  return pino({
    level,
    formatters: {
      level: (label) => {
        return { level: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    base: undefined, // Remove default pid/hostname
    mixin() {
      // Inject requestId and correlationId (#946) from the request context
      const store = requestContextStore.getStore();
      if (!store) return {};
      const fields = {};
      if (store.requestId) fields.requestId = store.requestId;
      if (store.correlationId) fields.correlationId = store.correlationId;
      return fields;
    },
  });
}

export const logger = createLogger();

/**
 * Create a child logger with additional context fields.
 * 
 * @param {object} bindings - Context fields to include in all logs
 * @returns {pino.Logger} Child logger instance
 */
export function createChildLogger(bindings) {
  return logger.child(bindings);
}
