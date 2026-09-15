import { describe, expect, it } from 'vitest';

import { createEngine, createMemoryStore } from '../src/index.js';

import { chain, fail, harness, pipeline, recorder, reject, stage } from './helpers.js';

// §5.4 and §5.6. The engine's reason to exist: a stage advances ONLY if its gate says so,
// and a gate that could not run is not the same as a gate that said no.
//   gate returns {ok:false}   -> blocked:rejected   (the content is wrong)
//   gate throws               -> blocked:technical  (the check could not run)
//   needsHuman and says no    -> waiting:decision   (nothing is wrong; it is pending)

describe('running a piece', () => {
  it('runs every stage in order when all gates pass', async () => {
    const seen = recorder();
    const { engine } = harness(
      chain(
        stage('spec', { gate: seen.gateFor('spec') }),
        stage('build', { gate: seen.gateFor('build') }),
        stage('gate', { gate: seen.gateFor('gate') }),
      ),
    );

    const result = await engine.run('997');

    expect(seen.seen).toEqual(['spec', 'build', 'gate']);
    expect(result.outcome === 'ran' && result.status.state).toBe('done');
  });

  it('stops at the failing stage and does not run the next one', async () => {
    const seen = recorder();
    const { engine } = harness(
      chain(
        stage('spec', { gate: seen.gateFor('spec') }),
        stage('build', { gate: seen.gateFor('build', reject('falta el benchmark')) }),
        stage('gate', { gate: seen.gateFor('gate') }),
      ),
    );

    const result = await engine.run('997');

    expect(seen.seen).toEqual(['spec', 'build']);
    expect(result.outcome === 'ran' && result.status.stage).toBe('build');
    expect(result.outcome === 'ran' && result.status.state).toBe('blocked:rejected');
  });

  it('reports the reason the gate gave, word for word', async () => {
    const { engine } = harness(chain(stage('build', { gate: reject('falta el benchmark') })));

    const result = await engine.run('997');

    expect(result.outcome === 'ran' && result.status.reason).toContain('falta el benchmark');
  });

  it('distinguishes a gate that could not run from a gate that said no', async () => {
    const { engine } = harness(
      chain(stage('gate', { gate: fail('el preview no desplego') })),
    );

    const result = await engine.run('997');

    expect(result.outcome === 'ran' && result.status.state).toBe('blocked:technical');
    expect(result.outcome === 'ran' && result.status.reason).toContain('el preview no desplego');
  });

  it('keeps a reason on a technical block too', async () => {
    const { engine } = harness(chain(stage('gate', { gate: fail('sin cuota') })));

    const result = await engine.run('997');

    expect(result.outcome === 'ran' && (result.status.reason ?? '')).not.toBe('');
  });

  it('waits instead of failing when a stage needs a person', async () => {
    const seen = recorder();
    const { engine } = harness(
      chain(
        stage('qa', { gate: seen.gateFor('qa') }),
        stage('sign-off', {
          needsHuman: true,
          nature: 'attest',
          gate: seen.gateFor('sign-off', reject('sin visto bueno')),
        }),
        stage('queue', { gate: seen.gateFor('queue') }),
      ),
    );

    const result = await engine.run('997');

    expect(result.outcome === 'ran' && result.status.state).toBe('waiting:decision');
    expect(seen.seen).toEqual(['qa', 'sign-off']);
  });
});

