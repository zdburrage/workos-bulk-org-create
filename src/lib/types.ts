export type DomainState = "pending" | "verified";

export type DomainDataInput = { domain: string; state: DomainState };

/**
 * A domain as declared in the input. `state` is optional — when absent, the
 * global `--domain-state` flag is used when the org is created or updated.
 */
export type DomainSpec = { domain: string; state?: DomainState };

export type OrgInput = {
  name: string;
  externalId?: string;
  /** undefined means "not provided, don't touch"; empty array behaves the same. */
  domains?: DomainSpec[];
  metadata?: Record<string, string>;
};

export type ResultStatus =
  | "created"
  | "updated"
  | "skipped_existing"
  | "skipped_unchanged"
  | "failed"
  | "dry_run";

export type ResultRow = {
  external_id: string;
  name: string;
  org_id: string;
  status: ResultStatus;
  error: string;
};

export type ExistingOrg = {
  id: string;
  name?: string;
  externalId?: string | null;
  metadata?: Record<string, string>;
  domains?: Array<{ domain: string; state: DomainState }>;
};

/** Per-row input for invite-users.ts. Must provide email AND (orgId OR externalId). */
export type InviteInput = {
  email: string;
  /** Target org by WorkOS id. One of orgId / externalId is required. */
  organizationId?: string;
  /** Target org by external_id. Resolved to a WorkOS id before invitation. */
  externalId?: string;
  roleSlug?: string;
  expiresInDays?: number;
  inviterUserId?: string;
};

export type InviteStatus = "invited" | "skipped_existing" | "dry_run" | "failed";

export type InviteResultRow = {
  email: string;
  organization_id: string;
  external_id: string;
  invitation_id: string;
  status: InviteStatus;
  error: string;
};
