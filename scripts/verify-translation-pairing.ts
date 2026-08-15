#!/usr/bin/env node
/**
 * 双语 README 配对门禁（对齐 deepseek-harness 官方 docs/i18n/README.md 规范的轻量实现）。
 *
 * 契约要点：
 * 1. 三件套：每份 README.md 必须与 README.zh.md、README.i18n.yaml 同目录共存；
 *    反之，任何一侧"孤儿"文件（缺另外两件）同样是违规。
 * 2. 一致性记录：README.i18n.yaml 记录两侧在"最后确认内容一致"时的 git blob hash
 *    （blob hash = sha1("blob <字节数>\0" + 内容)，与 `git hash-object` 完全一致，
 *    因此对同一 PR 内未提交的工作区文件也可计算，一致性是纯内容比较）。
 *    任一侧被编辑而未重新确认，hash 对不上即红。
 * 3. 语言切换器：中文侧 H1 后须有独立行 `[English](README.md) | 中文`；
 *    英文侧须有 `English | [中文](README.zh.md)`，且链接指向正确的兄弟文件。
 * 4. 结构镜像：两侧的标题层级序列、代码块（info 字符串 + 正文逐字）、表格块（行数×列数）、
 *    列表块（类型、有序列表起始号、项数）、链接目标（切换器行除外，须逐字一致）一一对应。
 *    官方实践：中文文档的内链直接指向英文目标文件（不做 .zh.md 后缀链接），
 *    读者经目标文件自身的切换器切换语言。
 *
 * 用法（package.json 已挂载同名命令）：
 *   pnpm run verify-translation-pairing              # 全量校验，任何违规退出码非 0（CI / doc-sync 形态）
 *   pnpm run verify-translation-pairing -- --list    # 打印每对状态（ok / missing / out-of-sync），永不失败
 *   pnpm run verify-translation-pairing -- bridge    # 只校验指名的配对（目录或三件套中任一文件路径均可）
 *   pnpm run verify-translation-pairing -- --write README.md   # 人工确认两侧一致后，重记录该对的 hash
 *   pnpm run verify-translation-pairing -- --write --all       # 显式的全量重记录
 *
 * 与官方实现的差异（刻意保持轻量）：
 * - 官方 --write 会把快照写入本地 Git 对象库并以 refs 钉住防 GC；本实现只记录 hash，
 *   不做快照存储与合并驱动（merge driver）。
 * - 官方有 exclusion manifest；本仓库扫描时直接按目录名排除（node_modules / .git / 构建产物）。
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'

/** 仓库根目录（脚本位于 <root>/scripts/ 下，向上取一层） */
const ROOT = path.resolve(import.meta.dirname, '..')

/** 扫描时跳过的目录名：依赖树、版本库与构建产物不属于翻译范围 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', 'dist', 'coverage'])

/** 三件套的固定文件名（键名同时用于 i18n.yaml 中的 hash 记录行） */
const EN_NAME = 'README.md'
const ZH_NAME = 'README.zh.md'
const RECORD_NAME = 'README.i18n.yaml'

/** i18n.yaml 文件不存在时生成用的标准注释头（与既有文件保持一致） */
const RECORD_HEADER = [
  '# Bilingual-pair consistency record (docs/i18n/README.md): the git blob hash of each',
  '# side as of the last confirmed-consistent state. Both languages carry equal authority;',
  '# after editing either side, bring the other along and re-record with:',
  `#   pnpm run verify-translation-pairing --write ${EN_NAME}`,
]

/** 一对配对的磁盘位置与派生路径 */
interface Pair {
  /** 配对所在目录（相对仓库根的 posix 路径，用于展示与指认） */
  dir: string
  en: string
  zh: string
  record: string
}

