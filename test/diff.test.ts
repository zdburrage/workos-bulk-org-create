import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computePatch,
  domainsEqual,
  resolveDomainData,
  shallowEqualRecord,
} from "../src/lib/diff.ts";
import type { ExistingOrg, OrgInput } from "../src/lib/types.ts";

test("shallowEqualRecord treats identical records as equal", () => {
  assert.equal(shallowEqualRecord({ a: "1", b: "2" }, { a: "1", b: "2" }), true);
  assert.equal(shallowEqualRecord({}, {}), true);
  assert.equal(shallowEqualRecord(undefined, undefined), true);
});

test("shallowEqualRecord detects differing values and shapes", () => {
  assert.equal(shallowEqualRecord({ a: "1" }, { a: "2" }), false);
  assert.equal(shallowEqualRecord({ a: "1" }, { a: "1", b: "2" }), false);
  assert.equal(shallowEqualRecord({ a: "1" }, {}), false);
});

test("domainsEqual returns true when desired is undefined (not being touched)", () => {
  assert.equal(domainsEqual([{ domain: "a.com", state: "verified" }], undefined), true);
});

test("domainsEqual ignores order", () => {
  assert.equal(
    domainsEqual(
      [
        { domain: "b.com", state: "pending" },
        { domain: "a.com", state: "pending" },
      ],
      [
        { domain: "a.com", state: "pending" },
        { domain: "b.com", state: "pending" },
      ]
    ),
    true
  );
});

test("domainsEqual detects state mismatches", () => {
  assert.equal(
    domainsEqual(
      [{ domain: "a.com", state: "verified" }],
      [{ domain: "a.com", state: "pending" }]
    ),
    false
  );
});

test("computePatch returns null when everything matches", () => {
  const input: OrgInput = {
    name: "Acme",
    externalId: "ext_acme",
    domains: [{ domain: "acme.com" }],
    metadata: { tier: "enterprise" },
  };
  const existing: ExistingOrg = {
    id: "org_1",
    name: "Acme",
    externalId: "ext_acme",
    domains: [{ domain: "acme.com", state: "pending" }],
    metadata: { tier: "enterprise" },
  };
  assert.equal(computePatch(input, existing, "pending"), null);
});

test("computePatch reports only changed fields", () => {
  const input: OrgInput = {
    name: "Acme Inc",
    externalId: "ext_acme",
    domains: [{ domain: "acme.com" }],
  };
  const existing: ExistingOrg = {
    id: "org_1",
    name: "Acme",
    externalId: "ext_acme",
    domains: [{ domain: "acme.com", state: "pending" }],
  };
  const patch = computePatch(input, existing, "pending");
  assert.ok(patch);
  assert.equal(patch!.name, "Acme Inc");
  assert.equal(patch!.externalId, undefined);
  assert.equal(patch!.domainData, undefined);
});

test("computePatch omits domains when not provided in input", () => {
  const input: OrgInput = { name: "Acme", externalId: "ext_acme" };
  const existing: ExistingOrg = {
    id: "org_1",
    name: "Other Name",
    externalId: "ext_acme",
    domains: [{ domain: "acme.com", state: "verified" }],
  };
  const patch = computePatch(input, existing, "pending");
  assert.ok(patch);
  assert.equal(patch!.name, "Acme");
  assert.equal(patch!.domainData, undefined);
});

test("computePatch detects per-domain state drift", () => {
  // Domain is the same, but state differs — we want a patch.
  const input: OrgInput = {
    name: "Acme",
    externalId: "ext_acme",
    domains: [{ domain: "acme.com", state: "verified" }],
  };
  const existing: ExistingOrg = {
    id: "org_1",
    name: "Acme",
    externalId: "ext_acme",
    domains: [{ domain: "acme.com", state: "pending" }],
  };
  const patch = computePatch(input, existing, "pending");
  assert.ok(patch);
  assert.deepEqual(patch!.domainData, [{ domain: "acme.com", state: "verified" }]);
});

test("resolveDomainData falls back to default state when unspecified", () => {
  const input: OrgInput = {
    name: "Acme",
    externalId: "ext_acme",
    domains: [
      { domain: "a.com" },
      { domain: "b.com", state: "verified" },
    ],
  };
  assert.deepEqual(resolveDomainData(input, "pending"), [
    { domain: "a.com", state: "pending" },
    { domain: "b.com", state: "verified" },
  ]);
});

test("resolveDomainData returns undefined when input has no domains key", () => {
  assert.equal(resolveDomainData({ name: "Acme", externalId: "ext" }, "pending"), undefined);
});

test("computePatch detects metadata drift", () => {
  const input: OrgInput = {
    name: "Acme",
    externalId: "ext_acme",
    metadata: { tier: "enterprise", seats: "10" },
  };
  const existing: ExistingOrg = {
    id: "org_1",
    name: "Acme",
    externalId: "ext_acme",
    metadata: { tier: "starter" },
  };
  const patch = computePatch(input, existing, "pending");
  assert.ok(patch);
  assert.deepEqual(patch!.metadata, { tier: "enterprise", seats: "10" });
});
