/**
 * Promise-chain mutex. One thread, but every service here awaits subprocesses, so two starts of
 * the same branch would otherwise interleave across their `await`s exactly the way two threads
 * did in the Swift build.
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
 * branch and must not wait on itself. QuickJS has no `AsyncLocalStorage`, so a chain that holds a
 * key passes the `Held` it was given to nested calls: `run(key, body)` gives `body` a `Held`, and
 * `body` runs nested work with `held.run(key, …)`, which walks straight through for keys it holds.
 */
export class KeyedMutex {
  private readonly locks = new Map<string, Mutex>()

  run<T>(key: string, body: (held: Held) => Promise<T>, held?: Held): Promise<T> {
    if (held?.has(key)) return body(held)
    let lock = this.locks.get(key)
    if (!lock) {
      lock = new Mutex()
      this.locks.set(key, lock)
    }
    const nextHeld = new Held(this, new Set([...(held?.keys ?? []), key]))
    return lock.run(() => body(nextHeld))
  }
}

/** The keys an async chain holds; nested work runs through it. */
export class Held {
  constructor(
    private readonly mutex: KeyedMutex,
    readonly keys: ReadonlySet<string>,
  ) {}

  has(key: string): boolean {
    return this.keys.has(key)
  }

  run<T>(key: string, body: (held: Held) => Promise<T>): Promise<T> {
    return this.mutex.run(key, body, this)
  }
}
