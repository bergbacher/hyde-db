// SECURITY.md is a view of LEDGER.md. It states the same guarantee and non-guarantees as the
// README (D93), word for word where the README states them, plus the private reporting path (D41),
// the supported release (D133) and a hardening checklist; these tests keep the two documents from
// drifting apart.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  citedRecords,
  headingAnchors,
  ledgerStatement,
  ledgerStates,
  section,
  withoutComments,
} from '../helpers/docs.ts'
import { readRepoFile, repoRoot } from '../helpers/files.ts'

const security = readRepoFile('SECURITY.md')
const prose = withoutComments(security)
const readmeProse = withoutComments(readRepoFile('README.md'))
const applySql = readRepoFile('example', 'redacted', 'redacted-views.sql')

/** The paragraphs of a section: blocks of text separated by blank lines, trimmed. */
function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
}

/** A table's separator row, such as `|---|---|`. */
const SEPARATOR = /^\|[-| ]+\|$/

/** The first cell of every body row of the tables in `text`: header and separator rows skipped. */
function firstColumn(text: string): string[] {
  const lines = text.split('\n')
  const header = (index: number): boolean => SEPARATOR.test(lines[index + 1] ?? '')
  return lines
    .filter((line, index) => line.startsWith('|') && !SEPARATOR.test(line) && !header(index))
    .map((row) => row.split(/(?<!\\)\|/)[1]?.trim() ?? '')
}

const README_GUARANTEES = section(readmeProse, 'What it guarantees and what it does not')
const CHECKLIST = section(prose, 'Hardening checklist')