describe('two controllers', () => {
  it('tells the loser it did not run, instead of inventing a status', async () => {
    // The slice-1 engine returned a fabricated `running` that `status()` then denied.
    const store = createMemoryStore();
    await store.reserve('997', 'someone-else', 30_000);
    const { engine } = harness(chain(stage('spec')), { store, runId: 'mine' });

    const result = await engine.run('997');

    expect(result.outcome).toBe('busy');
    expect(result.outcome === 'busy' && result.heldBy).toBe('someone-else');
  });

  it('does not touch the stored state when it loses the race', async () => {
    const store = createMemoryStore();
    await store.reserve('997', 'someone-else', 30_000);
    const { engine } = harness(chain(stage('spec')), { store, runId: 'mine' });

    await engine.run('997');

    expect(await store.loadStatus('997')).toBeUndefined();
  });

  it('does not run a single gate when it loses the race', async () => {
    const seen = recorder();
    const store = createMemoryStore();
    await store.reserve('997', 'someone-else', 30_000);
    const { engine } = harness(chain(stage('spec', { gate: seen.gateFor('spec') })), {
      store,
      runId: 'mine',
    });

    await engine.run('997');

    expect(seen.seen).toEqual([]);
  });

  it('releases the piece when it finishes, so the next controller can take it', async () => {
    const store = createMemoryStore();
    const { engine } = harness(chain(stage('spec')), { store, runId: 'mine' });

    await engine.run('997');

    expect((await store.reserve('997', 'other', 30_000)).ok).toBe(true);
  });

  it('releases the piece even when a gate blew up', async () => {
    const store = createMemoryStore();
    const { engine } = harness(chain(stage('spec', { gate: fail('trueno') })), {
      store,
      runId: 'mine',
    });

    await engine.run('997');

    expect((await store.reserve('997', 'other', 30_000)).ok).toBe(true);
  });
});

