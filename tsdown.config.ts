import { defineConfig, type UserConfig } from 'tsdown'

const config: UserConfig = defineConfig({
  entry: {
    index: 'src/index.ts',
    generator: 'src/generator.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node20',
  dts: { entry: 'src/index.ts' },
  exports: {
    exclude: ['generator'],
    bin: { 'hyde-db': './src/generator.ts' },
  },
  publint: true,
  attw: { profile: 'esm-only' },
  failOnWarn: true,
})

export default config
