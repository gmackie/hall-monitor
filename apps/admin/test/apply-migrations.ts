import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

beforeEach(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