describe('SECURITY.md (a view of LEDGER.md)', () => {
  it('D41: routes reports through GitHub private vulnerability reporting', () => {
    expect(prose).toContain('GitHub private vulnerability reporting')
    expect(prose).toContain('https://github.com/bergbacher/hyde-db/security/advisories/new')
    expect(prose).toContain('Do not open a public issue')
  })

  it('D133: only the latest release is supported, in the ledger’s words', () => {
    expect(section(prose, 'Supported versions')).toContain(ledgerStatement('D133'))
    expect(citedRecords(security).has('D133')).toBe(true)
  })

  it('D93, D14, D132: states the README guarantee and its time scope word for word', () => {
    const [guarantee, sessionDefaults] = paragraphs(README_GUARANTEES).slice(1, 3)
    expect(guarantee).toMatch(/^The guarantee is the privilege setup/)
    expect(guarantee).toContain('can read no table data outside the generated views')
    expect(guarantee).toContain(
      'It holds as of each successful apply: a grant made later is not prevented, and the next apply refuses it.',
    )
    expect(sessionDefaults).toContain('are session defaults, not guarantees')
    // D1, D95: the README's proof sentence is the PostgreSQL mechanism; SECURITY.md words it per dialect.
    const proof = ' The apply script proves that against the live database before it commits.'
    expect(guarantee).toContain(proof)
    const [head = '', tail = ''] = guarantee?.split(proof) ?? []
    expect(prose).toContain(head)
    expect(prose).toContain(tail.trim())
    expect(prose).not.toContain(proof)
    expect(prose).toContain('On PostgreSQL the apply script proves that')
    expect(prose).toContain('before it commits')
    expect(prose).toContain(sessionDefaults)
  })

  it('D93: labels the hardening checklist as PostgreSQL only', () => {
    expect(CHECKLIST).toMatch(/^Run each step once\./m)
    expect(CHECKLIST).toContain('These steps are for PostgreSQL')
  })

  it('D93, D34, D15, D50: lists exactly the README non-guarantees, in the same order', () => {
    const readmeRows = firstColumn(README_GUARANTEES)
    expect(readmeRows.length).toBeGreaterThanOrEqual(8)
    expect(firstColumn(section(prose, 'What hyde-db does not guarantee'))).toEqual(readmeRows)
  })

  it('D93: gives the optional large-object hardening and its cost, as the README does', () => {
    const statement =
      'REVOKE EXECUTE ON FUNCTION lo_create(oid), lo_creat(integer), lo_from_bytea(oid, bytea) FROM PUBLIC;'
    expect(readmeProse).toContain(statement)
    expect(CHECKLIST).toContain(statement)
  })

  it('D11, D13, D24, D49, D58, D141: says the final check refuses every kind of access the apply script checks, and that a refusal changes nothing', () => {
    // The aborts after the header of the final check; the guards before the drop come earlier.
    const finalCheck = applySql.slice(applySql.indexOf('-- Safety check'))
    const finalChecks = (finalCheck.match(/RAISE EXCEPTION/g) ?? []).length
    expect(finalChecks).toBeGreaterThanOrEqual(14)
    const enforced = section(prose, 'How the PostgreSQL guarantee is enforced', '###')
    expect(enforced).toContain(`${finalChecks} kinds of access`)
    expect(enforced).toContain('nothing changes')
    expect(enforced).toContain('Generated by hyde-db')
    expect(enforced).toContain('objects outside it that depend on its views')
    expect(enforced).toContain('never changes the reader role')
    expect(enforced).toContain('README.md#what-the-apply-script-refuses')
  })

  it('D135: states only what the tests show about pasted fixes, as the README does', () => {
    const evidence =
      'The integration tests paste each printed fix and re-apply; the fix tests also compare ACL entries before and after the paste.'
    expect(readmeProse).toContain(evidence)
    expect(section(prose, 'How the PostgreSQL guarantee is enforced', '###')).toContain(evidence)
    expect(prose).not.toContain('proves each refusal and each printed fix')
  })

  it('D15: gives the REVOKE CONNECT step', () => {
    expect(CHECKLIST).toContain('REVOKE CONNECT ON DATABASE other_database FROM PUBLIC;')
  })

  it('D141, D144: the drop refusal excepts temporary objects and objects that depend on one, as the README does', () => {
    const phrase = 'temporary objects and objects that depend on a temporary object excepted'
    expect(prose).toContain(phrase)
    expect(readmeProse).toContain(phrase)
  })

  it('A99, D140: the cluster step says a role belongs to the whole cluster and gives each database its own role, as the README does', () => {
    const sentence = 'give each database, and each generator block, its own `role`'
    expect(CHECKLIST).toContain('A role belongs to the whole cluster')
    expect(CHECKLIST).toContain(sentence)
    expect(readmeProse).toContain(sentence)
  })

  it("A15, A95, D24: gives the REVOKE CREATE step for PostgreSQL 14 and older, run in the application's database by the owner of public or a superuser", () => {
    expect(CHECKLIST).toContain('REVOKE CREATE ON SCHEMA public FROM PUBLIC;')
    expect(CHECKLIST).toContain('PostgreSQL 14 and older')
    expect(CHECKLIST).toContain("in the application's database")
    expect(CHECKLIST).toContain('the owner of schema `public` or a superuser')
    expect(CHECKLIST).toContain('no privileges could be revoked')
  })

  it('D50: gives the optional REVOKE TEMPORARY step and says it affects every role', () => {
    expect(CHECKLIST).toContain('REVOKE TEMPORARY ON DATABASE app_database FROM PUBLIC;')
    expect(CHECKLIST).toContain('affects every role')
    expect(CHECKLIST).toContain('read replica')
  })

  it('every link into the repository points at a file and, with an anchor, at a heading of it', () => {
    const links = Array.from(prose.matchAll(/\]\(([^)]+)\)/g), (m) => m[1] ?? '').filter(
      (target) => !/^[a-z]+:/.test(target),
    )
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      // A bare `#anchor` points into SECURITY.md itself.
      const [path = '', fragment] = link.split('#')
      const file = path === '' ? 'SECURITY.md' : path
      expect(existsSync(join(repoRoot, file)), link).toBe(true)
      if (fragment !== undefined)
        expect(headingAnchors(readRepoFile(file)), link).toContain(fragment)
    }
  })

  it('D41: the README links here', () => {
    expect(readmeProse).toContain('[SECURITY.md](SECURITY.md)')
  })

  it('keeps record IDs in HTML comments, cites only live records, and ends with the view footer', () => {
    expect(prose).not.toMatch(/\b[ADCQ]\d+\b/)
    const states = ledgerStates()
    const cited = citedRecords(security)
    expect(cited.size).toBeGreaterThan(0)
    for (const id of cited) {
      expect(['active', 'verified', 'open', 'answered'], id).toContain(states.get(id))
    }
    expect(security.trimEnd()).toMatch(/\n---\n\nView on LEDGER\.md, \d{4}-\d{2}-\d{2}$/)
  })
})