/** 从 Markdown 提取的结构签名：两侧各算一份，逐字段比对 */
interface Signature {
  /** 标题层级序列，如 [1, 2, 2, 3]（只比深度与顺序，不比文本） */
  headings: number[]
  /** 代码块逐字内容（info 字符串 + 围栏内正文原样），跨语言必须完全相同（代码不翻译） */
  fences: string[]
  /** 每个表格块的“行数x列数”描述 */
  tables: string[]
  /** 每个列表块的描述：u=无序 / o:<起始号>=有序，后缀项数 */
  lists: string[]
  /** 围栏外所有行内链接的 target 序列（切换器行的链接被豁免剔除） */
  links: string[]
}

/** 单对配对的校验结论 */
interface Result {
  pair: Pair
  /** ok=三件套齐全且全部检查通过；missing=三件套不完整；out-of-sync=存在违规项 */
  status: 'ok' | 'missing' | 'out-of-sync'
  /** 具体检出的问题列表（空数组表示通过） */
  problems: string[]
}

/* ------------------------------------------------------------------ */
/* 发现：递归扫描仓库，找出所有配对（含孤儿文件所在的不完整配对）        */
/* ------------------------------------------------------------------ */

/** 递归收集所有非排除目录下的 README* 文件（相对根的 posix 路径） */
function collectReadmeFiles(): string[] {
  const found: string[] = []
  const walk = (abs: string, rel: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(path.join(abs, entry.name), `${rel}${entry.name}/`)
      } else if (entry.isFile()) {
        // basename 大小写不敏感匹配 readme.md / readme.zh.md / readme.i18n.yaml
        const lower = entry.name.toLowerCase()
        if (lower === 'readme.md' || lower === 'readme.zh.md' || lower === 'readme.i18n.yaml') {
          found.push(`${rel}${entry.name}`)
        }
      }
    }
  }
  walk(ROOT, '')
  return found.sort()
}

/** 由扫描结果归并出配对清单：任一侧文件出现即构成一个待检目录 */
function discoverPairs(): Pair[] {
  const dirs = new Set<string>()
  for (const file of collectReadmeFiles()) dirs.add(path.posix.dirname(file))
  return [...dirs].sort().map((dir) => ({
    dir,
    en: path.posix.join(dir, EN_NAME),
    zh: path.posix.join(dir, ZH_NAME),
    record: path.posix.join(dir, RECORD_NAME),
  }))
}

/* ------------------------------------------------------------------ */
/* 基础工具：blob hash 与 i18n.yaml 记录的读写                          */
/* ------------------------------------------------------------------ */

/** 计算 git blob hash（sha1("blob <字节数>\0" + 原始字节)，等价 `git hash-object`） */
function blobHash(content: string): string {
  const buf = Buffer.from(content, 'utf8')
  const h = createHash('sha1')
  h.update(`blob ${buf.byteLength}\0`)
  h.update(buf)
  return h.digest('hex')
}

/** 解析 i18n.yaml 中两侧的记录 hash；文件缺失或行缺失返回 null */
function readRecord(pair: Pair): { en: string | null; zh: string | null } {
  if (!existsSync(path.join(ROOT, pair.record))) return { en: null, zh: null }
  const text = readFileSync(path.join(ROOT, pair.record), 'utf8')
  const pick = (name: string): string | null => {
    const m = text.match(new RegExp(`^${name}:\\s*([0-9a-f]{40})\\s*$`, 'm'))
    return m ? m[1] : null
  }
  return { en: pick(EN_NAME), zh: pick(ZH_NAME) }
}

