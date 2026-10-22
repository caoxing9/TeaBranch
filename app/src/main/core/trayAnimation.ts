import { type NativeImage, nativeImage, nativeTheme, type Tray } from 'electron'

/**
 * The menu-bar icon while agents work: the icon on a pulsing amber glow with a spark orbiting it,
 * like Claude's own status item. Frames are painted pixel by pixel from the template icon, so
 * there are no extra assets; idle, the plain template icon comes back.
 */

const FRAMES = 24
const FPS = 12
const GLOW: [number, number, number] = [255, 168, 64]

export function animatedFrames(base: NativeImage, dark: boolean): NativeImage[] {
  const icon = base.toBitmap({ scaleFactor: 2 }) // BGRA, in pixels
  // getSize() is in points; the @2x bitmap is twice that.
  const width = base.getSize().width * 2
  const height = icon.length / 4 / width
  const ink = dark ? 255 : 0
  const cx = (width - 1) / 2
  const cy = (height - 1) / 2
  const radius = Math.min(width, height) / 2

  return Array.from({ length: FRAMES }, (_, frame) => {
    const phase = (frame / FRAMES) * Math.PI * 2
    const pulse = 0.45 + 0.25 * Math.sin(phase)
    const sparkX = cx + Math.cos(phase - Math.PI / 2) * (radius - 2.5)
    const sparkY = cy + Math.sin(phase - Math.PI / 2) * (radius - 2.5)
    const out = Buffer.alloc(width * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        // Soft halo, brightest at the centre.
        const d = Math.hypot(x - cx, y - cy) / radius
        let glow = d < 1 ? (1 - d) ** 1.6 * pulse : 0
        // The orbiting spark, with a short falloff.
        const s = Math.hypot(x - sparkX, y - sparkY)
        glow = Math.min(1, glow + Math.max(0, 1 - s / 3.2) * 0.95)
        const ia = icon[i + 3] / 255
        // Icon over glow ("source over"), premultiplied the way macOS wants it.
        const a = ia + glow * (1 - ia)
        const mix = (channel: number) => Math.round(ink * ia + channel * glow * (1 - ia))
        out[i] = mix(GLOW[2])
        out[i + 1] = mix(GLOW[1])
        out[i + 2] = mix(GLOW[0])
        out[i + 3] = Math.round(a * 255)
      }
    }
    return nativeImage.createFromBitmap(out, { width, height, scaleFactor: 2 })
  })
}

/** Start or stop the animation as `count` (running agents) changes. */
export function trayActivity(tray: Tray, idle: NativeImage) {
  let timer: NodeJS.Timeout | null = null
  let frames: NativeImage[] = []
  let framesDark: boolean | null = null
  let frame = 0
  return (count: number) => {
    if (count > 0) {
      tray.setToolTip(`TeaBranch · ${count} 个 agent 在跑`)
      if (framesDark !== nativeTheme.shouldUseDarkColors) {
        framesDark = nativeTheme.shouldUseDarkColors
        frames = animatedFrames(idle, framesDark)
      }
      timer ??= setInterval(() => {
        frame = (frame + 1) % frames.length
        tray.setImage(frames[frame])
      }, 1000 / FPS)
    } else if (timer) {
      clearInterval(timer)
      timer = null
      tray.setImage(idle)
      tray.setToolTip('TeaBranch')
    }
  }
}
