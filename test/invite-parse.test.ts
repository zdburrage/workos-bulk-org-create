import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadInviteCsvInputs,
  loadInviteJsonlInputs,
  okInviteInputs,
} from "../src/lib/parse.ts";

test("loadInviteCsvInputs parses required columns + optional extras", () => {
  const csv = [
    "email,organization_id,external_id,role_slug,expires_in_days,inviter_user_id",
    "alice@acme.com,org_01ABC,,member,14,user_01XYZ",
    "bob@acme.com,,ext_acme_001,,,",
    "carol@acme.com,org_01DEF,,,,",
  ].join("\n");
  const rows = loadInviteCsvInputs(csv);
  const inputs = okInviteInputs(rows);
  assert.deepEqual(inputs, [
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

test("loadInviteCsvInputs requires email column (header-level)", () => {
  assert.throws(
    () => loadInviteCsvInputs("organization_id,role_slug\norg_01ABC,member\n"),
    /must include an 'email' column/
  );
});

test("loadInviteCsvInputs requires at least one of organization_id or external_id (header-level)", () => {
  assert.throws(
    () => loadInviteCsvInputs("email,role_slug\nalice@acme.com,member\n"),
    /organization_id.*external_id/
  );
});

test("loadInviteCsvInputs records a row without any org identifier as a failed row", () => {
  const csv = "email,organization_id,external_id\nalice@acme.com,,\n";
  const rows = loadInviteCsvInputs(csv);
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.error, /must provide organization_id or external_id/);
    assert.equal(r.email, "alice@acme.com");
  }
});

test("loadInviteCsvInputs records invalid emails as failed rows", () => {
  const csv = "email,organization_id\nnot-an-email,org_01ABC\nbob@acme.com,org_01DEF\n";
  const rows = loadInviteCsvInputs(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.ok, false);
  assert.equal(rows[1]!.ok, true);
  if (!rows[0]!.ok) {
    assert.match(rows[0]!.error, /Invalid email/);
    assert.equal(rows[0]!.email, "not-an-email");
  }
});

test("loadInviteCsvInputs records expires_in_days out of range as a failed row", () => {
  const csv =
    "email,organization_id,expires_in_days\n" +
    "alice@acme.com,org_01ABC,45\n" +
    "bob@acme.com,org_01DEF,7\n";
  const rows = loadInviteCsvInputs(csv);
  assert.equal(rows.length, 2);
  const first = rows[0]!;
  assert.equal(first.ok, false);
  if (!first.ok) {
    assert.match(first.error, /between 1 and 30/);
  }
  assert.equal(rows[1]!.ok, true);
});

test("loadInviteCsvInputs skips truly blank rows but records per-row validation failures", () => {
  const csv = "email,organization_id\n\nalice@acme.com,org_01ABC\n\n";
  const rows = loadInviteCsvInputs(csv);
  const inputs = okInviteInputs(rows);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]!.email, "alice@acme.com");
});

test("loadInviteJsonlInputs accepts snake_case and camelCase keys", () => {
  const jsonl = [
    '{"email":"alice@acme.com","organization_id":"org_01ABC","role_slug":"member"}',
    '{"email":"bob@acme.com","externalId":"ext_bob","roleSlug":"admin","expiresInDays":3,"inviterUserId":"user_01XYZ"}',
  ].join("\n");
  const rows = loadInviteJsonlInputs(jsonl);
  const inputs = okInviteInputs(rows);
  assert.deepEqual(inputs[0], {
    email: "alice@acme.com",
    organizationId: "org_01ABC",
    externalId: undefined,
    roleSlug: "member",
    expiresInDays: undefined,
    inviterUserId: undefined,
  });
  assert.deepEqual(inputs[1], {
    email: "bob@acme.com",
    organizationId: undefined,
    externalId: "ext_bob",
    roleSlug: "admin",
    expiresInDays: 3,
    inviterUserId: "user_01XYZ",
  });
});

test("loadInviteJsonlInputs records invalid JSON as a failed row with line number", () => {
  const text = '{"email":"alice@acme.com","organization_id":"o"}\n{not json}\n';
  const rows = loadInviteJsonlInputs(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.ok, true);
  const second = rows[1]!;
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.rowNumber, 2);
    assert.match(second.error, /line 2/);
  }
});
