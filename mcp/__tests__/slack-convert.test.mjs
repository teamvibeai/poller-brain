// Acceptance tests for the tv.ai#228 auto-convert (pipe-table in `text` →
// `markdown` block + native fallback). slack.mjs auto-starts a stdio server on
// import, so we load just its pure prelude (everything before the transport
// section) as a module and exercise the exported-by-eval helpers. No network,
// no Slack. Run: node mcp/__tests__/slack-convert.test.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'slack.mjs'), 'utf8')
const prelude = src.split('// --- stdio transport ---')[0]
const exports = '\nexport { isTableLine, computePipeTableWarning, gfmInlineToMrkdwn, convertPipeTablesToBlocks, textToSections, stripBoldWrappedUrl, wrapBoldEmbeddedUrl }\n'
const mod = await import('data:text/javascript,' + encodeURIComponent(prelude + exports))
const { computePipeTableWarning, convertPipeTablesToBlocks, stripBoldWrappedUrl, wrapBoldEmbeddedUrl } = mod

let pass = 0, fail = 0
const ok = (n, c) => { if (c) { pass++; console.log('  ✓', n) } else { fail++; console.log('  ✗ FAIL', n) } }

// 1) prose + table → section(prose) + one markdown block; fallback = verbatim prose (no pipes)
{
  const r = convertPipeTablesToBlocks('Hotovo, <@U01>:\n\n| úkol | stav |\n|---|---|\n| deploy | ✅ |\n| testy | ❌ |')
  ok('1 converted', !!r)
  ok('1 section first + exactly one markdown block', r.blocks[0].type === 'section' && r.blocks.filter(b => b.type === 'markdown').length === 1)
  ok('1 fallback = prose verbatim, no pipe chars', r.fallbackText === 'Hotovo, <@U01>:' && !r.fallbackText.includes('|'))
  ok('1 transformed echo present', r.transformed?.reason === 'pipe_table_in_text' && r.transformed.table_moved_to === 'markdown_block')
}
// 2) table-only → single markdown block, fallback NEVER empty (tv.ai#108)
{
  const r = convertPipeTablesToBlocks('| a | b |\n|---|---|\n| 1 | 2 |')
  ok('2 only a markdown block', r.blocks.length === 1 && r.blocks[0].type === 'markdown')
  ok('2 fallback non-empty', typeof r.fallbackText === 'string' && r.fallbackText.trim().length > 0)
}
// 3) passthrough is enforced at the send_message gate (agentSuppliedBlocks) — here
//    we assert the gate still SEES the table so the #224 warning fires in that branch
{
  ok('3 gate detects table (warning path for agent-supplied blocks)', computePipeTableWarning('x\n| a | b |\n| 1 | 2 |')?.code === 'ascii_table_in_text')
}
// 4) interleaved prose/table/prose/table → ordered blocks, both prose in fallback
{
  const r = convertPipeTablesToBlocks('Nahoře:\n| a | b |\n| 1 | 2 |\n\nDole:\n| c | d |\n| 3 | 4 |')
  ok('4 ordered section,markdown,section,markdown', JSON.stringify(r.blocks.map(b => b.type)) === JSON.stringify(['section', 'markdown', 'section', 'markdown']))
  ok('4 fallback carries both prose, no pipes', r.fallbackText.includes('Nahoře') && r.fallbackText.includes('Dole') && !r.fallbackText.includes('|'))
}
// 5) prose with GFM bold+link → normalized to mrkdwn in section; table stays RAW
{
  const r = convertPipeTablesToBlocks('Viz **důležité** a [odkaz](https://x.io):\n| a | b |\n| 1 | 2 |')
  const sec = r.blocks.find(b => b.type === 'section').text.text
  ok('5 **bold** → *bold*', sec.includes('*důležité*') && !sec.includes('**'))
  ok('5 [x](url) → <url|x>', sec.includes('<https://x.io|odkaz>'))
  ok('5 table raw (pipes preserved, no mrkdwn mangling)', r.blocks.find(b => b.type === 'markdown').text.includes('| a | b |'))
}
// 6) mention preserved in fallback → ping survives
{
  const r = convertPipeTablesToBlocks('Ahoj <@U01TALN63DK>:\n| a | b |\n| 1 | 2 |')
  ok('6 mention in native fallback', r.fallbackText.includes('<@U01TALN63DK>'))
}
// 7) no table → zero transformation (passthrough); gate + convert both null
{
  const t = 'Jen normální text, *tučně*, žádná tabulka.'
  ok('7 gate null', computePipeTableWarning(t) === null)
  ok('7 convert null (byte-identical passthrough upstream)', convertPipeTablesToBlocks(t) === null)
}
// 8) pipe-table inside a code fence → treated as prose, NOT converted
{
  const t = 'Příklad:\n```\n| a | b |\n| 1 | 2 |\n```\nkonec'
  ok('8 fenced table gate null', computePipeTableWarning(t) === null)
  ok('8 fenced table convert null', convertPipeTablesToBlocks(t) === null)
}
// 9) single isolated pipe line (not 2+ rows) → not a table
{
  ok('9 lone pipe line not a table', computePipeTableWarning('cena | 100 Kč jeden řádek') === null)
}

