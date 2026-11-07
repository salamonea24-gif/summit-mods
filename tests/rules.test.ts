import { expect, test } from 'claude-code/testing'

import { classify } from '../hooks/guard'
import { scan } from '../hooks/prepublish'
import { dailyLine, slotLines, weeklyLine, sentinelLine, newProblems } from '../hooks/health'
import { skillsFor, promptSection } from '../hooks/corrections'
import { parseDocs, nextItemId } from '../hooks/board'

const ROOT = 'C:\\Users\\Admin\\OneDrive\\Trading Scripts\\Stock Scanner'

test('guardrail: hard stops', async () => {
  expect(classify('Read', { file_path: `${ROOT}\\settings.ini` }).kind).toBe('block')
  expect(classify('mcp__remote-devices__device_bash', { command: 'cat "$HOME/mnt/Stock Scanner/settings.ini"' }).kind).toBe('block')
  expect(classify('mcp__remote-devices__device_stage_files', { paths: [`${ROOT}\\Indicators\\rs_line.pine`] }).kind).toBe('block')
  expect(classify('Bash', { command: 'sqlite3 journal.db "select * from trades"' }).kind).toBe('block')
  expect(classify('Read', { file_path: '/home/user/.env' }).kind).toBe('block')
  expect(classify('mcp__stripe__create_payment_link', {}).kind).toBe('block')
  // settings.ini.example is the shareable template, and writing about settings.ini is fine.
  expect(classify('Read', { file_path: `${ROOT}\\settings.ini.example` }).kind).toBe('allow')
  expect(classify('Write', { file_path: '/mnt/project-files/ops/notes.md', content: 'never open settings.ini' }).kind).toBe('allow')
})

test('guardrail: needs a yes', async () => {
  const send = classify('mcp__remote-devices__device_bash', { command: 'cd "$HOME/mnt/Stock Scanner" && python summit/workspace/venture/email/daily/ghost_send.py --today' })
  expect(send.kind).toBe('needsYes')
  const check = classify('mcp__remote-devices__device_bash', { command: 'cd "$HOME/mnt/Stock Scanner" && python summit/workspace/venture/email/daily/ghost_send.py --check' })
  expect(check.kind).toBe('allow')
  const ship = classify('mcp__remote-devices__device_commit_files', { files: [{ devicePath: `${ROOT}\\scanner\\thememap.py`, stagedPath: '/mnt/project-files/x.py' }] })
  expect(ship.kind).toBe('needsYes')
  const pineEdit = classify('mcp__remote-devices__device_bash', { command: 'cp new.pine "$HOME/mnt/Stock Scanner/Pine Scripts - Adopted Rules Oct 2026/swing.pine"' })
  expect(pineEdit.kind).toBe('needsYes')
  const pineRead = classify('mcp__remote-devices__device_bash', { command: 'cat "$HOME/mnt/Stock Scanner/Pine Scripts - Adopted Rules Oct 2026/WEEKLY_REVIEWS.md"' })
  expect(pineRead.kind).toBe('allow')
  expect(classify('mcp__claude-code-remote__update_trigger', { trigger_id: 'x', prompt: 'new' }).kind).toBe('needsYes')
  expect(classify('mcp__Gmail__send_email', { to: 'someone@example.com' }).kind).toBe('needsYes')
  // Talking to Anthony in the thread is never gated.
  expect(classify('mcp__hearthbot__post_message', { text: 'hi' }).kind).toBe('allow')
  // The same action gets the same key, so his yes matches it.
  const again = classify('mcp__remote-devices__device_commit_files', { files: [{ devicePath: `${ROOT}\\scanner\\thememap.py`, stagedPath: '/mnt/project-files/x.py' }] })
  expect(ship.kind === 'needsYes' && again.kind === 'needsYes' && ship.key === again.key).toBe(true)
})

test('guardrail: folder scope', async () => {
  expect(classify('Read', { file_path: 'C:\\Users\\Admin\\Documents\\taxes.pdf' }).kind).toBe('outside')
  expect(classify('Read', { file_path: `${ROOT}\\playbook.md` }).kind).toBe('allow')
  expect(classify('Read', { file_path: 'C:\\Users\\Admin\\AppData\\Local\\StockScanner\\scanner.db' }).kind).toBe('allow')
  expect(classify('mcp__remote-devices__device_bash', { command: 'ls "$HOME/mnt/Documents"' }).kind).toBe('outside')
  expect(classify('mcp__remote-devices__device_bash', { command: 'ls "$HOME/mnt/Stock Scanner/output"' }).kind).toBe('allow')
  // Cloud paths are not the PC.
  expect(classify('Read', { file_path: '/mnt/project-files/ops/mods/summit-mods-design.html' }).kind).toBe('allow')
})

test('prepublish: catches the known misses', async () => {
  const caption = 'Steel demand is turning. Read more in Sentinel Weekly. Not advice.'
  expect(scan(caption, { needsDisclaimer: true }).map(f => f.rule)).toEqual(['Retired name'])
  expect(scan('Buy point at $42 on the breakout. Not advice.', { needsDisclaimer: true }).some(f => f.rule === 'Advice wording')).toBe(true)
  expect(scan('The centre of the value chain is moving to inputs, and this is long enough.', { needsDisclaimer: true }).map(f => f.rule)).toEqual(['UK spelling', 'Missing disclaimer'])
  expect(scan('Nvidia closed 9.6% above its Nov 2021 high on 3.6x volume. Summit Terminal ranks 136 industry groups nightly. Not advice.', { needsDisclaimer: true })).toEqual([])
})

