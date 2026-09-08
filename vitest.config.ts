import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The core carries no DOM dependency; a suite that needs one says so with
    // its own `@vitest-environment` pragma.
    environment: 'node',
    globals: true,
    setupFiles: './src/test/setup.ts',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json'],
      include: ['src/**/*.ts'],
      // Excluded because they contain no runtime code to cover, so their 0%
      // is arithmetic rather than a gap and only dilutes the number that
      // matters. Everything here is a type declaration, a barrel of
      // re-exports, or a test double.
      exclude: [
        'src/**/*.test.ts',
        'src/test/**',
        'src/testing/**',
        'src/types.ts',
        'src/index.ts',
        'src/api/CatalogueApi.ts',
        'src/api/MediaApi.ts',
        'src/api/ManageApi.ts',
        'src/api/AcquisitionApi.ts',
        'src/api/PlaybackFactsApi.ts',
        'src/playback/PlaybackResolver.ts',
      ],
    },
  },
});