/** 把两侧当前 hash 写回 i18n.yaml：已有文件逐行替换/追加，缺失则带注释头新建 */
function writeRecord(pair: Pair, en: string, zh: string): void {
  const abs = path.join(ROOT, pair.record)
  const entry = (name: string, hash: string): string => `${name}: ${hash}`
  if (!existsSync(abs)) {
    writeFileSync(abs, [...RECORD_HEADER, entry(EN_NAME, en), entry(ZH_NAME, zh), ''].join('\n'))
    return
  }
  const lines = readFileSync(abs, 'utf8').split('\n')
  const next: string[] = []
  let wroteEn = false
  let wroteZh = false
  for (const line of lines) {
    if (line.startsWith(`${EN_NAME}:`)) {
      next.push(entry(EN_NAME, en))
      wroteEn = true
    } else if (line.startsWith(`${ZH_NAME}:`)) {
      next.push(entry(ZH_NAME, zh))
      wroteZh = true
    } else {
      next.push(line)
    }
  }
  // 文件里原本缺哪一行的，补到末尾（去掉可能的尾空行再统一追加）
  while (next.length > 0 && next[next.length - 1] === '') next.pop()
  if (!wroteEn) next.push(entry(EN_NAME, en))
  if (!wroteZh) next.push(entry(ZH_NAME, zh))
  writeFileSync(abs, `${next.join('\n')}\n`)
}

/* ------------------------------------------------------------------ */
/* 结构签名：逐行状态机解析 Markdown 的可比结构                         */
/* ------------------------------------------------------------------ */

/** 判断某行是否为语言切换器独立行（`[English](x) | 中文` 或 `English | [中文](x)`） */
function isSwitcherLine(trimmed: string): boolean {
  return (
    /^\[English\]\([^)]*\)\s*\|\s*中文$/.test(trimmed) ||
    /^English\s*\|\s*\[中文\]\([^)]*\)$/.test(trimmed)
  )
}

/**
 * 提取 Markdown 结构签名。
 * 已知简化（对本仓库 README 足够，且两侧适用同一套规则，比对仍然对称）：
 * - 列表项按“匹配行”逐行计数，嵌套缩进的子项同样计为一项（两侧计数规则一致，可比性不受影响）；
 * - 表格列数按行内 `|` 分隔段数 - 1 计算，不含单元格内转义 `\\|` 的特殊处理。
 */
function parseSignature(text: string): Signature {
  const sig: Signature = { headings: [], fences: [], tables: [], lists: [], links: [] }
  const lines = text.split('\n')

  let inFence = false          // 当前是否在代码围栏内
  let fenceMarker = ''         // 围栏字符（``` 或 ~~~），用于识别闭合
  let fenceInfo = ''           // 围栏首行的 info 字符串（如 ts、yaml）
  let fenceBody: string[] = [] // 围栏正文行
  let tableRows: string[] = [] // 当前连续表格行块
  let listRows: string[] = []  // 当前连续列表项行块

  /** 表格块结束：记录“行数x列数”并清空缓冲 */
  const flushTable = (): void => {
    if (tableRows.length === 0) return
    const cols = tableRows[0].split('|').length - 1
    sig.tables.push(`${tableRows.length}x${cols}`)
    tableRows = []
  }

  /** 列表块结束：记录类型（有序含起始号）与项数并清空缓冲 */
  const flushList = (): void => {
    if (listRows.length === 0) return
    const first = listRows[0]
    const ordered = /^\s*\d/.test(first)
    const start = ordered ? (first.trim().match(/^(\d+)/)?.[1] ?? '') : ''
    sig.lists.push(`${ordered ? `o:${start}` : 'u'}(${listRows.length})`)
    listRows = []
  }

  for (const raw of lines) {
    const trimmed = raw.trim()

    // --- 围栏内：正文逐字收集，不做任何结构解析 ---
    if (inFence) {
      if (new RegExp(`^ {0,3}${fenceMarker}+\\s*$`).test(raw)) {
        sig.fences.push(`${fenceInfo}\n${fenceBody.join('\n')}`)
        inFence = false
      } else {
        fenceBody.push(raw)
      }
      continue
    }

    // --- 围栏开启：```ts / ~~~sh 等 ---
    const fenceOpen = raw.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (fenceOpen) {
      flushTable()
      flushList()
      inFence = true
      fenceMarker = fenceOpen[1][0] === '`' ? '`' : '~'
      fenceInfo = fenceOpen[2].trim()
      fenceBody = []
      continue
    }

    // --- 标题：只记录层级（# 的个数） ---
    const heading = trimmed.match(/^(#{1,6})\s/)
    if (heading) {
      flushTable()
      flushList()
      sig.headings.push(heading[1].length)
    }

    // --- 表格行：以 | 开头的连续行归为一块 ---
    if (/^ {0,3}\|/.test(raw)) {
      flushList()
      tableRows.push(trimmed)
    } else {
      flushTable()
    }

    // --- 列表项：`-`/`*`/`+` 或 `1.`/`1)` 开头；相邻项归为一块 ---
    if (/^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/.test(raw)) {
      flushTable()
      listRows.push(trimmed)
    } else if (!/^ {0,3}\|/.test(raw)) {
      flushList()
    }

    // --- 链接：收集围栏外所有 [text](target)；切换器行整体豁免 ---
    if (!isSwitcherLine(trimmed)) {
      for (const m of raw.matchAll(/\[([^\]]*)\]\(([^)\s]*)\)/g)) sig.links.push(m[2])
    }
  }

  // 文件结束时收尾尚未闭合的块（未闭合围栏按正文收尾，异常结构交给两侧对称性去暴露）
  if (inFence) sig.fences.push(`${fenceInfo}\n${fenceBody.join('\n')}`)
  flushTable()
  flushList()
  return sig
}

