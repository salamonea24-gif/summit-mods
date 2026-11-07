export type ItemStatus = 'waiting' | 'claude' | 'approved' | 'live' | 'verified' | 'declined' | 'held'

export type BoardItem = {
  n: number
  title: string
  group: string
  ask: string
  why: string
  where: string
  link?: string
  rec?: string
  status: ItemStatus
  pendingDecision?: 'approved' | 'declined' | 'held' | null
  needsReply: boolean
  updatedAt: number
  gateKey?: string
  dependsOn?: string[]
  settledBy?: { item: string; at: number; note: string }
  conflict?: { item: string; note: string } | null
}

export type BoardMsg = {
  item: string
  from: 'anthony' | 'claude'
  text: string
  decision: 'approved' | 'declined' | 'held' | null
  at: number
}

export type Correction = {
  text: string
  at: number
  skills: string[]
  status: 'live' | 'carded' | 'closed'
  source: 'anthony'
}

export type PaneRow = { id: string; version: number; item: BoardItem; msgs: BoardMsg[] }

export type PaneData = {
  rows: PaneRow[]
  loadedAt: number
  error: string | null
}

export type HealthLine = { name: string; light: 'ok' | 'bad' | 'warn' | 'wait' | 'off'; text: string }

export type HealthState = {
  date: string
  checkedAt: number
  daily: HealthLine
  weekly: HealthLine
  sentinel: HealthLine
  slots: HealthLine[]
  source: 'pc' | 'cloud' | 'none'
}

export type GuardEvent = { at: number; tool: string; verdict: string; reason: string; enforced: boolean }

declare module 'claude-code' {
  interface PluginState {
    summit: {
      pane: Shaped<PaneData>
      tab: 'needs' | 'claude' | 'done' | 'held'
      health: Shaped<HealthState | null>
      corrections: Shaped<Correction[]>
      guardLog: Shaped<GuardEvent[]>
    }
  }
}
