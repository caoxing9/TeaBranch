import { effect, signal } from 'nsh'
import { TextInput } from '../../components/kit'
import { cn } from '../../lib/utils'

/** Text saved when you leave the box or press Return — a setting, not a search. */
export function SavedInput(props: { value: string; onSave: (value: string) => void; placeholder?: string; mono?: boolean; masked?: boolean; class?: string }) {
  const text = signal(props.value)
  effect(() => text.set(props.value))
  const commit = () => {
    if (text() !== props.value) props.onSave(text())
  }
  return (
    <TextInput
      value={text()}
      masked={props.masked}
      placeholder={props.placeholder}
      onChange={(e) => text.set(e.value)}
      onBlur={commit}
      onSubmit={commit}
      autoCorrect={false}
      class={cn(props.mono && 'font-mono text-[12px]', props.class)}
    />
  )
}

/** `Choice` drops an empty value, so "none" travels as this and comes back as undefined. */
export const NONE = '__none__'
