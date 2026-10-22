import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { en } from './en'
import { issues } from './en/issues'
import { main } from './en/main'
import { ui } from './en/ui'
import { resolveLocale, setLocale, t } from '.'

const SRC = join(__dirname, '../..')
const CJK = /[一-鿿]/

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'i18n' ? [] : sources(path)
    return /\.tsx?$/.test(name) && !name.includes('.test.') ? [path] : []
  })
}

/** Every `t('…')` key, single- or double-quoted or a template without interpolation. */
const KEY = /\bt\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g

describe('i18n', () => {
  const files = sources(SRC)

  it('has English for every t() key', () => {
    const missing: string[] = []
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(KEY)) {
        const key = match[2].replace(/\\(['"`\\])/g, '$1')
        if (!(key in en)) missing.push(`${relative(SRC, file)}: ${key}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('leaves no Chinese outside t() and comments', () => {
    const stray: string[] = []
    for (const file of files) {
      let inBlock = false
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          let code = line
          if (inBlock) {
            const end = code.indexOf('*/')
            if (end < 0) return
            inBlock = false
            code = code.slice(end + 2)
          }
          code = code.replace(/\/\*.*?\*\//g, '')
          const open = code.indexOf('/*')
          if (open >= 0) {
            inBlock = true
            code = code.slice(0, open)
          }
          if (/i18n-ignore/.test(line)) return
          code = code.replace(/(^|[^:])\/\/.*$/, '$1').replace(KEY, '')
          if (CJK.test(code)) stray.push(`${relative(SRC, file)}:${index + 1}: ${line.trim()}`)
        })
    }
    expect(stray).toEqual([])
  })

  it('translates a key the same way in every catalog', () => {
    const conflicts = Object.keys(en).filter(
      (key) => new Set([main[key], issues[key], ui[key]].filter((value) => value !== undefined)).size > 1,
    )
    expect(conflicts).toEqual([])
  })

  it('interpolates and falls back', () => {
    setLocale('en')
    expect(t('不存在的文案 {n}', { n: 3 })).toBe('不存在的文案 3')
    setLocale('zh')
    expect(t('共 {n} 个', { n: 2 })).toBe('共 2 个')
  })

  it('resolves the system language', () => {
    expect(resolveLocale('system', ['zh-Hans-CN', 'en-US'])).toBe('zh')
    expect(resolveLocale('system', ['en-GB', 'zh-Hans'])).toBe('en')
    expect(resolveLocale(undefined, [])).toBe('en')
    expect(resolveLocale('zh', ['en-US'])).toBe('zh')
  })
})
