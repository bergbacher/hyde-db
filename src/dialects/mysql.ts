// The MySQL Dialect (D104, D107, D113, D114, D115). Its only generate-time rule is the marker-view
// name; the D12 counterpart is a run-time check in the apply script (D117).
import { validateConfig } from '../config.ts'
import { viewNameCollision } from '../diagnostics.ts'
import { renderMysqlApplySql } from '../render/mysql-apply-sql.ts'
import { renderMysqlDropSql } from '../render/mysql-drop-sql.ts'
import { ABORT_TABLE, MARKER_VIEW } from '../render/mysql-guards.ts'
import { renderMysqlMarkdown } from '../render/mysql-markdown.ts'
import type { Diagnostic, MysqlConfig, View } from '../types.ts'
import type { Dialect } from './index.ts'

/**
 * D115, D157, D167: a view named like the marker view or the script's abort table, in any case
 * (D152), collides with it; the script's own object holds the name first.
 */
function mysqlViewRules(_config: MysqlConfig, views: readonly View[]): Diagnostic[] {
  const holders: Readonly<Record<string, string>> = {
    [MARKER_VIEW]: 'the hyde-db marker view',
    [ABORT_TABLE]: 'the hyde-db abort table',
  }
  return views.flatMap((view) => {
    const name = view.name.toLowerCase()
    const holder = Object.hasOwn(holders, name) ? holders[name] : undefined
    return holder === undefined ? [] : [viewNameCollision(name, holder, view.source)]
  })
}

export const mysqlDialect: Dialect<MysqlConfig> = {
  provider: 'mysql',
  validate: (raw) => validateConfig(raw, 'mysql'),
  configRules: () => [],
  viewRules: mysqlViewRules,
  sourceSchemaOf: () => null,
  render: { apply: renderMysqlApplySql, drop: renderMysqlDropSql, markdown: renderMysqlMarkdown },
}
