import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '@shared/i18n'
import type { Issue, ReviewRecord } from '@shared/types'
import {
  defaultPrompts,
  fillTemplate,
  fixAfterTriagePrompt,
  fixPrompt,
  type PromptTarget,
  reviewFeedbackPrompt,
  reviewPrompt,
  triagePrompt,
} from './prompts'

const issue: Issue = {
  id: 'rec1',
  key: 'T42',
  title: 'Grid crashes',
  body: 'It crashes',
  record: { id: 'rec1', fields: { Title: 'Grid crashes', Body: 'It crashes on scroll', Empty: '' } },
}

const target = (custom?: PromptTarget['custom']): PromptTarget => ({
  issue,
  link: 'https://teable.test/r/rec1',
  branch: 'fix/T42',
  base: 'develop',
  custom,
})

const review: ReviewRecord = { engine: 'codex', model: 'gpt-x', text: 'Line 3 is wrong.', approved: false, round: 2, at: 0 }

const ISSUE = '<issue id="T42" link="https://teable.test/r/rec1">\nBody: It crashes on scroll\nTitle: Grid crashes\n</issue>'

afterEach(() => setLocale('zh'))

describe('default prompts', () => {
  it('triage: issue, context and worktree, then the steps, then the TRIAGE protocol', () => {
    setLocale('zh')
    const prompt = triagePrompt(target(), '<comments>\nhi\n</comments>')
    expect(
      prompt.startsWith(
        `${ISSUE}\n\n<comments>\nhi\n</comments>\n\nYou are in a dedicated git worktree on branch \`fix/T42\`, cut from the latest origin/develop.`,
      ),
    ).toBe(true)
    expect(prompt).toContain('Before anyone fixes this Teable issue, verify it. Do not fix anything yet.')
    expect(prompt).toContain('`git log origin/develop` (grep for T42 and the key terms)')
    expect(prompt).toContain('Report in Chinese: what you checked')
    expect(prompt.endsWith("TRIAGE: NEEDS_INFO — the report isn't enough to tell; say exactly what's missing")).toBe(true)
    expect(prompt).not.toMatch(/\{(key|link|branch|base|round|language)\}/)
  })

  it('reports in the interface language', () => {
    setLocale('en')
    expect(triagePrompt(target())).toContain('Report in English:')
    expect(reviewPrompt(target(), 1)).toContain('Be concise, in English.')
  })

  it('fix: the six steps, filled in', () => {
    const prompt = fixPrompt(target())
    expect(
      prompt.startsWith(`${ISSUE}\n\nYou are in a dedicated git worktree on branch \`fix/T42\`, cut from origin/develop.\n\nFix this bug`),
    ).toBe(true)
    expect(prompt).toContain('3. Commit: `fix: <summary> (T42)`.')
    expect(prompt).toContain('4. `git push -u origin fix/T42`')
    expect(prompt).toContain('`gh pr create --base develop --head fix/T42 --title "fix: <summary> [T42]"`')
    expect(prompt.endsWith('6. Finish with a short summary and the PR URL.')).toBe(true)
  })

  it('fix after the check is unchanged', () => {
    const prompt = fixAfterTriagePrompt(target())
    expect(prompt).toBe(`Your verification confirmed the bug. Now fix it.

1. Start from what you found. If you wrote a reproducing test, it is the regression test: it must fail before your fix and pass after.
2. Make the smallest correct fix. Add or update a test where the area has tests, and run the relevant tests and type checks.
3. Commit: \`fix: <summary> (T42)\`.
4. \`git push -u origin fix/T42\`
5. Open the PR: \`gh pr create --base develop --head fix/T42 --title "fix: <summary> [T42]"\` with a body containing: the issue id T42 and its link, root cause, the fix, and how it was tested. Write the PR in the issue's language.
6. Finish with a short summary and the PR URL.`)
    expect(fixAfterTriagePrompt(target(), true).startsWith('The user has read your verification and wants this fixed anyway.')).toBe(true)
  })

  it('review: the diff, the issue, the checks, then the VERDICT protocol', () => {
    const prompt = reviewPrompt(target(), 3)
    expect(prompt).toContain('review `git diff origin/develop...HEAD` (run `git fetch origin develop` first if needed)')
    expect(prompt).toContain(ISSUE)
    expect(prompt).toContain('(review round 3)')
    expect(prompt.endsWith('`VERDICT: CHANGES_REQUESTED` otherwise.')).toBe(true)
  })

  it('review feedback is unchanged', () => {
    expect(reviewFeedbackPrompt(target(), review, 'Codex CLI')).toBe(`A code reviewer (Codex CLI, gpt-x) left this review on your PR:

<review>
Line 3 is wrong.
</review>

Address the findings you agree with; for any you judge wrong, say why instead of changing code. Run the relevant tests, commit, and push to the same branch — the PR updates itself. Finish with a short summary of what changed.`)
  })

  it('exposes the editable templates with placeholders unfilled', () => {
    const defaults = defaultPrompts()
    expect(Object.keys(defaults).sort()).toEqual(['fix', 'review', 'reviewFeedback', 'triage'])
    expect(defaults.triage).toContain('{language}')
    expect(defaults.fix).toContain('{branch}')
    expect(defaults.triage).not.toContain('TRIAGE:')
    expect(defaults.review).not.toContain('VERDICT:')
  })
})

