import { env } from "cloudflare:test";
import { ACTIVE_POINTER_KEY, configReleaseDigest, releaseObjectKey, verifyConfigRelease } from "@gmacko/hall-monitor-config-release";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mayApprove, publishConflicts, releaseApprover } from "../src/two-person.ts";
import { api, grant, ROOT } from "./helpers.ts";

const EDITOR = "editor@example.test";
const PUBLISHER = "publisher@example.test";
const OTHER_PUBLISHER = "publisher2@example.test";
const T = "playtrek";
const REVS = `/tenants/${T}/profiles/student-6-8/revisions`;

beforeEach(async () => {
  for (const method of ["log", "warn", "error"] as const) vi.spyOn(console, method).mockImplementation(() => {});
  await grant(EDITOR, T, "policy-editor");
  await grant(PUBLISHER, T, "publisher");
  await grant(PUBLISHER, T, "policy-editor");
  await grant(OTHER_PUBLISHER, T, "publisher");
});

async function draft(email: string, overlay: Record<string, unknown>) {
  const response = await api(email, "POST", REVS, { overlay });
  return { status: response.status, body: await response.json() as { id: string; status: string; violations: unknown[]; studentFacing: boolean; enforcesFamily: boolean } };
}

async function approved(author: string, approver: string, revision: string) {
  const { body } = await draft(author, { revision, outputModeration: "required" });
  expect((await api(author, "POST", `${REVS}/${body.id}:propose`)).status).toBe(200);
  expect((await api(approver, "POST", `${REVS}/${body.id}:approve`)).status).toBe(200);
  return body.id;
}

async function auditActions(): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT action FROM audit_log ORDER BY at, rowid").all<{ action: string }>();
  return results.map((r) => r.action);
}

describe("two-person rule (pure)", () => {
  it("separates authors from approvers and sensitive publishers", () => {
    expect(mayApprove("a@x.test", "A@x.test")).toBe(false);
    expect(mayApprove("a@x.test", "b@x.test")).toBe(true);
    const revisions = [
      { author: "p@x.test", approver: "q@x.test", studentFacing: true, enforcesFamily: false },
      { author: "p@x.test", approver: "q@x.test", studentFacing: false, enforcesFamily: false },
    ];
    expect(publishConflicts("p@x.test", revisions)).toHaveLength(1);
    expect(publishConflicts("q@x.test", revisions)).toHaveLength(0);
    expect(releaseApprover("q@x.test", revisions)).toBe("p@x.test");
    expect(releaseApprover("p@x.test", revisions)).toBe("q@x.test");
    expect(releaseApprover("p@x.test", [])).toBe("none");
  });
});

describe("profile revisions", () => {
  it("stores a draft and reports floor-weakening fields, which block proposal", async () => {
    const { status, body } = await draft(EDITOR, { revision: "pt:weak", inputModeration: "off", studentFacing: false });
    expect(status).toBe(201);
    expect(body).toMatchObject({ status: "draft", studentFacing: true });
    expect(body.violations.map((v) => (v as { field: string }).field).sort()).toEqual(["inputModeration", "studentFacing"]);
    const propose = await api(EDITOR, "POST", `${REVS}/${body.id}:propose`);
    expect(propose.status).toBe(409);
  });

  it("refuses invalid overlays, duplicates and editors without the role", async () => {
    expect((await draft(EDITOR, { outputModeration: "required" })).status).toBe(400);
    expect((await draft(EDITOR, { revision: "pt:dup" })).status).toBe(201);
    expect((await draft(EDITOR, { revision: "pt:dup" })).status).toBe(409);
    expect((await draft("viewer@example.test", { revision: "pt:x" })).status).toBe(403);
    expect((await api(EDITOR, "POST", `/tenants/playtrek-beta/profiles/student-6-8/revisions`, { overlay: { revision: "x" } })).status).toBe(403);
  });

  it("updates routing on a draft and flags enforce families", async () => {
    const { body } = await draft(EDITOR, { revision: "pt:route" });
    const response = await api(EDITOR, "PUT", `${REVS}/${body.id}/routing`, { routing: { clairic: { enabled: true, mode: "enforce" } }, waiverNoted: true });
    expect(await response.json()).toMatchObject({ enforcesFamily: true, waiverNoted: true, overlay: { routing: { clairic: { enabled: true, mode: "enforce" } } } });
  });

  it("diffs a revision over the synthetic corpus and stores the report", async () => {
    const { body } = await draft(EDITOR, { revision: "pt:diff", answerAssistance: "scaffolded" });
    const response = await api(EDITOR, "POST", `${REVS}/${body.id}:diff`);
    expect(response.status).toBe(200);
    const report = await response.json() as { kind: string; classifier: string; candidate: { label: string } };
    expect(report).toMatchObject({ kind: "decision-diff", classifier: "fake" });
    const stored = await (await api(EDITOR, "GET", `${REVS}/${body.id}/diff`)).json();
    expect(stored).toEqual(report);
  });

  it("forbids the author from approving their own revision", async () => {
    const { body } = await draft(PUBLISHER, { revision: "pt:self" });
    await api(PUBLISHER, "POST", `${REVS}/${body.id}:propose`);
    const self = await api(PUBLISHER, "POST", `${REVS}/${body.id}:approve`);
    expect(self.status).toBe(409);
    expect(await self.json()).toMatchObject({ message: expect.stringContaining("two-person rule") });
    expect((await api(EDITOR, "POST", `${REVS}/${body.id}:approve`)).status).toBe(403);
    expect((await api(OTHER_PUBLISHER, "POST", `${REVS}/${body.id}:approve`)).status).toBe(200);
  });

  it("reads another tenant's revision id as 404", async () => {
    const { body } = await draft(EDITOR, { revision: "pt:scoped" });
    await grant(EDITOR, "playtrek-beta", "policy-editor");
    expect((await api(EDITOR, "POST", `/tenants/playtrek-beta/profiles/student-6-8/revisions/${body.id}:propose`)).status).toBe(404);
  });
});

