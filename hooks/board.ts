// The "Waiting on Anthony" board's database: the one store every view reads and writes.
// Row format: /mnt/project-files/ops/waiting-on-anthony-schema.md (7 Nov 2026).
// Reached through the ArtifactData tool, so the person's own sign-in and permission
// rules apply; nothing here keeps a second copy of the rows.

import { BOARD_URL } from './config'
import type { BoardItem, BoardMsg, Correction } from '../types'

export type Doc<T> = { id: string; version: number; data: T }
export type Call = (input: Record<string, unknown>) => Promise<{ text: string; deny?: string }>

export function parseDocs<T>(text: string): Doc<T>[] {
  const out: Doc<T>[] = []
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('{"id"')) continue
    try {
      const d = JSON.parse(t) as { id: string; version: number; data: T }
      if (d && typeof d.id === 'string' && d.data) out.push({ id: d.id, version: d.version, data: d.data })
    } catch {
      // A line that is not one document is skipped.
    }
  }
  return out
}

function nextCursor(text: string): string | undefined {
  const m = text.match(/next_cursor:\s*"([^"]+)"/)
  return m?.[1]
}

async function readAll<T>(call: Call, collection: string): Promise<Doc<T>[]> {
  const docs: Doc<T>[] = []
  let cursor: string | undefined
  for (let page = 0; page < 10; page++) {
    const r = await call({ action: 'list', url: BOARD_URL, collection, query: cursor ? { limit: 500, cursor } : { limit: 500 } })
    if (r.deny) throw new Error(r.deny)
    docs.push(...parseDocs<T>(r.text))
    cursor = nextCursor(r.text)
    if (!cursor) break
  }
  return docs
}

export const readItems = (call: Call) => readAll<BoardItem>(call, 'items')
export const readMsgs = (call: Call) => readAll<BoardMsg>(call, 'msgs')
export const readCorrections = (call: Call) => readAll<Correction>(call, 'corrections')

export function nextItemId(items: Doc<BoardItem>[]): { id: string; n: number } {
  const n = items.reduce((m, d) => Math.max(m, Number(d.id.replace(/\D/g, '')) || 0), 0) + 1
  return { id: `i${String(n).padStart(2, '0')}`, n }
}

async function write(call: Call, input: Record<string, unknown>) {
  const r = await call({ url: BOARD_URL, ...input })
  if (r.deny) throw new Error(r.deny)
  if (/refused|failed|not found|conflict|changed since/i.test(r.text) && !/written|updated|saved|applied/i.test(r.text)) {
    throw new Error(r.text.slice(0, 200))
  }
  return r.text
}

// Anthony's send from the pane: a message, then the item flagged for Claude.
export async function sendFromAnthony(
  call: Call,
  item: Doc<BoardItem>,
  text: string,
  decision: 'approved' | 'declined' | 'held' | null,
  now: number,
) {
  const msg: BoardMsg = { item: item.id, from: 'anthony', text, decision, at: now }
  await write(call, {
    action: 'batch',
    writes: [
      { op: 'set', collection: 'msgs', doc_id: `m${now.toString(36)}${item.id}`, data: msg },
      {
        op: 'update',
        collection: 'items',
        doc_id: item.id,
        if_version: item.version,
        data: { status: 'claude', pendingDecision: decision, needsReply: true, updatedAt: now },
      },
    ],
  })
}

export async function addItem(call: Call, items: Doc<BoardItem>[], fields: Omit<BoardItem, 'n' | 'status' | 'needsReply' | 'updatedAt'>, now: number) {
  const { id, n } = nextItemId(items)
  const data: BoardItem = { ...fields, n, status: 'waiting', needsReply: false, updatedAt: now }
  await write(call, { action: 'set', collection: 'items', doc_id: id, data })
  return { id, version: 1, data }
}

export async function setItemStatus(call: Call, item: Doc<BoardItem>, status: BoardItem['status'], now: number) {
  await write(call, { action: 'update', collection: 'items', doc_id: item.id, if_version: item.version, data: { status, updatedAt: now } })
}

export async function addCorrection(call: Call, c: Correction, now: number) {
  const id = `c${now.toString(36)}`
  await write(call, { action: 'set', collection: 'corrections', doc_id: id, data: c })
  return id
}

export function isAnswered(i: BoardItem | undefined): boolean {
  return !!i && i.status !== 'waiting' && i.status !== 'claude' && i.status !== 'held'
}

// What a line is waiting on, among its dependsOn parents.
export function openParents(item: BoardItem, byId: Map<string, BoardItem>): string[] {
  return (item.dependsOn ?? []).filter(id => !isAnswered(byId.get(id)))
}

// Open lines that wait on this one: answering it moves them.
export function unlockCount(id: string, items: Doc<BoardItem>[]): number {
  return items.filter(d => !isAnswered(d.data) && (d.data.dependsOn ?? []).includes(id)).length
}

// Ranking shared with the board page (schema file, 7 and 8 Nov): conflicts first, then lines
// whose parents were all answered (most recently unblocked first), then group order; inside a
// group the line that unlocks the most other open lines comes first, then the oldest (lowest
// number). Lines with an open parent sink to the bottom.
export function rank(items: Doc<BoardItem>[], order: string[]): Doc<BoardItem>[] {
  const byId = new Map(items.map(d => [d.id, d.data]))
  const g = (s: string) => {
    const i = order.indexOf(s)
    return i < 0 ? order.length : i
  }
  const unblockedAt = (i: BoardItem) =>
    (i.dependsOn ?? []).length && openParents(i, byId).length === 0
      ? Math.max(...(i.dependsOn ?? []).map(id => byId.get(id)?.updatedAt ?? 0))
      : 0
  const tier = (i: BoardItem) => (i.conflict ? 0 : openParents(i, byId).length ? 3 : unblockedAt(i) ? 1 : 2)
  const unlocks = new Map(items.map(d => [d.id, unlockCount(d.id, items)]))
  return [...items].sort(
    (a, b) =>
      tier(a.data) - tier(b.data) ||
      unblockedAt(b.data) - unblockedAt(a.data) ||
      g(a.data.group) - g(b.data.group) ||
      (unlocks.get(b.id) ?? 0) - (unlocks.get(a.id) ?? 0) ||
      a.data.n - b.data.n,
  )
}

// The prompt the Code session gets after Anthony answers a line, from the pane or the board page.
export function afterAnswerPrompt(id: string, item: BoardItem, what: string, boardUrl: string, schemaPath: string): string {
  const who = item.owner
    ? `This line is owned by the thread "${item.owner}", which answers it; do not answer it yourself, only make sure that thread is woken (board ${boardUrl}).`
    : `No thread owns this line, so act on it yourself and answer on that line (board ${boardUrl}).`
  return `On the Waiting on you board Anthony ${what} on "${item.title}" (item ${id}). ${who} Then reconcile: read every other open item and, where his answer settles or contradicts one, set settledBy or conflict on it with a claude msg saying why, following the reconcile rule in ${schemaPath} (never auto-approve a line that needs his explicit yes).`
}

// Lines Claude owes an answer on for longer than `hours`.
export function staleReplies(items: Doc<BoardItem>[], now: number, hours = 2): Doc<BoardItem>[] {
  const limit = hours * 3600 * 1000
  return items.filter(d => d.data.needsReply && now - d.data.updatedAt > limit)
}

export function hoursSince(ms: number, now: number): string {
  const h = (now - ms) / 3600000
  return h < 1 ? `${Math.round(h * 60)} min` : `${Math.round(h * 10) / 10} h`
}

export function isWaiting(i: BoardItem) {
  return i.status === 'waiting'
}
