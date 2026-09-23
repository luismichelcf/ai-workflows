import { afterEach, describe, expect, it } from 'vitest';

import { passed, refused, runBlock } from './block-harness.js';
import { commit, git, removeRepositories, repository, write } from './git-fixtures.js';

// PLAN-13-R2 §3.1 and §3.2: two structure blocks. They check the shape of documents — never
// their truth — with every title, path and threshold coming from `with:`, so nothing of any
// project lives in the engine. Each refusal lists everything missing at once.

afterEach(removeRepositories);

function projectWith(files: Readonly<Record<string, string>>): string {
  const root = repository();
  for (const [file, content] of Object.entries(files)) write(root, file, content);
  commit(root, 'project');
  return root;
}

// ---------------------------------------------------------------------------------------
// spec-structure@1
// ---------------------------------------------------------------------------------------

const SPEC_STAGE = [
  '    nature: structure',
  '    gate:',
  '      uses: ai-workflows/spec-structure@1',
  '      with:',
  '        file: "docs/plans/PLAN-{piece}.md"',
  '        sections: ["En tres líneas", "Casos de aceptación", "Decisiones"]',
  '        summary: { section: "En tres líneas", labels: ["Qué pasa hoy", "Qué cambia", "Por qué importa"] }',
  '        criteria: { section: "Casos de aceptación", id-prefix: "CA-", words: ["Dado", "Cuando", "Entonces"] }',
  '        decisions: { section: "Decisiones" }',
];

const GOOD_SPEC = [
  '# Plan 42',
  '',
  '## En tres líneas',
  '',
  '**Qué pasa hoy:** algo. **Qué cambia:** otra cosa. **Por qué importa:** porque sí.',
  '',
  '## Casos de aceptación',
  '',
  '- CA-01 Dado un recibo, cuando se cierra, entonces se guarda.',
  '- CA-02 Dado un error, cuando se reintenta, entonces avisa.',
  '',
  '## Decisiones',
  '',
  '- El dueño eligió el color azul.',
  '',
].join('\n');

