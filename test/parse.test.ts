import { test } from "node:test";
import assert from "node:assert/strict";
import {
  csvEscape,
  detectFormat,
  loadCsvInputs,
  loadJsonlInputs,
  normalizeMetadata,
  parseCsv,
  parseMetadata,
  splitDomains,
} from "../src/lib/parse.ts";

test("parseCsv handles quoted fields, commas, and escaped quotes", () => {
  const text = 'a,b,c\n"hello, world",plain,"say ""hi"""\n';
  const rows = parseCsv(text);
  assert.deepEqual(rows, [
    ["a", "b", "c"],
    ["hello, world", "plain", 'say "hi"'],
  ]);
});

test("parseCsv handles CRLF line endings", () => {
  const rows = parseCsv("a,b\r\n1,2\r\n3,4\r\n");
  assert.deepEqual(rows, [
    ["a", "b"],
    ["1", "2"],
    ["3", "4"],
  ]);
});

test("parseCsv strips UTF-8 BOM", () => {
  const bom = "\uFEFF";
  const rows = parseCsv(`${bom}name,external_id\nAcme,ext_1\n`);
  assert.deepEqual(rows[0], ["name", "external_id"]);
});

test("parseCsv skips blank lines", () => {
  const rows = parseCsv("a,b\n1,2\n\n\n3,4\n");
  assert.equal(rows.length, 3);
});

test("csvEscape quotes values containing commas, quotes, or newlines", () => {
  assert.equal(csvEscape("plain"), "plain");
  assert.equal(csvEscape("has,comma"), '"has,comma"');
  assert.equal(csvEscape('has"quote'), '"has""quote"');
  assert.equal(csvEscape("has\nnewline"), '"has\nnewline"');
  assert.equal(csvEscape(""), "");
  assert.equal(csvEscape(undefined), "");
});

test("splitDomains handles pipe and semicolon separators", () => {
  assert.deepEqual(splitDomains("a.com|b.com"), [{ domain: "a.com" }, { domain: "b.com" }]);
  assert.deepEqual(splitDomains("a.com;b.com"), [{ domain: "a.com" }, { domain: "b.com" }]);
  assert.deepEqual(splitDomains("a.com | b.com ;c.com"), [
    { domain: "a.com" },
    { domain: "b.com" },
    { domain: "c.com" },
  ]);
});

test("splitDomains returns undefined for empty or null input", () => {
  assert.equal(splitDomains(""), undefined);
  assert.equal(splitDomains("   "), undefined);
  assert.equal(splitDomains(null), undefined);
  assert.equal(splitDomains(undefined), undefined);
  assert.equal(splitDomains([]), undefined);
});

test("splitDomains accepts array input of strings", () => {
  assert.deepEqual(splitDomains(["a.com", " b.com ", ""]), [
    { domain: "a.com" },
    { domain: "b.com" },
  ]);
});

test("splitDomains parses explicit per-domain state from colon suffix", () => {
  assert.deepEqual(splitDomains("a.com:verified|b.com:pending|c.com"), [
    { domain: "a.com", state: "verified" },
    { domain: "b.com", state: "pending" },
    { domain: "c.com" },
  ]);
});

test("splitDomains tolerates whitespace around colon", () => {
  assert.deepEqual(splitDomains("a.com : verified | b.com:pending"), [
    { domain: "a.com", state: "verified" },
    { domain: "b.com", state: "pending" },
  ]);
});

test("splitDomains accepts array of objects (JSONL shape)", () => {
  assert.deepEqual(
    splitDomains([
      { domain: "a.com", state: "verified" },
      { domain: "b.com" },
    ]),
    [
      { domain: "a.com", state: "verified" },
      { domain: "b.com" },
    ]
  );
});

test("splitDomains throws on invalid state", () => {
  assert.throws(() => splitDomains("a.com:bogus"), /Invalid domain state/);
  assert.throws(() => splitDomains([{ domain: "a.com", state: "bogus" }]), /Invalid domain state/);
});

test("parseMetadata parses JSON strings", () => {
  assert.deepEqual(parseMetadata('{"tier":"enterprise","seats":"5"}'), {
    tier: "enterprise",
    seats: "5",
  });
});

