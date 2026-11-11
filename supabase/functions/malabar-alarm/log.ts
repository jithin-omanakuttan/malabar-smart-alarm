/** Minimal structured logger. Callers must never pass secrets. */

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  info: (m) => console.log(`[malabar] INFO ${m}`),
  warn: (m) => console.warn(`[malabar] WARN ${m}`),
  error: (m) => console.error(`[malabar] ERROR ${m}`),
};

/** Collects messages in memory (used by tests). */
export class MemoryLogger implements Logger {
  readonly lines: string[] = [];
  info(m: string) {
    this.lines.push(`INFO ${m}`);
  }
  warn(m: string) {
    this.lines.push(`WARN ${m}`);
  }
  error(m: string) {
    this.lines.push(`ERROR ${m}`);
  }
}
