// Delivery health: turns the PC's own logs into a plain-word state per publication.
// Pure functions: the caller reads the files and passes their text in.

import { SLOTS } from './config'

export type Light = 'ok' | 'bad' | 'warn' | 'wait' | 'off'
export type Line = { name: string; light: Light; text: string }
export type Health = {
  date: string // ET date the lines describe, YYYY-MM-DD
  checkedAt: number
  daily: Line
  weekly: Line
  sentinel: Line
  slots: Line[]
  source: 'pc' | 'cloud' | 'none'
}

// Eastern time parts for an epoch, without relying on the host's zone.
export function etParts(ms: number): { date: string; minutes: number; weekday: number } {
  try {
    const f = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    })
    const p: Record<string, string> = {}
    for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value
    const hour = Number(p.hour) % 24
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    return { date: `${p.year}-${p.month}-${p.day}`, minutes: hour * 60 + Number(p.minute), weekday: days.indexOf(p.weekday ?? '') }
  } catch {
    // Fallback: EST, no daylight saving.
    const d = new Date(ms - 5 * 3600 * 1000)
    return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday: d.getUTCDay() }
  }
}

function linesFor(log: string, date: string): string[] {
  return log.split(/\r?\n/).filter(l => l.startsWith(date))
}

function minutesOf(line: string): number {
  const m = line.match(/^\d{4}-\d{2}-\d{2} (\d{2}):(\d{2})/)
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1
}

// Summit Daily, from ghost_send_log.txt (ghost_send.py writes it at 8:20 am ET).
export function dailyLine(log: string, date: string, minutes: number, weekday: number): Line {
  const name = 'Daily'
  if (weekday === 0 || weekday === 6) return { name, light: 'off', text: 'no edition on weekends' }
  const today = linesFor(log, date)
  const sent = today.find(l => /\bSENT\b/.test(l))
  if (sent) return { name, light: 'ok', text: `sent ${sent.slice(11, 16)}` }
  const refused = today.find(l => /REFUSED/.test(l))
  if (refused) {
    const why = refused.split(/:\s(.+)/)[1] ?? 'send refused'
    return { name, light: 'bad', text: `not sent: ${plainReason(why)}` }
  }
  const noDraft = today.find(l => /no Summit Daily draft/.test(l))
  if (noDraft) return { name, light: 'bad', text: 'not sent: no draft was made this morning' }
  if (minutes < 8 * 60 + 25) return { name, light: 'wait', text: 'sends at 8:20 am' }
  return { name, light: 'bad', text: 'no send attempt logged (is the PC on?)' }
}

function plainReason(why: string): string {
  if (/postal address/i.test(why)) return 'no postal address in the Daily settings'
  if (/stale/i.test(why)) return 'the draft was stale'
  if (/check/i.test(why)) return 'its checks did not pass'
  return why.slice(0, 80)
}

// The four social slots, from post_runner_log.txt.
export function slotLines(log: string, date: string, minutes: number): Line[] {
  const today = linesFor(log, date)
  return SLOTS.map(slot => {
    const inSlot = today.filter(l => {
      const m = minutesOf(l)
      return m >= slot.from && m < slot.to
    })
    const posted = inSlot.filter(l => /: posted\b/.test(l))
    const failed = inSlot.filter(l => /FAILED/.test(l))
    // A failure fixed later in the day still counts as out, flagged.
    const late = today.filter(l => minutesOf(l) >= slot.to && /: posted\b/.test(l))
    if (posted.length && failed.length) return { name: slot.label, light: 'warn', text: 'out, after a failed try' }
    if (posted.length) return { name: slot.label, light: 'ok', text: 'out' }
    if (failed.length) {
      const first = failed[0] ?? ''
      const id = first.split(' ')[2] ?? ''
      const recovered = late.some(l => l.split(' ')[2] === id)
      if (recovered) return { name: slot.label, light: 'warn', text: 'failed on time, posted later' }
      const why = /FileNotFound/.test(first) ? 'a file was missing' : 'the post failed'
      return { name: slot.label, light: 'bad', text: `failed: ${why}` }
    }
    if (minutes < slot.at) return { name: slot.label, light: 'wait', text: `due at ${slot.label}` }
    if (minutes < slot.to) return { name: slot.label, light: 'wait', text: 'running' }
    return { name: slot.label, light: 'bad', text: 'nothing posted' }
  })
}

// Summit Weekly free edition: the Saturday draft folder, and whether a send was logged.
export function weeklyLine(draftDates: string[], dailyLog: string, date: string, weekday: number): Line {
  const name = 'Weekly free'
  // The Saturday on or before today.
  const back = (weekday + 1) % 7
  const sat = shiftDate(date, -back)
  const sentLine = dailyLog.split(/\r?\n/).find(l => l.startsWith(sat) && /\bSENT\b.*(weekly|preview)/i.test(l))
  if (sentLine) return { name, light: 'ok', text: `sent ${sat.slice(5)}` }
  if (draftDates.includes(sat)) return { name, light: 'warn', text: `drafted ${sat.slice(5)}, not sent` }
  return { name, light: 'bad', text: `no draft for ${sat.slice(5)}` }
}

// Sentinel: the newest issue folder, and whether Anthony's yes is still pending on the board.
export function sentinelLine(issueDates: string[], pendingTitles: string[]): Line {
  const name = 'Sentinel'
  const latest = [...issueDates].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().pop()
  if (!latest) return { name, light: 'off', text: 'no issues found' }
  const pending = pendingTitles.find(t => /sentinel issue/i.test(t))
  if (pending) return { name, light: 'warn', text: `${latest.slice(5)} built, waiting on your yes` }
  return { name, light: 'ok', text: `latest issue ${latest.slice(5)}` }
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const MARK: Record<Light, string> = { ok: '✓', bad: '✕', warn: '!', wait: '◷', off: '·' }

export function statusText(h: Health, waiting: number): string {
  const one = (l: Line) => `${l.name} ${MARK[l.light]}`
  const parts = [one(h.daily), one(h.weekly), one(h.sentinel), ...h.slots.map(one)]
  const tail = waiting > 0 ? ` · ${waiting} waiting on you` : ''
  return `Summit: ${parts.join('  ')}${tail}`
}

// The seven-day view for /health.
export function weekReport(dailyLog: string, socialLog: string, today: string): string[] {
  const out: string[] = []
  for (let i = 6; i >= 0; i--) {
    const date = shiftDate(today, -i)
    const wd = new Date(`${date}T12:00:00Z`).getUTCDay()
    const d = dailyLine(dailyLog, date, 24 * 60, wd)
    const slots = slotLines(socialLog, date, 24 * 60)
    const out4 = slots.filter(s => s.light === 'ok' || s.light === 'warn').length
    out.push(`${date.slice(5)}  Daily: ${d.text}.  Social: ${out4} of 4 slots out.`)
  }
  return out
}

// Lines that newly went bad since the last check: the ones worth an alert.
export function newProblems(before: Health | null, now: Health): Line[] {
  const all = (h: Health) => [h.daily, h.weekly, h.sentinel, ...h.slots]
  const prior = new Map((before && before.date === now.date ? all(before) : []).map(l => [l.name, l.light]))
  return all(now).filter(l => l.light === 'bad' && prior.get(l.name) !== 'bad')
}
