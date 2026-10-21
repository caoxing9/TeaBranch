/** Diagnostic logging to stderr, `[TeaBranch] …` like the Swift and Rust builds before it. */
export const log = {
  info: (message: string): void => {
    process.stderr.write(`[TeaBranch] ${message}\n`)
  },
  warn: (message: string): void => {
    process.stderr.write(`[TeaBranch] warning: ${message}\n`)
  },
}

export class TeaBranchError extends Error {}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
