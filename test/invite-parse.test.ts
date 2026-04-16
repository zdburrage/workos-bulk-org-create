import { test } from "node:test";
import assert from "node:assert/strict";
import { loadInviteCsvInputs, loadInviteJsonlInputs } from "../src/lib/parse.ts";

test("loadInviteCsvInputs parses required columns + optional extras", () => {
  const csv = [
    "email,organization_id,external_id,role_slug,expires_in_days,inviter_user_id",
    "alice@acme.com,org_01ABC,,member,14,user_01XYZ",
    "bob@acme.com,,ext_acme_001,,,",
    "carol@acme.com,org_01DEF,,,,",
  ].join("\n");
  const rows = loadInviteCsvInputs(csv);
  assert.deepEqual(rows, [
    {
      email: "alice@acme.com",
      organizationId: "org_01ABC",
      externalId: undefined,
      roleSlug: "member",
      expiresInDays: 14,
      inviterUserId: "user_01XYZ",
    },
    {
      email: "bob@acme.com",
      organizationId: undefined,
      externalId: "ext_acme_001",
      roleSlug: undefined,
      expiresInDays: undefined,
      inviterUserId: undefined,
    },
    {
      email: "carol@acme.com",
      organizationId: "org_01DEF",
      externalId: undefined,
      roleSlug: undefined,
      expiresInDays: undefined,
      inviterUserId: undefined,
    },
  ]);
});

test("loadInviteCsvInputs requires email column", () => {
  assert.throws(
    () => loadInviteCsvInputs("organization_id,role_slug\norg_01ABC,member\n"),
    /must include an 'email' column/
  );
});

test("loadInviteCsvInputs requires at least one of organization_id or external_id", () => {
  assert.throws(
    () => loadInviteCsvInputs("email,role_slug\nalice@acme.com,member\n"),
    /organization_id.*external_id/
  );
});

test("loadInviteCsvInputs rejects a row without any org identifier", () => {
  const csv = "email,organization_id,external_id\nalice@acme.com,,\n";
  assert.throws(() => loadInviteCsvInputs(csv), /must provide organization_id or external_id/);
});

test("loadInviteCsvInputs rejects invalid emails", () => {
  const csv = "email,organization_id\nnot-an-email,org_01ABC\n";
  assert.throws(() => loadInviteCsvInputs(csv), /Invalid email/);
});

test("loadInviteCsvInputs rejects expires_in_days out of range", () => {
  const csv = "email,organization_id,expires_in_days\nalice@acme.com,org_01ABC,45\n";
  assert.throws(() => loadInviteCsvInputs(csv), /between 1 and 30/);
});

test("loadInviteCsvInputs skips blank rows but still enforces per-row validation", () => {
  const csv = "email,organization_id\n\nalice@acme.com,org_01ABC\n\n";
  const rows = loadInviteCsvInputs(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.email, "alice@acme.com");
});

test("loadInviteJsonlInputs accepts snake_case and camelCase keys", () => {
  const jsonl = [
    '{"email":"alice@acme.com","organization_id":"org_01ABC","role_slug":"member"}',
    '{"email":"bob@acme.com","externalId":"ext_bob","roleSlug":"admin","expiresInDays":3,"inviterUserId":"user_01XYZ"}',
  ].join("\n");
  const rows = loadInviteJsonlInputs(jsonl);
  assert.deepEqual(rows[0], {
    email: "alice@acme.com",
    organizationId: "org_01ABC",
    externalId: undefined,
    roleSlug: "member",
    expiresInDays: undefined,
    inviterUserId: undefined,
  });
  assert.deepEqual(rows[1], {
    email: "bob@acme.com",
    organizationId: undefined,
    externalId: "ext_bob",
    roleSlug: "admin",
    expiresInDays: 3,
    inviterUserId: "user_01XYZ",
  });
});

test("loadInviteJsonlInputs surfaces invalid JSON with line number", () => {
  assert.throws(
    () => loadInviteJsonlInputs('{"email":"alice@acme.com","organization_id":"o"}\n{not json}\n'),
    /line 2/
  );
});
