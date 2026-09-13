import { describe, expect, it } from 'vitest';

import {
  EffectNeedsReconciliation,
  StaleVersion,
  createGitStore,
  createMemoryStore,
  type EffectRecord,
  type JournalEntry,
  type StageOutcome,
  type Store,
} from '../src/index.js';

import { fakeClock } from './helpers.js';
import { fakeRemote } from './remote.js';

// ai-workflows#6, spec §5.7: a piece's progress must survive the session that made it and be
// visible from another terminal. The git-backed store keeps each piece, and each zone, on its own
// ref, where every write is «read the head, decide from that one read, commit on top, move the ref
// only if it did not move». One ref per piece is a flock finding: with a single shared ref, three
// pieces running at once exhausted each other's retries and ended blocked.
// These tests run over an in-memory remote with that exact property; the GitHub adapter is tested
// on its own.

const LEASE = 30_000;
const noPause = async (): Promise<void> => undefined;
const entry = (stage: string, outcome: StageOutcome = 'passed'): JournalEntry => ({
  stage,
  outcome,
  at: 1,
  runId: 'run-a',
  pipeline: 'fp',
});

type Make = (now?: () => number) => Store;

const STORES: ReadonlyArray<readonly [string, Make]> = [
  // The memory store is the reference: if it fails a case here, the case is wrong, not the store.
  ['memory', (now) => createMemoryStore(now === undefined ? {} : { now })],
  [
    'git',
    (now) => createGitStore({ port: fakeRemote().port(), pause: noPause, ...(now === undefined ? {} : { now }) }),
  ],
];

