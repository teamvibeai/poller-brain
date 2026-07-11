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
const exports = '\nexport { isTableLine, computePipeTableWarning, gfmInlineToMrkdwn, convertPipeTablesToBlocks, textToSections }\n'
const mod = await import('data:text/javascript,' + encodeURIComponent(prelude + exports))
const { computePipeTableWarning, convertPipeTablesToBlocks } = mod

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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
