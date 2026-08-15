import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/*/tests/**/*.spec.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
  resolve: {
    alias: {
      'dsh-frontend-tools-client': path.resolve(__dirname, 'packages/client/src/index.ts'),
      'dsh-frontend-tools-client/invariant': path.resolve(__dirname, 'packages/client/src/invariant.ts'),
    },
  },
})
