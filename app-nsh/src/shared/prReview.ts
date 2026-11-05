/**
 * Reviewing a pull request someone sent in a chat — the pure parts: finding PR links in a message,
 * reading the reviewer's structured verdict, and placing its inline findings on the lines GitHub lets
 * a review comment on. No Node, no Electron: unit-tested directly.
 */

export interface PRRef {
  owner: string
  repo: string
  number: number
  /** The canonical `https://github.com/owner/repo/pull/N`. */
  url: string
}

const PR_URL = /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g

/** Every GitHub PR link in a text, in order, each once. */
export function findPRs(text: string): PRRef[] {
  const found = new Map<string, PRRef>()
  for (const match of text.matchAll(PR_URL)) {
    const url = `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`
    found.set(url, { owner: match[1], repo: match[2], number: Number(match[3]), url })
  }
  return [...found.values()]
}

export const parsePR = (url: string): PRRef | undefined => findPRs(url)[0]

/** What a review on GitHub can be. */
export type ReviewVerdict = 'APPROVE' | 'CHANGES_REQUESTED' | 'COMMENT'

export interface ReviewComment {
  path: string
  /** A line of the new file. */
  line: number
  body: string
}

export interface ReviewOutput {
  verdict: ReviewVerdict
  /** A few sentences for the chat. */
  summary: string
  /** Findings tied to a line of the diff. */
  comments: ReviewComment[]
  /** The review as GitHub gets it: what the reviewer wrote before the JSON. */
  body: string
}

/** The line the reviewer ends with, before its JSON object. */
export const REVIEW_MARKER = 'REVIEW_JSON'

const asVerdict = (value: unknown): ReviewVerdict => {
  const text = String(value ?? '')
    .toUpperCase()
    .replace(/[\s-]+/g, '_')
  if (text.startsWith('APPROVE')) return 'APPROVE'
  if (text === 'CHANGES_REQUESTED' || text === 'REQUEST_CHANGES') return 'CHANGES_REQUESTED'
  return 'COMMENT'
}

const asComment = (value: unknown): ReviewComment | undefined => {
  const raw = value as { path?: unknown; line?: unknown; body?: unknown }
  const path = typeof raw?.path === 'string' ? raw.path.trim().replace(/^\.\//, '') : ''
  const line = Number(raw?.line)
  const body = typeof raw?.body === 'string' ? raw.body.trim() : ''
  return path && body && Number.isInteger(line) && line > 0 ? { path, line, body } : undefined
}

/** The first `{…}` in a text as JSON, fences and all ignored; undefined when it doesn't parse. */
function extractJSON(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const firstParagraph = (text: string): string => text.split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ').trim() ?? ''

/**
 * The reviewer ends with `REVIEW_JSON` and a JSON object. Without one (a reviewer that ignored the
 * protocol) the VERDICT line decides, and the whole text is the body.
 */
export function parseReviewOutput(text: string): ReviewOutput {
  const at = text.lastIndexOf(REVIEW_MARKER)
  if (at >= 0) {
    const json = extractJSON(text.slice(at + REVIEW_MARKER.length))
    if (json) {
      // A fence the reviewer opened for the JSON belongs to it, not to the body.
      const body = text
        .slice(0, at)
        .replace(/```(?:json)?\s*$/, '')
        .trim()
      const comments = Array.isArray(json.comments)
        ? json.comments.map(asComment).filter((comment): comment is ReviewComment => !!comment)
        : []
      const summary = typeof json.summary === 'string' ? json.summary.trim() : ''
      return { verdict: asVerdict(json.verdict), summary: summary || firstParagraph(body), comments, body }
    }
  }
  const verdict: ReviewVerdict = /VERDICT:\s*APPROVE/i.test(text)
    ? 'APPROVE'
    : /VERDICT:\s*CHANGES_REQUESTED/i.test(text)
      ? 'CHANGES_REQUESTED'
      : 'COMMENT'
  const body = text.replace(/\n?[`*\s]*VERDICT:[^\n]*$/i, '').trim()
  return { verdict, summary: firstParagraph(body), comments: [], body }
}

/**
 * The lines of each file a review may comment on, from a unified diff: GitHub takes a comment on any
 * line of a hunk on the new side — added and context lines, by their new-file numbers.
 */
export function commentableLines(diff: string): Map<string, Set<number>> {
  const files = new Map<string, Set<number>>()
  let path: string | undefined
  let line = 0
  let inHunk = false
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      path = undefined
      inHunk = false
    } else if (raw.startsWith('+++ ')) {
      const name = raw.slice(4).trim()
      path = name === '/dev/null' ? undefined : name.replace(/^b\//, '')
    } else if (raw.startsWith('@@ ')) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      line = match ? Number(match[1]) : 0
      inHunk = !!match
    } else if (inHunk && path) {
      if (raw.startsWith('+') || raw.startsWith(' ')) {
        if (!files.has(path)) files.set(path, new Set())
        files.get(path)!.add(line)
        line += 1
      } else if (raw.startsWith('-') || raw.startsWith('\\')) {
        // A removed line, or "No newline at end of file": the new side doesn't move.
      } else {
        inHunk = false
      }
    }
  }
  return files
}

/** The findings GitHub will take inline, and those that have to go in the body instead. */
export function placeComments(comments: ReviewComment[], lines: Map<string, Set<number>>): { inline: ReviewComment[]; loose: ReviewComment[] } {
  const inline: ReviewComment[] = []
  const loose: ReviewComment[] = []
  const seen = new Set<string>()
  for (const comment of comments) {
    const key = `${comment.path}:${comment.line}:${comment.body}`
    if (seen.has(key)) continue
    seen.add(key)
    if (lines.get(comment.path)?.has(comment.line)) inline.push(comment)
    else loose.push(comment)
  }
  return { inline, loose }
}