describe('§3.1 spec-structure@1', () => {
  it('positive: a complete plan passes and its fingerprint is kept', async () => {
    const root = projectWith({ 'docs/plans/PLAN-42.md': GOOD_SPEC });
    const result = await runBlock(root, SPEC_STAGE);
    expect(result.outcome).toMatchObject(passed);
    expect(result.entry?.evidence).toMatchObject({
      block: { file: 'docs/plans/PLAN-42.md', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
  });

  it('refuses when the plan does not exist, naming the file it looked for', async () => {
    const root = projectWith({});
    expect((await runBlock(root, SPEC_STAGE)).outcome).toMatchObject(refused(/docs\/plans\/PLAN-42\.md/));
  });

  it('lists every problem at once', async () => {
    const spec = [
      '## En tres líneas',
      '',
      '**Qué pasa hoy:** algo. **Por qué importa:** porque sí.',
      '',
      '## Casos de aceptación',
      '',
      '- CA-01 Dado un recibo, entonces se guarda.',
      '',
      '## Decisiones',
      '',
      '- [ ] el dueño elige el color',
      '',
    ].join('\n');
    const root = projectWith({ 'docs/plans/PLAN-42.md': spec });
    const result = await runBlock(root, SPEC_STAGE);
    const reason = (result.outcome as { status: { reason: string } }).status.reason;
    expect(result.outcome).toMatchObject(refused(/./));
    expect(reason).toContain('«Qué cambia»');
    expect(reason).toContain('«CA-01»');
    expect(reason).toContain('«Cuando»');
    expect(reason).toContain('el dueño elige el color');
  });

  it('refuses a criteria section without any identified criterion', async () => {
    const root = projectWith({ 'docs/plans/PLAN-42.md': GOOD_SPEC.replace(/CA-0(\d)/g, 'Caso $1') });
    expect((await runBlock(root, SPEC_STAGE)).outcome).toMatchObject(refused(/«CA-»/));
  });

  it('refuses a required section that is only a title', async () => {
    const root = projectWith({ 'docs/plans/PLAN-42.md': GOOD_SPEC.replace('- El dueño eligió el color azul.\n', '') });
    expect((await runBlock(root, SPEC_STAGE)).outcome).toMatchObject(refused(/«Decisiones»/));
  });

  it('matches titles and labels without caring about accents or case', async () => {
    const plain = GOOD_SPEC.replace('## En tres líneas', '## en tres lineas').replace('**Qué cambia:**', '**que CAMBIA:**');
    const root = projectWith({ 'docs/plans/PLAN-42.md': plain });
    expect((await runBlock(root, SPEC_STAGE)).outcome).toMatchObject(passed);
  });
});

// ---------------------------------------------------------------------------------------
// benchmark-sources@1
// ---------------------------------------------------------------------------------------

const link = (url: string) => `- [fuente](${url})`;

const benchmark = (psa: string[], others: string[], extra = '') =>
  [
    '# Benchmark 42',
    '',
    '## Fuera de PSA',
    '',
    ...others.map(link),
    '',
    '## PSA',
    '',
    ...psa.map(link),
    '',
    extra,
  ].join('\n');

const FIVE = ['https://productive.io/a', 'https://scoro.com/b', 'https://runn.io/c', 'https://ruddr.io/d', 'https://forecast.app/e'];
const TWO = ['https://linear.app/x', 'https://notion.so/y'];

const BENCH_STAGE = (...extra: string[]) => [
  '    nature: structure',
  '    gate:',
  '      uses: ai-workflows/benchmark-sources@1',
  '      with:',
  '        files: ["docs/research/{piece}-*.md"]',
  '        categories: [{ heading: "Fuera de PSA", min: 2 }, { heading: "PSA", min: 5 }]',
  ...extra.map((row) => `        ${row}`),
];

describe('CN-01 · advancing without the benchmark, through benchmark-sources@1', () => {
  it('refuses when there is no benchmark document, naming where it looked', async () => {
    const root = projectWith({});
    expect((await runBlock(root, BENCH_STAGE())).outcome).toMatchObject(refused(/docs\/research\/42-\*\.md/));
  });

  it('refuses a category with too few distinct providers, counting the providers', async () => {
    const same = ['https://productive.io/a', 'https://productive.io/b', 'https://docs.productive.io/c', 'https://scoro.com/d', 'https://runn.io/e'];
    const root = projectWith({ 'docs/research/42-benchmark.md': benchmark(same, TWO) });
    expect((await runBlock(root, BENCH_STAGE())).outcome).toMatchObject(refused(/«PSA» tiene 3 proveedores distintos y hacen falta al menos 5/));
  });

  it('refuses when a category section is missing', async () => {
    const onlyPsa = ['# B', '', '## PSA', '', ...FIVE.map(link), ''].join('\n');
    const root = projectWith({ 'docs/research/42-benchmark.md': onlyPsa });
    expect((await runBlock(root, BENCH_STAGE())).outcome).toMatchObject(refused(/falta la sección «Fuera de PSA»/i));
  });

  it('positive control: a real benchmark passes and says what it counted', async () => {
    const root = projectWith({ 'docs/research/42-benchmark.md': benchmark(FIVE, TWO) });
    const result = await runBlock(root, BENCH_STAGE());
    expect(result.outcome).toMatchObject(passed);
    expect(result.entry?.evidence).toMatchObject({
      block: { file: 'docs/research/42-benchmark.md', counts: { 'Fuera de PSA': 2, PSA: 5 } },
    });
  });

  it('the first document that meets the rules wins', async () => {
    const root = projectWith({
      'docs/research/42-a-borrador.md': benchmark(FIVE.slice(0, 2), TWO),
      'docs/research/42-b-final.md': benchmark(FIVE, TWO),
    });
    const result = await runBlock(root, BENCH_STAGE());
    expect(result.outcome).toMatchObject(passed);
    expect(result.entry?.evidence).toMatchObject({ block: { file: 'docs/research/42-b-final.md' } });
  });

  it('requires the sections the recipe lists', async () => {
    const root = projectWith({ 'docs/research/42-benchmark.md': benchmark(FIVE, TWO, '## Evidencia\n\nhay datos\n') });
    const result = await runBlock(root, BENCH_STAGE('sections: ["Evidencia", "Inferencia", "Ausencia"]'));
    expect(result.outcome).toMatchObject(refused(/«Inferencia», «Ausencia»/));
  });

  it('enforces a minimum over all categories together', async () => {
    const root = projectWith({ 'docs/research/42-benchmark.md': benchmark(FIVE, TWO) });
    const result = await runBlock(root, BENCH_STAGE('min-total: 9'));
    expect(result.outcome).toMatchObject(refused(/7 proveedores distintos en total y hacen falta al menos 9/));
  });

  it('a written waiver with its motive skips the stage with that motive, never passes it', async () => {
    const root = projectWith({ 'docs/plans/PLAN-42.md': '# Plan\n\nBenchmark: no aplica — es un cambio de texto interno\n' });
    const result = await runBlock(root, BENCH_STAGE('waiver: "Benchmark: no aplica"', 'spec: "docs/plans/PLAN-{piece}.md"'));
    expect(result.outcome).toMatchObject(passed);
    expect(result.entry).toMatchObject({ outcome: 'skipped', reason: 'es un cambio de texto interno' });
  });

  it('a waiver without a motive is no waiver', async () => {
    const root = projectWith({ 'docs/plans/PLAN-42.md': '# Plan\n\nBenchmark: no aplica —\n' });
    const result = await runBlock(root, BENCH_STAGE('waiver: "Benchmark: no aplica"', 'spec: "docs/plans/PLAN-{piece}.md"'));
    expect(result.outcome).toMatchObject(refused(/docs\/research\/42-\*\.md/));
  });

  it('with check-reachable, a source that does not answer is refused by name', async () => {
    // `.invalid` never resolves (RFC 2606), so this needs no network and cannot flake.
    const root = projectWith({
      'docs/research/42-benchmark.md': benchmark(['https://nonexistent-aiw13.invalid/x'], ['https://also-missing-aiw13.invalid/y']),
    });
    const stage = BENCH_STAGE('check-reachable: true').map((row) =>
      row.includes('categories:') ? '        categories: [{ heading: "Fuera de PSA", min: 1 }, { heading: "PSA", min: 1 }]' : row,
    );
    const result = await runBlock(root, stage);
    expect(result.outcome).toMatchObject(refused(/aiw13\.invalid/));
  }, 60_000);

  it('reads the document of the change, not one left out of the repository', async () => {
    const root = projectWith({ 'docs/research/42-benchmark.md': benchmark(FIVE, TWO) });
    git(root, 'rm', '-q', 'docs/research/42-benchmark.md');
    git(root, 'commit', '-q', '-m', 'removed');
    expect((await runBlock(root, BENCH_STAGE())).outcome).toMatchObject(refused(/docs\/research\/42-\*\.md/));
  });
});


describe('review round 1: a required decisions section that is missing is a problem, not a pass', () => {
  it('names the missing section', async () => {
    const root = projectWith({ 'docs/plans/PLAN-42.md': GOOD_SPEC.replace(/## Decisiones[\s\S]*$/, '') });
    const stage = SPEC_STAGE.map((row) => (row.includes('sections:') ? '        sections: ["En tres líneas", "Casos de aceptación"]' : row));
    expect((await runBlock(root, stage)).outcome).toMatchObject(refused(/«Decisiones»/));
  });
});
