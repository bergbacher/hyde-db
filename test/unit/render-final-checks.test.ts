import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../../src/config.ts'
import { checkContext, FINAL_CHECKS, renderFinalCheck } from '../../src/render/final-checks.ts'

describe('D143: the final check is an ordered list of check records', () => {
  it('D143: pins each record id to its README refusal row, rows 2 to 15 in order', () => {
    expect(FINAL_CHECKS.map((c) => [c.row, c.id])).toEqual([
      [2, 'role-attributes'],
      [3, 'ownership'],
      [4, 'memberships'],
      [5, 'schema-creation'],
      [6, 'catalog-privileges'],
      [7, 'relations'],
      [8, 'foreign-servers'],
      [9, 'security-definer'],
      [10, 'sequences'],
      [11, 'default-privileges'],
      [12, 'create-in-schemas'],
      [13, 'lo-compat-privileges'],
      [14, 'large-object-acls'],
      [15, 'parameters'],
    ])
  })
  it('D143: every record renders an abort and the assembled check holds the records as consecutive blocks in order', () => {
    const ctx = checkContext(DEFAULT_CONFIG)
    const assembled = renderFinalCheck(DEFAULT_CONFIG)
    let next: number | undefined
    for (const check of FINAL_CHECKS) {
      const lines = check.render(ctx)
      expect(lines.join('\n'), check.id).toContain('RAISE EXCEPTION')
      const at = assembled.findIndex((_, i) => lines.every((line, j) => assembled[i + j] === line))
      expect(at, `${check.id} is present`).toBeGreaterThanOrEqual(0)
      if (next !== undefined) expect(at, `${check.id} follows the previous record`).toBe(next)
      next = at + lines.length
    }
    expect(assembled.slice(next)).toEqual(['END $$;'])
  })
})
