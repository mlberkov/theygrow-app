'use strict';

// POL-P1 — the arming of the promotion check, and the reason it is a spec at
// all.
//
// scripts/check-live-policy-edition.js is what the owner runs after promoting:
// it fetches the LIVE policy document and compares its edition with the one
// this tree ships. A check whose failure mode has never been observed is a
// claim, not a guard — and this packet cannot deploy anything, so the failure
// is BUILT here instead: a local server answers with the shipped bytes
// rewritten to the newest SUPERSEDED edition on disk, which is exactly the
// state the 2026-08-29 promotion gap produced (the live site serving edition
// 1.2 while the repository said 1.3), and the script is SPAWNED so what is
// asserted is the process's exit status rather than a return value.
//
// The three verdicts are held apart on purpose. A bot challenge from the edge
// must never be read as agreement (that would make the check worse than
// nothing) and must never be read as staleness either (that would cry wolf at
// every promotion), so it has its own exit code and its own leg.
//
// NOTHING HERE LEAVES THE MACHINE. Every leg serves 127.0.0.1 on an ephemeral
// port and passes that address in explicitly; the script's default public
// target is never used from a test.
//
// The mutant edition is DERIVED from docs/, never pinned: a leg pinned to «1.2»
// would still be testing edition 1.2 three editions later.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const { test, expect } = require('@playwright/test');

const {
  EXIT,
  SHELL_MARKER,
  checkTier,
  declaredCacheControl,
  editionFromHtml,
  shippedExpectation,
} = require('../../scripts/check-live-policy-edition');

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-live-policy-edition.js');

const PAGE = fs.readFileSync(path.join(APP_ROOT, 'privacy.html'), 'utf8');
const NGINX_CONF = fs.readFileSync(path.join(APP_ROOT, 'nginx.conf'), 'utf8');
const DECLARED = declaredCacheControl(NGINX_CONF);
const SHIPPED = shippedExpectation();

// The class this packet moved away from, kept as a literal because it is the
// historical value the check must red on — not a value read from anywhere.
const PRE_PACKET_CLASS = 'public, max-age=3600, must-revalidate';

// The newest SUPERSEDED edition on disk, read out of its own Markdown header.
// Fails closed: with no superseded edition there is nothing to build a stale
// document out of, and a leg that quietly served the CURRENT edition would pass
// while proving nothing.
function previousEditionOnDisk() {
  const editions = fs
    .readdirSync(DOCS_DIR)
    .map((name) => /^privacy-policy-v(\d+)\.(\d+)\.md$/.exec(name))
    .filter(Boolean)
    .map((m) => ({ name: m[0], key: Number(m[1]) * 1000 + Number(m[2]) }))
    .sort((a, b) => a.key - b.key);
  if (editions.length < 2) throw new Error('docs/ carries no superseded edition to build a stale document from');
  const previous = editions[editions.length - 2];
  const source = fs.readFileSync(path.join(DOCS_DIR, previous.name), 'utf8');
  const version = /\*\*Версия:\*\*\s*(\S+)/.exec(source);
  const date = /\*\*Дата вступления в силу:\*\*\s*(\S+)/.exec(source);
  if (!version || !date) throw new Error(`${previous.name}: no edition header to read`);
  return { name: previous.name, version: version[1], date: date[1] };
}

const PREVIOUS = previousEditionOnDisk();

// The shipped page as the PREVIOUS edition would have carried it. Built in-run,
// asserted to actually differ, and never written to disk.
function stalePage() {
  const stale = PAGE.split(SHIPPED.version).join(PREVIOUS.version).split(SHIPPED.date).join(PREVIOUS.date);
  if (stale === PAGE) throw new Error('the stale document is byte-identical to the shipped one — the mutation did nothing');
  return stale;
}