describe.each(STORES)('the %s store keeps the Store contract', (_name, make) => {
  describe('reservations', () => {
    it('gives the piece to exactly one of two controllers racing for it', async () => {
      const store = make();

      const results = await Promise.all([
        store.reserve('997', 'run-a', LEASE),
        store.reserve('997', 'run-b', LEASE),
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
    });

    it('tells the loser who holds it and until when', async () => {
      const store = make();
      await store.reserve('997', 'run-a', LEASE);

      const result = await store.reserve('997', 'run-b', LEASE);

      expect(result.ok === false && result.heldBy).toBe('run-a');
      expect(result.ok === false && result.expiresAt).toBeGreaterThan(0);
    });

    it('lets the holder renew and refuses anyone else', async () => {
      const store = make();
      await store.reserve('997', 'run-a', LEASE);

      expect((await store.renew('997', 'run-a', LEASE)).ok).toBe(true);
      expect((await store.renew('997', 'run-b', LEASE)).ok).toBe(false);
    });

    it('does not name the caller as the holder of a piece nobody holds', async () => {
      const result = await make().renew('997', 'run-a', LEASE);

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.heldBy).not.toBe('run-a');
    });

    it('frees the piece on release by its holder, and ignores anyone else', async () => {
      const store = make();
      await store.reserve('997', 'run-a', LEASE);
      await store.release('997', 'run-b');
      expect((await store.reserve('997', 'run-c', LEASE)).ok).toBe(false);

      await store.release('997', 'run-a');
      expect((await store.reserve('997', 'run-c', LEASE)).ok).toBe(true);
    });

    it('hands over an expired lease, and not a live one', async () => {
      const clock = fakeClock();
      const store = make(clock.now);
      await store.reserve('997', 'run-a', LEASE);

      clock.advance(LEASE - 1);
      expect((await store.reserve('997', 'run-b', LEASE)).ok).toBe(false);
      clock.advance(2);
      expect((await store.reserve('997', 'run-b', LEASE)).ok).toBe(true);
    });
  });

  describe('versioned writes', () => {
    it('accepts a write carrying the version it read, with a new version every time', async () => {
      const store = make();
      const first = await store.saveStatus({ piece: '997', state: 'running' }, undefined);
      const read = await store.loadStatus('997');
      expect(read).toEqual({ status: { piece: '997', state: 'running' }, version: first });

      const second = await store.saveStatus({ piece: '997', state: 'running' }, read?.version);

      expect(second).toBeTruthy();
      expect(second).not.toBe(first);
    });

    it('refuses a stale version instead of overwriting', async () => {
      const store = make();
      const stale = await store.saveStatus({ piece: '997', state: 'running' }, undefined);
      await store.saveStatus({ piece: '997', state: 'blocked:rejected' }, stale);

      await expect(store.saveStatus({ piece: '997', state: 'done' }, stale)).rejects.toBeInstanceOf(
        StaleVersion,
      );
      await expect(store.saveStatus({ piece: '997', state: 'done' }, undefined)).rejects.toBeInstanceOf(
        StaleVersion,
      );
      expect((await store.loadStatus('997'))?.status.state).toBe('blocked:rejected');
    });

    it('lists every piece it knows about', async () => {
      const store = make();
      await store.saveStatus({ piece: '997', state: 'running' }, undefined);
      await store.saveStatus({ piece: '998', state: 'done' }, undefined);

      expect((await store.listStatuses()).map((status) => status.piece).sort()).toEqual(['997', '998']);
    });
  });

  describe('the journal', () => {
    it('keeps entries in order, per piece', async () => {
      const store = make();
      await store.append('997', entry('spec'));
      await store.append('997', entry('build', 'rejected'));

      expect((await store.journal('997')).map((item) => item.stage)).toEqual(['spec', 'build']);
      expect(await store.journal('998')).toEqual([]);
    });

    it('cannot be rewritten through what it hands out', async () => {
      const store = make();
      await store.append('997', entry('spec', 'rejected'));
      const journal = await store.journal('997');

      expect(() => {
        (journal as { length: number }).length = 0;
      }).toThrow();
      expect(() => {
        (journal[0] as { outcome: string }).outcome = 'passed';
      }).toThrow();
      expect((await store.journal('997'))[0]?.outcome).toBe('rejected');
    });

    it('drops one stage entries when asked to forget them', async () => {
      const store = make();
      await store.append('997', entry('spec'));
      await store.append('997', entry('vieja'));

      await store.forget('997', 'vieja');

      expect((await store.journal('997')).map((item) => item.stage)).toEqual(['spec']);
    });
  });

  describe('external effects', () => {
    it('does not repeat a confirmed effect', async () => {
      const store = make();
      let attempts = 0;
      const openPr = async () => {
        attempts += 1;
        return { pr: 1234 };
      };

      const first = await store.runEffect('997', 'open-pr', openPr);
      const second = await store.runEffect('997', 'open-pr', openPr);

      expect(attempts).toBe(1);
      expect(second).toEqual(first);
    });

    it('runs the effect once when two calls race with the same operation id', async () => {
      const store = make();
      let attempts = 0;
      const openPr = async () => {
        attempts += 1;
        await Promise.resolve();
        return { pr: attempts };
      };

      const [a, b] = await Promise.all([
        store.runEffect('997', 'open-pr', openPr),
        store.runEffect('997', 'open-pr', openPr),
      ]);

      expect(attempts).toBe(1);
      expect(a).toEqual(b);
    });

    it('leaves a failed effect uncertain and refuses to retry it blindly', async () => {
      const store = make();
      let attempts = 0;
      await expect(
        store.runEffect('997', 'open-pr', async () => {
          attempts += 1;
          throw new Error('la red se cayo');
        }),
      ).rejects.toThrow('la red se cayo');

      expect((await store.getEffect('997', 'open-pr'))?.state).toBe('uncertain');
      await expect(
        store.runEffect('997', 'open-pr', async () => {
          attempts += 1;
          return { pr: 1 };
        }),
      ).rejects.toBeInstanceOf(EffectNeedsReconciliation);
      expect(attempts).toBe(1);
    });

    it('reconciles: confirmed returns that value, didNotHappen runs it again', async () => {
      const store = make();
      const failing = async (): Promise<{ pr: number }> => {
        throw new Error('la red se cayo');
      };
      await store.runEffect('997', 'open-pr', failing).catch(() => undefined);
      await store.runEffect('997', 'other', failing).catch(() => undefined);

      await store.reconcileEffect('997', 'open-pr', { confirmed: { pr: 77 } });
      await store.reconcileEffect('997', 'other', { didNotHappen: true });

      expect(await store.runEffect('997', 'open-pr', async () => ({ pr: 99 }))).toEqual({ pr: 77 });
      expect(await store.runEffect('997', 'other', async () => ({ pr: 7 }))).toEqual({ pr: 7 });
    });

    it('keeps effects of different pieces apart and hands back no live object', async () => {
      const store = make();
      const first = await store.runEffect('997', 'open-pr', async () => ({ pr: 1 }));
      (first as { pr: number }).pr = 99;

      expect(await store.getEffect('998', 'open-pr')).toBeUndefined();
      expect(await store.runEffect('997', 'open-pr', async () => ({ pr: 2 }))).toEqual({ pr: 1 });
    });
  });

  describe('zones', () => {
    it('keeps a second piece out, frees on release, and does not confuse zones or pieces', async () => {
      const store = make();
      await store.reserveZone('nomina', '997', 'run-a', LEASE);

      expect((await store.reserveZone('nomina', '998', 'run-b', LEASE)).ok).toBe(false);
      expect((await store.reserveZone('tiempo', '998', 'run-b', LEASE)).ok).toBe(true);
      // A piece that happens to share a zone's name is a different thing.
      expect((await store.reserve('nomina', 'run-b', LEASE)).ok).toBe(true);

      await store.releaseZone('nomina', 'run-a');
      expect((await store.reserveZone('nomina', '998', 'run-b', LEASE)).ok).toBe(true);
    });

    it('hands a lapsed zone to the next piece', async () => {
      const clock = fakeClock();
      const store = make(clock.now);
      await store.reserveZone('nomina', '997', 'run-a', LEASE);

      clock.advance(LEASE + 1);

      expect((await store.reserveZone('nomina', '998', 'run-b', LEASE)).ok).toBe(true);
    });
  });
});

describe('the git store over a remote', () => {
  const session = (
    remote: ReturnType<typeof fakeRemote>,
    options: { now?: () => number; maxAttempts?: number } = {},
  ): Store => createGitStore({ port: remote.port(), pause: noPause, ...options });

  it('what one session wrote, the next session reads', async () => {
    const remote = fakeRemote();
    const clock = fakeClock();
    const first = session(remote, { now: clock.now });
    const version = await first.saveStatus({ piece: '997', state: 'running', stage: 'spec' }, undefined);
    await first.append('997', entry('spec'));
    await first.runEffect('997', 'open-pr', async () => ({ pr: 1004 }));
    await first.reserve('997', 'run-a', LEASE);
    await first.reserveZone('Plataforma y CI', '997', 'run-a', LEASE);

    const next = session(remote, { now: clock.now });

    expect(await next.loadStatus('997')).toEqual({
      status: { piece: '997', state: 'running', stage: 'spec' },
      version,
    });
    expect((await next.journal('997')).map((item) => item.stage)).toEqual(['spec']);
    expect(await next.getEffect('997', 'open-pr')).toEqual({ state: 'confirmed', result: { pr: 1004 } });
    expect(await next.runEffect('997', 'open-pr', async () => ({ pr: 9999 }))).toEqual({ pr: 1004 });
    expect((await next.reserve('997', 'run-b', LEASE)).ok).toBe(false);
    expect((await next.reserveZone('Plataforma y CI', '998', 'run-b', LEASE)).ok).toBe(false);
    expect((await next.listStatuses()).map((status) => status.piece)).toEqual(['997']);
  });

  it('gives a piece to exactly one of two sessions racing for it', async () => {
    const remote = fakeRemote();

    const [a, b] = await Promise.all([
      session(remote).reserve('997', 'run-a', LEASE),
      session(remote).reserve('997', 'run-b', LEASE),
    ]);

    expect([a, b].filter((result) => result.ok)).toHaveLength(1);
    const winner = a.ok ? 'run-a' : 'run-b';
    const loser = a.ok ? b : a;
    expect(loser.ok === false && loser.heldBy).toBe(winner);
  });

  it('does not make pieces wait for each other: a write to another piece costs no retry', async () => {
    const remote = fakeRemote();
    const store = session(remote);
    const other = session(remote);
    remote.beforeNextCommit(async () => {
      await other.append('1000', entry('spec'));
    });
    const before = remote.commitAttempts;

    await store.saveStatus({ piece: '997', state: 'running' }, undefined);

    // One attempt by the session that slipped in, one by this store: nobody lost a race.
    expect(remote.commitAttempts - before).toBe(2);
    expect((await session(remote).journal('1000')).map((item) => item.stage)).toEqual(['spec']);
  });

  it('refuses a status write when another session changed the status in between, and keeps theirs', async () => {
    const remote = fakeRemote();
    const store = session(remote);
    const other = session(remote);
    const read = await store.saveStatus({ piece: '997', state: 'running' }, undefined);
    remote.beforeNextCommit(async () => {
      await other.saveStatus({ piece: '997', state: 'parked' }, read);
    });

    await expect(store.saveStatus({ piece: '997', state: 'done' }, read)).rejects.toBeInstanceOf(StaleVersion);
    expect((await session(remote).loadStatus('997'))?.status.state).toBe('parked');
  });

  it('retries a write that lost only to another change on the same piece, and keeps both', async () => {
    const remote = fakeRemote();
    const store = session(remote);
    const other = session(remote);
    remote.beforeNextCommit(async () => {
      await other.append('997', entry('spec'));
    });

    await store.saveStatus({ piece: '997', state: 'running' }, undefined);

    const fresh = session(remote);
    expect((await fresh.loadStatus('997'))?.status.state).toBe('running');
    expect((await fresh.journal('997')).map((item) => item.stage)).toEqual(['spec']);
  });

  it('keeps both of two appends that raced, instead of one overwriting the other', async () => {
    const remote = fakeRemote();
    const store = session(remote);
    const other = session(remote);
    remote.beforeNextCommit(async () => {
      await other.append('997', entry('from-other'));
    });

    await store.append('997', entry('mine'));

    expect((await session(remote).journal('997')).map((item) => item.stage).sort()).toEqual([
      'from-other',
      'mine',
    ]);
  });

  it('claims an effect before running it, so a crash mid-effect leaves it pending, not absent', async () => {
    const remote = fakeRemote();
    let seenDuring: EffectRecord | undefined;

    await session(remote).runEffect('997', 'open-pr', async () => {
      seenDuring = await session(remote).getEffect('997', 'open-pr');
      return { pr: 1 };
    });

    expect(seenDuring?.state).toBe('pending');
  });

  it('does not run an effect another session has in flight: it reports instead', async () => {
    const remote = fakeRemote();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let startedA = false;
    const flightA = session(remote).runEffect('997', 'open-pr', async () => {
      startedA = true;
      await held;
      return { pr: 1 };
    });
    while (!startedA) await new Promise((resolve) => setImmediate(resolve));

    let ranB = false;
    await expect(
      session(remote).runEffect('997', 'open-pr', async () => {
        ranB = true;
        return { pr: 2 };
      }),
    ).rejects.toBeInstanceOf(EffectNeedsReconciliation);

    expect(ranB).toBe(false);
    release();
    await expect(flightA).resolves.toEqual({ pr: 1 });
  });

  it('gives up after repeated lost races instead of retrying forever, and writes nothing', async () => {
    const remote = fakeRemote();
    let noise = 0;
    remote.beforeEveryCommit(() => {
      noise += 1;
      remote.put('pieces/997', 'noise.json', String(noise));
    });
    let pauses = 0;
    const store = createGitStore({
      port: remote.port(),
      maxAttempts: 3,
      pause: async () => {
        pauses += 1;
      },
    });

    const error = await store.saveStatus({ piece: '997', state: 'running' }, undefined).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(StaleVersion);
    expect(remote.commitAttempts).toBe(3);
    // A pause after the last attempt only delays the error (delta review: up to 2 s per write).
    expect(pauses).toBe(2);
    expect(remote.files('pieces/997')['status.json']).toBeUndefined();
  });

  it('passes a failure of the remote through, instead of reading it as «nothing stored»', async () => {
    const remote = fakeRemote();
    const store = session(remote);
    await store.saveStatus({ piece: '997', state: 'running' }, undefined);

    remote.failNext('head', new Error('network down: head'));
    await expect(store.loadStatus('997')).rejects.toThrow('network down: head');
    remote.failNext('read', new Error('network down: read'));
    await expect(store.journal('997')).rejects.toThrow('network down: read');
    remote.failNext('refs', new Error('network down: refs'));
    await expect(store.listStatuses()).rejects.toThrow('network down: refs');
    remote.failNext('commit', new Error('network down: commit'));
    await expect(store.append('997', entry('spec'))).rejects.toThrow('network down: commit');
  });

  it('fails closed on a stored file it cannot read, naming the file', async () => {
    const remote = fakeRemote();
    const store = session(remote);
    await store.saveStatus({ piece: '997', state: 'running' }, undefined);

    remote.put('pieces/997', 'status.json', '{not json');
    await expect(store.loadStatus('997')).rejects.toThrow(/status\.json/);
    remote.put('pieces/997', 'journal.json', '{"not":"a list"}');
    await expect(store.journal('997')).rejects.toThrow(/journal\.json/);
  });

  it('keeps pieces with awkward names apart, each on its own ref with a safe name', async () => {
    const remote = fakeRemote();
    const store = session(remote);
    // `a_2Fb` is what `a/b` would become if `_` were left unescaped: the pair proves the key is
    // injective, not just safe.
    const names = ['a/b', 'a_2Fb', '..', '.', 'Plataforma y CI', 'a%2Fb', 'ü', 'a_b', 'a-b'];
    for (const piece of names) await store.saveStatus({ piece, state: 'running' }, undefined);

    expect((await session(remote).listStatuses()).map((status) => status.piece).sort()).toEqual(
      [...names].sort(),
    );
    const refs = remote.refNames();
    expect(refs).toHaveLength(names.length);
    for (const name of refs) expect(name).toMatch(/^pieces\/[A-Za-z0-9_-]+$/);
  });

  it('reads nothing into existence: reading an empty remote writes no commit', async () => {
    const remote = fakeRemote();
    const store = session(remote);

    expect(await store.loadStatus('997')).toBeUndefined();
    expect(await store.listStatuses()).toEqual([]);
    expect(await store.journal('997')).toEqual([]);
    expect(await store.getEffect('997', 'open-pr')).toBeUndefined();
    expect(remote.commits).toBe(0);
  });

  it('keeps each concern in its own file on the piece ref, and each zone on its own ref', async () => {
    const remote = fakeRemote();
    const store = session(remote);
    await store.saveStatus({ piece: '997', state: 'running' }, undefined);
    await store.append('997', entry('spec'));
    await store.runEffect('997', 'open-pr', async () => ({ pr: 1004 }));
    await store.reserve('997', 'run-a', LEASE);
    await store.reserveZone('Plataforma y CI', '997', 'run-a', LEASE);

    const piece = remote.files('pieces/997');
    const parse = (text: string | undefined): unknown => JSON.parse(text ?? 'null');
    expect(parse(piece['status.json'])).toMatchObject({ status: { piece: '997', state: 'running' } });
    expect(parse(piece['journal.json'])).toHaveLength(1);
    expect(parse(piece['effects.json'])).toMatchObject({
      'open-pr': { state: 'confirmed', result: { pr: 1004 } },
    });
    expect(parse(piece['lease.json'])).toMatchObject({ runId: 'run-a' });
    expect(parse(piece['ref.json'])).toEqual({ kind: 'piece', id: '997' });
    const zone = remote.refNames().find((name) => name.startsWith('zones/'));
    expect(zone).toMatch(/^zones\/[A-Za-z0-9_-]+$/);
    expect(parse(remote.files(zone ?? '')['lease.json'])).toMatchObject({ runId: 'run-a', piece: '997' });
    expect(parse(remote.files(zone ?? '')['ref.json'])).toEqual({ kind: 'zone', id: 'Plataforma y CI' });
  });

  it('never leaves a ref without files, which GitHub refuses: releasing keeps who the ref is for', async () => {
    // Measured on 13-sep-2026: releasing a zone (its ref held only the lease) failed with 404 on
    // real GitHub, and the zone stayed taken until its lease ran out.
    const remote = fakeRemote();
    const store = session(remote);
    await store.reserve('997', 'run-a', LEASE);
    await store.release('997', 'run-a');
    await store.reserveZone('Plataforma y CI', '997', 'run-a', LEASE);
    await store.releaseZone('Plataforma y CI', 'run-a');

    const parse = (text: string | undefined): unknown => JSON.parse(text ?? 'null');
    expect(remote.files('pieces/997')['lease.json']).toBeUndefined();
    expect(parse(remote.files('pieces/997')['ref.json'])).toEqual({ kind: 'piece', id: '997' });
    const zone = remote.refNames().find((name) => name.startsWith('zones/')) ?? '';
    expect(remote.files(zone)['lease.json']).toBeUndefined();
    expect(parse(remote.files(zone)['ref.json'])).toEqual({ kind: 'zone', id: 'Plataforma y CI' });
    expect((await session(remote).reserve('997', 'run-b', LEASE)).ok).toBe(true);
    expect((await session(remote).reserveZone('Plataforma y CI', '998', 'run-b', LEASE)).ok).toBe(true);
  });
});
