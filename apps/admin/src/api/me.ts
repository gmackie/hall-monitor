import { REASON_CODES, REASON_CODES_REVISION } from "@gmacko/hall-monitor-contracts";
import { json } from "../http.ts";
import { viewableTenants } from "../roles.ts";
import { route } from "../router.ts";

export const meRoutes = [
  /** The signed-in person, their grants and the tenants they can view. */
  route("GET", "/me", async ({ env, principal }) =>
    json({ email: principal.email, isAdmin: principal.isAdmin, grants: principal.grants, tenants: await viewableTenants(env, principal) })),
  /** Display text for every reason code, as the Worker's `GET /v1/reason-codes` returns it. */
  route("GET", "/reason-codes", async () => json({ schemaVersion: "1.0", revision: REASON_CODES_REVISION, codes: REASON_CODES })),
];
