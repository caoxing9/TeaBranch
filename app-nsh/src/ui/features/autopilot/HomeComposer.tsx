import { type InputRef, Text, View, effect, keymap, signal } from 'nsh'
import { Input } from 'nsh/base'
import { attachmentMarker, DRAFT_UPLOADS } from '../../../shared/attachments'
import { t } from '../../../shared/i18n'
import { type Draft, DraftChip, importFiles, importUris, pickDrafts } from '../../components/Drafts'
import { Icon } from '../../components/Icon'
import { IconButton, Spinner } from '../../components/kit'
import { api, messageOf } from '../../lib/api'
import { cn } from '../../lib/utils'
import { autopilot } from '../../store/autopilot'

/**
 * The one box on the home page: what you say here goes to the router, which decides what it is — a
 * question it answers, something to look into, a word for a task — and answers in the same place.
 * Return sends; ⌘Return skips the router and starts a probe straight away; Shift-Return breaks the
 * line. Screenshots paste or drop in and wait in the draft uploads until the message owns them.
 */
export function HomeComposer() {
  const text = signal('')
  const drafts = signal<Draft[]>([])
  const dragging = signal(false)
  const busy = signal(false)
  const focused = signal(false)
  let input: InputRef | undefined
  const filled = () => text().trim().length > 0 || drafts().length > 0

  const take = (work: Promise<Draft[]>) =>
    work.then((added) => drafts.set([...drafts(), ...added])).catch((error) => autopilot.set({ error: messageOf(error) }))
  const addFiles = (files: File[]) => take(importFiles(DRAFT_UPLOADS, files))
  const addPaths = (uris: string[]) => take(importUris(DRAFT_UPLOADS, uris))
  const pick = () => take(pickDrafts(DRAFT_UPLOADS))
  const submit = async (direct: boolean) => {
    if (busy() || !filled()) return
    const attachments = drafts().map((draft) => draft.path)
    const markers = attachments.map((_, index) => attachmentMarker(index + 1)).join(' ')
    const message = [text().trim(), markers].filter(Boolean).join('\n') || t('看一下附件。')
    busy.set(true)
    try {
      if (direct) await api.probe(message, attachments)
      else await api.askRouter(message, attachments)
      text.set('')
      drafts.set([])
    } catch (error) {
      autopilot.set({ error: messageOf(error) })
    } finally {
      busy.set(false)
    }
  }

  // The sidebar's "new probe": the cursor comes here.
  effect(() => {
    if (autopilot.focusKey()) input?.focus()
  })
  // ⌘Return while typing here: a probe, past the router.
  effect(() => {
    if (!focused()) return
    return keymap.bind('mod+enter', () => void submit(true))
  })

  return (
    <View
      class={cn(
        'rounded-[22px] border bg-card shadow-md',
        dragging() ? 'border-brand bg-brand-soft' : focused() ? 'border-border-strong' : 'border-border',
      )}
      onFileDragEnter={() => dragging.set(true)}
      onFileDragLeave={() => dragging.set(false)}
      onFileDrop={(e) => {
        dragging.set(false)
        void addPaths(e.uris)
      }}
    >
      <If when={drafts().length > 0}>
        <View class="flex-row flex-wrap gap-1.5 px-3 pt-3">
          <Each of={drafts()} key={(draft) => draft.path}>
            {(draft) => <DraftChip draft={draft()} onRemove={() => drafts.set(drafts().filter((d) => d.path !== draft().path))} />}
          </Each>
        </View>
      </If>
      <Input
        ref={(node) => (input = node)}
        multiline
        submitBehavior="submit"
        value={text()}
        placeholder={t('有什么要查的、要问的…')}
        onChange={(e) => text.set(e.value)}
        onSubmit={() => void submit(false)}
        onFocus={() => focused.set(true)}
        onBlur={() => focused.set(false)}
        onPaste={(e) => {
          if (e.files.length) void addFiles(e.files)
          else if (e.uris.length) void addPaths(e.uris)
        }}
        class="max-h-60 min-h-[60px] w-full px-4 pt-3 pb-1 text-[13.5px] leading-[20px] text-fg"
      />
      <View class="flex-row items-center gap-1 px-2.5 pb-2.5">
        <IconButton label={t('附加文件')} class="rounded-full" onPress={() => void pick()}>
          <Icon name="plus" size={16} tint="fg-2" />
        </IconButton>
        <View class="flex-1" />
        <If when={filled() && !busy()}>
          <Text class="mr-1.5 text-[11px] text-fg-3">{t('↩ 发送 · ⌘↩ 直接探查')}</Text>
        </If>
        <View
          class={cn('size-8 items-center justify-center rounded-xl', filled() && !busy() ? 'bg-primary hover:bg-primary/85' : 'bg-muted')}
          role="button"
          tooltip={t('发送')}
          disabled={!filled() || busy()}
          onPress={() => void submit(false)}
        >
          <If when={busy()} else={<Icon name="arrow-up" size={16} tint={filled() ? '#ffffff' : 'fg-3'} />}>
            <Spinner />
          </If>
        </View>
      </View>
    </View>
  )
}
