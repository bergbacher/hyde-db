// Preloaded into a generator process (node --import) so that every rmSync fails, the way a
// cleanup would on a read-only or busy file system (D147).
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

fs.rmSync = () => {
  throw Object.assign(new Error('EBUSY: cleanup refused'), { code: 'EBUSY' })
}
syncBuiltinESMExports()
