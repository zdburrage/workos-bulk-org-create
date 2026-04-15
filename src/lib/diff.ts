import type { DomainDataInput, DomainState, ExistingOrg, OrgInput } from "./types.js";

export function shallowEqualRecord(
  a?: Record<string, string>,
  b?: Record<string, string>
): boolean {
  const ak = Object.keys(a ?? {});
  const bk = Object.keys(b ?? {});
  if (ak.length !== bk.length) return false;
  for (const k of ak) if ((a as any)[k] !== (b as any)?.[k]) return false;
  return true;
}

export function domainsEqual(
  existing: Array<{ domain: string; state: string }> | undefined,
  desired: DomainDataInput[] | undefined
): boolean {
  if (!desired) return true; // not being touched
  const e = new Map((existing ?? []).map(d => [d.domain, d.state]));
  const d = new Map(desired.map(d => [d.domain, d.state]));
  if (e.size !== d.size) return false;
  for (const [k, v] of d) if (e.get(k) !== v) return false;
  return true;
}

export type OrgPatch = {
  name?: string;
  externalId?: string;
  domainData?: DomainDataInput[];
  metadata?: Record<string, string>;
};

/**
 * Resolve each DomainSpec into a concrete {domain, state}. Specs without an
 * explicit state fall back to `defaultState`.
 */
export function resolveDomainData(
  input: OrgInput,
  defaultState: DomainState
): DomainDataInput[] | undefined {
  if (!input.domains) return undefined;
  return input.domains.map(d => ({ domain: d.domain, state: d.state ?? defaultState }));
}

/** Returns a patch containing only changed fields, or null if nothing changed. */
export function computePatch(
  input: OrgInput,
  existing: ExistingOrg,
  domainState: DomainState
): OrgPatch | null {
  const patch: OrgPatch = {};
  if (input.name !== existing.name) patch.name = input.name;
  if (input.externalId !== (existing.externalId ?? undefined)) {
    patch.externalId = input.externalId;
  }
  const desired = resolveDomainData(input, domainState);
  if (desired && !domainsEqual(existing.domains, desired)) {
    patch.domainData = desired;
  }
  if (input.metadata && !shallowEqualRecord(input.metadata, existing.metadata)) {
    patch.metadata = input.metadata;
  }
  return Object.keys(patch).length ? patch : null;
}
