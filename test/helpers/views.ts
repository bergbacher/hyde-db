// Hand-written renderer inputs for unit tests.
import type { ResolvedConfig, View } from '../../src/types.ts'

export const config: ResolvedConfig = {
  schema: 'redacted',
  role: 'redacted_reader',
  sourceSchema: 'public',
  default: 'hidden',
  strict: true,
  statementTimeout: '15s',
}

export const users: View = {
  model: 'User',
  name: 'users',
  sourceSchema: 'public',
  source: 'users',
  doc: "A customer's account.",
  columns: [
    { column: 'id', field: 'id', type: 'Int', nullable: false, isId: true, doc: '' },
    {
      column: 'country',
      field: 'country',
      type: 'String',
      nullable: true,
      isId: false,
      doc: 'ISO | code',
    },
  ],
  relations: [],
}

export const orders: View = {
  model: 'Order',
  name: 'orders',
  sourceSchema: 'sales',
  source: 'Order Items',
  doc: '',
  columns: [
    { column: 'id', field: 'id', type: 'Int', nullable: false, isId: true, doc: '' },
    { column: 'user_id', field: 'userId', type: 'Int', nullable: false, isId: false, doc: '' },
  ],
  relations: [{ fromCols: ['user_id'], target: 'users', targetModel: 'User', toCols: ['id'] }],
}
