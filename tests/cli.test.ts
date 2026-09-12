import { describe, expect, it } from 'vitest';

import { createMemoryStore, renderStatus, renderDoctor, runCommand } from '../src/index.js';

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
