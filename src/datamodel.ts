// Datamodel adapter (D7, D46, D47): converts Prisma's DMMF datamodel into hyde-db's own
// minimal, internal Datamodel. Differences between Prisma majors are absorbed here; the
// rest of the core imports no Prisma types.
import type { DmmfDatamodel, DmmfField, DmmfModel } from './types.ts'

/** `other` covers kinds hyde-db never exposes (e.g. `unsupported`). */
export type FieldKind = 'scalar' | 'enum' | 'object' | 'other'

export interface Field {
  readonly name: string
  readonly column: string
  readonly kind: FieldKind
  readonly type: string
  readonly isList: boolean
  readonly isRequired: boolean
  readonly isId: boolean
  readonly documentation: string
  readonly relationFromFields: readonly string[]
  readonly relationToFields: readonly string[]
}

export interface Model {
  readonly name: string
  readonly table: string
  readonly schema: string | null
  readonly documentation: string
  readonly fields: readonly Field[]
}

export interface Datamodel {
  readonly models: readonly Model[]
}

function toKind(kind: string): FieldKind {
  return kind === 'scalar' || kind === 'enum' || kind === 'object' ? kind : 'other'
}

function toField(field: DmmfField): Field {
  return {
    name: field.name,
    column: field.dbName || field.name,
    kind: toKind(field.kind),
    type: field.type,
    isList: field.isList === true,
    isRequired: field.isRequired === true,
    isId: field.isId === true,
    documentation: field.documentation ?? '',
    relationFromFields: field.relationFromFields ?? [],
    relationToFields: field.relationToFields ?? [],
  }
}

function toModel(model: DmmfModel): Model {
  return {
    name: model.name,
    table: model.dbName || model.name,
    schema: model.schema || null,
    documentation: model.documentation ?? '',
    fields: model.fields.map(toField),
  }
}

export function toDatamodel(dmmf: DmmfDatamodel): Datamodel {
  return { models: dmmf.models.map(toModel) }
}
