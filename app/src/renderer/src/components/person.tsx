import { Bot } from 'lucide-react'
import type { Person } from '@shared/types'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** Initials for a fallback: the first character of a Chinese name, two letters of a Latin one. */
const initials = (name: string): string => {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  if (/[一-鿿]/.test(trimmed[0])) return trimmed[0]
  const parts = trimmed.split(/\s+/)
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : trimmed.slice(0, 2)).toUpperCase()
}

export function PersonAvatar({ person, className, tooltip = true }: { person: Person; className?: string; tooltip?: boolean }) {
  const avatar = (
    <Avatar className={cn('size-5 ring-2 ring-background', className)}>
      {person.avatar && <AvatarImage src={person.avatar} alt={person.name} />}
      <AvatarFallback className="text-[9px] font-medium">{initials(person.name)}</AvatarFallback>
    </Avatar>
  )
  if (!tooltip) return avatar
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{avatar}</TooltipTrigger>
      <TooltipContent>{person.email ? `${person.name} · ${person.email}` : person.name}</TooltipContent>
    </Tooltip>
  )
}

/** Overlapping avatars, deduplicated by name. */
export function PeopleStack({ people, max = 3, className }: { people: Person[]; max?: number; className?: string }) {
  const unique = people.filter((person, index) => people.findIndex((p) => p.name === person.name) === index)
  return (
    <span className={cn('flex -space-x-1.5', className)}>
      {unique.slice(0, max).map((person) => (
        <PersonAvatar key={person.name} person={person} />
      ))}
      {unique.length > max && (
        <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[9px] ring-2 ring-background">
          +{unique.length - max}
        </span>
      )}
    </span>
  )
}

/** The agent's mark in a conversation. */
export function AgentAvatar({ review = false }: { review?: boolean }) {
  return (
    <span
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-full',
        review ? 'bg-agent/15 text-agent' : 'bg-brand/15 text-brand',
      )}
    >
      <Bot className="size-3.5" />
    </span>
  )
}
