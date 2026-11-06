import { batch, type Signal, signal } from 'nsh'

/**
 * A store, as zustand's `create` gave the React build one: a field per key, read by calling
 * (`app.section()`), written together with `set(patch)`. Each field is its own signal, so a view
 * that reads one field re-renders for that field only.
 */
export type Fields<T> = { readonly [K in keyof T]: Signal<T[K]> }

export interface Store<T extends object> {
  /** The whole state, as of now (not tracked). */
  get(): T
  /** Writes every key of `patch`, in one batch. */
  set(patch: Partial<T>): void
}

export function createStore<T extends object>(initial: T): Fields<T> & Store<T> {
  const fields = Object.fromEntries(Object.entries(initial).map(([key, value]) => [key, signal(value)])) as Fields<T>
  const get = (): T =>
    Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, (field as Signal<unknown>)()])) as T
  const set = (patch: Partial<T>): void =>
    batch(() => {
      for (const [key, value] of Object.entries(patch)) (fields[key as keyof T] as Signal<unknown>).set(value)
    })
  return Object.assign(fields, { get, set })
}