test("parseMetadata coerces non-string values", () => {
  assert.deepEqual(parseMetadata('{"count":5,"active":true}'), {
    count: "5",
    active: "true",
  });
});

test("parseMetadata returns undefined for empty input", () => {
  assert.equal(parseMetadata(""), undefined);
  assert.equal(parseMetadata("   "), undefined);
  assert.equal(parseMetadata(null), undefined);
});

test("parseMetadata throws on invalid JSON", () => {
  assert.throws(() => parseMetadata("{not json}"), /Invalid metadata JSON/);
});

test("normalizeMetadata rejects arrays and primitives", () => {
  assert.equal(normalizeMetadata(["a", "b"]), undefined);
  assert.equal(normalizeMetadata("string"), undefined);
  assert.equal(normalizeMetadata(42), undefined);
  assert.equal(normalizeMetadata(null), undefined);
});

test("detectFormat respects explicit hint", () => {
  assert.equal(detectFormat("foo.csv", "jsonl"), "jsonl");
  assert.equal(detectFormat("foo.jsonl", "csv"), "csv");
});

test("detectFormat auto-detects from extension", () => {
  assert.equal(detectFormat("foo.csv", "auto"), "csv");
  assert.equal(detectFormat("foo.jsonl", "auto"), "jsonl");
  assert.equal(detectFormat("foo.ndjson", "auto"), "jsonl");
  assert.equal(detectFormat("foo", "auto"), "csv");
});

test("loadCsvInputs requires name column", () => {
  assert.throws(
    () => loadCsvInputs("foo,bar\n1,2\n"),
    /must include a 'name' column/
  );
});

test("loadCsvInputs parses full row with metadata", () => {
  const text =
    'name,external_id,domains,metadata\n' +
    'Acme,ext_acme,acme.com|acme.io,"{""tier"":""enterprise""}"\n';
  const rows = loadCsvInputs(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.name, "Acme");
  assert.equal(rows[0]!.externalId, "ext_acme");
  assert.deepEqual(rows[0]!.domains, [{ domain: "acme.com" }, { domain: "acme.io" }]);
  assert.deepEqual(rows[0]!.metadata, { tier: "enterprise" });
});

test("loadCsvInputs parses mixed per-domain states", () => {
  const text =
    'name,external_id,domains\n' +
    'Acme,ext_acme,acme.com:verified|acme.io:pending|legacy.com\n';
  const rows = loadCsvInputs(text);
  assert.deepEqual(rows[0]!.domains, [
    { domain: "acme.com", state: "verified" },
    { domain: "acme.io", state: "pending" },
    { domain: "legacy.com" },
  ]);
});

test("loadCsvInputs skips rows missing name but keeps rows without external_id", () => {
  const text = "name,external_id\nAcme,ext_acme\n,ext_blank_name\nNoExtId,\n";
  const rows = loadCsvInputs(text);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.externalId, "ext_acme");
  assert.equal(rows[1]!.name, "NoExtId");
  assert.equal(rows[1]!.externalId, undefined);
});

test("loadJsonlInputs accepts both external_id and externalId keys", () => {
  const text =
    '{"name":"A","external_id":"ext_a","domains":["a.com"]}\n' +
    '{"name":"B","externalId":"ext_b","domains":"b.com|b.io"}\n' +
    '{"name":"C","domains":["c.com"]}\n';
  const rows = loadJsonlInputs(text);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0]!.domains, [{ domain: "a.com" }]);
  assert.deepEqual(rows[1]!.domains, [{ domain: "b.com" }, { domain: "b.io" }]);
  assert.equal(rows[2]!.name, "C");
  assert.equal(rows[2]!.externalId, undefined);
});

test("loadJsonlInputs accepts domain objects with state", () => {
  const text =
    '{"name":"A","external_id":"ext_a","domains":[{"domain":"a.com","state":"verified"},{"domain":"b.com"}]}\n';
  const rows = loadJsonlInputs(text);
  assert.deepEqual(rows[0]!.domains, [
    { domain: "a.com", state: "verified" },
    { domain: "b.com" },
  ]);
});

test("loadJsonlInputs reports line number on parse error", () => {
  const text = '{"name":"A","external_id":"ext_a"}\n{not valid\n';
  assert.throws(() => loadJsonlInputs(text), /line 2/);
});
