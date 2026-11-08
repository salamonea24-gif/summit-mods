import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { BoardItem, BoardMsg, Correction, GuardEvent, HealthState, PaneData, PaneRow } from '../types'
import * as board from './board'
import type { Call, Doc } from './board'
import { BOARD_URL, GROUP_ORDER, LOGS, PC_ROOT } from './config'
import { bandText, liveOnes, promptSection, skillsFor } from './corrections'
import { classify } from './guard'
import type { Verdict } from './guard'
import { dailyLine, etParts, newProblems, sentinelLine, slotLines, statusText, weekReport, weeklyLine } from './health'
import type { Health } from './health'
import { describe, publicWords, scan } from './prepublish'

const PANE = 'summit-waiting'
const PANE_TITLE = 'Waiting on you'

const pane = atom({ plugin: 'summit', key: 'pane' } as const, { rows: [], loadedAt: 0, error: null } as PaneData, { shape: 'pane-1' })
const tab = atom({ plugin: 'summit', key: 'tab' } as const, 'needs' as 'needs' | 'claude' | 'done' | 'held')
const health = atom({ plugin: 'summit', key: 'health' } as const, null as HealthState | null, { shape: 'health-1' })
const corrections = atom({ plugin: 'summit', key: 'corrections' } as const, [] as Correction[], { shape: 'corrections-1' })
const guardLog = atom({ plugin: 'summit', key: 'guardLog' } as const, [] as GuardEvent[], { shape: 'guard-1' })

type Dollar = Parameters<Parameters<Parameters<Register>[0]>[2]>[0]

const DEVICE_BASH = 'mcp__remote-devices__device_bash'
const DAY = 24 * 3600 * 1000