describe('SECURITY.md on MySQL (a view of LEDGER.md)', () => {
  const guarantee = section(prose, 'What hyde-db guarantees')
  const notGuaranteed = section(prose, 'What hyde-db does not guarantee')
  const mysqlGuarantee = section(guarantee, 'The MySQL guarantee', '###')
  const mysqlLimits = section(notGuaranteed, 'MySQL non-guarantees', '###')

  it('D101, A74, D132: states the MySQL guarantee: no table data outside the views, no rollback, the refused-deploy wording, the time scope', () => {
    expect(mysqlGuarantee).toContain('can read no table data outside the views')
    expect(mysqlGuarantee).toContain('cannot be rolled back')
    expect(mysqlGuarantee).toContain('never grants the reader more than before')
    expect(mysqlGuarantee).toContain('rebuilt without the reader grant')
    expect(mysqlGuarantee).toContain('no other database names or columns')
    expect(mysqlGuarantee).toContain('as of each successful apply')
    expect(mysqlGuarantee).toContain('check, build the views, grant last, re-check')
  })

  it('D101, A78: lists the MySQL non-guarantees: only per-account resource limits stick; read-only and timeout are session settings', () => {
    expect(mysqlLimits).toContain('per-account resource limits')
    expect(mysqlLimits).toContain('session settings')
    expect(mysqlLimits).toContain('can change')
  })

  it('A103: says the reader sees server status and variables and its own session in performance_schema', () => {
    expect(mysqlLimits).toContain('performance_schema')
    expect(mysqlLimits).toContain('server status and variables')
    expect(mysqlLimits).toContain('its own session')
  })

  it('D101, A104: says a refused apply leaves access the reader already has until the printed fix runs', () => {
    expect(mysqlLimits).toContain('default roles')
    expect(mysqlLimits).toContain('mandatory_roles')
    expect(mysqlLimits).toContain('same user name')
    expect(mysqlLimits).toContain('anonymous')
    expect(mysqlLimits).toContain('until the printed fix runs')
  })

  it('D120: says role is the account user name, not a MySQL ROLE, and a non-empty mandatory_roles is unsupported', () => {
    expect(mysqlGuarantee + mysqlLimits).toContain('not a MySQL `ROLE`')
    expect(mysqlLimits).toContain('non-empty `mandatory_roles` is unsupported')
  })

  it('D118: says managed services are not tested end to end and PlanetScale is unsupported', () => {
    expect(mysqlLimits).toContain('not tested end to end')
    expect(mysqlLimits).toContain('PlanetScale is unsupported')
    expect(mysqlLimits).toContain('Cloud SQL')
  })

  it('D94: names the supported MySQL lines and the unsupported ones', () => {
    const supported = section(prose, 'Supported versions')
    expect(supported).toContain('MySQL 8.4 and 9.7')
    expect(supported).toContain('MariaDB')
    expect(supported).toContain('MySQL 8.0')
  })

  it('D164, A105, D165: says one source database and one generator block each need their own schema and role on a MySQL server', () => {
    const text = mysqlGuarantee + mysqlLimits
    expect(text).toContain('its own `schema` and `role`')
    expect(text).toContain('both belong to the whole server')
    expect(text).toContain('a second source database that uses the same `schema` is refused')
    expect(text).toContain(
      'a shared `role` is not detected and lets one reader read the views of both',
    )
  })

  it('D164, D119, A74: says the reader account must serve only as the hyde-db reader, and why', () => {
    expect(mysqlLimits).toContain('must serve only as the hyde-db reader')
    expect(mysqlLimits).toContain('every apply and drop first revokes all its privileges')
    expect(mysqlLimits).toContain('MySQL cannot roll that back')
  })

  it('D164, D155, A74: says the scripts run without --force and an account with CREATE VIEW or DROP can replace a view', () => {
    expect(mysqlLimits).toContain('without `--force`')
    expect(mysqlLimits).toContain('can leave the previous views granted')
    expect(mysqlLimits).toContain(
      'an account with `CREATE VIEW` or `DROP` on the views database can replace a view, and the reader grant stays attached',
    )
    expect(mysqlGuarantee).toContain('only after a refusal')
  })

  it('D154, D103: the MySQL attack suite claim is scoped to the paths of A77', () => {
    expect(mysqlGuarantee).toContain("each path beyond the reader's direct grants")
    expect(mysqlGuarantee).toContain(
      'neutralised by the reset or refused with a working pasted fix',
    )
    expect(mysqlGuarantee).not.toContain('every path through which the reader could reach more')
    expect(mysqlGuarantee).not.toMatch(/\bA77\b/)
  })

  it('cites the MySQL records it states', () => {
    const cited = citedRecords(security)
    for (const id of [
      'D101',
      'A74',
      'A78',
      'A103',
      'A104',
      'D118',
      'D120',
      'D94',
      'D164',
      'A105',
      'D154',
    ]) {
      expect(cited.has(id), id).toBe(true)
    }
  })
})
