// Helpers for the tests that pin README.md and SECURITY.md, which are views of LEDGER.md.
import { readRepoFile } from './files.ts'

/** The text without HTML comments, which is where the documents keep record IDs. */
export function withoutComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '')
}

/**
 * A section of a Markdown document, from its heading (`##` unless `level` says otherwise) up to the
 * next `## ` heading; throws when there is no such heading.
 */
export function section(text: string, heading: string, level = '##'): string {
  const start = text.indexOf(`\n${level} ${heading}\n`)
  if (start === -1) throw new Error(`no "${level} ${heading}" section`)
  const end = text.indexOf('\n## ', start + 1)
  return text.slice(start, end === -1 ? undefined : end)
}

/** GitHub's anchor for a heading: lower case, punctuation other than `-` dropped, spaces as `-`. */
export function anchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\- ]/g, '')
    .replaceAll(' ', '-')
}

/** The anchors of every heading in a Markdown document. */
export function headingAnchors(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => /^#{1,6} /.test(line))
    .map((line) => anchor(line.replace(/^#+ /, '')))
}

/**
 * Record ID → state, from the records table of LEDGER.md. The state is read from the end of the
 * row (State, Basis, By), since a statement may hold an unescaped pipe, as in `string | null`.
 */
export function ledgerStates(): Map<string, string> {
  const states = new Map<string, string>()
  for (const line of readRepoFile('LEDGER.md').split('\n')) {
    const row = line.split(/(?<!\\)\|/).map((cell) => cell.trim())
    const id = row[1]
    if (id !== undefined && /^[ADCQ]\d+$/.test(id)) states.set(id, row.at(-4) ?? '')
  }
  return states
}

/** The statement of a ledger record, from its row in LEDGER.md. */
export function ledgerStatement(id: string): string {
  const row = readRepoFile('LEDGER.md')
    .split('\n')
    .find((line) => line.startsWith(`| ${id} |`))
  if (row === undefined) throw new Error(`LEDGER.md has no record ${id}`)
  return row.split(/(?<!\\)\|/)[2]?.trim() ?? ''
}

/** The record IDs cited in a document's HTML comments. */
export function citedRecords(text: string): Set<string> {
  return new Set(
    Array.from(text.matchAll(/<!--[\s\S]*?-->/g), (match) =>
      Array.from(match[0].matchAll(/\b[ADCQ]\d+\b/g), (id) => id[0]),
    ).flat(),
  )
}
