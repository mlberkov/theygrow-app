'use strict';

// The transaction the SEAM drives, and whose failure it reports (DIA-P3R2).
//
// WHY THIS IS ITS OWN FILE. The property here belongs to neither write path and
// to both: `store/records.js` (the diary) and `store/journal.js` (the mark)
// reach the plugin through the same `bridge.executeSet`, and the arming in
// `DiaryEntryTest` reaches it through that same shipped module. A leg living in
// diary-write.spec.js would under-state a rule the mark path depends on just as
// hard; one living in store-unit.spec.js would contradict that file's own header,
// which says outright that bridge claims needing a fake do not belong there.
//
// WHAT THIS PROVES, AND WHAT IT DOES NOT. It starts no product and executes no
// SQL. It drives the shipped `bridge.js` against the recorder in
// support/fake-bridge.js and asserts CALL ORDER and ERROR PRECEDENCE — that the
// set is wrapped in a transaction the seam issues, and that when a statement
// fails and the rollback fails too, the caller is handed the STATEMENT's failure.
//
// It says nothing about SQLite, nothing about whether a real full disk produces
// those messages, and nothing about what a parent then reads. Those are
// `DiaryEntryTest::a_full_disk_refuses_the_entry_and_keeps_the_text` and
// `::a_full_disk_withdraws_the_tick_and_says_why`, on a device, and DIA-DL-005
// alternative 9 — which refused to fake the parent-facing disk-full claim —
// is untouched by this file.
//
// WHY THE RULE EXISTS, measured rather than reasoned. Run 31979084821, logcat
// 23:30:40.036-40.038: a statement inside `executeSet` fails with `(13) …
// database or disk is full`, the wrapper's ROLLBACK then fails with `(1) cannot
// rollback - no transaction is active` — SQLite had already aborted the
// transaction, which is what SQLITE_FULL does — and the wrapper throws the
// ROLLBACK's message from a `finally`, discarding the disk-full one. What
// crossed the bridge carried none of DISK_FULL_MARKERS, so a parent whose disk
// was full would have been told to press Save again.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');
const { createFakeBridge, withFakeBridge } = require('./support/fake-bridge');
const { currentMount } = require('./support/ship-list');

const APP_ROOT = path.resolve(__dirname, '..');
const MOUNT = currentMount(fs.readFileSync(path.join(APP_ROOT, 'index.html'), 'utf8'));
// The mount the SHELL references, never a literal (EMV-DL-001).
const STORE_DIR = path.join(APP_ROOT, 'm', MOUNT.dir, 'store');

// The same two pieces of Node plumbing store-unit.spec.js documents: a real
// dynamic import Playwright's CommonJS transform will not rewrite, and a temp
// directory carrying the ESM marker that app/m/ cannot carry because everything
// under it ships.
const dynamicImport = new Function('specifier', 'return import(specifier)');

let loadRoot = null;
let generation = 0;

// The wrapper's own words, both halves. The first is what the engine says and
// the classifier recognises; the second is what the wrapper says INSTEAD when
// its rollback fails, and it deliberately carries no disk-full marker — that is
// the whole point of the pair.
const DISK_FULL = 'ExecuteSet: database or disk is full (code 13 SQLITE_FULL)';
const ROLLBACK_FAILED =
    'RollbackTransaction: Failed in rollbackTransactioncannot rollback - no transaction is'
    + ' active (code 1)';

const SET = [{ statement: 'INSERT INTO record (id) VALUES (?)', values: ['r-1'] }];

test.beforeAll(() => {
    loadRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'theygrow-seam-'));
    fs.writeFileSync(path.join(loadRoot, 'package.json'), '{"type":"module"}');
    fs.mkdirSync(path.join(loadRoot, 'store'), { recursive: true });
    for (const name of fs.readdirSync(STORE_DIR)) {
        const from = path.join(STORE_DIR, name);
        if (!fs.statSync(from).isFile()) continue;
        const to = path.join(loadRoot, 'store', name);
        fs.copyFileSync(from, to);
        expect(
            fs.readFileSync(to).equals(fs.readFileSync(from)),
            `store/${name} was not copied verbatim — this spec would test a different file`
        ).toBeTruthy();
    }
});

test.afterAll(() => {
    if (loadRoot) fs.rmSync(loadRoot, { recursive: true, force: true });
});

const load = (rel) => {
    generation += 1;
    return dynamicImport(`${pathToFileURL(path.join(loadRoot, rel)).href}?g=${generation}`);
};

/** The plugin methods the seam issued, in order. */
const order = (fake) => fake.calls.map((call) => call.method);

