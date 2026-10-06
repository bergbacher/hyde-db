// Tiny builders for hand-written DMMF datamodels in unit tests.
import type { DmmfDatamodel, DmmfField, DmmfModel } from '../../src/types.ts'

export function scalar(
  name: string,
  documentation?: string,
  extra: Partial<DmmfField> = {},
): DmmfField {
  return { name, kind: 'scalar', type: 'String', isRequired: true, documentation, ...extra }
}

export function model(
  name: string,
  fields: readonly DmmfField[],
  extra: Partial<Omit<DmmfModel, 'name' | 'fields'>> = {},
): DmmfModel {
  return { name, fields, ...extra }
}

export function datamodel(...models: DmmfModel[]): DmmfDatamodel {
  return { models }
}
