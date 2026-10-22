import { ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { api } from '@/lib/api'

/**
 * In-app image preview, Quick Look style: images open over the window instead of downloading.
 * ←/→ step through the set it was opened from, Esc or a click on the backdrop closes it.
 */

export interface PreviewImage {
  url: string
  name?: string
}

interface LightboxStore {
  images: PreviewImage[]
  index: number
  open(images: PreviewImage[], index?: number): void
  close(): void
  step(delta: number): void
}

export const useLightbox = create<LightboxStore>((set, get) => ({
  images: [],
  index: 0,
  open: (images, index = 0) => set({ images, index }),
  close: () => set({ images: [], index: 0 }),
  step: (delta) => {
    const { images, index } = get()
    if (images.length > 1) set({ index: (index + delta + images.length) % images.length })
  },
}))

export function Lightbox() {
  const { images, index, close, step } = useLightbox()
  const image = images[index]

  useEffect(() => {
    if (!image) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === ' ') close()
      else if (event.key === 'ArrowLeft') step(-1)
      else if (event.key === 'ArrowRight') step(1)
      else return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [image, close, step])

  if (!image) return null
  return createPortal(
    // role=dialog also makes it a no-drag layer over the title bar (styles.css).
    <div
      role="dialog"
      aria-label={image.name ?? '图片预览'}
      className="no-drag fixed inset-0 z-[100] flex flex-col bg-black/80 backdrop-blur-sm animate-in fade-in-0 duration-150"
      onClick={close}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 px-4 text-[12.5px] text-white/80" onClick={(event) => event.stopPropagation()}>
        <span className="min-w-0 flex-1 truncate">{image.name}</span>
        {images.length > 1 && (
          <span className="tabular-nums text-white/50">
            {index + 1} / {images.length}
          </span>
        )}
        <button
          type="button"
          title="在浏览器打开"
          onClick={() => void api.openExternal(image.url)}
          className="grid size-8 place-items-center rounded-md hover:bg-white/10"
        >
          <ExternalLink className="size-4" />
        </button>
        <button type="button" title="关闭（Esc）" onClick={close} className="grid size-8 place-items-center rounded-md hover:bg-white/10">
          <X className="size-4" />
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center px-16 pb-10">
        <img
          src={image.url}
          alt={image.name ?? ''}
          onClick={(event) => event.stopPropagation()}
          className="max-h-full max-w-full rounded-md object-contain shadow-2xl"
        />
        {images.length > 1 && (
          <>
            <NavButton side="left" onClick={() => step(-1)} />
            <NavButton side="right" onClick={() => step(1)} />
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

function NavButton({ side, onClick }: { side: 'left' | 'right'; onClick: () => void }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className={`absolute top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white hover:bg-white/20 ${side === 'left' ? 'left-4' : 'right-4'}`}
    >
      <Icon className="size-5" />
    </button>
  )
}