test.describe('the seam owns the transaction', () => {
    test('a set is wrapped in a transaction the SEAM issues, not the wrapper', async () => {
        const fake = createFakeBridge({});
        await withFakeBridge(fake, async () => {
            const { executeSet } = await load('store/bridge.js');
            await executeSet(SET);
        });

        expect(order(fake)).toEqual(['beginTransaction', 'executeSet', 'commitTransaction']);

        // And the wrapper is told NOT to drive one of its own. A nested wrapper
        // transaction would reintroduce the `finally` this design exists to get
        // out from under.
        const set = fake.calls.find((call) => call.method === 'executeSet');
        expect(
            set.options.transaction,
            'the wrapper must not be asked to drive a transaction the seam is already driving'
        ).toBe(false);

        // The atomicity the call sites depend on is still readable, and it now
        // reads true only because the envelope actually committed.
        const [tx] = fake.transactions();
        expect(tx.transaction).toBe(true);
        expect(tx.committed).toBe(true);
    });

    test('an explicit { transaction: false } goes straight through, unwrapped', async () => {
        const fake = createFakeBridge({});
        await withFakeBridge(fake, async () => {
            const { executeSet } = await load('store/bridge.js');
            await executeSet(SET, { transaction: false });
        });
        expect(order(fake)).toEqual(['executeSet']);
    });
});

test.describe('the failure that caused the rollback outranks the rollback (ADR-046 §1.1)', () => {
    test('a full disk reaches the caller as itself even when the ROLLBACK also fails', async () => {
        const fake = createFakeBridge({ failOn: 1, failWith: DISK_FULL, rollbackFailsWith: ROLLBACK_FAILED });

        let failure = null;
        await withFakeBridge(fake, async () => {
            const { executeSet } = await load('store/bridge.js');
            failure = await executeSet(SET).then(() => null, (error) => error);
        });

        // THE CLAIM. Both calls failed; the one the parent is told about is the
        // one that describes what is wrong with their device.
        expect(failure, 'the write must not resolve when its statement was refused').not.toBeNull();
        expect(
            failure.name,
            'the rollback\'s failure was reported instead of the disk being full'
        ).toBe('StoreDiskFullError');
        expect(failure.message, 'the raw engine message survives for the RUNBOOK').toBe(DISK_FULL);
        expect(
            failure.message,
            'the rollback\'s words must not reach the classifier or the RUNBOOK'
        ).not.toContain('rollback');

        // The rollback was still ATTEMPTED — swallowing its error is not the
        // same as skipping it — and no commit was issued.
        expect(order(fake)).toEqual([
            'beginTransaction',
            'executeSet',
            'rollbackTransaction',
        ]);
    });

    test('a rollback that succeeds changes nothing about which failure is reported', async () => {
        const fake = createFakeBridge({ failOn: 1, failWith: DISK_FULL });

        let failure = null;
        await withFakeBridge(fake, async () => {
            const { executeSet } = await load('store/bridge.js');
            failure = await executeSet(SET).then(() => null, (error) => error);
        });

        // The wrapper's behaviour was never consistent — in run 31979084821 the
        // single-statement `run` fillers surfaced the engine's words cleanly
        // while the two-statement set did not. The seam must not depend on which
        // way it falls, so the same assertion holds on the other branch.
        expect(failure.name).toBe('StoreDiskFullError');
        expect(failure.message).toBe(DISK_FULL);
        expect(order(fake)).toEqual(['beginTransaction', 'executeSet', 'rollbackTransaction']);
    });

    test('a failure that is not a full disk is still classified as what it is', async () => {
        const fake = createFakeBridge({
            failOn: 1,
            failWith: 'ExecuteSet: no such table: record',
            rollbackFailsWith: ROLLBACK_FAILED,
        });

        let failure = null;
        await withFakeBridge(fake, async () => {
            const { executeSet } = await load('store/bridge.js');
            failure = await executeSet(SET).then(() => null, (error) => error);
        });

        // The reason DISK_FULL_MARKERS was NOT widened to match the rollback
        // message: a marker matching "cannot rollback" would land here, and this
        // parent would be told to free space when space is not the problem.
        expect(failure.name).toBe('StoreError');
        expect(failure.message).toBe('ExecuteSet: no such table: record');
    });
});

