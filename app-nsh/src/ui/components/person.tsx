import { Image, Text, View } from 'nsh'
import type { Person } from '../../shared/types'
import { cn } from '../lib/utils'
import { Icon } from './Icon'

/** Initials for a fallback: the first character of a Chinese name, two letters of a Latin one. */
const initials = (name: string): string => {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  if (/[一-鿿]/.test(trimmed[0])) return trimmed[0] // i18n-ignore: detects CJK names
  const parts = trimmed.split(/\s+/)
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : trimmed.slice(0, 2)).toUpperCase()
}

export function PersonAvatar(props: { person: Person; size?: number; class?: string; tooltip?: boolean }) {
  const size = () => props.size ?? 20
  const label = () => (props.person.email ? `${props.person.name} · ${props.person.email}` : props.person.name)
  return (
    <View
      class={cn('items-center justify-center overflow-hidden rounded-full border-2 border-bg bg-muted', props.class)}
      style={{ width: size(), height: size() }}
      tooltip={(props.tooltip ?? true) ? label() : undefined}
    >
      <If when={props.person.avatar} else={<Text class="text-[9px] font-medium text-fg">{initials(props.person.name)}</Text>}>
        {(avatar) => <Image src={avatar()} style={{ width: size(), height: size() }} class="object-cover" />}
      </If>
    </View>
  )
}

/** Overlapping avatars, deduplicated by name. */
export function PeopleStack(props: { people: Person[]; max?: number; class?: string }) {
  const unique = () => props.people.filter((person, index) => props.people.findIndex((p) => p.name === person.name) === index)
  const max = () => props.max ?? 3
  return (
    <View class={cn('flex-row', props.class)} style={{ gap: -6 }}>
      <Each of={unique().slice(0, max())} key={(person) => person.name}>
        {(person) => <PersonAvatar person={person()} />}
      </Each>
      <If when={unique().length > max()}>
        <View class="size-5 items-center justify-center rounded-full border-2 border-bg bg-muted">
          <Text class="text-[9px] text-fg">+{unique().length - max()}</Text>
        </View>
      </If>
    </View>
  )
}

/** The agent's mark in a conversation. */
export function AgentAvatar(props: { review?: boolean }) {
  return (
    <View class={cn('size-6 shrink-0 items-center justify-center rounded-full', props.review ? 'bg-agent/15' : 'bg-brand/15')}>
      <Icon name="bot" size={14} tint={props.review ? 'agent' : 'brand'} />
    </View>
  )
}
