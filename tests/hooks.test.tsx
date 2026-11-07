import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ROOT = 'C:\\Users\\Admin\\OneDrive\\Trading Scripts\\Stock Scanner'

const ITEMS = [
  '{"id":"i01","data":{"n":1,"title":"Postal address for Summit Daily","group":"Launch blockers","ask":"Add your business postal address.","why":"Only thing stopping Summit Daily.","where":"PC email settings","status":"waiting","needsReply":false,"updatedAt":1},"version":1}',
  '{"id":"i05","data":{"n":5,"title":"Send Sentinel Issue 4 (6 Nov)","group":"Launch blockers","ask":"Send it?","why":"Built 6 Nov.","where":"PC","rec":"Approve as is.","status":"waiting","needsReply":false,"updatedAt":1},"version":2}',
  '{"id":"i09","data":{"n":9,"title":"Five theme names","group":"Research and themes","ask":"OK the names.","why":"Names need your OK.","where":"Theme thread","status":"claude","needsReply":true,"updatedAt":1},"version":4}',
].join('\n')
const MSGS = '{"id":"m1","data":{"item":"i09","from":"anthony","text":"Why not fold Nursing home landlords into Senior housing?","decision":null,"at":5},"version":1}'

const PANE = {
  plugin: 'summit',
  component: 'Pane',
  requestId: 'summit-waiting',
  props: { title: 'Waiting on you', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

type Writes = Record<string, unknown>[]

function engine(on: On, writes: Writes) {
  on('command.register', (_, e) => ({ value: { command: (e as { name: string }).name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.list', () => ({ value: [{ name: 'ArtifactData' }] as never }))
  on('fs.exists', () => ({ value: false }))
  mock.clock(on, { now: Date.UTC(2026, 10, 9, 14) })
  mock.store(on)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' as const } }))
  on('prompt.compose', () => ({ sections: [] }))
  on('tool.call', (_, e) => {
    const input = e as unknown as Record<string, unknown>
    if (input.tool !== 'ArtifactData') return { result: 'ran' }
    if (input.action === 'list') {
      const col = input.collection
      return { result: col === 'items' ? `3 documents\n${ITEMS}` : col === 'msgs' ? `1 document\n${MSGS}` : '0 documents' }
    }
    writes.push(input)
    return { result: 'written' }
  })
}

test('the guardrail stops settings.ini through the hook', async ($, on) => {
  const writes: Writes = []
  engine(on, writes)
  const r = await $.tool.call({ tool: 'Read', file_path: `${ROOT}\\settings.ini` })
  expect(typeof r.deny).toBe('string')
  expect(String(r.deny).includes('settings.ini')).toBe(true)
  const ok = await $.tool.call({ tool: 'Read', file_path: `${ROOT}\\playbook.md` })
  expect(ok.deny).toBe(undefined)
})

test('a scanner ship adds a line to the board and waits for his yes', async ($, on) => {
  const writes: Writes = []
  engine(on, writes)
  const r = await $.tool.call({ tool: 'Write', file_path: `${ROOT}\\scanner\\thememap.py`, content: 'x' })
  expect(String(r.deny).includes('needs Anthony')).toBe(true)
  const made = writes.find(w => w.action === 'set' && w.collection === 'items')
  expect(made?.doc_id).toBe('i10')
  expect(((made?.data ?? {}) as { gateKey?: string }).gateKey?.startsWith('g')).toBe(true)
})

test('the prepublish gate holds a caption with a retired name', async ($, on) => {
  const writes: Writes = []
  engine(on, writes)
  const r = await $.tool.call({ tool: 'mcp__Metricool_Social_Media_Management__createScheduledPost', text: 'Read the full story in Sentinel Weekly. Not advice.' } as never)
  expect(String(r.deny).includes('Retired name')).toBe(true)
})

test('the pane lists what needs him, and Approve writes his decision', async ($, on) => {
  const writes: Writes = []
  engine(on, writes)
  on('prompt.submit', (_, e) => ({ text: (e as unknown as { text: string }).text }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Postal address for Summit Daily/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Recommended: Approve as is/ })).toBeDefined()
  await ui.press({ key: 'ok-i05' })
  const batch = writes.find(w => w.action === 'batch') as { writes: { op: string; collection: string; data: Record<string, unknown>; if_version?: number }[] } | undefined
  expect(batch?.writes[0]?.data.from).toBe('anthony')
  expect(batch?.writes[0]?.data.decision).toBe('approved')
  expect(batch?.writes[1]?.data.status).toBe('claude')
  expect(batch?.writes[1]?.if_version).toBe(2)
  await ui.unmount()
})

test('the Claude working tab shows the back and forth', async ($, on) => {
  const writes: Writes = []
  engine(on, writes)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-claude' })
  expect(await ui.find({ type: 'Text', text: /You: Why not fold/ })).toBeDefined()
  await ui.unmount()
})

test('/correct makes a live correction and puts it in new sessions', async ($, on) => {
  const writes: Writes = []
  engine(on, writes)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r = await $.command.run({ command: 'correct', args: 'Every caption closes on Summit Daily, not the Weekly.' } as never)
  expect(String((r as { text?: string }).text).startsWith('In force now')).toBe(true)
  expect(writes.some(w => w.collection === 'corrections')).toBe(true)
  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] } as never)
  const section = (composed as unknown as { sections: { id: string; text: string }[] }).sections.find(s => s.id === 'summit:live-corrections')
  expect(section?.text.includes('Every caption closes on Summit Daily')).toBe(true)
})
