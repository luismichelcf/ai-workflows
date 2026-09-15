import { describe, expect, it } from 'vitest';

import { createEngine, createMemoryStore, renderStatus, renderDoctor, runCommand } from '../src/index.js';

import { chain, pipeline, reject, stage } from './helpers.js';

// The CLI is how the owner actually touches this thing, and he does not read code. So the
// seven states of the spec are a contract here, not decoration: an empty list has to say
// how to start, an error has to say what to do now, and nothing may be reported in jargon.
//
// These tests check what the command PRINTS, because that is the product.

const config = pipeline(
  chain(
    stage('spec'),
    stage('build', { gate: reject('falta el benchmark') }),
    stage('gate'),
  ),
);

describe('running a piece from the command line', () => {
  it('reports what happened in words, not in a code', async () => {
    const store = createMemoryStore();

    const output = await runCommand(['run', '997'], { config, store });

    expect(output.text).toContain('997');
    expect(output.text).toContain('falta el benchmark');
  });

  it('fails when told to run nothing', async () => {
    const store = createMemoryStore();

    const output = await runCommand(['run'], { config, store });

    expect(output.ok).toBe(false);
    expect(output.text.toLowerCase()).toContain('pieza');
  });

  it('says a piece finished when it did', async () => {
    const store = createMemoryStore();
    const easy = pipeline(chain(stage('spec')));

    const output = await runCommand(['run', '997'], { config: easy, store });

    expect(output.ok).toBe(true);
  });

  it('does not change anything when only rehearsing', async () => {
    const store = createMemoryStore();

    await runCommand(['run', '997', '--dry-run'], { config, store });

    expect(await store.loadStatus('997')).toBeUndefined();
  });

  it('passes the configured cancellation cadence to the engine', async () => {
    const inner = createMemoryStore();
    let gateActive = false;
    let pollsDuringGate = 0;
    const store: typeof inner = {
      ...inner,
      loadStatus: async (piece) => {
        if (gateActive) pollsDuringGate += 1;
        return inner.loadStatus(piece);
      },
    };
    const active = pipeline(
      chain(
        stage('qa', {
          gate: async () => {
            gateActive = true;
            await new Promise((resolve) => setTimeout(resolve, 25));
            gateActive = false;
            return { ok: true };
          },
        }),
      ),
    );

    const output = await runCommand(['run', '997'], {
      config: active,
      store,
      cancellationPollMs: 5,
    });

    expect(output.ok).toBe(true);
    expect(pollsDuringGate).toBeGreaterThan(0);
  });
});

describe('the seven states of `status`', () => {
  it('empty: says there is nothing and how to start', () => {
    const text = renderStatus([], { locale: 'es' });

    expect(text.toLowerCase()).toContain('sin piezas');
    expect(text).toContain('run');
  });

  it('one piece: shows it with its step and what comes next', () => {
    const text = renderStatus(
      [{ piece: '997', stage: 'build', state: 'blocked:rejected', reason: 'falta el benchmark' }],
      { locale: 'es' },
    );

    expect(text).toContain('997');
    expect(text).toContain('build');
    expect(text).toContain('falta el benchmark');
  });

  it('running: says which step it is in', () => {
    const text = renderStatus(
      [{ piece: '997', stage: 'qa', state: 'running', startedAt: 1 }],
      { locale: 'es' },
    );

    expect(text).toContain('qa');
  });

  it('error: says what to do now, not only what broke', () => {
    const text = renderStatus(
      [{ piece: '997', stage: 'gate', state: 'blocked:technical', reason: 'el preview no desplego' }],
      { locale: 'es' },
    );

    expect(text).toContain('el preview no desplego');
    expect(text.length).toBeGreaterThan(30);
  });

  it('many: one line per piece', () => {
    const text = renderStatus(
      [
        { piece: '997', stage: 'build', state: 'running' },
        { piece: '998', state: 'done' },
        { piece: '999', stage: 'qa', state: 'waiting:decision', reason: 'falta el visto bueno' },
      ],
      { locale: 'es' },
    );

    for (const piece of ['997', '998', '999']) {
      expect(text).toContain(piece);
    }
  });

  it('very long text: trims it instead of wrapping the screen', () => {
    const long = 'x'.repeat(500);
    const text = renderStatus(
      [{ piece: '997', stage: 'build', state: 'blocked:rejected', reason: long }],
      { locale: 'es' },
    );

    for (const line of text.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(120);
    }
  });

  it('keeps the whole reason when asked for detail', () => {
    const long = `principio ${'x'.repeat(400)} final`;
    const text = renderStatus(
      [{ piece: '997', stage: 'build', state: 'blocked:rejected', reason: long }],
      { locale: 'es', verbose: true },
    );

    expect(text).toContain('final');
  });
});

