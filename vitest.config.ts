import { defineConfig, type ViteUserConfig } from 'vitest/config'

const config: ViteUserConfig = defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/generator.ts'],
      reporter: ['text', 'lcov'],
      thresholds: { lines: 95, branches: 95 },
    },
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'test/unit/**/*.test.ts',
            'test/characterization/**/*.test.ts',
            'test/contract/**/*.test.ts',
            'test/generator/**/*.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/integration/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
})

export default config
