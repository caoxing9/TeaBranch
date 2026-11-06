import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ safeStorage: {} }))
const { render } = await import('./feishu')

describe('feishu render', () => {
  it('spells out mentions in text messages', () => {
    const mentions = [{ key: '@_user_1', name: 'TeaBranch' }]
    expect(render('text', JSON.stringify({ text: '@_user_1 表格打不开了' }), mentions)).toEqual({
      text: '@TeaBranch 表格打不开了',
      images: [],
    })
  })

  it('flattens posts, numbering their images', () => {
    const post = {
      title: 'Bug',
      content: [
        [
          { tag: 'text', text: '点击 ' },
          { tag: 'a', text: '这里', href: 'https://x.test' },
        ],
        [
          { tag: 'img', image_key: 'img_1' },
          { tag: 'at', user_name: 'Bot' },
        ],
      ],
    }
    expect(render('post', JSON.stringify(post), [])).toEqual({ text: 'Bug\n点击 这里 (https://x.test)\n[image 1]@Bot', images: ['img_1'] })
  })

  it('reads posts still keyed by language', () => {
    const post = { zh_cn: { title: '', content: [[{ tag: 'text', text: 'hi' }]] } }
    expect(render('post', JSON.stringify(post), []).text).toBe('hi')
  })

  it('names what it cannot read', () => {
    expect(render('sticker', '{}', [])).toEqual({ text: '[sticker]', images: [] })
    expect(render('image', JSON.stringify({ image_key: 'k' }), [])).toEqual({ text: '[image 1]', images: ['k'] })
  })
})
