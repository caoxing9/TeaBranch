import { effect, Image, keymap, Text, View } from 'nsh'
import { Dialog } from 'nsh/base'
import { t } from '../../shared/i18n'
import { api } from '../lib/api'
import { createStore } from '../store/base'
import { Icon } from './Icon'
import { IconButton } from './kit'

/**
 * In-app image preview, Quick Look style: images open over the window instead of downloading.
 * ←/→ step through the set it was opened from, Esc or a click on the backdrop closes it.
 */
export interface PreviewImage {
  url: string
  name?: string
}

const fields = createStore<{ images: PreviewImage[]; index: number }>({ images: [], index: 0 })

export const lightbox = {
  ...fields,
  open: (images: PreviewImage[], index = 0): void => fields.set({ images, index }),
  close: (): void => fields.set({ images: [], index: 0 }),
  step: (delta: number): void => {
    const images = fields.images()
    if (images.length > 1) fields.set({ index: (fields.index() + delta + images.length) % images.length })
  },
}

export function Lightbox() {
  const image = () => fields.images()[fields.index()]
  effect(() => {
    if (!image()) return
    return keymap.bind({
      escape: () => lightbox.close(),
      space: () => lightbox.close(),
      left: () => lightbox.step(-1),
      right: () => lightbox.step(1),
    })
  })
  return (
    <If when={image()}>
      {(current) => (
        <Dialog open animation="fade" closeOnEscape closeOnBackdropPress onClose={lightbox.close} backdropClass="bg-black/80" class="flex-1">
          <View class="flex-1" onPress={lightbox.close}>
            <View class="h-12 shrink-0 flex-row items-center gap-2 px-4" onPress={() => undefined}>
              <Text class="min-w-0 flex-1 text-[12.5px] text-white/80" style={{ numberOfLines: 1 }}>
                {current().name ?? ''}
              </Text>
              <If when={fields.images().length > 1}>
                <Text class="text-[12.5px] text-white/50 tabular-nums">
                  {fields.index() + 1} / {fields.images().length}
                </Text>
              </If>
              <IconButton label={t('在浏览器打开')} onPress={() => void api.openExternal(current().url)} class="hover:bg-white/10">
                <Icon name="external-link" size={16} tint="#ffffff" />
              </IconButton>
              <IconButton label={t('关闭（Esc）')} onPress={lightbox.close} class="hover:bg-white/10">
                <Icon name="x" size={16} tint="#ffffff" />
              </IconButton>
            </View>
            <View class="relative min-h-0 flex-1 items-center justify-center px-16 pb-10">
              <Image src={current().url} class="h-full w-full rounded-md object-contain" onPress={() => undefined} />
              <If when={fields.images().length > 1}>
                <View class="absolute top-1/2 left-4 size-10 items-center justify-center rounded-full bg-white/10 hover:bg-white/20" onPress={() => lightbox.step(-1)}>
                  <Icon name="chevron-left" size={20} tint="#ffffff" />
                </View>
                <View class="absolute top-1/2 right-4 size-10 items-center justify-center rounded-full bg-white/10 hover:bg-white/20" onPress={() => lightbox.step(1)}>
                  <Icon name="chevron-right" size={20} tint="#ffffff" />
                </View>
              </If>
            </View>
          </View>
        </Dialog>
      )}
    </If>
  )
}
