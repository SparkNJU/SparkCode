// skills/loader.ts — Skill 加载器

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

/** Skill 定义 */
export interface SkillDefinition {
  name: string
  description: string
  body: string
  source: 'user' | 'project'
}

/** 解析 YAML frontmatter（极简实现） */
function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { meta: {}, body: content }

  const meta: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const colonIndex = line.indexOf(':')
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim()
      const value = line.slice(colonIndex + 1).trim()
      meta[key] = value
    }
  }

  return { meta, body: match[2] }
}

/** 加载目录下的所有 Skill */
async function loadSkillsFromDir(dir: string, source: 'user' | 'project'): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = []

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue

      const name = entry.name.replace(/\.md$/, '')
      const content = await fs.readFile(path.join(dir, entry.name), 'utf-8')
      const { meta, body } = parseFrontmatter(content)

      skills.push({
        name,
        description: meta.description ?? '无描述',
        body,
        source,
      })
    }
  } catch {
    // 目录不存在，忽略
  }

  return skills
}

/** 加载所有 Skill（项目级覆盖用户级同名） */
export async function loadAllSkills(cwd: string): Promise<SkillDefinition[]> {
  const userDir = path.join(os.homedir(), '.spark', 'commands')
  const projectDir = path.join(cwd, '.spark', 'commands')

  const userSkills = await loadSkillsFromDir(userDir, 'user')
  const projectSkills = await loadSkillsFromDir(projectDir, 'project')

  // 合并：项目级覆盖用户级同名
  const merged = new Map<string, SkillDefinition>()
  for (const skill of userSkills) merged.set(skill.name, skill)
  for (const skill of projectSkills) merged.set(skill.name, skill)

  return [...merged.values()]
}
