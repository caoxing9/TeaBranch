import { describe, expect, test } from 'nsh/test'
import { commentableLines, findPRs, parsePR, parseReviewOutput, placeComments } from './prReview'

describe('findPRs', () => {
  test('finds every PR link once, in order', () => {
    const text = '看下 https://github.com/teableio/teable/pull/4012 和 https://www.github.com/a/b.c/pull/7/files，还有 https://github.com/teableio/teable/pull/4012'
    expect(findPRs(text)).toEqual([
      { owner: 'teableio', repo: 'teable', number: 4012, url: 'https://github.com/teableio/teable/pull/4012' },
      { owner: 'a', repo: 'b.c', number: 7, url: 'https://github.com/a/b.c/pull/7' },
    ])
  })

  test('ignores issues and other sites', () => {
    expect(findPRs('https://github.com/a/b/issues/3 https://gitlab.com/a/b/-/merge_requests/1')).toEqual([])
    expect(parsePR('nope')).toBeUndefined()
  })
})

describe('parseReviewOutput', () => {
  test('reads the JSON after the marker and keeps the body before it', () => {
    const text = `Looks right overall.\n\n- \`src/a.ts:12\` — off by one\n\nREVIEW_JSON\n\`\`\`json\n{"verdict":"changes_requested","summary":"有一处越界。","comments":[{"path":"src/a.ts","line":12,"body":"off by one"},{"path":"","line":3,"body":"x"},{"line":"4","path":"b.ts","body":"string line"}]}\n\`\`\``
    expect(parseReviewOutput(text)).toEqual({
      verdict: 'CHANGES_REQUESTED',
      summary: '有一处越界。',
      comments: [
        { path: 'src/a.ts', line: 12, body: 'off by one' },
        { path: 'b.ts', line: 4, body: 'string line' },
      ],
      body: 'Looks right overall.\n\n- `src/a.ts:12` — off by one',
    })
  })

  test('falls back to the VERDICT line', () => {
    const out = parseReviewOutput('Fine by me.\n\nNo tests touched though.\n\n**VERDICT: APPROVE**')
    expect(out.verdict).toBe('APPROVE')
    expect(out.comments).toEqual([])
    expect(out.body).toBe('Fine by me.\n\nNo tests touched though.')
    expect(out.summary).toBe('Fine by me.')
    expect(parseReviewOutput('meh').verdict).toBe('COMMENT')
  })

  test('takes the first paragraph as the summary when the JSON has none', () => {
    const out = parseReviewOutput('First.\n\nSecond.\nREVIEW_JSON {"verdict":"approve"}')
    expect(out.verdict).toBe('APPROVE')
    expect(out.summary).toBe('First.')
  })
})

describe('commentableLines', () => {
  const diff = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,5 @@ function f() {
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 return a
 }
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-x
-y
diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+hello
+world
\\ No newline at end of file
`
  test('numbers added and context lines on the new side', () => {
    const lines = commentableLines(diff)
    expect([...(lines.get('src/a.ts') ?? [])]).toEqual([10, 11, 12, 13, 14])
    expect(lines.has('gone.ts')).toBe(false)
    expect([...(lines.get('new.ts') ?? [])]).toEqual([1, 2])
  })

  test('places findings inline only on those lines', () => {
    const { inline, loose } = placeComments(
      [
        { path: 'src/a.ts', line: 11, body: 'a' },
        { path: 'src/a.ts', line: 11, body: 'a' },
        { path: 'src/a.ts', line: 40, body: 'b' },
        { path: 'other.ts', line: 1, body: 'c' },
      ],
      commentableLines(diff),
    )
    expect(inline).toEqual([{ path: 'src/a.ts', line: 11, body: 'a' }])
    expect(loose).toEqual([
      { path: 'src/a.ts', line: 40, body: 'b' },
      { path: 'other.ts', line: 1, body: 'c' },
    ])
  })
})