// 10) poller-brain#225: bare URL wrapped as its own bold span -> stripped
{
  ok('10 whole-span bold URL stripped', stripBoldWrappedUrl('*https://x.io/a*') === 'https://x.io/a')
  ok('10 mid-sentence, surrounded by other text', stripBoldWrappedUrl('Hotovo: *https://x.io/a* diky') === 'Hotovo: https://x.io/a diky')
  ok('10 start of string, trailing text', stripBoldWrappedUrl('*https://x.io/a* diky') === 'https://x.io/a diky')
  ok('10 end of string, leading text', stripBoldWrappedUrl('Viz *https://x.io/a*') === 'Viz https://x.io/a')
  ok('10 multiple occurrences', stripBoldWrappedUrl('*https://a.io*\n*https://b.io*') === 'https://a.io\nhttps://b.io')
}
// 11) poller-brain#225: NOT touched — bold sentence merely containing a URL as substring
{
  const t = '*Viz report: https://x.io/a pro detaily*'
  ok('11 bold sentence with URL substring untouched', stripBoldWrappedUrl(t) === t)
}
// 12) poller-brain#225: NOT touched — other markers (narrow scope: only `*...*`)
{
  ok('12 underscore-italic untouched', stripBoldWrappedUrl('_https://x.io/a_') === '_https://x.io/a_')
  ok('12 tilde-strike untouched', stripBoldWrappedUrl('~https://x.io/a~') === '~https://x.io/a~')
  ok('12 double-star GFM bold untouched (different pattern)', stripBoldWrappedUrl('**https://x.io/a**') === '**https://x.io/a**')
}
// 13) poller-brain#225: plain text / no markers -> byte-identical passthrough
{
  const t = 'Jen normální text s https://x.io/a bez formátování.'
  ok('13 unwrapped URL untouched', stripBoldWrappedUrl(t) === t)
  ok('13 no URL at all untouched', stripBoldWrappedUrl('*tučně* bez URL') === '*tučně* bez URL')
}

// 14) poller-brain#322: URL mid-sentence inside a real `*...*` bold span -> wrapped
{
  ok('14 mid-sentence url wrapped, span stays bold', wrapBoldEmbeddedUrl('*testovat můžeš na https://x.io/a*') === '*testovat můžeš na <https://x.io/a>*')
  ok('14 leading text, end of string', wrapBoldEmbeddedUrl('*Viz https://x.io/a*') === '*Viz <https://x.io/a>*')
  ok('14 url NOT adjacent to closing star untouched (no adjacency bug here)', wrapBoldEmbeddedUrl('*https://x.io/a je hotovo*') === '*https://x.io/a je hotovo*')
  ok('14 trailing punctuation moved outside the link', wrapBoldEmbeddedUrl('*viz https://x.io/a.*') === '*viz <https://x.io/a>.*')
  ok('14 trailing punctuation, multiple marks', wrapBoldEmbeddedUrl('*hotovo, https://x.io/a!*') === '*hotovo, <https://x.io/a>!*')
}
// 15) poller-brain#322 DevGuru round-1 blocking catch: NOT touched — URL not
// inside a real bold span (no matching opening `*` anchor before it), even
// though the URL itself is immediately followed by a word-boundary `*`
{
  ok('15 cloudflare route glob (URL contains literal /*) untouched', wrapBoldEmbeddedUrl('routa https://console.sitebrew.app/* pokrývá vše') === 'routa https://console.sitebrew.app/* pokrývá vše')
  const fence = 'Příklad:\n```\ncurl https://x.io/a*\n```\nkonec'
  ok('15 url+trailing-star inside a code fence untouched', wrapBoldEmbeddedUrl(fence) === fence)
  ok('15 plain prose url with literal trailing star untouched', wrapBoldEmbeddedUrl('zdroj https://x.io/a* (viz níže)') === 'zdroj https://x.io/a* (viz níže)')
}
// 16) poller-brain#322: NOT touched — other markers / already-explicit-link idempotence
{
  ok('16 underscore-italic untouched', wrapBoldEmbeddedUrl('_Viz https://x.io/a_') === '_Viz https://x.io/a_')
  ok('16 double-star GFM bold untouched (different pattern)', wrapBoldEmbeddedUrl('**Viz https://x.io/a**') === '**Viz https://x.io/a**')
  ok('16 already <url> form is idempotent', wrapBoldEmbeddedUrl('*Viz <https://x.io/a>*') === '*Viz <https://x.io/a>*')
  ok('16 already <url|label> form is idempotent', wrapBoldEmbeddedUrl('*Viz <https://x.io/a|label>*') === '*Viz <https://x.io/a|label>*')
  ok('16 #225 solo-span case untouched (that shape is stripBoldWrappedUrl\'s job)', wrapBoldEmbeddedUrl('*https://x.io/a*') === '*https://x.io/a*')
}
// 17) poller-brain#322: strip→wrap pipeline order — solo-span strips (#225),
// embedded-in-sentence wraps (#322), no double-matching within one string
{
  const combo = 'Report: *https://x.io/a* a *viz https://y.io/b* diky'
  const afterStrip = stripBoldWrappedUrl(combo)
  ok('17 strip only touches the solo-span occurrence', afterStrip === 'Report: https://x.io/a a *viz https://y.io/b* diky')
  ok('17 wrap only touches the embedded occurrence, strip result untouched otherwise', wrapBoldEmbeddedUrl(afterStrip) === 'Report: https://x.io/a a *viz <https://y.io/b>* diky')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