describe('the words `status` uses', () => {
  // The owner asked for plain language, and a rule that only lives in a prompt is not a
  // control. The states have internal names; what he reads must not be one of them.
  const internalNames = ['blocked:rejected', 'blocked:technical', 'waiting:decision', 'parked'];

  it('never prints an internal state name', () => {
    const text = renderStatus(
      [
        { piece: '1', stage: 'a', state: 'blocked:rejected', reason: 'r' },
        { piece: '2', stage: 'b', state: 'blocked:technical', reason: 'r' },
        { piece: '3', stage: 'c', state: 'waiting:decision', reason: 'r' },
        { piece: '4', stage: 'd', state: 'parked', reason: 'r' },
        { piece: '5', state: 'done' },
        { piece: '6', stage: 'e', state: 'running' },
      ],
      { locale: 'es' },
    );

    for (const name of internalNames) {
      expect(text).not.toContain(name);
    }
  });

  it('tells a piece waiting for the owner apart from one that failed', () => {
    const waiting = renderStatus(
      [{ piece: '1', stage: 'a', state: 'waiting:decision', reason: 'falta el visto bueno' }],
      { locale: 'es' },
    );
    const failed = renderStatus(
      [{ piece: '1', stage: 'a', state: 'blocked:rejected', reason: 'falta el benchmark' }],
      { locale: 'es' },
    );

    expect(waiting).not.toBe(failed);
  });
});

describe('checking the configuration before anything runs', () => {
  it('accepts a pipeline that makes sense', async () => {
    const store = createMemoryStore();

    const output = await runCommand(['validate'], { config, store });

    expect(output.ok).toBe(true);
  });

  it('rejects one that does not, and says which step is wrong', async () => {
    const store = createMemoryStore();
    const broken = pipeline([
      stage('spec'),
      stage('build', { after: 'revision' }),
    ]);

    const output = await runCommand(['validate'], { config: broken, store });

    expect(output.ok).toBe(false);
    expect(output.text).toContain('revision');
  });
});

describe('doctor', () => {
  it('says nothing is set up when nothing is', () => {
    const text = renderDoctor({ providers: [] }, { locale: 'es' });

    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain('undefined');
  });

  it('warns that one provider is not enough for a cross review', () => {
    const text = renderDoctor(
      { providers: [{ name: 'claude', authenticated: true, models: ['claude-opus-5'] }] },
      { locale: 'es' },
    );

    expect(text.toLowerCase()).toContain('claude');
  });

  it('tells an installed provider apart from a signed-in one', () => {
    const text = renderDoctor(
      {
        providers: [
          { name: 'claude', authenticated: true, models: ['claude-opus-5'] },
          { name: 'codex', authenticated: false, models: [] },
        ],
      },
      { locale: 'es' },
    );

    expect(text).toContain('claude');
    expect(text).toContain('codex');
  });

  it('runs the configured diagnosis from the command line', async () => {
    const store = createMemoryStore();
    let calls = 0;

    const output = await runCommand(['doctor'], {
      config,
      store,
      diagnose: async () => {
        calls += 1;
        return {
          providers: [
            { name: 'opencode', authenticated: true, models: ['deepseek/deepseek-flash'] },
            { name: 'claude', authenticated: true, models: ['claude-opus-5'] },
          ],
        };
      },
    });

    expect(output.ok).toBe(true);
    expect(output.text).toContain('opencode');
    expect(output.text).toContain('claude');
    expect(calls).toBe(1);
  });

  it('fails closed when no diagnosis was configured', async () => {
    const output = await runCommand(['doctor'], { config, store: createMemoryStore() });

    expect(output.ok).toBe(false);
    expect(output.text.toLowerCase()).toContain('diagnóstico');
  });

  it('returns a localized failure when diagnosis itself fails', async () => {
    const output = await runCommand(['doctor'], {
      config,
      store: createMemoryStore(),
      diagnose: async () => {
        throw new Error('credencial vencida');
      },
    });

    expect(output.ok).toBe(false);
    expect(output.text.toLowerCase()).toContain('diagnóstico');
    expect(output.text).toContain('credencial vencida');
  });

  it('localizes a failed diagnosis in English too', async () => {
    const output = await runCommand(['doctor'], {
      config: { ...config, locale: 'en' },
      store: createMemoryStore(),
      diagnose: async () => {
        throw new Error('expired credential');
      },
    });

    expect(output.ok).toBe(false);
    expect(output.text).toContain('diagnosis failed');
    expect(output.text).toContain('expired credential');
  });
});

