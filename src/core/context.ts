// core/context.ts — 服务仓库（依赖注入容器）

import { EventBus } from './events.js'

export class Context {
  readonly events: EventBus
  private services = new Map<string, unknown>()

  constructor() {
    this.events = new EventBus()
  }

  /** 注册服务 */
  provide<T>(key: string, value: T): void {
    this.services.set(key, value)
  }

  /** 查找服务（未找到抛错） */
  get<T>(key: string): T {
    const value = this.services.get(key)
    if (value === undefined) {
      throw new Error(`[Context] service "${key}" not found`)
    }
    return value as T
  }

  /** 快捷方法：广播事件 */
  emit<T>(event: string, data: T): void {
    this.events.emit(event, data)
  }

  /** 快捷方法：执行 waterfall */
  waterfall<T>(event: string, initial: T): Promise<T> {
    return this.events.runWaterfall(event, initial)
  }
}
