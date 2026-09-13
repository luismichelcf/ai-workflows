import { describe, expect, it } from 'vitest';

import { createEngine, createMemoryStore } from '../src/index.js';

import { chain, fakeClock, harness, pipeline, recorder, reject, stage } from './helpers.js';

// The third review. Nine of eleven earlier findings were closed; these are what it found
// next, plus the mutants that survived 124 tests. The common thread is the same one that
// has run through every round: the engine must not be fooled, including by itself.

const held = () => {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release?.() };
};

describe('a gate cannot rewrite the journal it was handed', () => {
  it('refuses an edit to an entry written earlier in this same run', async () => {
    // Entries loaded from the store were frozen; the ones this run had just written were
    // not — and those are exactly what the next stage reads. A gate turned its own skip
    // into a pass and the next stage read the forgery as good.
    let edit: unknown;
    const { engine } = harness(
      chain(
        stage('spec', { gate: () => ({ ok: 'skipped', reason: 'exento por el carril' }) }),
        stage('flock', {
          nature: 'execution-record',
          gate: (context) => {
            try {
              (context.journal[0] as { outcome: string }).outcome = 'passed';
            } catch (error) {
              edit = error;
            }
            return { ok: true };
          },
        }),
      ),
    );

    await engine.run('997');

    expect(edit).toBeDefined();
  });

  it('keeps the stored entry intact even after a gate tried', async () => {
    const store = createMemoryStore();
    const { engine } = harness(
      chain(
        stage('spec', { gate: () => ({ ok: 'skipped', reason: 'exento por el carril' }) }),
        stage('flock', {
          gate: (context) => {
            try {
              (context.journal[0] as { outcome: string }).outcome = 'passed';
            } catch {
              // expected
            }
            return { ok: true };
          },
        }),
      ),
      { store },
    );

    await engine.run('997');

    expect((await store.journal('997'))[0]?.outcome).toBe('skipped');
  });

  it('refuses an edit nested inside the evidence', async () => {
    let edit: unknown;
    const { engine } = harness(
      chain(
        stage('spec', { gate: () => ({ ok: true, evidence: { verdict: 'rejected' } }) }),
        stage('flock', {
          gate: (context) => {
            try {
              (context.journal[0]?.evidence as { verdict: string }).verdict = 'approved';
            } catch (error) {
              edit = error;
            }
            return { ok: true };
          },
        }),
      ),
    );

    await engine.run('997');

    expect(edit).toBeDefined();
  });
});

describe('a dry run stays a dry run', () => {
  it('does not swallow a real run that starts while it is in flight', async () => {
    // `run` joined whatever run was already live for the piece, without looking at the
    // mode. A real run handed back "ran, done" having written nothing at all.
    const slow = held();
    const store = createMemoryStore();
    const config = pipeline(
      chain(
        stage('spec', {
          gate: async () => {
            await slow.promise;
            return { ok: true };
          },
        }),
      ),
    );
    const engine = createEngine({ config, store });

    const dry = engine.run('997', { mode: 'dry-run' });
    const real = engine.run('997');
    slow.release();
    await Promise.all([dry, real]);

    expect(await store.journal('997')).not.toEqual([]);
  });

  it('writes nothing to the journal', async () => {
    const store = createMemoryStore();
    const { engine } = harness(chain(stage('spec'), stage('gate')), { store });

    await engine.run('997', { mode: 'dry-run' });

    expect(await store.journal('997')).toEqual([]);
  });

  it('does not run external effects: a dry run must not open the pull request', async () => {
    const store = createMemoryStore();
    let opened = false;
    const { engine } = harness(
      chain(
        stage('open-pr', {
          gate: async (context) => {
            await context.runEffect('open-pr', async () => {
              opened = true;
              return { pr: 7 };
            });
            return { ok: true };
          },
        }),
      ),
      { store },
    );

    await engine.run('997', { mode: 'dry-run' });

    expect(opened).toBe(false);
    expect(await store.getEffect('997', 'open-pr')).toBeUndefined();
  });

  it('reports a stage it cannot evaluate dry as such, not as a technical failure', async () => {
    // A healthy pipeline reported `blocked:technical` in dry mode, which reads as "the
    // environment broke" — the opposite of what a rehearsal is for.
    const { engine } = harness(
      chain(
        stage('open-pr', {
          gate: async (context) => {
            await context.runEffect('open-pr', async () => ({ pr: 7 }));
            return { ok: true };
          },
        }),
      ),
    );

    const result = await engine.run('997', { mode: 'dry-run' });

    expect(result.outcome === 'ran' && result.status.state).not.toBe('blocked:technical');
  });
});

