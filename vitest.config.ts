import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Stubs throw NotImplementedError with a pointer to the contract they must
    // fulfil. A red test here is a work item, not a broken build — see AGENTS.md.
    passWithNoTests: false,
  },
});
