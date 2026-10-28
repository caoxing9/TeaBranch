import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import type { Issue, IssueComment } from '@shared/types'
import { httpFetch } from '../core/http'
import { log } from '../core/log'
import { configDirectory, loadTeableConfig } from '../core/settingsStore'
import * as teable from './teable'
import { accessToken } from './teableAuth'

/** Files bigger than this are listed for the agent but not downloaded. */
const maxDownloadBytes = 25 * 1024 * 1024

export interface IssueFile {
  name: string
  mimetype: string
  /** Absolute path, when it was downloaded. */
  path?: string
  /** Why it wasn't, when it wasn't. */
  skipped?: string
}

export interface IssueContext {
  /** Where the files live — outside the worktree, so nothing gets committed by accident. */
  dir: string
  files: IssueFile[]
  comments: IssueComment[]
}

export const contextDir = (recordId: string): string => join(configDirectory, 'issue-files', recordId)

/** Files the user attached to messages, kept apart so re-reading the issue doesn't wipe them. */
export const uploadsDir = (recordId: string): string => join(configDirectory, 'issue-uploads', recordId)

const imageTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/** An upload as a data URL, for the transcript's thumbnail. Only images, only from the uploads folder. */
export function readUpload(path: string): string | null {
  const root = join(configDirectory, 'issue-uploads') + sep
  const full = resolve(path)
  const type = imageTypes[extname(full).toLowerCase()]
  if (!full.startsWith(root) || !type) return null
  try {
    return `data:${type};base64,${readFileSync(full).toString('base64')}`
  } catch {
    return null
  }
}

/** Save one upload under a name that doesn't collide; returns its path. */
export function saveUpload(recordId: string, name: string, bytes: Buffer): string {
  const dir = uploadsDir(recordId)
  mkdirSync(dir, { recursive: true })
  const safe = name.replace(/[/\\:]/g, '_') || 'file'
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const path = join(dir, `${stamp}-${safe}`)
  writeFileSync(path, bytes)
  return path
}

/**
 * Everything about an issue that isn't a text cell: its attachments (screenshots, recordings,
 * exports) downloaded where the agent can open them, and its comment thread — which is often where
 * the reproduction steps actually are. Best effort: a failure here leaves the agent with less
 * context, never without a run.
 */
export async function prepareIssueContext(issue: Issue): Promise<IssueContext> {
  const dir = contextDir(issue.id)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const context: IssueContext = { dir, files: [], comments: [] }

  const token = await accessToken()
  if (!token) return context
  const config = loadTeableConfig()
  const used = new Set<string>()
  const uniqueName = (name: string): string => {
    const base = name.replace(/[/\\:]/g, '_') || 'file'
    let candidate = base
    for (let n = 2; used.has(candidate); n++) candidate = `${base.replace(extname(base), '')}-${n}${extname(base)}`
    used.add(candidate)
    return candidate
  }

  try {
    const fields = await teable.fields(config, token)
    const attachmentFields = fields.filter(teable.isAttachmentField).map((field) => field.name)
    for (const attachment of await teable.recordAttachments(config, token, issue.id, attachmentFields)) {
      context.files.push(await download(dir, uniqueName(attachment.name), attachment.mimetype, attachment.url, attachment.size))
    }
  } catch (error) {
    log.warn(`attachments for ${issue.key}: ${String(error)}`)
  }

  try {
    context.comments = await teable.comments(config, token, issue.id)
    let index = 0
    for (const comment of context.comments) {
      for (const url of comment.images) {
        index += 1
        const extension = extname(new URL(url).pathname) || '.png'
        context.files.push(await download(dir, uniqueName(`comment-image-${index}${extension}`), 'image/*', url))
      }
    }
  } catch (error) {
    log.warn(`comments for ${issue.key}: ${String(error)}`)
  }

  return context
}

async function download(dir: string, name: string, mimetype: string, url?: string, size = 0): Promise<IssueFile> {
  if (!url) return { name, mimetype, skipped: 'no download URL' }
  if (size > maxDownloadBytes) return { name, mimetype, skipped: `too large (${Math.round(size / 1048576)} MB)` }
  try {
    const response = await httpFetch(url)
    if (!response.ok) return { name, mimetype, skipped: `download failed (${response.status})` }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > maxDownloadBytes) return { name, mimetype, skipped: 'too large' }
    const path = join(dir, name)
    writeFileSync(path, bytes)
    return { name, mimetype, path }
  } catch (error) {
    return { name, mimetype, skipped: String((error as Error).message) }
  }
}

/** The context as prompt text: comments in order, then files with where to find them. */
export function contextPrompt(context: IssueContext): string {
  const parts: string[] = []
  if (context.comments.length) {
    parts.push(
      '<comments>',
      ...context.comments.map(
        (comment) =>
          `- ${comment.author.name} (${new Date(comment.createdTime).toISOString().slice(0, 16).replace('T', ' ')}): ${comment.text}${comment.images.length ? ` [${comment.images.length} image(s), downloaded below]` : ''}`,
      ),
      '</comments>',
    )
  }
  if (context.files.length) {
    parts.push(
      '<attachments>',
      ...context.files.map((file) =>
        file.path
          ? `- ${file.name} (${file.mimetype}): ${file.path}`
          : `- ${file.name} (${file.mimetype}): not downloaded — ${file.skipped}`,
      ),
      '</attachments>',
      'Open the image attachments with the Read tool before changing code — they usually show the bug.',
    )
  }
  return parts.join('\n')
}
