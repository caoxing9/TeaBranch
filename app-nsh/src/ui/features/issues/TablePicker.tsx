import { type JSX, Text, View, resource, signal } from 'nsh'
import { t } from '../../../shared/i18n'
import type { TeableLevel, TeableNode } from '../../../shared/types'
import { parseTableURL, sameHost } from '../../../shared/teableURL'
import { Icon } from '../../components/Icon'
import { Button, TextInput } from '../../components/kit'
import { SearchSelect } from '../../components/SearchSelect'
import { api, messageOf } from '../../lib/api'
import { cn } from '../../lib/utils'
import { issues } from '../../store/issues'

export interface TablePick {
  baseId: string
  tableId: string
  viewId?: string
}

/** One level's options, reloaded whenever its parent changes. */
function level(kind: TeableLevel, parentId: () => string | undefined, onError: (message: string) => void) {
  return resource(
    () => (kind === 'base' ? 'base' : (parentId() ?? '')),
    async (parent): Promise<TeableNode[] | null> => {
      if (kind !== 'base' && !parent) return null
      try {
        return await api.teableBrowse(kind, kind === 'base' ? undefined : parent)
      } catch (error) {
        onError(messageOf(error))
        return []
      }
    },
  )
}

/**
 * The issue table, picked the way Teable organises it: base → table → view, bases grouped by
 * space when the token may read space names, each list searchable. Or paste the table's link from
 * the browser and all three fill in — the way database tools take a connection string. Opens on
 * the current table when there is one. With `confirm`, the choice applies on a button; otherwise
 * as soon as a table is picked.
 */
export function TablePicker(props: { value?: Partial<TablePick>; onPick: (pick: TablePick) => void; confirm?: boolean }) {
  const host = () => issues.config()?.baseURL ?? ''
  const error = signal<string | null>(null)
  const link = signal('')
  const linkNote = signal<{ ok: boolean; text: string } | null>(null)
  const baseId = signal(props.value?.baseId || undefined)
  const tableId = signal(props.value?.tableId || undefined)
  const viewId = signal(props.value?.viewId || undefined)
  const bases = level('base', () => undefined, (m) => error.set(m))
  const tables = level('table', baseId, (m) => error.set(m))
  const views = level('view', tableId, (m) => error.set(m))
  const apply = (pick: Partial<TablePick>) => {
    if (!props.confirm && pick.baseId && pick.tableId) props.onPick(pick as TablePick)
  }
  const takeLink = (raw: string) => {
    link.set(raw)
    if (!raw.trim()) return linkNote.set(null)
    const parsed = parseTableURL(raw)
    if (!parsed) return linkNote.set({ ok: false, text: t('不是 Teable 的表链接，应该像 …/base/bse…/table/tbl…') })
    if (host() && !sameHost(parsed.baseURL, host())) {
      return linkNote.set({ ok: false, text: t('这个链接在 {link}，当前登录的是 {host}', { link: new URL(parsed.baseURL).host, host: hostOf(host()) }) })
    }
    error.set(null)
    baseId.set(parsed.baseId)
    tableId.set(parsed.tableId)
    viewId.set(parsed.viewId)
    linkNote.set({ ok: true, text: parsed.tableId ? t('已按链接选好') : t('链接只到 base，再选一张表') })
    apply(parsed)
  }
  const options = (nodes: TeableNode[] | null | undefined) => (nodes === undefined ? null : nodes)
  return (
    <View class="gap-2">
      <View class="h-8 flex-row items-center gap-2 rounded-md border border-dashed border-input px-2.5">
        <Icon name="link-2" size={14} tint="fg-3" />
        <TextInput value={link()} onChange={(e) => takeLink(e.value)} placeholder={t('粘贴表或视图的链接，自动选好')} class="h-6 flex-1 border-0 bg-transparent px-0 text-[12.5px] shadow-none" />
      </View>
      <If when={linkNote()}>{(note) => <Text class={cn('-mt-1 text-[11.5px]', note().ok ? 'text-ok' : 'text-err')}>{note().text}</Text>}</If>
      <View class="my-1 flex-row items-center gap-2">
        <View class="h-px flex-1 bg-border" />
        <Text class="text-[11px] text-fg-3">{t('或者逐级选择')}</Text>
        <View class="h-px flex-1 bg-border" />
      </View>
      <Row label="Base">
        <SearchSelect
          options={options(bases())}
          value={baseId()}
          onChange={(id) => {
            baseId.set(id)
            tableId.set(undefined)
            viewId.set(undefined)
            linkNote.set(null)
          }}
        />
      </Row>
      <Row label={t('表')}>
        <SearchSelect
          options={baseId() ? options(tables()) : []}
          disabled={!baseId()}
          value={tableId()}
          onChange={(id) => {
            const view = tables()?.find((table) => table.id === id)?.defaultViewId
            tableId.set(id)
            viewId.set(view)
            linkNote.set(null)
            apply({ baseId: baseId(), tableId: id, viewId: view })
          }}
        />
      </Row>
      <Row label={t('视图')}>
        <SearchSelect
          options={tableId() ? options(views()) : []}
          disabled={!tableId()}
          value={viewId()}
          none={t('整张表')}
          onChange={(id) => {
            viewId.set(id)
            linkNote.set(null)
            apply({ baseId: baseId(), tableId: tableId(), viewId: id })
          }}
        />
      </Row>
      <If when={error()}>
        <Text class="text-[12px] text-err" style={{ userSelect: 'text' }}>
          {error()}
        </Text>
      </If>
      <If when={props.confirm}>
        <Button tone="accent" class="mt-2 self-end" disabled={!baseId() || !tableId()} onPress={() => baseId() && tableId() && props.onPick({ baseId: baseId() as string, tableId: tableId() as string, viewId: viewId() })}>
          {t('使用这张表')}
        </Button>
      </If>
    </View>
  )
}

function Row(props: { label: string; children: JSX.Element }) {
  return (
    <View class="flex-row items-center gap-3">
      <Text class="w-10 shrink-0 text-[12px] text-fg-2">{props.label}</Text>
      <View class="min-w-0 flex-1">{props.children}</View>
    </View>
  )
}

const hostOf = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/+$/, '')
