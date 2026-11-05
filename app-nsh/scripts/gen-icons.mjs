#!/usr/bin/env node
// The app's icons: lucide's, as SVG files under assets/icons, and src/ui/components/Icon.tsx made from
// that folder. `node scripts/gen-icons.mjs badge-check wrench` copies those icons in from the React
// build's lucide-react and regenerates Icon.tsx; with no names it only regenerates.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const icons = join(root, 'assets', 'icons')
const lucide = join(root, '..', 'app', 'node_modules', 'lucide-react', 'dist', 'esm', 'icons')

for (const name of process.argv.slice(2)) {
  const source = readFileSync(join(lucide, `${name}.mjs`), 'utf8')
  const match = /node:\s*(\[[\s\S]*?\n  \])/.exec(source)
  if (!match) throw new Error(`no node data in ${name}.mjs`)
  const node = new Function(`return ${match[1]}`)()
  const body = node
    .map(([tag, attrs]) => {
      const pairs = Object.entries(attrs)
        .filter(([key]) => key !== 'key')
        .map(([key, value]) => `${key}="${value}"`)
        .join(' ')
      return `<${tag} ${pairs}/>`
    })
    .join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
  writeFileSync(join(icons, `${name}.svg`), svg)
  console.log(`+ ${name}.svg`)
}

const pascal = (name) =>
  name
    .split('-')
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('')

const names = readdirSync(icons)
  .filter((file) => file.endsWith('.svg'))
  .map((file) => file.slice(0, -4))
  .sort()

const out = [
  '// Generated from assets/icons: every icon the app uses, as an nsh Image tinted to a colour.',
  "import { Image, type ImageStyle } from 'nsh'",
  "import { type ColorName, color, isColorName } from '../theme'",
  '',
  ...names.map((name) => `import ${pascal(name)} from '../../../assets/icons/${name}.svg'`),
  '',
  'export const ICONS = {',
  ...names.map((name) => `  '${name}': ${pascal(name)},`),
  '} as const',
  '',
  'export type IconName = keyof typeof ICONS',
  '',
  '/** A line icon at `size` points (16 when left out), in the palette colour `tint` (the text colour when left out). */',
  'export function Icon(props: { name: IconName; size?: number; tint?: ColorName | string; class?: string; style?: ImageStyle }) {',
  '  const size = () => props.size ?? 16',
  "  const tint = () => (props.tint === undefined ? color('fg') : isColorName(props.tint) ? color(props.tint) : props.tint)",
  '  return <Image src={ICONS[props.name]} class={props.class} style={{ width: size(), height: size(), tintColor: tint(), ...props.style }} />',
  '}',
  '',
]
writeFileSync(join(root, 'src', 'ui', 'components', 'Icon.tsx'), out.join('\n'))
console.log(`Icon.tsx: ${names.length} icons`)
