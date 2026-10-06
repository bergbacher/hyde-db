// Builds the package and packs it into .e2e/ for the end-to-end tests (D20).
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'

rmSync('.e2e', { recursive: true, force: true })
mkdirSync('.e2e')
execFileSync('pnpm', ['build'], { stdio: 'inherit' })
execFileSync('pnpm', ['pack', '--pack-destination', '.e2e'], { stdio: 'inherit' })
