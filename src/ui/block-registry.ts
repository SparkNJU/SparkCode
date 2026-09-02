// ui/block-registry.ts — FoldableBlock 注册表
// 对标 PaiCLI BlockRegistry.java
// 管理可折叠块的生命周期，提供 Ctrl+O toggle 支持

import type { FoldableBlock } from './foldable-block.js'

export class BlockRegistry {
  private blocks: FoldableBlock[] = []

  /** 注册新块：先冻结所有已有块，再 push 新块 */
  register(block: FoldableBlock): void {
    this.freezeAll()
    this.blocks.push(block)
  }

  /** 切换最后一个块（终端写入）。无块或已冻结时返回 false */
  toggleLast(): boolean {
    const block = this.blocks[this.blocks.length - 1]
    if (!block) return false
    return block.toggle()
  }

  /** 切换最后一个块（仅内存状态，不写终端） */
  toggleLastForRedraw(): boolean {
    const block = this.blocks[this.blocks.length - 1]
    if (!block) return false
    return block.toggleForRedraw()
  }

  /** 冻结所有块 */
  freezeAll(): void {
    for (const block of this.blocks) {
      block.freeze()
    }
  }

  /** 清空所有块 */
  clear(): void {
    this.blocks.length = 0
  }

  /** 已注册块数 */
  size(): number {
    return this.blocks.length
  }
}
