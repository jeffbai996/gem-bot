/** Close admission and await every in-flight Discord write before terminal output. */
export class TurnOutput {
  private closed = false
  private pending = new Set<Promise<void>>()

  run(write: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.resolve()
    const task = Promise.resolve().then(write)
    this.pending.add(task)
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task))
    return task
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.pending])
  }
}
