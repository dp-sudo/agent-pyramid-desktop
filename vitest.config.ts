import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: ["DeepSeek/**", "node_modules/**", "out/**"],
    clearMocks: true,
    restoreMocks: true,
  },
});
