/**
 * Node's synchronous `fs`, the subset the services use, over the Rust base's `Fs`. A `#[module]`
 * call runs inside the TSX call, so these really are synchronous; errors come back as thrown
 * `Error`s whose message starts with Node's code (`ENOENT: …`), as the callers expect.
 */
import { Fs } from 'teabranch/native'

export interface Stats {
  size: number
  mtimeMs: number
  birthtimeMs: number
  mode: number
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export interface Dirent {
  name: string
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

const stats = (s: ReturnType<typeof Fs.stat>): Stats => ({
  size: s.size,
  mtimeMs: s.mtimeMs,
  birthtimeMs: s.birthtimeMs ?? s.mtimeMs,
  mode: s.mode,
  isFile: () => s.isFile,
  isDirectory: () => s.isDirectory,
  isSymbolicLink: () => s.isSymlink,
})

export const existsSync = (path: string): boolean => Fs.exists(path)

export function mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): void {
  Fs.mkdir(path, options?.recursive ?? false)
  if (options?.mode !== undefined) Fs.chmod(path, options.mode)
}

/** The file's text. Binary content: `readFileBase64Sync`. */
export const readFileSync = (path: string, _encoding?: 'utf8' | 'utf-8' | { encoding?: string }): string => Fs.readFile(path)

/** The file's bytes as base64, for images and the like. */
export const readFileBase64Sync = (path: string): string => Fs.readFileBase64(path)

export function writeFileSync(path: string, data: string | Uint8Array, options?: { mode?: number }): void {
  if (typeof data === 'string') Fs.writeFile(path, data, options?.mode ?? null)
  else Fs.writeFileBase64(path, toBase64(data), options?.mode ?? null)
}

/** Writes base64-encoded bytes. */
export const writeFileBase64Sync = (path: string, base64: string, options?: { mode?: number }): void =>
  Fs.writeFileBase64(path, base64, options?.mode ?? null)

export const appendFileSync = (path: string, data: string): void => Fs.appendFile(path, data)

export const rmSync = (path: string, options?: { recursive?: boolean; force?: boolean }): void =>
  Fs.rm(path, options?.recursive ?? false, options?.force ?? false)

export const unlinkSync = (path: string): void => Fs.rm(path, false, false)

export const renameSync = (from: string, to: string): void => Fs.rename(from, to)
export const copyFileSync = (from: string, to: string): void => Fs.copyFile(from, to)
export const chmodSync = (path: string, mode: number): void => Fs.chmod(path, mode)
export const realpathSync = (path: string): string => Fs.realpath(path)
export const readlinkSync = (path: string): string => Fs.readlink(path)
export const symlinkSync = (target: string, path: string): void => Fs.symlink(target, path)
export const mkdtempSync = (prefix: string): string => Fs.mkdtemp(prefix)

export function readdirSync(path: string): string[]
export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[]
export function readdirSync(path: string, options?: { withFileTypes?: boolean }): string[] | Dirent[] {
  const entries = Fs.readdir(path)
  if (!options?.withFileTypes) return entries.map((e) => e.name)
  return entries.map((e) => ({
    name: e.name,
    isFile: () => e.isFile,
    isDirectory: () => e.isDirectory,
    isSymbolicLink: () => e.isSymlink,
  }))
}

export const statSync = (path: string): Stats => stats(Fs.stat(path))
export const lstatSync = (path: string): Stats => stats(Fs.lstat(path))

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
