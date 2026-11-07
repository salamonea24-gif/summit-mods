// The prepublish gate's quick scan: the wording problems that are cheap to catch
// on the words about to go out. The full summit-prepublish-check skill is still the gate;
// this stops the obvious misses at the moment of sending.

export type Finding = { rule: string; found: string; fix: string }

const RETIRED: [RegExp, string][] = [
  [/\bSentinel Weekly\b/i, 'Sentinel'],
  [/\bfood chain\b/i, 'value chain'],
  [/\bSummit Brief\b/i, 'Summit Daily'],
  [/\bDaily Brief\b/i, 'Summit Daily'],
  [/\bSummit Scanner\b/i, 'Summit Terminal'],
  [/\bWeekly Deep Dive\b/i, 'Summit Weekly'],
  [/\bWeekly Summary\b/i, 'Summit Weekly'],
  [/\bBase Camp\b/, 'the current product name'],
  [/\bThe Ascent\b/, 'the current product name'],
  [/\bSummit View\b/, 'the current product name'],
]

const ADVICE: RegExp[] = [
  /\bbuy points?\b/i,
  /\b(price )?targets? (of|at) \$?\d/i,
  /\btarget price\b/i,
  /\bwhat I'?d do\b/i,
  /\bentry (at|near|above|below) \$?\d/i,
  /\bstop(-| )loss (at|near|below) \$?\d/i,
  /\bposition siz(e|ing)\b/i,
  /\b(I'?m|we'?re) (buying|selling|long|short)\b/i,
  /\bload up\b/i,
  /\btrade plan\b/i,
  /\bcoach'?s notes?\b/i,
]

const UK: [RegExp, string][] = [
  [/\bcolour/i, 'color'],
  [/\bcentre\b/i, 'center'],
  [/\banalys(e|ed|ing)\b/i, 'analyze'],
  [/\bfavour/i, 'favor'],
  [/\bbehaviour/i, 'behavior'],
  [/\borganisation/i, 'organization'],
  [/\bprogramme\b/i, 'program'],
  [/\blicence\b/i, 'license'],
]

const DISCLAIMER = /not (investment )?advice|research and education|research, not advice/i

export function scan(text: string, opts: { needsDisclaimer: boolean }): Finding[] {
  const out: Finding[] = []
  for (const [re, fix] of RETIRED) {
    const m = text.match(re)
    if (m) out.push({ rule: 'Retired name', found: m[0], fix: `Use "${fix}".` })
  }
  for (const re of ADVICE) {
    const m = text.match(re)
    if (m) out.push({ rule: 'Advice wording', found: m[0], fix: 'Summit shows what the data says; no buy points, targets, levels or plans.' })
  }
  for (const [re, fix] of UK) {
    const m = text.match(re)
    if (m) out.push({ rule: 'UK spelling', found: m[0], fix: `Use "${fix}".` })
  }
  if (opts.needsDisclaimer && text.length > 40 && !DISCLAIMER.test(text)) {
    out.push({ rule: 'Missing disclaimer', found: '(none)', fix: 'Add "Not advice." or the research-and-education line.' })
  }
  return out
}

// Which calls are public sends whose words the gate reads, and which words.
export function publicWords(tool: string, input: Record<string, unknown>): { text: string; needsDisclaimer: boolean; what: string } | null {
  const pick = (...keys: string[]) =>
    keys
      .map(k => input[k])
      .filter((v): v is string => typeof v === 'string')
      .join('\n')
  if (/Metricool.*(createScheduledPost|updateScheduledPost|createScheduledPostForReview)/i.test(tool)) {
    const words = pick('text', 'caption', 'body', 'title') || JSON.stringify(input)
    return { text: words, needsDisclaimer: true, what: 'social post' }
  }
  if (tool.startsWith('mcp__') && /(send_?(email|message|newsletter)|gmail.*send|publish_?post)/i.test(tool) && !tool.startsWith('mcp__hearthbot__')) {
    return { text: pick('subject', 'body', 'text', 'html', 'content'), needsDisclaimer: false, what: 'message' }
  }
  return null
}

export function describe(findings: Finding[]): string {
  return findings.map(f => `${f.rule}: "${f.found}". ${f.fix}`).join(' ')
}
