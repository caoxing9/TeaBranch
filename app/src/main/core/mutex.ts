import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Promise-chain mutex. Node has one thread, but every service here awaits subprocesses, so two
 * starts of the same branch would otherwise interleave across their `await`s exactly the way two
 * threads did in the Swift build.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(body: () => Promise<T>): Promise<T> {
    const next = this.tail.then(body, body)
    this.tail = next.catch(() => undefined)
    return next
  }
}

/**
 * One mutex per key, so work on the *same* branch serialises and different branches don't wait.
 *
 * Re-entrant per async call chain: `stop` nested inside a delete or restart already holds the
 * branch and must not wait on itself. Which keys a chain holds is tracked in `AsyncLocalStorage`
 * — a plain "held" set would let an unrelated concurrent caller walk straight past the lock.
 */
export class KeyedMutex {
  private readonly locks = new Map<string, Mutex>()
  private readonly context = new AsyncLocalStorage<ReadonlySet<string>>()

  run<T>(key: string, body: () => Promise<T>): Promise<T> {
    const held = this.context.getStore()
    if (held?.has(key)) return body()

    let lock = this.locks.get(key)
    if (!lock) {
      lock = new Mutex()
      this.locks.set(key, lock)
    }
    const nextHeld = new Set(held ?? [])
    nextHeld.add(key)
    return lock.run(() => this.context.run(nextHeld, body))
  }
}
