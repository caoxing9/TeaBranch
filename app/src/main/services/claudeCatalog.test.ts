import { describe, expect, it } from 'vitest'
import { catalogFrom } from './claudeCatalog'

describe('catalogFrom', () => {
  it('maps list_models rows and names the default', () => {
    const catalog = catalogFrom([
      { value: 'default', description: 'Opus 5.5 · Best for everyday, complex tasks' },
      { value: 'opus', displayName: 'Opus 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'high', 'xhigh'] },
      { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', supportsEffort: true, supportedEffortLevels: ['low', 'max'] },
      { value: 'claude-haiku-4-5', displayName: 'Haiku 4.5' },
      { value: 'old', disabled: true },
    ])
    expect(catalog.defaultName).toBe('Opus 5.5')
    expect(catalog.models.map((m) => m.value)).toEqual(['opus', 'claude-sonnet-4-6', 'claude-haiku-4-5'])
    expect(catalog.models[0].efforts).toEqual(['low', 'high', 'xhigh', 'ultracode', 'ultrathink'])
    expect(catalog.models[1].efforts).toEqual(['low', 'max', 'ultrathink'])
    expect(catalog.models[2].efforts).toEqual([])
  })
})
