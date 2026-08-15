import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['bridge/tests/**/*.spec.ts', 'client/tests/**/*.spec.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
  },
  resolve: {
    alias: {
      'dsh-frontend-tools-client': path.resolve(__dirname, 'client/src/index.ts'),
      'dsh-frontend-tools-client/invariant': path.resolve(__dirname, 'client/src/invariant.ts'),
    },
  },
})