describe('stopping, pausing and resuming from the command line', () => {
  it('cancels an active gate started by another engine before it can claim an effect', async () => {
    const store = createMemoryStore();
    let entered: (() => void) | undefined;
    const gateEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let sawAbort = false;
    let effects = 0;
    const active = pipeline(
      chain(
        stage('qa', {
          gate: async (context) => {
            entered?.();
            await new Promise((resolve) => setTimeout(resolve, 25));
            sawAbort = context.signal.aborted;
            if (!context.signal.aborted) {
              await context.runEffect('publish', async () => {
                effects += 1;
                return { published: true };
              });
            }
            return { ok: true };
          },
        }),
      ),
    );
    const runner = createEngine({ config: active, store, cancellationPollMs: 5 });

    const running = runner.run('997');
    await gateEntered;
    const output = await runCommand(['stop', '997', 'cambio de prioridad'], {
      config: active,
      store,
    });
    const result = await running;

    expect(output.ok).toBe(true);
    expect(sawAbort).toBe(true);
    expect(effects).toBe(0);
    expect(result.outcome).toBe('parked');
    expect((await store.loadStatus('997'))?.status.state).toBe('parked');
    expect(output.text.toLowerCase()).toContain('solicitud');
  });

  it('stops one registered piece and keeps its diagnosis', async () => {
    const store = createMemoryStore();
    await runCommand(['run', '997'], { config, store });

    const output = await runCommand(['stop', '997', 'cambio de prioridad'], { config, store });
    const saved = await store.loadStatus('997');

    expect(output.ok).toBe(true);
    expect(output.text).toContain('997');
    expect(output.text).toContain('cambio de prioridad');
    expect(saved?.status.state).toBe('parked');
    expect(saved?.status.previous).toEqual({
      state: 'blocked:rejected',
      reason: 'falta el benchmark',
    });
  });

  it('refuses to claim it stopped a piece that is not registered', async () => {
    const store = createMemoryStore();

    const output = await runCommand(['stop', 'no-existe'], { config, store });

    expect(output.ok).toBe(false);
    expect(output.text).toContain('no-existe');
    expect(await store.loadStatus('no-existe')).toBeUndefined();
  });

  it('returns a localized failure when stopping cannot be stored', async () => {
    const inner = createMemoryStore();
    await inner.saveStatus({ piece: '997', state: 'running' }, undefined);
    const store: typeof inner = {
      ...inner,
      saveStatus: async () => {
        throw new Error('almacén no disponible');
      },
    };

    const output = await runCommand(['stop', '997'], { config, store });

    expect(output.ok).toBe(false);
    expect(output.text).toContain('997');
    expect(output.text.toLowerCase()).toContain('parada');
    expect(output.text).toContain('almacén no disponible');
    expect((await inner.loadStatus('997'))?.status.state).toBe('running');
  });

  it('returns an honest failure when stop cannot read the piece', async () => {
    const inner = createMemoryStore();
    const store: typeof inner = {
      ...inner,
      loadStatus: async () => {
        throw new Error('fallo al leer la pieza');
      },
    };

    const output = await runCommand(['stop', '997'], { config, store });

    expect(output.ok).toBe(false);
    expect(output.text).toContain('997');
    expect(output.text).toContain('fallo al leer la pieza');
  });

  it('pauses every unfinished piece and leaves finished work alone', async () => {
    const store = createMemoryStore();
    const finished = pipeline(chain(stage('spec')));
    await runCommand(['run', '997'], { config, store });
    await runCommand(['run', '998'], { config, store });
    await runCommand(['run', '999'], { config: finished, store });

    const output = await runCommand(['pause'], { config, store });

    expect(output.ok).toBe(true);
    expect((await store.loadStatus('997'))?.status.state).toBe('parked');
    expect((await store.loadStatus('998'))?.status.state).toBe('parked');
    expect((await store.loadStatus('999'))?.status.state).toBe('done');
  });

  it('does not park a piece that finishes after the pause list was read', async () => {
    const inner = createMemoryStore();
    await inner.saveStatus({ piece: '997', state: 'running' }, undefined);
    let firstList = true;
    const store: typeof inner = {
      ...inner,
      listStatuses: async () => {
        const snapshot = await inner.listStatuses();
        if (firstList) {
          firstList = false;
          const current = await inner.loadStatus('997');
          await inner.saveStatus({ piece: '997', state: 'done' }, current?.version);
        }
        return snapshot;
      },
    };

    const output = await runCommand(['pause'], { config, store });

    expect(output.ok).toBe(true);
    expect((await inner.loadStatus('997'))?.status.state).toBe('done');
  });

  it('does not replace a newer explicit hold discovered after the pause list', async () => {
    const inner = createMemoryStore();
    await inner.saveStatus({ piece: '997', state: 'running' }, undefined);
    let firstList = true;
    const store: typeof inner = {
      ...inner,
      listStatuses: async () => {
        const snapshot = await inner.listStatuses();
        if (firstList) {
          firstList = false;
          const current = await inner.loadStatus('997');
          await inner.saveStatus(
            {
              piece: '997',
              state: 'parked',
              reason: 'pausa explícita más reciente',
              previous: { state: 'running' },
            },
            current?.version,
          );
        }
        return snapshot;
      },
    };

    const output = await runCommand(['pause'], { config, store });

    expect(output.ok).toBe(true);
    expect((await inner.loadStatus('997'))?.status).toMatchObject({
      state: 'parked',
      reason: 'pausa explícita más reciente',
    });
  });

  it('reports completed and failed pieces when bulk pause only partly succeeds', async () => {
    const inner = createMemoryStore();
    await inner.saveStatus({ piece: '997', state: 'running' }, undefined);
    await inner.saveStatus({ piece: '998', state: 'running' }, undefined);
    const store: typeof inner = {
      ...inner,
      saveStatus: async (status, expected) => {
        if (status.piece === '998') throw new Error('red no disponible');
        return inner.saveStatus(status, expected);
      },
    };

    const output = await runCommand(['pause'], { config, store });

    expect(output.ok).toBe(false);
    expect(output.text).toContain('997');
    expect(output.text).toContain('998');
    expect(output.text.toLowerCase()).toContain('paus');
    expect(output.text).toContain('red no disponible');
    expect((await inner.loadStatus('997'))?.status.state).toBe('parked');
    expect((await inner.loadStatus('998'))?.status.state).toBe('running');
  });

  it('reports completed pauses when the final status read fails', async () => {
    const inner = createMemoryStore();
    await inner.saveStatus({ piece: '997', state: 'running' }, undefined);
    let lists = 0;
    const store: typeof inner = {
      ...inner,
      listStatuses: async () => {
        lists += 1;
        if (lists === 2) throw new Error('fallo al leer el resultado');
        return inner.listStatuses();
      },
    };

    const output = await runCommand(['pause'], { config, store });

    expect(output.ok).toBe(false);
    expect(output.text).toContain('997');
    expect(output.text).toContain('fallo al leer el resultado');
    expect((await inner.loadStatus('997'))?.status.state).toBe('parked');
  });

  it('returns an honest failure when pause cannot read its initial snapshot', async () => {
    const inner = createMemoryStore();
    const store: typeof inner = {
      ...inner,
      listStatuses: async () => {
        throw new Error('fallo al leer las piezas');
      },
    };

    const output = await runCommand(['pause'], { config, store });

    expect(output.ok).toBe(false);
    expect(output.text).toContain('fallo al leer las piezas');
  });

  it('rejects pause operands without pausing any piece', async () => {
    const store = createMemoryStore();
    await runCommand(['run', '997'], { config, store });

    const output = await runCommand(['pause', '997'], { config, store });

    expect(output.ok).toBe(false);
    expect(output.text.toLowerCase()).toContain('argumento');
    expect((await store.loadStatus('997'))?.status.state).toBe('blocked:rejected');
  });

  it('resumes every paused piece without advancing it', async () => {
    const store = createMemoryStore();
    await runCommand(['run', '997'], { config, store });
    await runCommand(['run', '998'], { config, store });
    await runCommand(['pause'], { config, store });

    const output = await runCommand(['resume'], { config, store });

    expect(output.ok).toBe(true);
    expect((await store.loadStatus('997'))?.status.state).toBe('blocked:rejected');
    expect((await store.loadStatus('998'))?.status.state).toBe('blocked:rejected');
  });

  it('rejects an unsupported resume flag without removing any hold', async () => {
    const store = createMemoryStore();
    await runCommand(['run', '997'], { config, store });
    await runCommand(['run', '998'], { config, store });
    await runCommand(['pause'], { config, store });

    const output = await runCommand(['resume', '--help'], { config, store });

    expect(output.ok).toBe(false);
    expect(output.text.toLowerCase()).toContain('argumento');
    expect((await store.loadStatus('997'))?.status.state).toBe('parked');
    expect((await store.loadStatus('998'))?.status.state).toBe('parked');
  });

  it('rejects excess resume operands without removing any hold', async () => {
    const store = createMemoryStore();
    await runCommand(['run', '997'], { config, store });
    await runCommand(['run', '998'], { config, store });
    await runCommand(['pause'], { config, store });

    const output = await runCommand(['resume', '997', '998'], { config, store });

    expect(output.ok).toBe(false);
    expect((await store.loadStatus('997'))?.status.state).toBe('parked');
    expect((await store.loadStatus('998'))?.status.state).toBe('parked');
  });

  it('reports completed and failed pieces when bulk resume only partly succeeds', async () => {
    const inner = createMemoryStore();
    const parked = (piece: string) => ({
      piece,
      state: 'parked' as const,
      reason: 'pausa original',
      previous: { state: 'blocked:rejected' as const, reason: 'falta una corrección' },
    });
    await inner.saveStatus(parked('997'), undefined);
    await inner.saveStatus(parked('998'), undefined);
    let conflict = true;
    const store: typeof inner = {
      ...inner,
      saveStatus: async (status, expected) => {
        if (status.piece === '998' && conflict) {
          conflict = false;
          const current = await inner.loadStatus('998');
          await inner.saveStatus(
            { ...parked('998'), reason: 'pausa más reciente' },
            current?.version,
          );
        }
        return inner.saveStatus(status, expected);
      },
    };

    const output = await runCommand(['resume'], { config, store });

    expect(output.ok).toBe(false);
    expect(output.text).toContain('997');
    expect(output.text).toContain('998');
    expect(output.text.toLowerCase()).toContain('reanud');
    expect((await inner.loadStatus('997'))?.status.state).toBe('blocked:rejected');
    expect((await inner.loadStatus('998'))?.status).toMatchObject({
      state: 'parked',
      reason: 'pausa más reciente',
    });
  });

  it('reports partial progress when bulk resume hits an operational store failure', async () => {
    const inner = createMemoryStore();
    const parked = (piece: string) => ({
      piece,
      state: 'parked' as const,
      reason: 'pausa original',
      previous: { state: 'running' as const },
    });
    await inner.saveStatus(parked('997'), undefined);
    await inner.saveStatus(parked('998'), undefined);
    const store: typeof inner = {
      ...inner,
      saveStatus: async (status, expected) => {
        if (status.piece === '998') throw new Error('red no disponible');
        return inner.saveStatus(status, expected);
      },
    };

    const output = await runCommand(['resume'], { config, store });

    expect(output.ok).toBe(false);
    expect(output.text).toContain('997');
    expect(output.text).toContain('998');
    expect(output.text).toContain('red no disponible');
    expect((await inner.loadStatus('997'))?.status.state).toBe('running');
    expect((await inner.loadStatus('998'))?.status.state).toBe('parked');
  });

  it('reports completed resumes when the final status read fails', async () => {
    const inner = createMemoryStore();
    await inner.saveStatus(
      {
        piece: '997',
        state: 'parked',
        reason: 'pausa original',
        previous: { state: 'running' },
      },
      undefined,
    );
    let lists = 0;
    const store: typeof inner = {
      ...inner,
      listStatuses: async () => {
        lists += 1;
        if (lists === 2) throw new Error('fallo al leer el resultado');
        return inner.listStatuses();
      },
    };

    const output = await runCommand(['resume'], { config, store });

    expect(output.ok).toBe(false);
    expect(output.text).toContain('997');
    expect(output.text).toContain('fallo al leer el resultado');
    expect((await inner.loadStatus('997'))?.status.state).toBe('running');
  });

  it('returns honest failures when resume cannot read its initial state', async () => {
    const makeStore = () => {
      const inner = createMemoryStore();
      const store: typeof inner = {
        ...inner,
        loadStatus: async () => {
          throw new Error('fallo al leer la pieza');
        },
        listStatuses: async () => {
          throw new Error('fallo al leer las piezas');
        },
      };
      return store;
    };

    const bulk = await runCommand(['resume'], { config, store: makeStore() });
    const named = await runCommand(['resume', '997'], { config, store: makeStore() });

    expect(bulk.ok).toBe(false);
    expect(bulk.text).toContain('fallo al leer las piezas');
    expect(named.ok).toBe(false);
    expect(named.text).toContain('997');
    expect(named.text).toContain('fallo al leer la pieza');
  });

  it('resumes only the named piece when one is provided', async () => {
    const store = createMemoryStore();
    await runCommand(['run', '997'], { config, store });
    await runCommand(['run', '998'], { config, store });
    await runCommand(['pause'], { config, store });

    const output = await runCommand(['resume', '997'], { config, store });

    expect(output.ok).toBe(true);
    expect((await store.loadStatus('997'))?.status.state).toBe('blocked:rejected');
    expect((await store.loadStatus('998'))?.status.state).toBe('parked');
  });

  it('reports a named resume when its final status read fails', async () => {
    const inner = createMemoryStore();
    await inner.saveStatus(
      {
        piece: '997',
        state: 'parked',
        reason: 'pausa original',
        previous: { state: 'running' },
      },
      undefined,
    );
    const store: typeof inner = {
      ...inner,
      listStatuses: async () => {
        throw new Error('fallo al leer el resultado');
      },
    };

    const output = await runCommand(['resume', '997'], { config, store });

    expect(output.ok).toBe(false);
    expect(output.text).toContain('997');
    expect(output.text).toContain('fallo al leer el resultado');
    expect((await inner.loadStatus('997'))?.status.state).toBe('running');
  });

  it('does not claim it resumed a named piece that was already done', async () => {
    const inner = createMemoryStore();
    await inner.saveStatus({ piece: '997', state: 'done' }, undefined);
    const store: typeof inner = {
      ...inner,
      listStatuses: async () => {
        throw new Error('fallo al leer el resultado');
      },
    };

    const output = await runCommand(['resume', '997'], { config, store });

    expect(output.ok).toBe(false);
    expect(output.text).toContain('997');
    expect(output.text).toContain('terminada');
    expect(output.text).not.toContain('Ya reanudadas');
    expect((await inner.loadStatus('997'))?.status.state).toBe('done');
  });

  it('reports a conflict without replacing a newer hold on named resume', async () => {
    const inner = createMemoryStore();
    await inner.saveStatus(
      {
        piece: '997',
        state: 'parked',
        reason: 'pausa original',
        previous: { state: 'blocked:rejected', reason: 'falta una corrección' },
      },
      undefined,
    );
    let conflict = true;
    const store: typeof inner = {
      ...inner,
      saveStatus: async (status, expected) => {
        if (conflict) {
          conflict = false;
          const current = await inner.loadStatus('997');
          await inner.saveStatus(
            {
              piece: '997',
              state: 'parked',
              reason: 'pausa más reciente',
              previous: { state: 'blocked:rejected', reason: 'falta una corrección' },
            },
            current?.version,
          );
        }
        return inner.saveStatus(status, expected);
      },
    };

    const output = await runCommand(['resume', '997'], { config, store });

    expect(output.ok).toBe(false);
    expect(output.text).toContain('997');
    expect(output.text.toLowerCase()).toContain('reanud');
    expect((await inner.loadStatus('997'))?.status).toMatchObject({
      state: 'parked',
      reason: 'pausa más reciente',
    });
  });
});

describe('an unknown command', () => {
  it('says what it does know instead of failing silently', async () => {
    const store = createMemoryStore();

    const output = await runCommand(['inventado'], { config, store });

    expect(output.ok).toBe(false);
    expect(output.text).toContain('run');
    expect(output.text).toContain('status');
  });

  it('with no command at all, shows the help', async () => {
    const store = createMemoryStore();

    const output = await runCommand([], { config, store });

    expect(output.text).toContain('run');
  });
});