/** 逐字段比对两侧签名，返回全部差异描述 */
function diffSignatures(en: Signature, zh: Signature): string[] {
  const problems: string[] = []
  const cmp = (label: string, a: unknown[], b: unknown[]): void => {
    if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${label} 不一致: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)
  }
  cmp('标题层级序列', en.headings, zh.headings)
  cmp('代码块', en.fences, zh.fences)
  cmp('表格结构', en.tables, zh.tables)
  cmp('列表结构', en.lists, zh.lists)
  cmp('链接目标', en.links, zh.links)
  return problems
}

/* ------------------------------------------------------------------ */
/* 核心校验：三件套完整性 → hash → 切换器 → 结构签名                   */
/* ------------------------------------------------------------------ */

function verifyPair(pair: Pair): Result {
  const problems: string[] = []
  const absEn = path.join(ROOT, pair.en)
  const absZh = path.join(ROOT, pair.zh)

  // 1) 三件套完整性
  const missing: string[] = []
  if (!existsSync(absEn)) missing.push(EN_NAME)
  if (!existsSync(absZh)) missing.push(ZH_NAME)
  if (!existsSync(path.join(ROOT, pair.record))) missing.push(RECORD_NAME)
  if (missing.length > 0) {
    return { pair, status: 'missing', problems: [`配对不完整，缺少: ${missing.join(', ')}`] }
  }

  const enText = readFileSync(absEn, 'utf8')
  const zhText = readFileSync(absZh, 'utf8')

  // 2) hash 与记录一致（编辑任一侧而未重新确认即红）
  const record = readRecord(pair)
  if (record.en !== blobHash(enText)) problems.push(`${EN_NAME} 当前内容与 i18n.yaml 记录的 hash 不符（编辑后未重新确认配对）`)
  if (record.zh !== blobHash(zhText)) problems.push(`${ZH_NAME} 当前内容与 i18n.yaml 记录的 hash 不符（编辑后未重新确认配对）`)

  // 3) 语言切换器：两侧各自紧跟 H1 的位置须有规范形态的切换行，且指向正确的兄弟文件
  const earlyLines = enText.split('\n').slice(0, 10).map((l) => l.trim())
  if (!earlyLines.some((l) => l === `English | [中文](${ZH_NAME})`)) {
    problems.push(`${EN_NAME} 缺少语言切换行 "English | [中文](${ZH_NAME})"`)
  }
  const zhEarlyLines = zhText.split('\n').slice(0, 10).map((l) => l.trim())
  if (!zhEarlyLines.some((l) => l === `[English](${EN_NAME}) | 中文`)) {
    problems.push(`${ZH_NAME} 缺少语言切换行 "[English](${EN_NAME}) | 中文"`)
  }

  // 4) 结构镜像
  problems.push(...diffSignatures(parseSignature(enText), parseSignature(zhText)))

  return { pair, status: problems.length === 0 ? 'ok' : 'out-of-sync', problems }
}

