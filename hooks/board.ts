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

// Board items still needing Anthony, best first.
export function rank(items: Doc<BoardItem>[], order: string[]): Doc<BoardItem>[] {
  const g = (s: string) => {
    const i = order.indexOf(s)
    return i < 0 ? order.length : i
  }
  return [...items].sort((a, b) => g(a.data.group) - g(b.data.group) || a.data.n - b.data.n)
}

export function isWaiting(i: BoardItem) {
  return i.status === 'waiting'
}
