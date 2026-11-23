/**
 * The two-person rule (HM-34), as pure functions so it is testable on its own.
 *
 * - Approving any revision: the approver must not be its author.
 * - Publishing a release: the publisher must not be the author of any newly included revision
 *   that is sensitive, meaning its effective profile is student-facing or its routing puts any
 *   model family in `enforce` mode.
 */
export interface RevisionParties {
  readonly author: string;
  readonly approver: string | null;
  readonly studentFacing: boolean;
  readonly enforcesFamily: boolean;
}

export function isSensitive(revision: Pick<RevisionParties, "studentFacing" | "enforcesFamily">): boolean {
  return revision.studentFacing || revision.enforcesFamily;
}

/** Whether `approver` may approve a revision written by `author`. */
export function mayApprove(author: string, approver: string): boolean {
  return author.toLowerCase() !== approver.toLowerCase();
}

/** The newly included revisions that `publisher` may not publish themselves. */
export function publishConflicts<T extends RevisionParties>(publisher: string, revisions: readonly T[]): T[] {
  return revisions.filter((revision) => isSensitive(revision) && revision.author.toLowerCase() === publisher.toLowerCase());
}

/**
 * The second person a release names as its `approver`: the first approver of a new revision who is
 * not the publisher, else the first author who is not; `none` when the release carries no new
 * revision (a tenant-mode change or a re-publish). Every new revision has an approver other than
 * its author, so a release with new revisions always names someone besides the publisher.
 */
export function releaseApprover(publisher: string, revisions: readonly RevisionParties[]): string {
  const other = (email: string | null) => email !== null && email.toLowerCase() !== publisher.toLowerCase();
  return revisions.find((r) => other(r.approver))?.approver ?? revisions.find((r) => other(r.author))?.author ?? "none";
}
