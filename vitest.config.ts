import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The core carries no DOM dependency; a suite that needs one says so with
    // its own `@vitest-environment` pragma.
    environment: 'node',
    globals: true,
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.test.ts'],
  },
});
