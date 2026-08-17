'use strict';

// The transitional transfer envelope, off-device (DIA-P1).
//
// Imports the SHIPPED modules under Node — the same files both delivery channels
// carry — rather than a copy of the logic. Same plumbing and the same reason as
// app/tests/store-unit.spec.js: Playwright compiles these specs as CommonJS and
// rewrites a literal `import()` into `require()`, and Node decides ESM-ness from
// the nearest package.json, which app/package.json cannot declare without
// breaking every CommonJS spec beside it and which a marker inside app/m/ cannot
// supply because everything under m/ SHIPS. So the directory is copied verbatim
// into a temp dir carrying the marker, and every copy is verified byte-for-byte
// before anything is imported.
//
// WHAT THIS FILE IS FOR. The envelope is the one shape both ends of the transfer
// agree on, and the receiving end feeds it to an APPEND-ONLY journal whose
// entries can never be edited or removed (LSC-P2-INV-001). So the properties
// worth pinning are not "it round-trips" — they are what it REFUSES, and that
// what it does admit is exactly the four fields the importer reads and nothing
// else. A field nobody designed for, riding through into a permanent record, is
// the failure this format's narrowing exists to prevent.
//
// STATIC/PURE, and it says so: no page, no browser, no bridge. The band
// invariant's legs are elsewhere (handoff-source.spec.js, handoff-transfer.spec.js).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');
const { currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const MOUNT = currentMount(fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8'));
const TRANSFER_DIR = path.join(APP_ROOT, 'm', MOUNT.dir, 'transfer');

const dynamicImport = new Function('specifier', 'return import(specifier)');

let loadRoot = null;
const load = (name) => dynamicImport(pathToFileURL(path.join(loadRoot, name)).href);

test.beforeAll(() => {
  loadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'theygrow-transfer-'));
  fs.writeFileSync(path.join(loadRoot, 'package.json'), '{"type":"module"}');
  for (const name of fs.readdirSync(TRANSFER_DIR)) {
    const from = path.join(TRANSFER_DIR, name);
    if (!fs.statSync(from).isFile()) continue;
    fs.copyFileSync(from, path.join(loadRoot, name));
    expect(
      fs.readFileSync(path.join(loadRoot, name)).equals(fs.readFileSync(from)),
      `${name} was not copied verbatim — this suite would be testing a different file`
    ).toBeTruthy();
  }
});

test.afterAll(() => {
  if (loadRoot) fs.rmSync(loadRoot, { recursive: true, force: true });
});

const PROFILE = {
  id: 'profile_parity_0001',
  name: 'Тестовый профиль',
  birthdate: '2024-09-15',
  completedSkills: ['GM_001', 'GM_002'],
};

test.describe('transfer envelope — what it carries', () => {
  test('a profile survives the round trip in the shape the importer takes', async () => {
    const { buildEnvelope, parseEnvelope } = await load('format.js');
    const parsed = parseEnvelope(buildEnvelope([PROFILE]));

    expect(parsed).toHaveLength(1);
    // Exactly the four fields runImport() reads — asserted as the whole key set,
    // not by spot-checking, because the point is what is ABSENT.
    expect(Object.keys(parsed[0]).sort()).toEqual([
      'birthdate',
      'completedSkills',
      'id',
      'name',
    ]);
    expect(parsed[0]).toEqual(PROFILE);
  });

  test('a field nobody designed for does not ride through', async () => {
    const { parseEnvelope } = await load('format.js');
    const { ENVELOPE_FORMAT_ID, ENVELOPE_FORMAT_VERSION } = await load('config.js');
    const smuggled = JSON.stringify({
      formatId: ENVELOPE_FORMAT_ID,
      formatVersion: ENVELOPE_FORMAT_VERSION,
      profiles: [{ ...PROFILE, notes: 'что-то, что родитель написал', origin: 'authored' }],
    });
    const parsed = parseEnvelope(smuggled);
    expect(Object.keys(parsed[0]).sort()).toEqual([
      'birthdate',
      'completedSkills',
      'id',
      'name',
    ]);
    // `origin` in particular: the importer sets it to 'migrated_legacy' by
    // contract (LSC-P4-INV-002), and a wire field that could override it would
    // let a transfer mislabel provenance permanently.
    expect(parsed[0].origin).toBeUndefined();
  });

  test('a profile with no name or birthdate carries nulls, not absences', async () => {
    // The importer skips an attribute whose value is null/undefined/'' — so the
    // two must arrive as a decided null rather than as a missing key that a
    // later refactor could read as "unset, use a default".
    const { buildEnvelope, parseEnvelope } = await load('format.js');
    const parsed = parseEnvelope(buildEnvelope([{ id: 'p1', completedSkills: [] }]));
    expect(parsed[0]).toEqual({ id: 'p1', name: null, birthdate: null, completedSkills: [] });
  });

  test('a non-string skill id is dropped rather than carried', async () => {
    const { buildEnvelope, parseEnvelope } = await load('format.js');
    const parsed = parseEnvelope(
      buildEnvelope([{ ...PROFILE, completedSkills: ['GM_001', null, 7, '', 'GM_002'] }])
    );
    expect(parsed[0].completedSkills).toEqual(['GM_001', 'GM_002']);
  });
});

