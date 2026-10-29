import { Link2 } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import type { TeableLevel, TeableNode } from '@shared/types'
import { parseTableURL, sameHost } from '@shared/teableURL'
import { Button } from '@/components/kit'
import { SearchSelect } from '@/components/SearchSelect'
import { api, messageOf } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useIssues } from '@/store/issues'

export interface TablePick {
  baseId: string
  tableId: string
  viewId?: string
}

/** One level's options, reloaded whenever its parent changes. */
function useLevel(level: TeableLevel, parentId: string | undefined, onError: (message: string) => void) {
  const [nodes, setNodes] = useState<TeableNode[] | null>(null)
  useEffect(() => {
    setNodes(null)
    if (level !== 'base' && !parentId) return
    let live = true
    api
      .teableBrowse(level, parentId)
      .then((list) => live && setNodes(list))
      .catch((error) => {
        if (!live) return
        setNodes([])
        onError(messageOf(error))
      })
    return () => {
      live = false
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- reload per parent, not per error callback
  }, [level, parentId])
  return nodes
}

/**
 * The issue table, picked the way Teable organises it: base → table → view, bases grouped by
 * space when the token may read space names, each list searchable. Or paste the table's link from
 * the browser and all three fill in — the way database tools take a connection string. Opens on
 * the current table when there is one. With `confirm`, the choice applies on a button; otherwise
 * as soon as a table is picked.
 */
export function TablePicker({
  value,
  onPick,
  confirm,
}: {
  value?: Partial<TablePick>
  onPick: (pick: TablePick) => void
  confirm?: boolean
}) {
  const host = useIssues((s) => s.config?.baseURL ?? '')
  const [error, setError] = useState<string | null>(null)
  const [link, setLink] = useState('')
  const [linkNote, setLinkNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [baseId, setBaseId] = useState(value?.baseId || undefined)
  const [tableId, setTableId] = useState(value?.tableId || undefined)
  const [viewId, setViewId] = useState(value?.viewId || undefined)

  const bases = useLevel('base', undefined, setError)
  const tables = useLevel('table', baseId, setError)
  const views = useLevel('view', tableId, setError)

  const apply = (pick: Partial<TablePick>) => {
    if (!confirm && pick.baseId && pick.tableId) onPick(pick as TablePick)
  }

  const takeLink = (raw: string) => {
    setLink(raw)
    if (!raw.trim()) return setLinkNote(null)
    const parsed = parseTableURL(raw)
    if (!parsed) return setLinkNote({ ok: false, text: t('不是 Teable 的表链接，应该像 …/base/bse…/table/tbl…') })
    if (host && !sameHost(parsed.baseURL, host)) {
      return setLinkNote({
        ok: false,
        text: t('这个链接在 {link}，当前登录的是 {host}', { link: new URL(parsed.baseURL).host, host: hostOf(host) }),
      })
    }
    setError(null)
    setBaseId(parsed.baseId)
    setTableId(parsed.tableId)
    setViewId(parsed.viewId)
    setLinkNote({ ok: true, text: parsed.tableId ? t('已按链接选好') : t('链接只到 base，再选一张表') })
    apply(parsed)
  }

  const row = (label: string, control: ReactNode) => (
    <div className="flex items-center gap-3">
      <span className="w-10 shrink-0 text-[12px] text-fg-2">{label}</span>
      <div className="min-w-0 flex-1">{control}</div>
    </div>
  )

  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-8 items-center gap-2 rounded-md border border-dashed border-input px-2.5 focus-within:border-ring">
        <Link2 className="size-3.5 shrink-0 text-fg-3" />
        <input
          value={link}
          onChange={(event) => takeLink(event.target.value)}
          placeholder={t('粘贴表或视图的链接，自动选好')}
          className="selectable min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fg-3"
        />
      </div>
      {linkNote && <div className={cn('-mt-1 text-[11.5px]', linkNote.ok ? 'text-ok' : 'text-err')}>{linkNote.text}</div>}
      <div className="my-1 flex items-center gap-2 text-[11px] text-fg-3">
        <span className="h-px flex-1 bg-border" />
        {t('或者逐级选择')}
        <span className="h-px flex-1 bg-border" />
      </div>
      {row(
        'Base',
        <SearchSelect
          options={bases}
          value={baseId}
          onChange={(id) => {
            setBaseId(id)
            setTableId(undefined)
            setViewId(undefined)
            setLinkNote(null)
          }}
        />,
      )}
      {row(
        t('表'),
        <SearchSelect
          options={baseId ? tables : []}
          disabled={!baseId}
          value={tableId}
          onChange={(id) => {
            const view = tables?.find((table) => table.id === id)?.defaultViewId
            setTableId(id)
            setViewId(view)
            setLinkNote(null)
            apply({ baseId, tableId: id, viewId: view })
          }}
        />,
      )}
      {row(
        t('视图'),
        <SearchSelect
          options={tableId ? views : []}
          disabled={!tableId}
          value={viewId}
          none={t('整张表')}
          onChange={(id) => {
            setViewId(id)
            setLinkNote(null)
            apply({ baseId, tableId, viewId: id })
          }}
        />,
      )}
      {error && <div className="selectable text-[12px] text-err">{error}</div>}
      {confirm && (
        <Button
          tone="accent"
          className="mt-2 self-end"
          disabled={!baseId || !tableId}
          onClick={() => baseId && tableId && onPick({ baseId, tableId, viewId })}
        >
          {t('使用这张表')}
        </Button>
      )}
    </div>
  )
}

const hostOf = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/+$/, '')