function resultText(r: Record<string, unknown>): string {
  if (typeof r.text === 'string' && r.text) return r.text
  const res = r.result as unknown
  if (typeof res === 'string') return res
  if (Array.isArray(res)) return res.map(b => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('\n')
  if (res && typeof res === 'object') {
    const o = res as Record<string, unknown>
    if (typeof o.stdout === 'string') return o.stdout
    if (Array.isArray(o.content)) return resultText({ result: o.content })
    return JSON.stringify(o)
  }
  return ''
}

// Every board read and write goes through the ArtifactData tool, as the person.
function boardCall($: Dollar): Call {
  return async input => {
    const r = (await $.tool.call({ tool: 'ArtifactData', ...input } as never)) as unknown as Record<string, unknown>
    if (typeof r.deny === 'string') return { text: '', deny: r.deny }
    return { text: resultText(r) }
  }
}

async function hasTool($: Dollar, name: string): Promise<boolean> {
  try {
    return (await $.tool.list()).some(t => t.name === name)
  } catch {
    return false
  }
}

// ---------- reading the PC's files: locally on the PC, through folder access in the cloud

type Reader = { source: 'pc' | 'cloud' | 'none'; text: (rel: string) => Promise<string>; list: (rel: string) => Promise<string[]> }

async function reader($: Dollar): Promise<Reader> {
  try {
    if (await $.fs.exists(`${PC_ROOT}\\README.md`)) {
      return {
        source: 'pc',
        text: rel => $.fs.read(`${PC_ROOT}\\${rel}`).catch(() => ''),
        list: rel => $.fs.list(`${PC_ROOT}\\${rel}`).then(es => es.map(x => x.name)).catch(() => [] as string[]),
      }
    }
  } catch {
    // Not on the PC.
  }
  if (await hasTool($, DEVICE_BASH)) {
    const run = async (command: string) => {
      try {
        const r = (await $.tool.call({ tool: DEVICE_BASH, command } as never)) as unknown as Record<string, unknown>
        return typeof r.deny === 'string' ? '' : resultText(r)
      } catch {
        return ''
      }
    }
    const posix = (rel: string) => `$HOME/mnt/Stock Scanner/${rel.replace(/\\/g, '/')}`
    return {
      source: 'cloud',
      text: rel => run(`tail -n 600 "${posix(rel)}" 2>/dev/null`),
      list: async rel => (await run(`ls -1 "${posix(rel)}" 2>/dev/null`)).split(/\r?\n/).map(s => s.trim()).filter(Boolean),
    }
  }
  return { source: 'none', text: async () => '', list: async () => [] }
}

async function collectHealth($: Dollar, pendingTitles: string[]): Promise<Health> {
  const now = await $.clock.now()
  const et = etParts(now)
  const r = await reader($)
  // The shared summary the PC writes, when it exists, is the first choice.
  const summary = await r.text('summit\\workspace\\ops\\health.json')
  if (summary) {
    try {
      const sum = JSON.parse(summary) as Health
      if (sum && sum.date === et.date && sum.daily && Array.isArray(sum.slots)) {
        const waitingOnYou = pendingTitles.some(t => /sentinel issue/i.test(t))
        const sentinel = waitingOnYou && sum.sentinel.light === 'ok' ? { ...sum.sentinel, light: 'warn' as const, text: `${sum.sentinel.text}, waiting on your yes` } : sum.sentinel
        return { ...sum, sentinel, source: r.source }
      }
    } catch {
      // Fall through to the logs.
    }
  }
  const [dailyLog, socialLog, drafts, issues] = await Promise.all([
    r.text(LOGS.daily),
    r.text(LOGS.social),
    r.list(LOGS.weeklyDrafts),
    r.list(LOGS.sentinelIssues),
  ])
  if (r.source === 'none' || (!dailyLog && !socialLog)) {
    const off = { light: 'off' as const, text: 'cannot reach the PC from here' }
    return {
      date: et.date,
      checkedAt: now,
      daily: { name: 'Daily', ...off },
      weekly: { name: 'Weekly free', ...off },
      sentinel: { name: 'Sentinel', ...off },
      slots: ['8:30', '10:00', '12:30', '6 pm'].map(name => ({ name, ...off })),
      source: 'none',
    }
  }
  return {
    date: et.date,
    checkedAt: now,
    daily: dailyLine(dailyLog, et.date, et.minutes, et.weekday),
    weekly: weeklyLine(drafts, dailyLog, et.date, et.weekday),
    sentinel: sentinelLine(issues, pendingTitles),
    slots: slotLines(socialLog, et.date, et.minutes),
    source: r.source,
  }
}

// ---------- the pack

// Background work never leaves an unhandled rejection behind.
function quiet(p: Promise<unknown>): void {
  p.catch(() => undefined)
}

const mem = { boardItems: [] as Doc<BoardItem>[], lastDenied: null as { key: string; title: string } | null, seenMsgAt: 0 }
const SCHEMA_PATH = '/mnt/project-files/ops/waiting-on-anthony-schema.md'

function unlocksOf(id: string, rows: PaneRow[]): number {
  return board.unlockCount(id, rows.map(r => ({ id: r.id, version: r.version, data: r.item })))
}

// An answer Anthony gave on the board web page (not in the pane) gets the same follow-up here:
// a toast, and the Code session is asked to act and reconcile when no thread owns the line.
async function boardPageAnswers($: Dollar, items: Doc<BoardItem>[], msgs: Doc<BoardMsg>[]) {
  const stored = (await $.store.get('seenMsgAt')) as number | undefined
  const latest = msgs.reduce((m, d) => Math.max(m, d.data.at), 0)
  if (stored === undefined) {
    // First run: start from now, never replay history.
    mem.seenMsgAt = latest
    await $.store.set('seenMsgAt', latest)
    return
  }
  const since = Math.max(stored, mem.seenMsgAt)
  const fresh = msgs.filter(d => d.data.from === 'anthony' && d.data.at > since).sort((a, b) => a.data.at - b.data.at)
  if (!fresh.length) return
  mem.seenMsgAt = latest
  await $.store.set('seenMsgAt', latest)
  const byId = new Map(items.map(d => [d.id, d]))
  for (const m of fresh) {
    const item = byId.get(m.data.item)
    if (!item) continue
    $.ui.toast(`Anthony answered line ${item.data.n} on the board: ${m.data.text.slice(0, 60)}`)
    const what = m.data.decision ? `chose "${label(m.data.decision)}"` : `wrote "${m.data.text}"`
    quiet($.prompt.submit({ text: board.afterAnswerPrompt(item.id, item.data, what, BOARD_URL, SCHEMA_PATH) } as never))
  }
}

async function refreshBoard($: Dollar) {
  if (!(await hasTool($, 'ArtifactData'))) {
    await update($, pane, p => ({ ...p, error: 'The board cannot be reached from this session (no ArtifactData tool). Open it in the browser instead.' }))
    return
  }
  try {
    const call = boardCall($)
    const [items, msgs] = await Promise.all([board.readItems(call), board.readMsgs(call)])
    mem.boardItems = items
    await boardPageAnswers($, items, msgs)
    const byItem = new Map<string, BoardMsg[]>()
    for (const m of msgs) {
      const list = byItem.get(m.data.item) ?? []
      list.push(m.data)
      byItem.set(m.data.item, list)
    }
    const rows: PaneRow[] = board.rank(items, GROUP_ORDER).map(d => ({
      id: d.id,
      version: d.version,
      item: d.data,
      msgs: (byItem.get(d.id) ?? []).sort((a, b) => a.at - b.at),
    }))
    await update($, pane, () => ({ rows, loadedAt: Date.now(), error: null }))
  } catch (err) {
    await update($, pane, p => ({ ...p, error: `Could not read the board: ${String((err as Error)?.message ?? err).slice(0, 160)}` }))
  }
}

async function refreshCorrections($: Dollar) {
  const cached = ((await $.store.get('corrections')) as Correction[] | undefined) ?? []
  if (cached.length) await update($, corrections, () => cached)
  if (!(await hasTool($, 'ArtifactData'))) return
  try {
    const docs = await board.readCorrections(boardCall($))
    const pending = ((await $.store.get('correctionsUnsynced')) as Correction[] | undefined) ?? []
    // Merge rather than replace, so a correction typed while this read ran is kept.
    const local = await read($, corrections)
    const seen = new Set<string>()
    const all = [...docs.map(d => d.data), ...pending, ...local].filter(c => {
      const k = `${c.at}|${c.text}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    await update($, corrections, () => all)
    await $.store.set('corrections', all)
  } catch {
    // Keep the cached list.
  }
}

async function refreshHealth($: Dollar, alert: boolean) {
  const rows = (await read($, pane)).rows
  const pendingTitles = rows.filter(r => r.item.status === 'waiting').map(r => r.item.title)
  const before = await read($, health)
  const fresh = await collectHealth($, pendingTitles)
  await update($, health, () => fresh)
  $.ui.status(statusText(fresh, pendingTitles.length))
  if (!alert || fresh.source === 'none') return
  for (const line of newProblems(before, fresh)) {
    const key = `alerted:${fresh.date}:${line.name}`
    if (await $.store.get(key)) continue
    await $.store.set(key, true)
    const text = `${line.name}: ${line.text}`
    $.ui.toast(`Summit · ${text}`, { timeoutMs: 15000 })
    quiet($.ui.notify(text, { title: 'Summit delivery' }))
    // A Daily miss with no open line about it becomes a line on the board.
    if (line.name === 'Daily' && !rows.some(r => r.item.status === 'waiting' && /summit daily/i.test(r.item.title))) {
      try {
        await board.addItem(boardCall($), mem.boardItems, {
          title: `Summit Daily did not send on ${fresh.date}`,
          group: 'Launch blockers',
          ask: 'Look at why Summit Daily did not send, or tell me to fix it.',
          why: line.text,
          where: 'PC send log',
        }, Date.now())
        await refreshBoard($)
      } catch {
        // The alert has already been shown.
      }
    }
  }
}

async function twiceDaily($: Dollar) {
  const now = await $.clock.now()
  const et = etParts(now)
  const slot = et.minutes >= 480 && et.minutes < 495 ? 'am' : et.minutes >= 1080 && et.minutes < 1095 ? 'pm' : null
  if (!slot) return
  const key = `nudge:${et.date}:${slot}`
  if (await $.store.get(key)) return
  await $.store.set(key, true)
  await refreshBoard($)
  const waiting = (await read($, pane)).rows.filter(r => r.item.status === 'waiting')
  if (waiting.length === 0) return
  const [top, next] = waiting
  if (!top) return
  const text = `Top: ${top.item.title}.${next ? ` Next: ${next.item.title}.` : ''}`
  quiet($.ui.notify(text, { title: `Summit · ${waiting.length} thing${waiting.length === 1 ? '' : 's'} need you` }))
  $.ui.toast(`${waiting.length} waiting on you. ${text}`, { timeoutMs: 20000 })
}

// A line Claude has owed an answer on for over two hours gets one alert a day.
async function staleCheck($: Dollar) {
  const now = await $.clock.now()
  const rows = (await read($, pane)).rows
  const docs: Doc<BoardItem>[] = rows.map(r => ({ id: r.id, version: r.version, data: r.item }))
  const stale = board.staleReplies(docs, now)
  if (stale.length === 0) return
  const day = etParts(now).date
  for (const d of stale) {
    const key = `stale:${day}:${d.id}`
    if (await $.store.get(key)) continue
    await $.store.set(key, true)
    const who = d.data.owner ? ` (owner: ${d.data.owner})` : ' (no owner set)'
    const text = `Line ${d.data.n} "${d.data.title}" has had no answer from Claude for ${board.hoursSince(d.data.updatedAt, now)}${who}.`
    $.ui.toast(`Summit · ${text}`, { timeoutMs: 20000 })
    quiet($.ui.notify(text, { title: 'Summit · an answer is overdue' }))
  }
  $.ui.toast(`${stale.length} line${stale.length === 1 ? '' : 's'} waiting on Claude for over two hours. Type /waiting to see them.`, { timeoutMs: 12000 })
}

async function logGuard($: Dollar, ev: GuardEvent) {
  await update($, guardLog, list => [...list, ev].slice(-50))
}

export const register: Register = on => {
  // ---------- session start: commands, pane, timers

  on('session.start', async ($, e, next) => {
    const ran = await next(e)
    await $.command.register({ name: 'waiting', description: 'Open the Waiting on you pane (the approvals board)' })
    await $.command.register({ name: 'health', description: 'Summit delivery: today and the last seven days', argumentHint: '' })
    await $.command.register({ name: 'correct', description: 'Make a correction a live rule now and flag the skills it touches', argumentHint: '<the correction, in one line>' })
    await $.command.register({ name: 'guardrail', description: 'What the Summit guardrail stopped, and its mode' })
    await $.command.register({ name: 'approve-once', description: 'Let the last action the guardrail stopped through once (only when the board cannot be reached)' })

    if (!(await $.store.get('installedAt'))) await $.store.set('installedAt', await $.clock.now())

    quiet($.ui.open({ id: PANE, title: PANE_TITLE }))
    quiet(refreshCorrections($))
    quiet(refreshBoard($).then(() => refreshHealth($, true)))

    $.clock.every(3 * 60 * 1000, () => quiet(refreshBoard($)))
    $.clock.every(5 * 60 * 1000, () => quiet(refreshHealth($, true)))
    $.clock.every(60 * 1000, () => quiet(twiceDaily($)))
    $.clock.every(15 * 60 * 1000, () => quiet(staleCheck($)))
    return ran
  })

  // ---------- live corrections in every new session's instructions

  on('prompt.compose', async ($, e, next) => {
    const ran = await next(e)
    let list = await read($, corrections)
    if (list.length === 0) list = ((await $.store.get('corrections')) as Correction[] | undefined) ?? []
    return { ...ran, sections: [...ran.sections, { id: 'summit:live-corrections', text: promptSection(liveOnes(list)), scope: 'session' as const }] }
  })

  // ---------- the guardrail and prepublish gate

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    const now = await $.clock.now()

    // Prepublish quick scan on public words.
    const words = publicWords(tool, input)
    if (words) {
      const found = scan(words.text, { needsDisclaimer: words.needsDisclaimer })
      if (found.length) {
        await logGuard($, { at: now, tool, verdict: 'prepublish', reason: describe(found), enforced: true })
        return { deny: `Held by the Summit prepublish gate (${words.what}): ${describe(found)} Fix the words, run summit-prepublish-check, then send again.` }
      }
    }

    const v: Verdict = classify(tool, input)
    if (v.kind === 'allow') return next(e)

    if (v.kind === 'block') {
      await logGuard($, { at: now, tool, verdict: 'block', reason: v.reason, enforced: true })
      $.ui.toast(`Summit guardrail stopped a call: ${v.reason}`)
      return { deny: `Stopped by the Summit guardrail: ${v.reason} Do not look for another way to do this; tell Anthony in one line if the task needs it.` }
    }

    if (v.kind === 'outside') {
      const installedAt = ((await $.store.get('installedAt')) as number | undefined) ?? now
      const enforced = now - installedAt > DAY
      await logGuard($, { at: now, tool, verdict: 'outside', reason: v.reason, enforced })
      if (!enforced) {
        $.ui.toast(`Guardrail (report only today): would stop this, ${v.reason}`)
        return next(e)
      }
      return { deny: `Stopped by the Summit guardrail: ${v.reason} Work only in the two Summit folders.` }
    }

    // Needs Anthony's yes: released once, only by his own approval message on the matching line.
    const once = (await $.store.get('approveOnce')) as { key: string; at: number } | undefined
    if (once && once.key === v.key && now - once.at < 30 * 60 * 1000) {
      await $.store.delete('approveOnce')
      await logGuard($, { at: now, tool, verdict: 'released (typed /approve-once)', reason: v.title, enforced: false })
      return next(e)
    }
    mem.lastDenied = { key: v.key, title: v.title }
    await $.store.set('lastDenied', mem.lastDenied)
    if (!(await hasTool($, 'ArtifactData'))) {
      await logGuard($, { at: now, tool, verdict: 'needs yes', reason: v.title, enforced: true })
      return { deny: `Stopped by the Summit guardrail: "${v.title}" needs Anthony's yes, and the approvals board cannot be reached from this session. Ask Anthony; he can type /approve-once to let it through once.` }
    }
    try {
      const call = boardCall($)
      const items = await board.readItems(call)
      const line = items.find(d => d.data.gateKey === v.key && d.data.status !== 'live' && d.data.status !== 'declined')
      if (line) {
        const msgs = (await board.readMsgs(call)).map(m => m.data).filter(m => m.item === line.id)
        const created = Math.min(line.data.updatedAt, ...msgs.map(m => m.at))
        const yes = msgs.some(m => m.from === 'anthony' && m.decision === 'approved' && m.at >= created)
        if (yes) {
          const ran = await next(e)
          await board.setItemStatus(call, line, 'live', Date.now()).catch(() => undefined)
          await logGuard($, { at: now, tool, verdict: 'released (approved on the board)', reason: v.title, enforced: false })
          return ran
        }
        await logGuard($, { at: now, tool, verdict: 'needs yes', reason: v.title, enforced: true })
        return { deny: `Stopped by the Summit guardrail: "${v.title}" is waiting for Anthony's approval on the board (line ${line.data.n}). It goes through once he approves it there.` }
      }
      const made = await board.addItem(call, items, {
        title: v.title,
        group: v.group,
        ask: `Approve or hold: ${v.title}.`,
        why: v.why,
        where: 'Claude guardrail',
        gateKey: v.key,
      }, Date.now())
      quiet(refreshBoard($))
      await logGuard($, { at: now, tool, verdict: 'needs yes', reason: v.title, enforced: true })
      $.ui.toast(`Added to Waiting on you: ${v.title}`)
      return { deny: `Stopped by the Summit guardrail: "${v.title}" needs Anthony's yes. It is now line ${made.data.n} on his Waiting on you board; it goes through once he approves it there.` }
    } catch (err) {
      await logGuard($, { at: now, tool, verdict: 'needs yes', reason: v.title, enforced: true })
      return { deny: `Stopped by the Summit guardrail: "${v.title}" needs Anthony's yes, and the board could not be updated (${String((err as Error)?.message ?? err).slice(0, 120)}). Ask Anthony; he can type /approve-once.` }
    }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'The Summit guardrail could not check this call, so it was stopped. Try again, or ask Anthony.' },
  )

  // ---------- commands

  on('command.run', { command: 'waiting' }, async $ => {
    await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true } as never)
    quiet(refreshBoard($))
    const n = (await read($, pane)).rows.filter(r => r.item.status === 'waiting').length
    return { text: `Waiting on you: ${n} item${n === 1 ? '' : 's'}. The pane is open; the same lines are on the board: ${BOARD_URL}` }
  })

  on('command.run', { command: 'health' }, async $ => {
    await refreshHealth($, false)
    const hl = await read($, health)
    if (!hl || hl.source === 'none') return { text: 'Delivery health: the PC cannot be reached from this session, so there is nothing to read.' }
    const r = await reader($)
    const [dailyLog, socialLog] = await Promise.all([r.text(LOGS.daily), r.text(LOGS.social)])
    const today = [hl.daily, hl.weekly, hl.sentinel].map(l => `${l.name}: ${l.text}.`).join('\n')
    const slots = `Social today: ${hl.slots.map(s => `${s.name} ${s.text}`).join(', ')}.`
    return { text: `Today (${hl.date})\n${today}\n${slots}\n\nLast seven days\n${weekReport(dailyLog, socialLog, hl.date).join('\n')}`, isTextDisplayOnly: true }
  })

  on('command.run', { command: 'correct' }, async ($, e) => {
    const text = e.args.trim()
    if (!text) return { text: 'Type the correction after /correct, in one line. Example: /correct The Weekly free edition close line names Summit Daily, not the Weekly.' }
    const now = Date.now()
    const skills = skillsFor(text)
    const c: Correction = { text, at: now, skills, status: 'live', source: 'anthony' }
    await update($, corrections, list => [...list, c])
    const cached = ((await $.store.get('corrections')) as Correction[] | undefined) ?? []
    await $.store.set('corrections', [...cached, c])
    let synced = false
    if (await hasTool($, 'ArtifactData')) {
      try {
        const call = boardCall($)
        await board.addCorrection(call, c, now)
        let items = await board.readItems(call)
        for (const skill of skills) {
          const made = await board.addItem(call, items, {
            title: `Same-day skill update: ${skill}`,
            group: 'Decide first',
            ask: 'Approve the skill card once its test set passes.',
            why: `From your correction: "${text.slice(0, 140)}"`,
            where: 'Live corrections',
          }, Date.now())
          // The schema has Claude draft it: flag it for a watching session.
          await board.setItemStatus(call, made, 'claude', Date.now()).catch(() => undefined)
          items = [...items, made]
        }
        synced = true
        quiet(refreshBoard($))
      } catch {
        synced = false
      }
    }
    if (!synced) {
      const pending = ((await $.store.get('correctionsUnsynced')) as Correction[] | undefined) ?? []
      await $.store.set('correctionsUnsynced', [...pending, c])
    }
    return {
      text: `In force now for every new session.\nTouches: ${skills.join(', ')}.${synced ? ' Logged on the board, with a same-day skill update line for each.' : ' Saved here; it goes to the board when it can be reached.'}`,
      context: [
        `Anthony just made this correction, in force now: "${text}". Draft a same-day skill card for ${skills.join(', ')} against the saved skill (old → new), run its test set from /mnt/project-files/ops/skill-tests/, put the score on the card, and log the lesson in Open lessons.`,
      ],
    }
  })

  on('command.run', { command: 'guardrail' }, async $ => {
    const list = await read($, guardLog)
    const installedAt = ((await $.store.get('installedAt')) as number | undefined) ?? Date.now()
    const reportOnly = Date.now() - installedAt < DAY
    const mode = reportOnly
      ? 'Hard stops and approvals are on. The outside-the-Summit-folders rule reports only for its first day, then stops calls too.'
      : 'All rules are on and stopping calls.'
    const recent = list.slice(-12).reverse().map(g => `${new Date(g.at).toISOString().slice(11, 16)}Z  ${g.verdict}: ${g.reason}`)
    return { text: `${mode}\n${recent.length ? recent.join('\n') : 'Nothing stopped in this session yet.'}`, isTextDisplayOnly: true }
  })

  on('command.run', { command: 'approve-once' }, async ($, e) => {
    if (e.origin.kind !== 'composer') return { text: 'Only Anthony can approve, by typing this command himself.' }
    const last = ((await $.store.get('lastDenied')) as { key: string; title: string } | undefined) ?? mem.lastDenied
    if (!last) return { text: 'Nothing has been stopped that needs your yes.' }
    await $.store.set('approveOnce', { key: last.key, at: Date.now() })
    return { text: `Approved once: ${last.title}. It goes through the next time it is tried, within 30 minutes.` }
  })

  // ---------- band above the prompt: live corrections in force

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const text = bandText(liveOnes(await read($, corrections)))
    if (!text || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor>{text}</Text>
      </Box>
    )
  })

  // ---------- scanner ship receipt under scanner code changes

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const input = (e.props.input ?? {}) as Record<string, unknown>
    const paths: string[] = []
    if (typeof input.file_path === 'string') paths.push(input.file_path)
    if (Array.isArray(input.files)) for (const f of input.files as Record<string, unknown>[]) if (typeof f?.devicePath === 'string') paths.push(f.devicePath)
    const scannerFiles = paths.filter(p => /[\\/]scanner[\\/][^\\/]+\.(py|html|js|css)$/i.test(p))
    const row = await next(e)
    if (scannerFiles.length === 0 || e.props.isRunning || e.props.isErrored) return row
    const r = await reader($)
    const backups = await r.list(LOGS.backups)
    const today = etParts(Date.now()).date
    const todays = backups.filter(b => b.includes(today))
    const { Box, Text } = $.ui.resolve(e)
    const names = scannerFiles.map(p => p.split(/[\\/]/).pop()).join(', ')
    return (
      <Box flexDirection="column">
        {row}
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text weight="semibold">Scanner ship receipt</Text>
          <Text>Changed: {names}</Text>
          {todays.length > 0 ? (
            <Text color="success">Backup made today: backups\{todays[todays.length - 1]}</Text>
          ) : (
            <Text color="warning">{r.source === 'none' ? 'Backup: cannot check the PC from here.' : 'No backup from today found in summit\\workspace\\backups. Check before restarting.'}</Text>
          )}
          <Text color="warning">Restart needed: double-click start_scanner.bat</Text>
        </Box>
      </Box>
    )
  })

  // ---------- the Waiting on you pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const data = await read($, pane)
    const which = await read($, tab)
    const groups: Record<typeof which, (i: BoardItem) => boolean> = {
      needs: i => i.status === 'waiting',
      claude: i => i.status === 'claude',
      done: i => i.status === 'approved' || i.status === 'live' || i.status === 'verified',
      held: i => i.status === 'held' || i.status === 'declined',
    }
    const count = (k: typeof which) => data.rows.filter(r => groups[k](r.item)).length
    const shown = data.rows.filter(r => groups[which](r.item))
    const byId = new Map(data.rows.map(r => [r.id, r.item]))
    const hl = await read($, health)

    const act = async (row: PaneRow, decision: 'approved' | 'declined' | 'held' | null, text: string) => {
      try {
        const doc: Doc<BoardItem> = { id: row.id, version: row.version, data: row.item }
        await board.sendFromAnthony(boardCall($), doc, text, decision, Date.now())
        $.ui.toast(decision ? `${label(decision)}: ${row.item.title}` : `Sent: ${row.item.title}`)
        await refreshBoard($)
        const what = decision ? `chose "${label(decision)}"` : `wrote "${text}"`
        mem.seenMsgAt = Math.max(mem.seenMsgAt, Date.now())
        quiet($.prompt.submit({ text: board.afterAnswerPrompt(row.id, row.item, what, BOARD_URL, SCHEMA_PATH) } as never))
      } catch (err) {
        $.ui.toast(`Could not save that: ${String((err as Error)?.message ?? err).slice(0, 100)}. Refresh and try again.`)
        await refreshBoard($)
      }
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Button key="tab-needs" variant={which === 'needs' ? 'primary' : 'secondary'} onPress={() => update($, tab, () => 'needs')}>Needs you · {count('needs')}</Button>
          <Button key="tab-claude" variant={which === 'claude' ? 'primary' : 'secondary'} onPress={() => update($, tab, () => 'claude')}>Claude working · {count('claude')}</Button>
          <Button key="tab-done" variant={which === 'done' ? 'primary' : 'secondary'} onPress={() => update($, tab, () => 'done')}>Approved · {count('done')}</Button>
          <Button key="tab-held" variant={which === 'held' ? 'primary' : 'secondary'} onPress={() => update($, tab, () => 'held')}>Held · {count('held')}</Button>
          <Button key="refresh" onPress={() => quiet(refreshBoard($))}>Refresh</Button>
        </Box>
        {hl && hl.source !== 'none' && (
          <Text dimColor size="footnote">
            Today: Daily {hl.daily.text} · Sentinel {hl.sentinel.text} · Social {hl.slots.filter(s => s.light === 'ok' || s.light === 'warn').length} of 4 out
          </Text>
        )}
        {data.error && <Text color="warning">{data.error}</Text>}
        {data.loadedAt === 0 && !data.error && <Text dimColor>Loading the board…</Text>}
        {data.loadedAt > 0 && shown.length === 0 && <Text dimColor>Nothing here.</Text>}
        {shown.map(row => (
          <Box key={`row-${row.id}`} flexDirection="column" borderStyle="round" paddingX={1} gap={0}>
            <Text weight="semibold">{row.item.title}</Text>
            <Text dimColor size="footnote">{row.item.group} · {row.item.where}</Text>
            <Text>{row.item.ask}</Text>
            <Text dimColor>{row.item.why}</Text>
            {row.item.conflict && <Text color="error">Needs a second look: {row.item.conflict.note} (line {byId.get(row.item.conflict.item)?.n ?? '?'})</Text>}
            {row.item.settledBy && <Text color="success">Seems settled by your answer on line {byId.get(row.item.settledBy.item)?.n ?? '?'}: {row.item.settledBy.note}</Text>}
            {board.openParents(row.item, byId).length > 0 && (
              <Text color="warning">Waiting on line {board.openParents(row.item, byId).map(id => byId.get(id)?.n ?? '?').join(', ')} first</Text>
            )}
            {row.item.status === 'waiting' && unlocksOf(row.id, data.rows) > 0 && (
              <Text color="success" size="footnote">Unlocks {unlocksOf(row.id, data.rows)} other {unlocksOf(row.id, data.rows) === 1 ? 'line' : 'lines'}</Text>
            )}
            {row.item.rec && <Text color="suggestion">Recommended: {row.item.rec}</Text>}
            {row.msgs.slice(-4).map(m => (
              <Text size="footnote" dimColor={m.from === 'claude'}>
                {m.from === 'anthony' ? 'You' : 'Claude'}: {m.decision ? `[${label(m.decision)}] ` : ''}{m.text}
              </Text>
            ))}
            {row.item.status === 'claude' && (
              <Text color={Date.now() - row.item.updatedAt > 2 * 3600000 ? 'error' : 'claude'} size="footnote">
                {Date.now() - row.item.updatedAt > 2 * 3600000 ? `No answer for ${board.hoursSince(row.item.updatedAt, Date.now())}` : 'Claude is answering'}{row.item.owner ? ` · owner: ${row.item.owner}` : ''}
              </Text>
            )}
            {(row.item.status === 'waiting' || row.item.status === 'held') && (
              <Box flexDirection="row" flexWrap="wrap" gap={1}>
                <Button key={`ok-${row.id}`} variant="primary" onPress={() => quiet(act(row, 'approved', 'Approved'))}>Approve</Button>
                <Button key={`hold-${row.id}`} onPress={() => quiet(act(row, 'held', 'Hold'))}>Hold</Button>
                <Button key={`no-${row.id}`} onPress={() => quiet(act(row, 'declined', 'Declined'))}>Decline</Button>
              </Box>
            )}
            {row.item.status !== 'verified' && (
              <Input key={`ask-${row.id}`} placeholder="Ask or challenge…" submitLabel="send" onSubmit={value => (value.trim() ? quiet(act(row, null, value.trim())) : undefined)} />
            )}
          </Box>
        ))}
      </Box>
    )
  })
}

function label(d: 'approved' | 'declined' | 'held'): string {
  return d === 'approved' ? 'Approved' : d === 'declined' ? 'Declined' : 'Held'
}