describe('aborting actually aborts', () => {
  it('does not run anything when the caller aborts before it starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const seen = recorder();
    const { engine } = harness(
      chain(
        stage('a', { gate: seen.gateFor('a') }),
        stage('b', { gate: seen.gateFor('b') }),
      ),
    );

    await engine.run('997', { signal: controller.signal });

    expect(seen.seen).toEqual([]);
  });

  it('stops between stages when the caller aborts mid-run', async () => {
    // The signal reached the gates, but the engine never looked at it, so a Ctrl-C let the
    // whole pipeline finish and write `done`.
    const controller = new AbortController();
    const slow = held();
    const seen = recorder();
    const { engine } = harness(
      chain(
        stage('a', {
          gate: async () => {
            seen.seen.push('a');
            await slow.promise;
            return { ok: true };
          },
        }),
        stage('b', { gate: seen.gateFor('b') }),
      ),
    );

    const running = engine.run('997', { signal: controller.signal });
    controller.abort();
    slow.release();
    await running;

    expect(seen.seen).not.toContain('b');
  });

  it('does not declare the piece done after being aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { engine } = harness(chain(stage('a')));

    const result = await engine.run('997', { signal: controller.signal });

    expect(result.outcome === 'ran' && result.status.state).not.toBe('done');
  });
});

describe('a store that fails while finishing', () => {
  it('does not lose the run because releasing the piece failed', async () => {
    // A remote store can fail to remove a label. That must not turn a finished run into a
    // raw exception for the caller.
    const store = createMemoryStore();
    const broken: typeof store = {
      ...store,
      release: async () => {
        throw new Error('500 al soltar la etiqueta');
      },
    };
    const config = pipeline(chain(stage('spec')));
    const engine = createEngine({ config, store: broken });

    const result = await engine.run('997');

    expect(result.outcome).toBe('ran');
  });

  it('reports a read failure instead of throwing out of run', async () => {
    const store = createMemoryStore();
    for (const method of ['loadStatus', 'journal', 'reserve'] as const) {
      const broken = {
        ...store,
        [method]: async () => {
          throw new Error(`502 en ${method}`);
        },
      } as typeof store;
      const engine = createEngine({ config: pipeline(chain(stage('spec'))), store: broken });

      const result = await engine.run('997');

      expect(result.outcome === 'ran' && result.status.state).toBe('blocked:technical');
    }
  });
});

describe('stages whose answer the engine must not coerce', () => {
  for (const [label, value] of [
    ['a string', 'no'],
    ['an object', {}],
    ['a number', 1],
  ] as const) {
    it(`blocks when stillValid returns ${label}`, async () => {
      // `appliesWhen` was hardened and `stillValid` was not: a forgotten comparison kept
      // stale evidence alive in silence.
      const store = createMemoryStore();
      const seen = recorder();
      const config = pipeline(
        chain(stage('a', { gate: seen.gateFor('a'), stillValid: () => value as never })),
      );
      const engine = createEngine({ config, store });
      await engine.run('997');

      const result = await engine.run('997');

      expect(result.outcome === 'ran' && result.status.state).toBe('blocked:technical');
    });
  }

  it('blocks when appliesWhen skips without saying why', async () => {
    const { engine } = harness(
      chain(stage('spec'), stage('mutants', { appliesWhen: () => ({ skip: '' }) })),
    );

    const result = await engine.run('997');

    expect(result.outcome === 'ran' && result.status.state).toBe('blocked:technical');
  });

  it('accepts an appliesWhen that answers asynchronously', async () => {
    const seen = recorder();
    const { engine } = harness(
      chain(
        stage('spec'),
        stage('mutants', {
          appliesWhen: async () => true,
          gate: seen.gateFor('mutants'),
        }),
      ),
    );

    await engine.run('997');

    expect(seen.seen).toContain('mutants');
  });

  it('gives stillValid the entry with its evidence', async () => {
    let seenEvidence: unknown;
    const store = createMemoryStore();
    const config = pipeline(
      chain(
        stage('a', {
          gate: () => ({ ok: true, evidence: { sha: 'abc' } }),
          stillValid: (entry) => {
            seenEvidence = entry.evidence;
            return true;
          },
        }),
      ),
    );
    const engine = createEngine({ config, store });

    await engine.run('997');
    await engine.run('997');

    expect(seenEvidence).toEqual({ sha: 'abc' });
  });
});