describe('stopping a piece', () => {
  it('parks it, keeping the reason', async () => {
    const { engine } = harness(
      chain(stage('spec', { gate: reject('aun no') }), stage('build')),
    );
    await engine.run('997');

    const parked = await engine.stop('997', 'el dueno lo detuvo');

    expect(parked.state).toBe('parked');
    expect(parked.reason).toContain('el dueno lo detuvo');
  });

  it('does not advance a parked piece on the next run', async () => {
    // The piece has to exist before it can be parked: parking one the store has never seen
    // used to invent it, and the owner decided (12-sep) that it should say it does not
    // exist instead. So this starts the piece, parks it, and checks it stays put.
    const seen = recorder();
    const { engine } = harness(
      chain(
        stage('spec', { gate: seen.gateFor('spec', reject('aun no')) }),
        stage('build', { gate: seen.gateFor('build') }),
      ),
    );
    await engine.run('997');
    seen.seen.length = 0;
    await engine.stop('997', 'el dueno lo detuvo');

    const result = await engine.run('997');

    expect(result.outcome).toBe('parked');
    expect(seen.seen).toEqual([]);
  });

  it('keeps what the piece was before it was parked', async () => {
    const { engine } = harness(chain(stage('build', { gate: reject('falta el benchmark') })));
    await engine.run('997');

    const parked = await engine.stop('997', 'lo dejamos para manana');

    expect(parked.previous?.state).toBe('blocked:rejected');
    expect(parked.previous?.reason).toContain('falta el benchmark');
  });

  it('stops a run that is already in flight, instead of being overwritten by it', async () => {
    // The owner stopped the piece, was told it was parked, and the slow stage finished and
    // wrote `done` on top. A stop that does not stop is worse than no stop at all.
    const store = createMemoryStore();
    let release: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen = recorder();
    const { engine } = harness(
      chain(
        stage('qa', {
          gate: async () => {
            await slow;
            return { ok: true };
          },
        }),
        stage('queue', { gate: seen.gateFor('queue') }),
      ),
      { store },
    );

    const running = engine.run('997');
    const parked = await engine.stop('997', 'el dueno lo detuvo');
    release?.();
    await running;

    expect(parked.state).toBe('parked');
    expect(seen.seen).toEqual([]);
    expect((await engine.status('997'))?.state).toBe('parked');
  });

  it('does not abort an active run when the stop could not be stored', async () => {
    const inner = createMemoryStore();
    let entered: (() => void) | undefined;
    const gateEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let sawAbort = false;
    const store: typeof inner = {
      ...inner,
      saveStatus: async (status, expected) => {
        if (status.state === 'parked') throw new Error('almacén no disponible');
        return inner.saveStatus(status, expected);
      },
    };
    const { engine } = harness(
      chain(
        stage('qa', {
          gate: async (context) => {
            entered?.();
            await new Promise((resolve) => setTimeout(resolve, 25));
            sawAbort = context.signal.aborted;
            return { ok: true };
          },
        }),
      ),
      { store },
    );

    const running = engine.run('997');
    await gateEntered;
    await expect(engine.stop('997', 'el dueño lo detuvo')).rejects.toThrow('almacén no disponible');
    const result = await running;

    expect(sawAbort).toBe(false);
    expect(result.outcome === 'ran' && result.status.state).toBe('done');
    expect((await inner.loadStatus('997'))?.status.state).toBe('done');
  });

  it('ignores a parked response from a watcher after that stage has ended', async () => {
    const inner = createMemoryStore();
    let delayParkedRead = false;
    let parkedReadSeen: (() => void) | undefined;
    const parkedReadCaptured = new Promise<void>((resolve) => {
      parkedReadSeen = resolve;
    });
    let releaseParkedRead: (() => void) | undefined;
    const parkedReadHeld = new Promise<void>((resolve) => {
      releaseParkedRead = resolve;
    });
    const store: typeof inner = {
      ...inner,
      loadStatus: async (piece) => {
        const current = await inner.loadStatus(piece);
        if (delayParkedRead && current?.status.state === 'parked') {
          delayParkedRead = false;
          parkedReadSeen?.();
          await parkedReadHeld;
        }
        return current;
      },
    };
    let releaseFirst: (() => void) | undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered: (() => void) | undefined;
    const firstGateEntered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let releaseSecond: (() => void) | undefined;
    const secondHeld = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let secondEntered: (() => void) | undefined;
    const secondGateEntered = new Promise<void>((resolve) => {
      secondEntered = resolve;
    });
    const config = pipeline(
      chain(
        stage('first', {
          gate: async () => {
            firstEntered?.();
            await firstHeld;
            return { ok: true };
          },
        }),
        stage('second', {
          gate: async () => {
            secondEntered?.();
            await secondHeld;
            return { ok: true };
          },
        }),
      ),
    );
    const runner = createEngine({ config, store, cancellationPollMs: 5 });
    const controller = createEngine({ config, store });

    const running = runner.run('997');
    await firstGateEntered;
    delayParkedRead = true;
    await controller.stop('997', 'pausa breve');
    await parkedReadCaptured;
    await controller.resume('997');
    releaseFirst?.();
    await secondGateEntered;
    releaseParkedRead?.();
    await Promise.resolve();
    releaseSecond?.();
    const result = await running;

    expect(result.outcome === 'ran' && result.status.state).toBe('done');
    expect((await inner.loadStatus('997'))?.status.state).toBe('done');
  });

  it('does not turn an effect refused by a brief park into a technical failure', async () => {
    const inner = createMemoryStore();
    let releaseEffect: (() => void) | undefined;
    const effectHeld = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    let effectRequested: (() => void) | undefined;
    const effectRequestReady = new Promise<void>((resolve) => {
      effectRequested = resolve;
    });
    let refused: (() => void) | undefined;
    const refusalCaptured = new Promise<void>((resolve) => {
      refused = resolve;
    });
    let releaseRefusal: (() => void) | undefined;
    const refusalHeld = new Promise<void>((resolve) => {
      releaseRefusal = resolve;
    });
    const store: typeof inner = {
      ...inner,
      runEffect: async (piece, operationId, effect) => {
        try {
          return await inner.runEffect(piece, operationId, effect);
        } catch (error) {
          refused?.();
          await refusalHeld;
          throw error;
        }
      },
    };
    const config = pipeline(
      chain(
        stage('publish', {
          gate: async (context) => {
            effectRequested?.();
            await effectHeld;
            await context.runEffect('open-pr', async () => ({ pr: 1234 }));
            return { ok: true };
          },
        }),
      ),
    );
    const runner = createEngine({ config, store, cancellationPollMs: 1_000 });
    const controller = createEngine({ config, store });

    const running = runner.run('997');
    await effectRequestReady;
    await controller.stop('997', 'pausa breve');
    releaseEffect?.();
    await refusalCaptured;
    await controller.resume('997');
    releaseRefusal?.();
    const result = await running;

    expect(result.outcome === 'ran' && result.status.state).toBe('running');
    expect((await inner.loadStatus('997'))?.status.state).toBe('running');
    expect((await inner.journal('997')).some((entry) => entry.outcome === 'failed')).toBe(false);
  });

  it('does not overwrite a resumed piece when confirming effect cancellation cannot read', async () => {
    const inner = createMemoryStore();
    let failNextRead = false;
    let releaseEffect: (() => void) | undefined;
    const effectHeld = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    let effectRequested: (() => void) | undefined;
    const effectRequestReady = new Promise<void>((resolve) => {
      effectRequested = resolve;
    });
    let refused: (() => void) | undefined;
    const refusalCaptured = new Promise<void>((resolve) => {
      refused = resolve;
    });
    let releaseRefusal: (() => void) | undefined;
    const refusalHeld = new Promise<void>((resolve) => {
      releaseRefusal = resolve;
    });
    const store: typeof inner = {
      ...inner,
      loadStatus: async (piece) => {
        if (failNextRead) {
          failNextRead = false;
          throw new Error('lectura temporalmente no disponible');
        }
        return inner.loadStatus(piece);
      },
      runEffect: async (piece, operationId, effect) => {
        try {
          return await inner.runEffect(piece, operationId, effect);
        } catch (error) {
          refused?.();
          await refusalHeld;
          throw error;
        }
      },
    };
    const config = pipeline(
      chain(
        stage('publish', {
          gate: async (context) => {
            effectRequested?.();
            await effectHeld;
            await context.runEffect('open-pr', async () => ({ pr: 1234 }));
            return { ok: true };
          },
        }),
      ),
    );
    const runner = createEngine({ config, store, cancellationPollMs: 1_000 });
    const controller = createEngine({ config, store });

    const running = runner.run('997');
    await effectRequestReady;
    await controller.stop('997', 'pausa breve');
    releaseEffect?.();
    await refusalCaptured;
    await controller.resume('997');
    failNextRead = true;
    releaseRefusal?.();
    const result = await running;

    expect(result.outcome === 'ran' && result.status.state).toBe('blocked:technical');
    expect((await inner.loadStatus('997'))?.status.state).toBe('running');
    expect((await inner.journal('997')).some((entry) => entry.outcome === 'failed')).toBe(false);
  });

  it('treats an effect refused inside appliesWhen as cancellation', async () => {
    const inner = createMemoryStore();
    await inner.saveStatus({ piece: '997', state: 'running' }, undefined);
    let releaseEffect: (() => void) | undefined;
    const effectHeld = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    let callbackEntered: (() => void) | undefined;
    const appliesWhenEntered = new Promise<void>((resolve) => {
      callbackEntered = resolve;
    });
    let refused: (() => void) | undefined;
    const refusalCaptured = new Promise<void>((resolve) => {
      refused = resolve;
    });
    let releaseRefusal: (() => void) | undefined;
    const refusalHeld = new Promise<void>((resolve) => {
      releaseRefusal = resolve;
    });
    const store: typeof inner = {
      ...inner,
      runEffect: async (piece, operationId, effect) => {
        try {
          return await inner.runEffect(piece, operationId, effect);
        } catch (error) {
          refused?.();
          await refusalHeld;
          throw error;
        }
      },
    };
    const config = pipeline(
      chain(
        stage('publish', {
          appliesWhen: async (context) => {
            callbackEntered?.();
            await effectHeld;
            await context.runEffect('inspect', async () => ({ applies: true }));
            return true;
          },
        }),
      ),
    );
    const runner = createEngine({ config, store, cancellationPollMs: 1_000 });
    const controller = createEngine({ config, store });

    const running = runner.run('997');
    await appliesWhenEntered;
    await controller.stop('997', 'pausa breve');
    releaseEffect?.();
    await refusalCaptured;
    await controller.resume('997');
    releaseRefusal?.();
    const result = await running;

    expect(result.outcome === 'ran' && result.status.state).toBe('running');
    expect((await inner.loadStatus('997'))?.status.state).toBe('running');
    expect((await inner.journal('997')).some((entry) => entry.outcome === 'failed')).toBe(false);
  });

  it('treats an effect refused inside stillValid as cancellation', async () => {
    const inner = createMemoryStore();
    const initial = pipeline(chain(stage('publish')));
    await createEngine({ config: initial, store: inner }).run('997');
    let releaseEffect: (() => void) | undefined;
    const effectHeld = new Promise<void>((resolve) => {
      releaseEffect = resolve;
    });
    let callbackEntered: (() => void) | undefined;
    const stillValidEntered = new Promise<void>((resolve) => {
      callbackEntered = resolve;
    });
    let refused: (() => void) | undefined;
    const refusalCaptured = new Promise<void>((resolve) => {
      refused = resolve;
    });
    let releaseRefusal: (() => void) | undefined;
    const refusalHeld = new Promise<void>((resolve) => {
      releaseRefusal = resolve;
    });
    const store: typeof inner = {
      ...inner,
      runEffect: async (piece, operationId, effect) => {
        try {
          return await inner.runEffect(piece, operationId, effect);
        } catch (error) {
          refused?.();
          await refusalHeld;
          throw error;
        }
      },
    };
    const config = pipeline(
      chain(
        stage('publish', {
          stillValid: async (_entry, context) => {
            callbackEntered?.();
            await effectHeld;
            await context.runEffect('inspect', async () => ({ valid: true }));
            return true;
          },
        }),
      ),
    );
    const runner = createEngine({ config, store, cancellationPollMs: 1_000 });
    const controller = createEngine({ config, store });

    const running = runner.run('997');
    await stillValidEntered;
    await controller.stop('997', 'pausa breve');
    releaseEffect?.();
    await refusalCaptured;
    await controller.resume('997');
    releaseRefusal?.();
    const result = await running;

    expect(result.outcome === 'ran' && result.status.state).toBe('done');
    expect((await inner.loadStatus('997'))?.status.state).toBe('done');
    expect((await inner.journal('997')).some((entry) => entry.outcome === 'failed')).toBe(false);
  });

  it('lets the piece move again once it is resumed', async () => {
    const seen = recorder();
    const { engine } = harness(chain(stage('spec', { gate: seen.gateFor('spec') })));
    await engine.stop('997', 'pausa');

    await engine.resume('997');
    await engine.run('997');

    expect(seen.seen).toEqual(['spec']);
  });
});

