/** Diagnostic logging to the native log, `[TeaBranch] …` like the Swift, Rust and Electron builds. */
export const log = {
  info: (message: string): void => {
    console.info(`[TeaBranch] ${message}`)
  },
  warn: (message: string): void => {
    console.warn(`[TeaBranch] warning: ${message}`)
  },
}

export class TeaBranchError extends Error {}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