// Real lines from the PC's logs, 3 to 7 Nov 2026.
const GHOST = [
  '2026-11-03 08:20:01 REFUSED send 2026-11-03: no postal address in config.json',
  '2026-11-05 08:20:01 no Summit Daily draft for 2026-11-05 (holiday, PC was off, or the 7:47 am draft task stopped); nothing sent',
  '2026-11-06 08:20:01 REFUSED send 2026-11-06: no postal address in config.json',
  '2026-11-06 08:20:04 draft created in Ghost: \'The AI trade\'s worst day since April\' (post 6aedd40461ee740001ce9825)',
].join('\n')
const SOCIAL = [
  '2026-11-07 08:34:57 S09 Instagram: FAILED FileNotFoundError: [Errno 2] No such file or directory',
  '2026-11-07 10:05:02 K4-ST4 X: posted https://x.com/charttheclimb/status/2119083711387824435',
  '2026-11-07 11:05:38 S09 Instagram: posted https://www.instagram.com/reel/DfckcbiFGXw/',
  '2026-11-07 12:35:33 C01 Instagram: posted https://www.instagram.com/reel/DfcuvCcmZSB/',
].join('\n')

test('health: Summit Daily from the send log', async () => {
  expect(dailyLine(GHOST, '2026-11-06', 9 * 60, 5)).toEqual({ name: 'Daily', light: 'bad', text: 'not sent: no postal address in the Daily settings' })
  expect(dailyLine(GHOST, '2026-11-05', 9 * 60, 4).text).toBe('not sent: no draft was made this morning')
  expect(dailyLine(GHOST, '2026-11-07', 9 * 60, 6).light).toBe('off')
  expect(dailyLine(GHOST, '2026-11-09', 8 * 60, 1).light).toBe('wait')
  expect(dailyLine(GHOST + '\n2026-11-09 08:20:03 SENT 2026-11-09: published and emailed', '2026-11-09', 9 * 60, 1).light).toBe('ok')
})

test('health: social slots, Saturday 7 Nov at 2 pm', async () => {
  const s = slotLines(SOCIAL, '2026-11-07', 14 * 60)
  expect(s.map(x => `${x.name}:${x.light}`)).toEqual(['8:30:warn', '10:00:ok', '12:30:ok', '6 pm:wait'])
  expect(s[0]?.text).toBe('failed on time, posted later')
})

test('health: Weekly free edition and Sentinel', async () => {
  expect(weeklyLine(['2026-10-31', '2026-11-07'], GHOST, '2026-11-07', 6).text).toBe('drafted 11-07, not sent')
  expect(sentinelLine(['2026-10-30', '2026-11-06', 'README.md'], ['Send Sentinel Issue 4 (6 Nov)']).light).toBe('warn')
  expect(sentinelLine(['2026-11-06'], []).text).toBe('latest issue 11-06')
})

test('health: alerts only on lines that newly went bad', async () => {
  const off = { light: 'off' as const, text: '' }
  const base = { date: '2026-11-09', checkedAt: 0, weekly: { name: 'Weekly free', ...off }, sentinel: { name: 'Sentinel', ...off }, slots: [], source: 'pc' as const }
  const before = { ...base, daily: { name: 'Daily', light: 'wait' as const, text: '' } }
  const after = { ...base, daily: { name: 'Daily', light: 'bad' as const, text: 'x' } }
  expect(newProblems(before, after).map(l => l.name)).toEqual(['Daily'])
  expect(newProblems(after, after)).toEqual([])
})

test('corrections: skills and the prompt section', async () => {
  expect(skillsFor('The Weekly free edition close line names Summit Daily, not the Weekly, on every caption')).toContain('sentinel-social-queue')
  expect(skillsFor('Always be kind')).toEqual(['summit-learning-loop'])
  const text = promptSection([{ text: 'Positions are none.', at: Date.UTC(2026, 10, 5), skills: [], status: 'live', source: 'anthony' }])
  expect(text.includes('(2026-11-05) Positions are none.')).toBe(true)
})

test('board: reads ArtifactData output and numbers new lines', async () => {
  const out = [
    '2 documents from collection "items":',
    '=== BEGIN ARTIFACT DB a73fed74 ===',
    '{"id":"i01","data":{"title":"Postal address for Summit Daily","n":1,"status":"waiting"},"version":1,"updatedAt":"x"}',
    '{"id":"i28","data":{"title":"Scanner restart","n":28,"status":"waiting"},"version":3,"updatedAt":"x"}',
    '=== END ARTIFACT DB a73fed74 ===',
  ].join('\n')
  const docs = parseDocs<{ title: string }>(out)
  expect(docs.length).toBe(2)
  expect(docs[1]?.version).toBe(3)
  expect(nextItemId(docs as never)).toEqual({ id: 'i29', n: 29 })
})
