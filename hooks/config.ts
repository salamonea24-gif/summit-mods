// Fixed facts about Summit that every part of the pack reads.
// Paths and rules follow the Summit HQ house rules (sections 3 and 7).

export const BOARD_URL = 'https://claude.ai/artifact/TzN5k3GW1GvNuo67a7pxVK'

export const PC_ROOT = 'C:\\Users\\Admin\\OneDrive\\Trading Scripts\\Stock Scanner'
export const PC_DATA = 'C:\\Users\\Admin\\AppData\\Local\\StockScanner'
export const PC_HOME = 'C:\\Users\\Admin'

// Folder names as the cloud's folder access mounts them under $HOME/mnt/.
// "sentinel" and "Product Suite Decisions" are approved subfolders of Stock Scanner;
// "outputs" is the session's own scratch folder.
export const ALLOWED_MOUNTS = [
  'Stock Scanner',
  'StockScanner',
  'sentinel',
  'Product Suite Decisions',
  'outputs',
]

// Files the delivery health line reads, relative to PC_ROOT.
export const LOGS = {
  daily: 'summit\\workspace\\venture\\email\\daily\\ghost_send_log.txt',
  social: 'summit\\workspace\\venture\\social\\sentinel_queue\\post_runner_log.txt',
  weeklyDrafts: 'summit\\workspace\\venture\\email\\drafts',
  sentinelIssues: 'Sentinel Research\\issues',
  backups: 'summit\\workspace\\backups',
} as const

// The four social slots, ET. A post logged inside a slot's window counts for it.
export const SLOTS = [
  { label: '8:30', at: 8 * 60 + 30, from: 8 * 60 + 15, to: 9 * 60 + 45 },
  { label: '10:00', at: 10 * 60, from: 9 * 60 + 45, to: 12 * 60 },
  { label: '12:30', at: 12 * 60 + 30, from: 12 * 60, to: 14 * 60 },
  { label: '6 pm', at: 18 * 60, from: 17 * 60 + 30, to: 19 * 60 + 30 },
] as const

// Board groups in the order the pane and alerts rank them.
export const GROUP_ORDER = [
  'Decide first',
  'Launch blockers',
  'Research and themes',
  'Social',
  'Scanner and code',
  'Housekeeping',
]

// Which skills a correction most likely touches, by words in it.
export const SKILL_WORDS: { skill: string; words: RegExp }[] = [
  { skill: 'sentinel-social-queue', words: /\b(post|posts|caption|reel|card|story|instagram|tiktok|x reply|social|footer|close line|hashtag)/i },
  { skill: 'sentinel-research-standard', words: /\b(sentinel|issue|deep dive|special report|validation|study|pdf|chart)/i },
  { skill: 'summit-edge-thinking', words: /\b(theme|thesis|winners|losers|umbrella|driver|second-order|top)\b/i },
  { skill: 'summit-equity-research', words: /\b(earnings|preview|scorecard|grade|grading|watch-date|sector overview|screen)\b/i },
  { skill: 'summit-launch-marketing', words: /\b(welcome|email|campaign|landing|marketing|copy|sign-?up|pricing)\b/i },
  { skill: 'summit-scanner-ship', words: /\b(scanner|terminal|ship|python|restart|backup|code)\b/i },
  { skill: 'summit-prepublish-check', words: /\b(compliance|disclosure|advice|spelling|stale|prepublish|position)\b/i },
]
