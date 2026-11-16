// Shared by the history boundary guard and the retry fingerprint normalizer.
export function historyPathFor(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error('invalid cycle date')
  }
  return `memory/episodic/archive/consolidation-history-${date.slice(0, 4)}-H${Number(date.slice(5, 7)) <= 6 ? 1 : 2}.md`
}

export function validateHistoryAppend(before, after, date, start) {
  historyPathFor(date)
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(start)) throw new Error('invalid starting HEAD')
  for (const bytes of [before, after]) {
    if (!Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new Error('invalid history UTF-8')
  }
  if (!after.subarray(0, before.length).equals(before)) throw new Error('existing archive bytes were not preserved')
  const suffix = after.subarray(before.length).toString('utf8')
  // Exactly one bounded, substantive record for this cycle; no extra prose,
  // duplicate cycle, or completion annotation may be treated as bookkeeping.
  const heading = `## Consolidation ${date} / ${start}`
  const record = suffix.match(/^\s*(## Consolidation [^\n]+)\nStatus: in progress\nWork performed: ([^\n]+)\n<!-- \/consolidation-history -->\n?\s*$/)
  if (!record || record[1] !== heading || record[2].trim().length < 20 || record[2].trim().split(/\s+/).length < 3) {
    throw new Error('missing substantive in-progress record for this exact cycle in the new append')
  }
  if (before.toString('utf8').split('\n').includes(heading)) throw new Error('cycle record already existed at starting HEAD')
}
