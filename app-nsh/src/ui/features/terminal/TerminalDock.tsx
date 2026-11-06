import { Text, View, effect, untracked } from 'nsh'
import { t } from '../../../shared/i18n'
import { Icon } from '../../components/Icon'
import { ContextMenuArea } from '../../components/kit'
import { cn } from '../../lib/utils'
import { issues } from '../../store/issues'
import { currentGroup } from '../../store/tabs'
import { DEFAULT_DOCK_HEIGHT, terminals } from '../../store/terminals'
import { here } from '../issues/place'
import { TerminalView } from './TerminalView'

const MIN_HEIGHT = 120
const MAX_HEIGHT = 720
const clamp = (height: number) => Math.round(Math.min(Math.max(height, MIN_HEIGHT), MAX_HEIGHT))

/**
 * MonoCode's terminal dock: under the conversation, its own tabs, drag the top edge to resize
 * (double-click resets), ⌘J to show or hide, ⌘` for another terminal. Each group — the selected
 * issue, or the free-standing chats — has its own terminals, opened where "here" is.
 */
export function TerminalDock() {
  const group = () => currentGroup(issues.selection()) ?? ''
  const mine = () => terminals.terms().filter((term) => term.group === group())
  const front = () => mine().find((term) => term.id === terminals.active()[group()]) ?? mine()[0]
  const place = () => here().place
  const addHere = () => {
    const target = place()
    if (target) terminals.add(group(), target.cwd)
  }

  // ⌘J hides what shows, or shows the dock — starting a shell here when the group has none, as does
  // ⌘`. Browsing to an issue without terminals just shows none: a shell per issue clicked would be
  // a surprise.
  let lastToggle = untracked(() => terminals.toggleRequest())
  effect(() => {
    const request = terminals.toggleRequest()
    if (request === lastToggle) return
    lastToggle = request
    untracked(() => {
      if (terminals.open() && mine().length) terminals.setOpen(false)
      else if (mine().length) terminals.setOpen(true)
      else addHere()
    })
  })
  let lastAdd = untracked(() => terminals.addRequest())
  effect(() => {
    const request = terminals.addRequest()
    if (request === lastAdd) return
    lastAdd = request
    untracked(addHere)
  })

  let drag: { y: number; height: number } | null = null

  return (
    <If when={mine().length > 0 && terminals.open()}>
      <View class="relative shrink-0 border-t border-border bg-bg" style={{ height: terminals.height() }}>
        <View
          class="absolute inset-x-0 -top-[3px] z-10 h-1.5 hover:bg-brand/30 active:bg-brand/50"
          accessibilityLabel={t('调整终端高度')}
          onStartShouldSetResponder={() => true}
          onResponderGrant={(e) => {
            drag = { y: e.pageY, height: terminals.height() }
            return true
          }}
          onResponderMove={(e) => {
            if (drag) terminals.setHeight(clamp(drag.height + drag.y - e.pageY), false)
          }}
          onResponderRelease={() => {
            drag = null
            terminals.setHeight(terminals.height())
          }}
          onPress={(e) => e.clickCount === 2 && terminals.setHeight(DEFAULT_DOCK_HEIGHT)}
        />
        <View class="h-8 shrink-0 flex-row items-center gap-0.5 px-2">
          <Each of={mine()} key={(term) => term.id}>
            {(term, index) => (
              <ContextMenuArea
                entries={() => [
                  { label: t('关闭'), onSelect: () => terminals.close(term().id) },
                  { label: t('关闭其他终端'), disabled: mine().length < 2, onSelect: () => terminals.closeOthers(term().id) },
                  'separator',
                  { label: t('上移'), disabled: index() === 0, onSelect: () => terminals.move(term().id, mine()[index() - 1]?.id ?? null) },
                  { label: t('下移'), disabled: index() >= mine().length - 1, onSelect: () => terminals.move(term().id, mine()[index() + 2]?.id ?? null) },
                ]}
              >
                <View
                  class={cn(
                    'h-6 max-w-48 min-w-0 flex-row items-center gap-1.5 rounded-md pr-0.5 pl-2',
                    term().id === front()?.id ? 'bg-accent' : 'hover:bg-accent/60',
                    term().exited && 'opacity-60',
                  )}
                  role="button"
                  tooltip={term().cwd}
                  onPress={() => terminals.select(group(), term().id)}
                >
                  <Icon name="square-terminal" size={12} tint={term().id === front()?.id ? 'fg' : 'fg-2'} />
                  <Text class={cn('min-w-0 flex-1 text-[11.5px]', term().id === front()?.id ? 'text-fg' : 'text-fg-2')} style={{ numberOfLines: 1 }}>
                    {term().title}
                  </Text>
                  <View
                    class={cn('size-[18px] shrink-0 items-center justify-center rounded hover:bg-fill-hover', term().id === front()?.id ? 'opacity-70' : 'opacity-40')}
                    role="button"
                    accessibilityLabel={t('关闭终端')}
                    onPress={() => terminals.close(term().id)}
                  >
                    <Icon name="x" size={12} tint="fg-2" />
                  </View>
                </View>
              </ContextMenuArea>
            )}
          </Each>
          <View
            class={cn('size-6 shrink-0 items-center justify-center rounded-md hover:bg-accent', !place() && 'opacity-40')}
            role="button"
            disabled={!place()}
            tooltip={place() ? t('新终端 · {place}（⌘`）', { place: place()?.label ?? '' }) : t('新终端')}
            onPress={addHere}
          >
            <Icon name="plus" size={14} tint="fg-2" />
          </View>
          <View class="flex-1" />
          <View class="size-6 shrink-0 items-center justify-center rounded-md hover:bg-accent" role="button" tooltip={t('隐藏终端（⌘J）')} onPress={() => terminals.setOpen(false)}>
            <Icon name="chevron-down" size={14} tint="fg-2" />
          </View>
        </View>
        <View class="relative min-h-0 flex-1">
          <If when={front()}>
            {(term) => (
              <Each of={[term()]} key={(current) => current.id}>
                {(current) => <TerminalView id={current().id} cwd={current().cwd} active />}
              </Each>
            )}
          </If>
        </View>
      </View>
    </If>
  )
}

/** The tab bar's toggle for the dock, lit while it shows. */
export function TerminalToggle() {
  const group = () => currentGroup(issues.selection()) ?? ''
  const open = () => terminals.open() && terminals.terms().some((term) => term.group === group())
  return (
    <View class="mb-1 size-7 shrink-0 items-center justify-center rounded-lg hover:bg-accent" role="button" tooltip={open() ? t('隐藏终端（⌘J）') : t('终端（⌘J）')} onPress={() => terminals.toggle()}>
      <Icon name="square-terminal" size={16} tint={open() ? 'fg' : 'fg-2'} />
    </View>
  )
}