describe('what counts as resolved', () => {
  it('does not treat a stage still waiting for a person as settled', async () => {
    // Counting `waiting` as resolved sends the piece to `done` without ever asking again.
    const asked = recorder();
    const { engine } = harness(
      chain(
        stage('qa'),
        stage('sign-off', {
          needsHuman: true,
          gate: asked.gateFor('sign-off', reject('sin visto bueno')),
        }),
      ),
    );

    await engine.run('997');
    await engine.run('997');

    expect(asked.seen.filter((name) => name === 'sign-off')).toHaveLength(2);
  });

  it('does not treat a stage that blew up as settled', async () => {
    const tried = recorder();
    const { engine } = harness(
      chain(
        stage('gate', {
          gate: () => {
            tried.seen.push('gate');
            throw new Error('el preview no desplego');
          },
        }),
      ),
    );

    await engine.run('997');
    await engine.run('997');

    expect(tried.seen).toHaveLength(2);
  });

  it('judges a stage by its latest entry, not its first', async () => {
    const asked = recorder();
    let approved = false;
    const { engine } = harness(
      chain(
        stage('sign-off', {
          needsHuman: true,
          gate: () => {
            asked.seen.push('sign-off');
            return approved ? { ok: true } : { ok: false, reason: 'sin visto bueno' };
          },
        }),
      ),
    );

    await engine.run('997');
    approved = true;
    await engine.run('997');
    await engine.run('997');

    expect(asked.seen).toHaveLength(2);
  });

  it('treats a stage that declares needsHuman false as an ordinary stage', async () => {
    const { engine } = harness(
      chain(stage('gate', { needsHuman: false, gate: reject('la puerta esta roja') })),
    );

    const result = await engine.run('997');

    expect(result.outcome === 'ran' && result.status.state).toBe('blocked:rejected');
  });
});

describe('the lease keepalive', () => {
  it('holds the piece through a stage far longer than the lease', async () => {
    // The per-stage renewal alone satisfied the earlier test; nothing exercised the timer
    // that has to keep renewing DURING one long stage.
    const slow = held();
    const clock = fakeClock();
    const store = createMemoryStore({ now: clock.now });
    const config = pipeline(
      chain(
        stage('suite', {
          gate: async () => {
            for (let tick = 0; tick < 5; tick += 1) {
              clock.advance(20);
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            await slow.promise;
            return { ok: true };
          },
        }),
      ),
    );
    const engine = createEngine({ config, store, now: clock.now, runId: 'A', leaseMs: 30 });

    const running = engine.run('997');
    await new Promise((resolve) => setTimeout(resolve, 40));
    const stolen = await store.reserve('997', 'B', 30);
    slow.release();
    await running;

    expect(stolen.ok).toBe(false);
  });
});

describe('two controllers that share a runId', () => {
  it('do not both run the gates', async () => {
    // A project that sets a stable runId — `process.env.GITHUB_RUN_ID`, say — or a
    // controller that restarts with the same id, gets two live writers.
    const slow = held();
    const store = createMemoryStore();
    const seen = recorder();
    const config = pipeline(
      chain(
        stage('a', {
          gate: async () => {
            seen.seen.push('a');
            await slow.promise;
            return { ok: true };
          },
        }),
      ),
    );
    const one = createEngine({ config, store, runId: 'shared' });
    const two = createEngine({ config, store, runId: 'shared' });

    const first = one.run('997');
    const second = two.run('997');
    slow.release();
    await Promise.all([first, second]);

    expect(seen.seen).toHaveLength(1);
  });
});

describe('parking a piece nobody knows', () => {
  it('does not invent a phantom piece', async () => {
    const { engine } = harness(chain(stage('spec')));

    await engine.stop('no-existe', 'freno');

    expect(await engine.list()).toEqual([]);
  });
});
