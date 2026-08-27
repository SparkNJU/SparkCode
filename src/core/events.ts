// core/events.ts — 类型化事件总线（emit 广播 + waterfall 中间件链）

/** 事件监听器 */
type Listener<T = unknown> = (data: T) => void | Promise<void>

/** waterfall 处理器：接收当前值 + next 函数，返回变换后的值 */
export type WaterfallHandler<T> = (value: T, next: (v: T) => Promise<T>) => Promise<T>

export class EventBus {
  private listeners = new Map<string, Set<Listener>>()
  private waterfalls = new Map<string, WaterfallHandler<unknown>[]>()

  /** 注册事件监听器，返回 disposer */
  on<T>(event: string, listener: Listener<T>): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener as Listener)
    return () => { set!.delete(listener as Listener) }
  }

  /** 广播事件（通知所有监听器，不等待返回值） */
  emit<T>(event: string, data: T): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const listener of set) {
      Promise.resolve(listener(data)).catch((err) => {
        console.error(`[EventBus] listener error on "${event}":`, err)
      })
    }
  }

  /** 注册 waterfall 处理器，返回 disposer */
  waterfall<T>(event: string, handler: WaterfallHandler<T>): () => void {
    let handlers = this.waterfalls.get(event)
    if (!handlers) {
      handlers = []
      this.waterfalls.set(event, handlers)
    }
    handlers.push(handler as WaterfallHandler<unknown>)
    return () => {
      const arr = this.waterfalls.get(event)
      if (!arr) return
      const idx = arr.indexOf(handler as WaterfallHandler<unknown>)
      if (idx >= 0) arr.splice(idx, 1)
    }
  }

  /** 执行 waterfall 链：初始值依次经过所有处理器变换 */
  async runWaterfall<T>(event: string, initial: T): Promise<T> {
    const handlers = this.waterfalls.get(event) as WaterfallHandler<T>[] | undefined
    if (!handlers || handlers.length === 0) return initial

    // 递归构建链：handlers[0](value, v1 => handlers[1](v1, v2 => ...))
    let idx = 0
    const run = async (value: T): Promise<T> => {
      if (idx >= handlers.length) return value
      const handler = handlers[idx++]!
      return handler(value, run)
    }
    return run(initial)
  }
}
