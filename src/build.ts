// build(): analysis plus the three output files; no files when any diagnostic is an error.
import { analyze } from './analyze.ts'
import { hasErrors } from './diagnostics.ts'
import { renderApplySql } from './render/apply-sql.ts'
import { renderDropSql } from './render/drop-sql.ts'
import { renderMarkdown } from './render/markdown.ts'
import type { BuildResult, DmmfDatamodel, GeneratorConfig } from './types.ts'

export function build(datamodel: DmmfDatamodel, config?: GeneratorConfig): BuildResult {
  const analysis = analyze(datamodel, config)
  if (hasErrors(analysis.diagnostics)) return { ...analysis, files: null }
  return {
    ...analysis,
    files: {
      'redacted-views.sql': renderApplySql(analysis),
      'redacted-views-drop.sql': renderDropSql(analysis),
      'redacted-schema.md': renderMarkdown(analysis),
    },
  }
}
