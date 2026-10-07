// build(): analysis plus the three output files; no files when any diagnostic is an error.
import { analyze } from './analyze.ts'
import { hasErrors } from './diagnostics.ts'
import { type Dialect, dialectFor } from './dialects/index.ts'
import type {
  Analysis,
  BuildOptions,
  BuildResult,
  DmmfDatamodel,
  GeneratorConfig,
  ResolvedConfig,
} from './types.ts'

export function build(
  datamodel: DmmfDatamodel,
  config?: GeneratorConfig,
  options: BuildOptions = {},
): BuildResult {
  const analysis = analyze(datamodel, config, options)
  if (hasErrors(analysis.diagnostics)) return { ...analysis, files: null }
  // An unregistered provider is an error, so a dialect is always found here (D142).
  return buildFiles(dialectFor(analysis.config.dialect) as Dialect, analysis)
}

function buildFiles<C extends ResolvedConfig>(
  dialect: Dialect<C>,
  analysis: Analysis & { config: C },
): BuildResult {
  return {
    ...analysis,
    files: {
      'redacted-views.sql': dialect.render.apply(analysis),
      'redacted-views-drop.sql': dialect.render.drop(analysis),
      'redacted-schema.md': dialect.render.markdown(analysis),
    },
  }
}