// One throwaway origin per leg, on loopback, on a port the OS picks.
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/privacy`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function document(body, { status = 200, cacheControl = DECLARED } = {}) {
  return (req, res) => {
    const headers = { 'Content-Type': 'text/html; charset=utf-8' };
    if (cacheControl !== null) headers['Cache-Control'] = cacheControl;
    res.writeHead(status, headers);
    res.end(body);
  };
}

// The command as the owner runs it — the assertion is the exit status, not a
// return value, because what the promotion step actually consumes is the exit
// code. ASYNC rather than spawnSync deliberately: the origin these legs measure
// runs in THIS process, and a synchronous spawn blocks the event loop that
// would accept its connection — the child would time out against a server that
// never got to answer. Measured while writing this file, and left as a comment
// so the next person does not "simplify" it back.
function runCli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { timeout: 30000 }, (err, stdout, stderr) => {
      const status = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ status, stdout, stderr });
    });
  });
}

test.describe('the promotion check tells a stale live document from an unmeasurable one (POL-P1)', () => {
  test('it agrees when the live document is the edition this tree ships', async () => {
    const origin = await serve(document(PAGE));
    try {
      const result = await checkTier({ label: 'edge', url: origin.url, expected: SHIPPED, strict: false });
      expect(result.verdict, result.lines.join('\n')).toBe(EXIT.OK);

      const cli = await runCli(['--edge', origin.url, '--timeout-ms', '5000']);
      expect(cli.status, `${cli.stdout}${cli.stderr}`).toBe(0);
      expect(cli.stdout).toContain(`edition ${SHIPPED.version}`);
    } finally {
      await origin.close();
    }
  });

  test('IT REDS WHEN THE LIVE DOCUMENT LAGS THE IMAGE — the 2026-08-29 state, built in-run', async () => {
    // This is the leg the check exists for. The document served here is the
    // shipped page rewritten to edition PREVIOUS, i.e. exactly what the live
    // address answered with for about an hour after the NAV merge while the
    // repository, the merge and the APK all said the current edition.
    const origin = await serve(document(stalePage()));
    try {
      const result = await checkTier({ label: 'edge', url: origin.url, expected: SHIPPED, strict: false });
      expect(result.verdict, result.lines.join('\n')).toBe(EXIT.STALE);
      expect(result.lines.join('\n')).toContain(PREVIOUS.version);
      expect(result.lines.join('\n')).toContain(SHIPPED.version);

      const cli = await runCli(['--edge', origin.url, '--timeout-ms', '5000']);
      expect(cli.status, `${cli.stdout}${cli.stderr}`).toBe(1);
      expect(cli.stderr).toContain(`LIVE edition ${PREVIOUS.version} (${PREVIOUS.date})`);
      expect(cli.stderr).toContain(`${SHIPPED.version} (${SHIPPED.date})`);
    } finally {
      await origin.close();
    }
  });

  test('it reds when the live class permits a stored copy, even on the right edition', async () => {
    const origin = await serve(document(PAGE, { cacheControl: PRE_PACKET_CLASS }));
    try {
      const result = await checkTier({ label: 'edge', url: origin.url, expected: SHIPPED, strict: false });
      expect(result.verdict, result.lines.join('\n')).toBe(EXIT.STALE);
      expect(result.lines.join('\n')).toContain('permits a stored copy');
    } finally {
      await origin.close();
    }
  });

  test('a class with no Cache-Control at all reds too — the header is not optional', async () => {
    const origin = await serve(document(PAGE, { cacheControl: null }));
    try {
      const result = await checkTier({ label: 'edge', url: origin.url, expected: SHIPPED, strict: false });
      expect(result.verdict, result.lines.join('\n')).toBe(EXIT.STALE);
      expect(result.lines.join('\n')).toContain('(no Cache-Control header)');
    } finally {
      await origin.close();
    }
  });

  test('A CHALLENGE IS UNMEASURABLE — never a pass, and never reported as staleness', async () => {
    const challenge = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id="challenge-platform"></div></body></html>';
    const origin = await serve(document(challenge, { status: 403, cacheControl: null }));
    try {
      const cli = await runCli(['--edge', origin.url, '--timeout-ms', '5000']);
      expect(cli.status, `${cli.stdout}${cli.stderr}`).toBe(2);
      expect(cli.status).not.toBe(0);
      expect(cli.status).not.toBe(1);
      expect(cli.stderr).toContain('bot challenge');
      expect(cli.stderr).toContain('NOT a pass');
    } finally {
      await origin.close();
    }
  });

  test('no answer at all is unmeasurable, and the deadline is the one knob this tool has', async () => {
    const hang = await serve(() => {
      /* deliberately never responds */
    });
    try {
      const result = await checkTier({
        label: 'edge',
        url: hang.url,
        expected: SHIPPED,
        strict: false,
        timeoutMs: 300,
      });
      expect(result.verdict, result.lines.join('\n')).toBe(EXIT.UNMEASURABLE);
      expect(result.lines.join('\n')).toContain('no answer within 300 ms');
    } finally {
      await hang.close();
    }
  });

  test('the app shell answering the policy address is a failure, not a parse miss', async () => {
    const shell = `<!DOCTYPE html><html><body><table id="${SHELL_MARKER}"></table></body></html>`;
    const origin = await serve(document(shell));
    try {
      const result = await checkTier({ label: 'edge', url: origin.url, expected: SHIPPED, strict: false });
      expect(result.verdict, result.lines.join('\n')).toBe(EXIT.STALE);
      expect(result.lines.join('\n')).toContain('APP SHELL');
    } finally {
      await origin.close();
    }
  });

  test('the origin tier is strict about the class and the edge tier is not, and both are measured', async () => {
    // The origin is our own nginx, so its header must be the declared class
    // exactly; the edge may normalise the value, so there the requirement is
    // that `no-store` survived. A single tier could not carry both readings.
    // The served class is DERIVED from the declared one so it cannot collide
    // with it: same semantics (no-store survives), different string.
    const different = `${DECLARED}, private`;
    expect(different, 'the leg must serve a class the config does not declare').not.toBe(DECLARED);
    const origin = await serve(document(PAGE, { cacheControl: different }));
    try {
      const strict = await checkTier({ label: 'origin', url: origin.url, expected: SHIPPED, strict: true });
      expect(strict.verdict, strict.lines.join('\n')).toBe(EXIT.STALE);
      expect(strict.lines.join('\n')).toContain('is not the class app/nginx.conf declares');

      const lenient = await checkTier({ label: 'edge', url: origin.url, expected: SHIPPED, strict: false });
      expect(lenient.verdict, lenient.lines.join('\n')).toBe(EXIT.OK);
    } finally {
      await origin.close();
    }
  });
});

test.describe('the check fails closed rather than passing on what it cannot read (POL-P1)', () => {
  test('every parser throws on input it does not fully understand', () => {
    expect(() => editionFromHtml('<p>no edition block here</p>')).toThrow(/Версия/);
    expect(() => editionFromHtml('<strong>Версия:</strong> 9.9<br>')).toThrow(/Дата вступления в силу/);
    expect(() => declaredCacheControl('http { server { } }')).toThrow(/no `location = \/privacy \{` block/);
    expect(() => declaredCacheControl('http { server { location = /privacy { try_files /privacy.html =404; } } }')).toThrow(
      /declares no readable Cache-Control/
    );
    // The named debt, proven rather than asserted: a trailing `always` is a form
    // neither this parser nor the drift guard's addHeaders() understands, and
    // both throw/red on it instead of silently dropping the header. POL-DL-001.
    expect(() =>
      declaredCacheControl('http { server { location = /privacy { add_header Cache-Control "no-store, max-age=0" always; } } }')
    ).toThrow(/declares no readable Cache-Control/);
  });

  test('a document whose edition block is a comment is not read as a document', () => {
    const commented = `<!-- <strong>Версия:</strong> 1.0<br><strong>Дата вступления в силу:</strong> 01.01.2026 -->`;
    expect(() => editionFromHtml(commented)).toThrow(/Версия/);
  });

  test('the shipped side is read, not assumed — anti-vacuity', () => {
    // Without this, every leg above could be comparing two nulls.
    expect(SHIPPED.version, 'no edition parsed out of app/privacy.html').toMatch(/^\d+\.\d+$/);
    expect(SHIPPED.date, 'no effective date parsed out of app/privacy.html').toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
    expect(SHIPPED.cacheControl, 'no class read out of app/nginx.conf').toBe(DECLARED);
    expect(PREVIOUS.version, 'the mutant edition is the shipped one').not.toBe(SHIPPED.version);
    expect(editionFromHtml(PAGE)).toEqual({ version: SHIPPED.version, date: SHIPPED.date });
  });
});
