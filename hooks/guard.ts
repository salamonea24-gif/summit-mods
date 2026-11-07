// The Summit guardrail's rules, as pure functions so they can be tested.
// A verdict is one of:
//   allow                         the call goes ahead
//   block   (reason)              never allowed, whoever asks
//   needsYes(title, key, group)   allowed only once Anthony approves the matching line
//   outside (reason)              outside the two Summit folders (report-only on day one)

import { ALLOWED_MOUNTS, PC_DATA, PC_HOME, PC_ROOT } from './config'

export type Verdict =
  | { kind: 'allow' }
  | { kind: 'block'; reason: string }
  | { kind: 'needsYes'; title: string; key: string; group: string; why: string }
  | { kind: 'outside'; reason: string }

const ALLOW: Verdict = { kind: 'allow' }

// Never touched by any session (house rules section 3).
const FORBIDDEN: { test: RegExp; reason: string }[] = [
  { test: /settings\.ini(?!\.example)/i, reason: 'settings.ini is never opened, printed or copied by any session.' },
  { test: /(^|[\\/"'\s])Indicators([\\/"'\s]|$)/, reason: 'the Indicators folder is private and off limits.' },
  { test: /journal\.db|[\\/]journal[\\/]|positions\.(csv|json|db|xlsx)/i, reason: 'the journal and positions are off limits.' },
  { test: /(^|[\\/\s"'])\.env(\.|\b|$)|\.pem\b|id_rsa|credentials?\.json|secrets?\.(json|txt|ini|ya?ml)/i, reason: 'keys and credentials are never handled by any session.' },
]

// Tools that move money or trade.
const MONEY_TOOL = /stripe|place_?order|submit_?order|payment|checkout|purchase|brokerage|trade_?execute/i

// Public sends that need Anthony's yes. Social posts that passed QA are exempt (3 Nov rule).
const SEND_COMMANDS: { test: RegExp; title: string; group: string }[] = [
  { test: /ghost_send\.py(?![^\n]*--check)/i, title: 'Send a newsletter through Ghost', group: 'Launch blockers' },
  { test: /send_daily_now\.bat/i, title: 'Send Summit Daily now', group: 'Launch blockers' },
  { test: /wrangler\b|pages\s+deploy|cloudflare.*(upload|deploy)/i, title: 'Upload the site to Cloudflare', group: 'Launch blockers' },
  { test: /admin\/api\/.*(posts|newsletters|members)/i, title: 'Publish through the Ghost admin API', group: 'Launch blockers' },
]
const SEND_TOOL = /(send_?(email|message|newsletter)|gmail.*send|create_?campaign|publish_?post)/i

// Files whose change needs a yes.
const YES_PATHS: { test: RegExp; title: string; group: string; why: string }[] = [
  { test: /Pine Scripts/i, title: 'Change a Pine script', group: 'Scanner and code', why: 'Pine scripts change only with your yes, asked each time.' },
  { test: /[\\/]scanner[\\/][^\\/]+\.(py|html|js|css)$/i, title: 'Ship a scanner code change', group: 'Scanner and code', why: 'Every scanner code change shipped to the PC needs your yes.' },
  { test: /scheduled-tasks?(-prompt)?\.md$|house-rules[^\\/]*\.md$/i, title: 'Change a scheduled task or house rule', group: 'Decide first', why: 'Changes to the house rules or a scheduled task’s instructions need your yes.' },
]
const TRIGGER_EDIT = /claude-code-remote__(update_trigger|create_trigger|delete_trigger)$|^RemoteTrigger$/

const WRITE_TOOLS = /^(Write|Edit|NotebookEdit|MultiEdit)$/
const READ_TOOLS = /^(Read|Glob|Grep)$/

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export function inputText(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input)
  } catch {
    return ''
  }
}

function lower(s: string) {
  return s.replace(/\//g, '\\').toLowerCase()
}

// A Windows path on the PC: is it inside the two Summit folders?
export function insideSummit(path: string): boolean {
  const p = lower(path)
  return p.startsWith(lower(PC_ROOT)) || p.startsWith(lower(PC_DATA))
}

function isPcUserPath(path: string): boolean {
  return lower(path).startsWith(lower(PC_HOME) + '\\')
}

// Claude's own folders under the home folder stay usable.
function isClaudeOwn(path: string): boolean {
  const p = lower(path)
  return /\\\.claude(\\|$)|\\appdata\\local\\temp(\\|$)|\\appdata\\roaming\\claude(\\|$)/.test(p)
}

// Short, stable key for a gated action, so a yes is matched to the same action.
export function gateKey(tool: string, target: string): string {
  let h = 2166136261
  const s = `${tool}|${target}`
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return 'g' + (h >>> 0).toString(36)
}

function needsYes(tool: string, target: string, title: string, group: string, why: string): Verdict {
  return { kind: 'needsYes', title, group, why, key: gateKey(tool, target) }
}

function shortTarget(s: string): string {
  const parts = s.split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join('\\') || s
}

// The parts of a call that name places on disk or commands: what the hard stops read.
// Written content (a doc that mentions settings.ini, say) is not a target.
export function targets(input: Record<string, unknown>): string {
  const out: string[] = []
  for (const k of ['file_path', 'notebook_path', 'path', 'command', 'pattern', 'devicePath', 'stagedPath']) {
    if (typeof input[k] === 'string') out.push(input[k] as string)
  }
  for (const k of ['paths', 'files']) {
    const v = input[k]
    if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === 'string') out.push(x)
        else if (x && typeof x === 'object') out.push(str((x as Record<string, unknown>).devicePath), str((x as Record<string, unknown>).stagedPath))
      }
    }
  }
  return out.filter(Boolean).join('\n')
}

// A shell command that only reads: no redirection, copy, move, delete or in-place edit.
export function isReadOnlyCommand(command: string): boolean {
  if (/[>|]\s*[^|&\s]|\b(cp|mv|rm|rmdir|del|copy|move|tee|touch|mkdir|chmod|python|py|powershell|cmd|bash|sh|git|sed\s+-i|perl\s+-i)\b/i.test(command.replace(/\|\s*(head|tail|grep|wc|sort|uniq|cut|md5sum)\b/g, ''))) {
    return false
  }
  return /^\s*(cd\s+[^;&|]+&&\s*)?(cat|head|tail|ls|grep|wc|find|md5sum|stat|file|diff)\b/.test(command)
}

export function classify(tool: string, input: Record<string, unknown>): Verdict {
  const text = inputText(input)
  const where = targets(input)

  // 1. Hard stops, on the paths and commands of any tool, whatever the spelling.
  for (const f of FORBIDDEN) {
    if (f.test.test(where)) return { kind: 'block', reason: f.reason }
  }
  if (tool.startsWith('mcp__') && MONEY_TOOL.test(tool)) {
    return { kind: 'block', reason: 'trades and payments are never handled by any session.' }
  }

  // 2. Scheduled task instructions.
  if (TRIGGER_EDIT.test(tool)) {
    const name = str(input.name) || str(input.trigger_id) || 'a scheduled task'
    return needsYes(tool, text, `Change the scheduled task "${name}"`, 'Decide first', 'Changes to a scheduled task’s instructions need your yes.')
  }

  // 3. Public sends.
  if (tool.startsWith('mcp__') && SEND_TOOL.test(tool) && !tool.startsWith('mcp__hearthbot__')) {
    const to = str(input.to) || str(input.recipient) || str(input.subject)
    return needsYes(tool, text, `Send a message${to ? ` (${to.slice(0, 60)})` : ''}`, 'Launch blockers', 'Messages to anyone but you need your yes.')
  }
  const command = str(input.command)
  if (command) {
    for (const s of SEND_COMMANDS) {
      if (s.test.test(command)) return needsYes(tool, command, s.title, s.group, 'Publishing anything public needs your yes.')
    }
    const pine = YES_PATHS[0]!
    if (pine.test.test(command) && !isReadOnlyCommand(command)) {
      return needsYes(tool, command, pine.title, pine.group, pine.why)
    }
  }

  // 4. File writes that need a yes (local tools, and copies onto the PC).
  const writePaths: string[] = []
  if (WRITE_TOOLS.test(tool)) writePaths.push(str(input.file_path) || str(input.notebook_path))
  if (tool.endsWith('device_commit_files') && Array.isArray(input.files)) {
    for (const f of input.files as Record<string, unknown>[]) writePaths.push(str(f?.devicePath))
  }
  for (const p of writePaths.filter(Boolean)) {
    for (const y of YES_PATHS) {
      if (y.test.test(p)) return needsYes(tool, p, `${y.title}: ${shortTarget(p)}`, y.group, y.why)
    }
  }

  // 5. Folder scope on the PC.
  const pcPaths: string[] = []
  if (WRITE_TOOLS.test(tool) || READ_TOOLS.test(tool)) {
    const p = str(input.file_path) || str(input.path) || str(input.notebook_path)
    if (p) pcPaths.push(p)
  }
  if (/device_(list_dir|stage_files|commit_files|request_folder_access)$/.test(tool)) {
    if (str(input.path)) pcPaths.push(str(input.path))
    if (Array.isArray(input.paths)) pcPaths.push(...(input.paths as unknown[]).map(str))
    if (Array.isArray(input.files)) pcPaths.push(...(input.files as Record<string, unknown>[]).map(f => str(f?.devicePath)))
  }
  for (const p of pcPaths.filter(Boolean)) {
    const winish = /^[a-z]:[\\/]|^~[\\/]/i.test(p)
    if (!winish) continue
    const full = p.startsWith('~') ? PC_HOME + p.slice(1) : p
    if (insideSummit(full) || isClaudeOwn(full)) continue
    if (isPcUserPath(full) || /^[a-z]:[\\/]/i.test(full)) {
      return { kind: 'outside', reason: `${full} is outside the two Summit folders.` }
    }
  }
  if (tool.endsWith('device_bash') && command) {
    const mounts = [...command.matchAll(/mnt\/([^/"'\n]+)/g)].map(m => (m[1] ?? '').trim())
    const bad = mounts.find(m => !ALLOWED_MOUNTS.includes(m))
    if (bad) return { kind: 'outside', reason: `the folder "${bad}" is outside the two Summit folders.` }
  }

  return ALLOW
}
