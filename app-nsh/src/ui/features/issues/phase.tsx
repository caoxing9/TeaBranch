import { Text, View } from 'nsh'
import type { IssuePhase } from '../../../shared/types'
import { isActivePhase, phaseLabel } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { Icon } from '../../components/Icon'
import { Spinner } from '../../components/kit'
import { chats } from '../../store/chats'
import type { ColorName } from '../../theme'
import { cn } from '../../lib/utils'

export const phaseColor: Record<IssuePhase, string> = {
  queued: 'text-agent',
  preparing: 'text-agent',
  triaging: 'text-agent',
  triaged: 'text-warn',
  fixing: 'text-agent',
  reviewing: 'text-agent',
  prOpen: 'text-ok',
  finished: 'text-fg-2',
  cancelled: 'text-fg-2',
  failed: 'text-err',
  paused: 'text-warn',
}

export const phaseTint: Record<IssuePhase, ColorName> = {
  queued: 'agent',
  preparing: 'agent',
  triaging: 'agent',
  triaged: 'warn',
  fixing: 'agent',
  reviewing: 'agent',
  prOpen: 'ok',
  finished: 'fg-2',
  cancelled: 'fg-2',
  failed: 'err',
  paused: 'warn',
}

const dotColor: Record<IssuePhase, string> = {
  queued: 'bg-agent',
  preparing: 'bg-agent',
  triaging: 'bg-agent',
  triaged: 'bg-warn',
  fixing: 'bg-agent',
  reviewing: 'bg-agent',
  prOpen: 'bg-ok',
  finished: 'bg-fg-2',
  cancelled: 'bg-fg-2',
  failed: 'bg-err',
  paused: 'bg-warn',
}

export function PhaseBadge(props: { phase: IssuePhase; recordId?: string }) {
  // A conversation opened under a settled issue is work on it too, though the issue's own agent rests.
  const chatting = () => !!props.recordId && chats.chats().some((chat) => chat.issueId === props.recordId && chat.running)
  return (
    <If
      when={chatting() && !isActivePhase(props.phase)}
      else={
        <View class="flex-row items-center gap-1">
          <If
            when={isActivePhase(props.phase)}
            else={
              <If when={props.phase === 'paused'} else={<View class={cn('size-1.5 rounded-full', dotColor[props.phase])} />}>
                <Icon name="pause" size={10} tint="warn" />
              </If>
            }
          >
            <Spinner size={10} />
          </If>
          <Text class={cn('text-[10px] font-medium', phaseColor[props.phase])}>{phaseLabel[props.phase]}</Text>
        </View>
      }
    >
      <View class="flex-row items-center gap-1">
        <Spinner size={10} />
        <Text class="text-[10px] font-medium text-agent">{t('对话中')}</Text>
      </View>
    </If>
  )
}
