import { type NativeImage, nativeImage, nativeTheme, type Tray } from 'electron'

/**
 * The menu-bar icon while agents work: the leaf stays put and the app icon's four-point spark
 * breathes in its free top-left corner. Frames are painted pixel by pixel from the template icon,
 * so there are no extra assets; idle, the plain template icon comes back. Nothing moves across the
 * icon and nothing shows through the vein cut-outs, so at menu-bar size it reads as calm, not as
 * flicker.
 */

const FRAMES = 30
const FPS = 15
const SPARK: [number, number, number] = [255, 176, 72]
/** Supersampling per axis, to anti-alias the spark. */
const SAMPLES = 4

/** Coverage of a four-point star (an astroid) of radius `r` centred on `(cx, cy)` at pixel `(x, y)`. */
function spark(x: number, y: number, cx: number, cy: number, r: number): number {
  let inside = 0
  for (let sy = 0; sy < SAMPLES; sy++) {
    for (let sx = 0; sx < SAMPLES; sx++) {
      const dx = Math.abs(x + (sx + 0.5) / SAMPLES - cx) / r
      const dy = Math.abs(y + (sy + 0.5) / SAMPLES - cy) / r
      if (dx ** (2 / 3) + dy ** (2 / 3) <= 1) inside++
    }
  }
  return inside / (SAMPLES * SAMPLES)
}

export function animatedFrames(base: NativeImage, dark: boolean): NativeImage[] {
  const icon = base.toBitmap({ scaleFactor: 2 }) // BGRA, in pixels
  // getSize() is in points; the @2x bitmap is twice that.
  const width = base.getSize().width * 2
  const height = icon.length / 4 / width
  const ink = dark ? 255 : 0
  const cx = width * 0.22
  const cy = height * 0.22
  const radius = Math.min(width, height) * 0.2

  return Array.from({ length: FRAMES }, (_, frame) => {
    // One slow breath per loop, eased at both ends.
    const t = (1 - Math.cos((frame / FRAMES) * Math.PI * 2)) / 2
    const r = radius * (0.55 + 0.45 * t)
    const strength = 0.55 + 0.45 * t
    const out = Buffer.alloc(width * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        const ia = icon[i + 3] / 255
        const sa = spark(x, y, cx, cy, r) * strength
        // Icon over spark ("source over"), premultiplied the way macOS wants it.
        const a = ia + sa * (1 - ia)
        const mix = (channel: number) => Math.round(ink * ia + channel * sa * (1 - ia))
        out[i] = mix(SPARK[2])
        out[i + 1] = mix(SPARK[1])
        out[i + 2] = mix(SPARK[0])
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