/* ------------------------------------------------------------------ */
/* CLI：参数解析与入口                                                  */
/* ------------------------------------------------------------------ */

/** 把用户指认的配对参数（三件套任一文件路径或目录路径）归一化为配对目录 */
function normalizePairArg(arg: string): string | null {
  const abs = path.resolve(ROOT, arg)
  if (!existsSync(abs)) return null
  const stat = statSync(abs)
  const dirAbs = stat.isDirectory() ? abs : path.dirname(abs)
  return path.posix.relative(ROOT, dirAbs).split(path.sep).join('/')
}

function main(): number {
  const rawArgs = process.argv.slice(2).filter((a) => a !== '--')
  const wantList = rawArgs.includes('--list')
  const wantWrite = rawArgs.includes('--write')
  const wantAll = rawArgs.includes('--all')
  const pairArgs = rawArgs.filter((a) => !a.startsWith('--'))

  if (wantList && wantWrite) {
    console.error('--list 与 --write 不能同时使用')
    return 2
  }
  if (wantWrite && pairArgs.length === 0 && !wantAll) {
    console.error('--write 需要显式指名确认的配对（目录或文件路径），全量重记录请使用 --write --all')
    return 2
  }

  const allPairs = discoverPairs()

  // 指名模式：把参数归一化为配对目录，必须在发现清单中
  let targets = allPairs
  if (pairArgs.length > 0) {
    const dirs = new Set<string>()
    for (const arg of pairArgs) {
      const dir = normalizePairArg(arg)
      if (dir === null || !allPairs.some((p) => p.dir === dir)) {
        console.error(`无法识别的配对参数: ${arg}（可用: ${allPairs.map((p) => p.dir).join(', ')}）`)
        return 2
      }
      dirs.add(dir)
    }
    targets = allPairs.filter((p) => dirs.has(p.dir))
  }

  // --write：重记录指名（或 --all 全量）配对的两侧 hash，随后立即复检并按结果退出
  if (wantWrite) {
    const chosen = wantAll ? allPairs : targets
    for (const pair of chosen) {
      const absEn = path.join(ROOT, pair.en)
      const absZh = path.join(ROOT, pair.zh)
      if (!existsSync(absEn) || !existsSync(absZh)) {
        console.error(`跳过 ${pair.dir}：三件套不完整，无法记录`)
        continue
      }
      writeRecord(pair, blobHash(readFileSync(absEn, 'utf8')), blobHash(readFileSync(absZh, 'utf8')))
      console.log(`已重记录 ${pair.record}`)
    }
    targets = chosen
  }

  // 校验并输出
  let bad = 0
  for (const result of targets.map(verifyPair)) {
    const label = result.pair.dir === '.' ? 'README' : `${result.pair.dir}/README`
    if (result.status === 'ok') {
      console.log(`ok            ${label}`)
    } else {
      bad++
      console.log(`${result.status.padEnd(13)} ${label}`)
      for (const problem of result.problems) console.log(`              - ${problem}`)
    }
  }

  if (wantList) return 0 // --list 只报告，永不失败
  if (bad > 0) {
    console.error(`\n${bad} 个配对违规。修复后执行 pnpm run verify-translation-pairing -- --write <pair> 重新确认。`)
    return 1
  }
  console.log(`\n全部 ${targets.length} 个配对一致。`)
  return 0
}

process.exit(main())
