import { defineProject } from "vitest/config";
export default defineProject({ test: { name: "evaluator-acceptance", environment: "node", include: ["__tests__/**/*.test.ts"] } });