test.describe('transfer envelope — what it refuses', () => {
  const cases = [
    ['bytes that are not JSON at all', () => 'not json {'],
    ['a JSON array rather than an envelope', () => '[]'],
    [
      'an envelope from another format',
      () => JSON.stringify({ formatId: 'theygrow-archive', formatVersion: 1, profiles: [] }),
    ],
    [
      'a NEWER format version this build does not know',
      async (load_) => {
        const { ENVELOPE_FORMAT_ID, ENVELOPE_FORMAT_VERSION } = await load_('config.js');
        return JSON.stringify({
          formatId: ENVELOPE_FORMAT_ID,
          formatVersion: ENVELOPE_FORMAT_VERSION + 1,
          profiles: [],
        });
      },
    ],
    [
      'an OLDER format version that was never published',
      async (load_) => {
        const { ENVELOPE_FORMAT_ID, ENVELOPE_FORMAT_VERSION } = await load_('config.js');
        return JSON.stringify({
          formatId: ENVELOPE_FORMAT_ID,
          formatVersion: ENVELOPE_FORMAT_VERSION - 1,
          profiles: [],
        });
      },
    ],
    [
      'an envelope with no profile list',
      async (load_) => {
        const { ENVELOPE_FORMAT_ID, ENVELOPE_FORMAT_VERSION } = await load_('config.js');
        return JSON.stringify({
          formatId: ENVELOPE_FORMAT_ID,
          formatVersion: ENVELOPE_FORMAT_VERSION,
          profiles: {},
        });
      },
    ],
    [
      'a profile with no id, which could never be made idempotent',
      async (load_) => {
        const { ENVELOPE_FORMAT_ID, ENVELOPE_FORMAT_VERSION } = await load_('config.js');
        return JSON.stringify({
          formatId: ENVELOPE_FORMAT_ID,
          formatVersion: ENVELOPE_FORMAT_VERSION,
          profiles: [{ name: 'без id', completedSkills: [] }],
        });
      },
    ],
  ];

  for (const [label, make] of cases) {
    test(`refuses ${label}`, async () => {
      const { parseEnvelope } = await load('format.js');
      const text = await make(load);
      let thrown = null;
      try {
        parseEnvelope(text);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `parseEnvelope accepted ${label}`).not.toBeNull();
      expect(thrown.name).toBe('TransferFormatError');
      // The closed code is what a signal may carry; the message is for the
      // device console and never reaches a payload (LSC-P4-INV-003).
      expect(thrown.reason).toBe('format_version');
    });
  }

  test('a refusal is total — no partial profile list comes back', async () => {
    // The one that matters most: an envelope carrying one good profile and one
    // broken one must not import the good one and drop the other silently. A
    // transfer that quietly loses a child is worse than one that does nothing,
    // because the journal it writes into can never be corrected.
    const { parseEnvelope } = await load('format.js');
    const { ENVELOPE_FORMAT_ID, ENVELOPE_FORMAT_VERSION } = await load('config.js');
    const mixed = JSON.stringify({
      formatId: ENVELOPE_FORMAT_ID,
      formatVersion: ENVELOPE_FORMAT_VERSION,
      profiles: [PROFILE, { name: 'без id', completedSkills: [] }],
    });
    expect(() => parseEnvelope(mixed)).toThrow(/no id/);
  });
});

test.describe('transfer envelope — the wire codec', () => {
  test('the payload round-trips through base64url', async () => {
    const { buildEnvelope, envelopeBytes, encodePayload, decodePayload } = await load('format.js');
    const envelope = buildEnvelope([PROFILE]);
    const bytes = envelopeBytes(envelope);
    const encoded = encodePayload(bytes);

    // URL-safe by construction: `+`, `/` and `=` would each be percent-encoded
    // in a query parameter, inflating by a content-dependent factor the very
    // length the ceiling exists to bound.
    expect(encoded, 'the payload is not URL-safe').toMatch(/^[A-Za-z0-9_-]*$/);
    expect(new TextDecoder().decode(decodePayload(encoded))).toBe(envelope);
  });

  test('Cyrillic survives the codec byte-for-byte', async () => {
    // A profile name is the one free-text field on this wire, it is Russian in
    // every real case, and a codec that mangled it would produce a valid-looking
    // transfer carrying a corrupted child's name into a permanent record.
    const { buildEnvelope, envelopeBytes, encodePayload, decodePayload, parseEnvelope } =
      await load('format.js');
    const name = 'Софья Ёлкина-Дюймовочка';
    const envelope = buildEnvelope([{ ...PROFILE, name }]);
    const decoded = decodePayload(encodePayload(envelopeBytes(envelope)));
    expect(parseEnvelope(new TextDecoder().decode(decoded))[0].name).toBe(name);
  });

  test('the digest is over the envelope bytes and changes when they do', async () => {
    const { buildEnvelope, envelopeBytes, digestHex } = await load('format.js');
    const one = await digestHex(envelopeBytes(buildEnvelope([PROFILE])));
    const again = await digestHex(envelopeBytes(buildEnvelope([PROFILE])));
    const other = await digestHex(
      envelopeBytes(buildEnvelope([{ ...PROFILE, completedSkills: ['GM_001'] }]))
    );

    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(again, 'the digest is not deterministic').toBe(one);
    // ANTI-VACUITY: a digest that never changes would let every truncation
    // check pass, which is the one job it has on this wire.
    expect(other, 'the digest did not change when the envelope did').not.toBe(one);
  });

  test('a truncated payload does not survive the digest', async () => {
    // The transport failure this digest exists for: a browser that shortens a
    // long URI. Executed here at the format level; the RECEIVER'S refusal on
    // the same input is the instrumented leg's (DIA-P1, checkpoint D).
    const { buildEnvelope, envelopeBytes, encodePayload, decodePayload, digestHex } =
      await load('format.js');
    const bytes = envelopeBytes(buildEnvelope([PROFILE]));
    const truncated = decodePayload(encodePayload(bytes).slice(0, -8));

    expect(truncated.length, 'the truncation changed nothing').toBeLessThan(bytes.length);
    expect(await digestHex(truncated)).not.toBe(await digestHex(bytes));
  });
});