// The park gate (FIU-P1).
//
// WHAT IT IS FOR. Since L3-P1 the store is CLOSED when the page goes hidden, so
// there is a state the seam never had to model: the connection is gone while the
// page and its handlers are still alive. An ordinary call in that state must
// wait for a reopen rather than fail, and the calls that PERFORM the reopen must
// not wait for themselves.
//
// WHY THESE LEGS ARE HERE AND NOT IN store-lifecycle.spec.js. That file drives a
// real page and asserts what a parent sees; these are properties of the seam's
// control flow — how many reopens N concurrent callers cause, and which entry
// point consults the gate at all — which need a recorder and no browser. The
// second one below is also the leg whose failure mode is a HANG rather than a
// wrong value, and a hang is much easier to read here than behind a page.
//
// Nothing here touches SQLite. `store/store.js` is not even loaded: the reopener
// is a stand-in, because what is under test is the gate's arithmetic and not
// what an open does.
test.describe('the park gate', () => {
    test('a call made while parked reopens the store ONCE, however many callers there are', async () => {
        const fake = createFakeBridge({});
        let reopens = 0;

        await withFakeBridge(fake, async () => {
            const bridge = await load('store/bridge.js');
            bridge.registerStoreReopener(async () => {
                reopens += 1;
                // What a real reopen is made of, reduced to its one observable:
                // a call that must land BEFORE any of the waiting ones.
                await bridge.lifecycleBridge.call('open', { database: 'theygrow' });
            });

            expect(bridge.storeIsParked(), 'the gate starts open').toBe(false);
            bridge.setStoreParked(true);

            await Promise.all([
                bridge.query('SELECT 1'),
                bridge.query('SELECT 2'),
                bridge.query('SELECT 3'),
            ]);

            expect(
                reopens,
                'three concurrent callers caused more than one reopen — the single-flight'
                    + ' promise is not being shared, and a second createConnection is answered'
                    + ' with "Connection theygrow already exists"'
            ).toBe(1);
            expect(bridge.storeIsParked(), 'the gate stayed shut after a successful reopen').toBe(
                false
            );
        });

        // The reopen went first. A gate that let a read through before the store
        // was back would hand the parent a refusal on the first tap after they
        // unlocked their phone, which is exactly the defect this packet is about.
        expect(order(fake)).toEqual(['open', 'query', 'query', 'query']);
    });

    test('a LIFECYCLE call does not consult the gate — an open must not wait for itself', async () => {
        // THE DEADLOCK LEG. `openStore()` and `closeStore()` are made of bridge
        // calls, so if those calls went through the gate they would wait for the
        // very transition they are performing, and the app would hang on its
        // first background. The failure mode of this leg is therefore a TIMEOUT,
        // not an assertion — which is why it is written with an explicit
        // reopener that must never run, so a regression names itself.
        const fake = createFakeBridge({});
        let reopens = 0;

        await withFakeBridge(fake, async () => {
            const bridge = await load('store/bridge.js');
            bridge.registerStoreReopener(async () => {
                reopens += 1;
            });
            bridge.setStoreParked(true);

            await bridge.lifecycleBridge.query('SELECT 1');
            await bridge.lifecycleBridge.run('UPDATE store_lifecycle SET clean_shutdown = 1', []);
            await bridge.lifecycleBridge.call('close', { database: 'theygrow' });

            expect(
                reopens,
                'a lifecycle call tripped the gate, so an open would wait for itself'
            ).toBe(0);
            expect(
                bridge.storeIsParked(),
                'a lifecycle call cleared the parked flag it has no business clearing'
            ).toBe(true);
        });

        expect(order(fake)).toEqual(['query', 'run', 'close']);
    });

    test('a transaction already in flight is waited out before the store is closed', async () => {
        // `whenBridgeIdle` is what stops a park landing between a BEGIN and its
        // COMMIT. The wrapper refuses to close a database that is still in a
        // transaction, and it refuses with a message about the transaction — so
        // without this the park would fail for a reason that says nothing about
        // the park.
        let release = null;
        const held = new Promise((resolve) => {
            release = resolve;
        });
        const calls = [];
        const bridgeObject = {
            isNativePlatform: () => true,
            nativePromise: async (plugin, method, options) => {
                calls.push(method);
                if (method === 'executeSet') await held;
                void plugin;
                void options;
                return { changes: { changes: 1 } };
            },
        };

        await withFakeBridge({ bridge: bridgeObject }, async () => {
            const bridge = await load('store/bridge.js');

            const writing = bridge.executeSet([
                { statement: 'INSERT INTO record (id) VALUES (?)', values: ['r-1'] },
            ]);

            let idle = false;
            const waiting = bridge.whenBridgeIdle().then(() => {
                idle = true;
            });

            // Give the idle waiter every chance to resolve early. It must not:
            // the transaction has begun and has not committed.
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(
                idle,
                'the park would have closed the database in the middle of a transaction'
            ).toBe(false);

            release();
            await writing;
            await waiting;
            expect(idle, 'the park never learned the transaction had finished').toBe(true);
        });

        expect(calls).toEqual(['beginTransaction', 'executeSet', 'commitTransaction']);
    });
});