describe('reporting', () => {
  it('reports nothing for a piece that never ran', async () => {
    const { engine } = harness(chain(stage('spec')));

    expect(await engine.status('997')).toBeUndefined();
  });

  it('reports the stage and state the piece stopped at', async () => {
    const { engine } = harness(chain(stage('build', { gate: reject('falta el benchmark') })));

    await engine.run('997');
    const status = await engine.status('997');

    expect(status?.stage).toBe('build');
    expect(status?.state).toBe('blocked:rejected');
  });

  it('lists every piece it has seen', async () => {
    const { engine } = harness(chain(stage('spec')));
    await engine.run('997');
    await engine.run('998');

    expect((await engine.list()).map((status) => status.piece).sort()).toEqual(['997', '998']);
  });
});

describe('an invalid pipeline', () => {
  it('refuses to build an engine at all', () => {
    const store = createMemoryStore();

    expect(() => createEngine({ config: pipeline([]), store })).toThrow();
  });

  it('says what is wrong in a way a caller can render', () => {
    const store = createMemoryStore();

    try {
      createEngine({ config: pipeline([]), store });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { errors?: readonly string[] }).errors?.length).toBeGreaterThan(0);
    }
  });
});

describe('cancellation polling', () => {
  it('rejects intervals that Node timers cannot represent faithfully', () => {
    const config = pipeline(chain(stage('spec')));

    for (const cancellationPollMs of [0.5, 2 ** 31]) {
      expect(() =>
        createEngine({ config, store: createMemoryStore(), cancellationPollMs }),
      ).toThrow();
    }
  });
});