describe('custom prompts', () => {
  it('replace the instructions but keep the issue and the TRIAGE protocol', () => {
    const prompt = triagePrompt(
      target({ triage: 'Check {key} on {branch} against {base}. Answer in {language}. {unknown}' }),
      '<comments/>',
    )
    expect(prompt).toContain(ISSUE)
    expect(prompt).toContain('<comments/>')
    expect(prompt).toContain('Check T42 on fix/T42 against develop. Answer in Chinese. {unknown}')
    expect(prompt).not.toContain('Before anyone fixes')
    expect(prompt).toContain('TRIAGE: BUG')
    expect(prompt).toContain('TRIAGE: NEEDS_INFO')
  })

  it('keep the VERDICT protocol on reviews', () => {
    const prompt = reviewPrompt(target({ review: 'Round {round}: look hard at {link}.' }), 2)
    expect(prompt).toContain(ISSUE)
    expect(prompt).toContain('Round 2: look hard at https://teable.test/r/rec1.')
    expect(prompt).not.toContain('Skip style nits')
    expect(prompt).toContain('VERDICT: APPROVE')
  })

  it('a custom fix prompt also drives the fix after the check', () => {
    const custom = target({ fix: 'Fix {key} minimally.' })
    expect(fixPrompt(custom)).toContain(ISSUE)
    expect(fixPrompt(custom).endsWith('Fix T42 minimally.')).toBe(true)
    const after = fixAfterTriagePrompt(custom)
    expect(after.startsWith('Your verification confirmed the bug. Now fix it.\n\nStart from what you found.')).toBe(true)
    expect(after.endsWith('Fix T42 minimally.')).toBe(true)
  })

  it('review feedback keeps the review block', () => {
    const prompt = reviewFeedbackPrompt(target({ reviewFeedback: 'Fix round {round} on {branch}.' }), review, 'Codex CLI')
    expect(prompt).toContain('<review>\nLine 3 is wrong.\n</review>')
    expect(prompt.endsWith('Fix round 2 on fix/T42.')).toBe(true)
  })

  it('a blank custom prompt falls back to the default', () => {
    expect(fixPrompt(target({ fix: '   ' }))).toBe(fixPrompt(target()))
  })
})

describe('fillTemplate', () => {
  it('fills known placeholders and leaves the rest', () => {
    expect(fillTemplate('{a} {b} {c}', { a: 1, b: 'x', c: undefined })).toBe('1 x {c}')
  })
})