describe("config releases", () => {
  it("publishes to R2 and KV under a verifiable digest, then rolls back", async () => {
    const first = await approved(EDITOR, PUBLISHER, "pt:1");
    // Student-facing: the publisher must not be the author; here the author is EDITOR.
    const published = await api(PUBLISHER, "POST", "/releases");
    expect(published.status).toBe(201);
    const one = await published.json() as { releaseId: string; digest: string };
    const pointer = JSON.parse((await env.CONFIG_POINTER!.get(ACTIVE_POINTER_KEY))!);
    expect(pointer).toEqual({ releaseId: one.releaseId, digest: one.digest });
    const object = await env.CONFIG_RELEASES!.get(releaseObjectKey(one.digest));
    const release = await verifyConfigRelease(await object!.text(), one.digest);
    expect(release).toMatchObject({ author: PUBLISHER, approver: EDITOR, overlays: { playtrek: { "student-6-8": { revision: "pt:1" } } } });
    expect(await configReleaseDigest(release)).toBe(one.digest);
    const rows = await (await api(ROOT, "GET", `${REVS}`)).json() as { revisions: { id: string; status: string }[] };
    expect(rows.revisions.find((r) => r.id === first)?.status).toBe("published");

    // Nothing changed: refused.
    expect((await api(PUBLISHER, "POST", "/releases")).status).toBe(409);

    await approved(EDITOR, PUBLISHER, "pt:2");
    const two = await (await api(PUBLISHER, "POST", "/releases")).json() as { releaseId: string; digest: string };
    expect(JSON.parse((await env.CONFIG_POINTER!.get(ACTIVE_POINTER_KEY))!).digest).toBe(two.digest);

    const rollback = await api(PUBLISHER, "POST", `/releases/${one.releaseId}:activate`);
    expect(rollback.status).toBe(200);
    expect(JSON.parse((await env.CONFIG_POINTER!.get(ACTIVE_POINTER_KEY))!)).toEqual({ releaseId: one.releaseId, digest: one.digest });
    const list = await (await api(PUBLISHER, "GET", "/releases")).json() as { releases: { releaseId: string; active: boolean }[] };
    expect(list.releases.find((r) => r.active)?.releaseId).toBe(one.releaseId);

    expect(await auditActions()).toEqual(expect.arrayContaining(["revision.created", "revision.proposed", "revision.approved", "release.published", "release.activated"]));
  });

  it("refuses to let the author of a student-facing revision publish it", async () => {
    await approved(PUBLISHER, OTHER_PUBLISHER, "pt:mine");
    const response = await api(PUBLISHER, "POST", "/releases");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining("two-person rule") });
    expect(await env.CONFIG_POINTER!.get(ACTIVE_POINTER_KEY)).toBeNull();
    expect((await api(OTHER_PUBLISHER, "POST", "/releases")).status).toBe(201);
  });

  it("needs the publisher role on every tenant with new revisions", async () => {
    await approved(EDITOR, PUBLISHER, "pt:scoped");
    expect((await api(EDITOR, "POST", "/releases")).status).toBe(403);
    expect((await api("viewer@example.test", "GET", "/releases")).status).toBe(403);
    // A publisher elsewhere sees the pending revision counted, never named.
    await grant("beta-publisher@example.test", "playtrek-beta", "publisher");
    const listing = await (await api("beta-publisher@example.test", "GET", "/releases")).json() as { pending: unknown[]; hiddenPending: number };
    expect(listing).toMatchObject({ pending: [], hiddenPending: 1 });
    expect((await api("beta-publisher@example.test", "POST", "/releases")).status).toBe(403);
  });

  it("carries tenant modes once an admin sets one", async () => {
    expect((await api(ROOT, "PUT", "/tenants/playtrek/mode", { setting: "shadow" })).status).toBe(200);
    expect((await api(ROOT, "PUT", "/tenants/playtrek-beta/mode", { setting: { mode: "enforce" } })).status).toBe(200);
    expect((await api(ROOT, "PUT", "/tenants/playtrek/mode", { setting: "loud" })).status).toBe(400);
    expect((await api(PUBLISHER, "PUT", "/tenants/playtrek/mode", { setting: "shadow" })).status).toBe(403);
    const published = await (await api(ROOT, "POST", "/releases")).json() as { digest: string };
    const release = JSON.parse(await (await env.CONFIG_RELEASES!.get(releaseObjectKey(published.digest)))!.text());
    expect(release).toMatchObject({ tenantModes: { playtrek: "shadow", "playtrek-beta": { mode: "enforce" } }, approver: "none" });
  });

  it("refuses an empty first release", async () => {
    expect((await api(ROOT, "POST", "/releases")).status).toBe(409);
  });
});

describe("model gate", () => {
  it("returns a not-approved verdict and stores nothing", async () => {
    const response = await api(EDITOR, "POST", "/models:gate", { family: "clairic" });
    expect(await response.json()).toMatchObject({ family: "clairic", verdict: "shadow-only", activation: "not-approved" });
    expect((await api(EDITOR, "POST", "/models:gate", { family: "nope" })).status).toBe(400);
  });
});
