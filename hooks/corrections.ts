// Live corrections: Anthony's corrections, in force from the moment he types them.

import { SKILL_WORDS } from './config'
import type { Correction } from '../types'

export function skillsFor(text: string): string[] {
  const hits = SKILL_WORDS.filter(s => s.words.test(text)).map(s => s.skill)
  return hits.length ? hits.slice(0, 3) : ['summit-learning-loop']
}

export function liveOnes(all: Correction[]): Correction[] {
  return all.filter(c => c.status === 'live').sort((a, b) => a.at - b.at)
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

// The system-prompt section every new session reads.
export function promptSection(live: Correction[]): string {
  const head = [
    'Summit HQ live corrections. These are Anthony’s own corrections, in force now, ahead of any skill text that says otherwise. Each stays here until its skill change is approved, live and checked.',
  ]
  const lines = live.map(c => `- (${day(c.at)}) ${c.text}`)
  const rules = [
    '',
    'Summit guardrail is on in this session: it stops any touch of settings.ini, keys, the Indicators folder, the journal or positions, and anything outside the two Summit folders on the PC. Public sends, scanner code ships, Pine script changes and scheduled-task or house-rule edits wait until Anthony approves the matching line on the Waiting on Anthony board. When a call is stopped, tell Anthony in one line what is waiting and where; do not try another route around it.',
  ]
  return [...head, ...(lines.length ? lines : ['- (none yet)']), ...rules].join('\n')
}

export function bandText(live: Correction[]): string | null {
  if (live.length === 0) return null
  const newest = live[live.length - 1]!
  const short = newest.text.length > 90 ? newest.text.slice(0, 87) + '…' : newest.text
  return `${live.length} live correction${live.length === 1 ? '' : 's'} in force · newest (${day(newest.at)}): ${short}`
}
