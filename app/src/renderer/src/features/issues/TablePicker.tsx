import { useEffect, useState } from 'react'
import { t } from '@shared/i18n'
import type { TeableLevel, TeableNode } from '@shared/types'
import { Button, inputClass } from '@/components/kit'
import { api, messageOf } from '@/lib/api'

export interface TablePick {
  baseId: string
  tableId: string
  viewId?: string
}

/** Nodes in runs of the same group (bases by space), in the order they came. */
function groups(nodes: TeableNode[]): [string | undefined, TeableNode[]][] {
  const runs: [string | undefined, TeableNode[]][] = []
  for (const node of nodes) {
    const last = runs.at(-1)
    if (last && last[0] === node.group) last[1].push(node)
    else runs.push([node.group, [node]])
  }
  return runs
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
 * space when the token may read space names. Lists come from the signed-in account, so nothing is
 * typed or pasted. Opens on the current table when there is one. With `confirm`, the choice applies on a button; otherwise as soon as a table is picked.
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
  const [error, setError] = useState<string | null>(null)
  const [baseId, setBaseId] = useState(value?.baseId || undefined)
  const [tableId, setTableId] = useState(value?.tableId || undefined)
  const [viewId, setViewId] = useState(value?.viewId || undefined)

  const bases = useLevel('base', undefined, setError)
  const tables = useLevel('table', baseId, setError)
  const views = useLevel('view', tableId, setError)

  const apply = (pick: Partial<TablePick>) => {
    if (!confirm && pick.baseId && pick.tableId) onPick(pick as TablePick)
  }

  const select = (
    label: string,
    nodes: TeableNode[] | null,
    current: string | undefined,
    onChange: (id: string | undefined) => void,
    disabled: boolean,
    none?: string,
  ) => (
    <label className="flex items-center gap-3">
      <span className="w-36 shrink-0 text-[12px] text-fg-2">{label}</span>
      <select
        value={current ?? ''}
        disabled={disabled || !nodes}
        onChange={(event) => onChange(event.target.value || undefined)}
        className={inputClass}
      >
        <option value="">{disabled ? '—' : !nodes ? t('加载中…') : (none ?? t('选择…'))}</option>
        {groups(nodes ?? []).map(([group, members]) => {
          const options = members.map((node) => (
            <option key={node.id} value={node.id}>
              {node.name}
            </option>
          ))
          return group ? (
            <optgroup key={group} label={group}>
              {options}
            </optgroup>
          ) : (
            options
          )
        })}
      </select>
    </label>
  )

  return (
    <div className="flex flex-col gap-2">
      {select(
        'Base',
        bases,
        baseId,
        (id) => {
          setBaseId(id)
          setTableId(undefined)
          setViewId(undefined)
        },
        false,
      )}
      {select(
        t('表'),
        tables,
        tableId,
        (id) => {
          const view = tables?.find((table) => table.id === id)?.defaultViewId
          setTableId(id)
          setViewId(view)
          apply({ baseId, tableId: id, viewId: view })
        },
        !baseId,
      )}
      {select(
        t('视图'),
        views,
        viewId,
        (id) => {
          setViewId(id)
          apply({ baseId, tableId, viewId: id })
        },
        !tableId,
        t('整张表'),
      )}
      {error && <div className="text-[12px] text-err">{error}</div>}
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
