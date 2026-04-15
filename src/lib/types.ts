export type DomainState = "pending" | "verified";

export type DomainDataInput = { domain: string; state: DomainState };

/**
 * A domain as declared in the input. `state` is optional — when absent, the
 * global `--domain-state` flag is used when the org is created or updated.
 */
export type DomainSpec = { domain: string; state?: DomainState };

export type OrgInput = {
  name: string;
  externalId: string;
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
