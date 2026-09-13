import { describe, expect, it } from 'vitest';

import { DEFAULT_STATE_REF, createGitHubStatePort, type GhRun } from '../src/index.js';

// The GitHub side of the git-backed store (ai-workflows#6). Probed against GitHub on 13-sep-2026:
//   - REST `PATCH git/refs` does NOT compare on refs outside refs/heads: a stale write overwrote a
//     newer commit, even 5 s later. Only GraphQL `updateRefs` with `beforeOid` refuses it.
//   - That refusal comes back as a generic «Something went wrong», so after any updateRefs error
//     the port re-reads the ref to tell a lost race from a landed write from a real failure.
//   - `POST git/refs` answers 422 «Reference already exists», which makes creating the ref safe.
// Request bodies travel as JSON on stdin (`--input -`), so these fakes read them from there.

const OWNER = 'luismichelcf';
const REPO = 'ai-workflows';
const BASE = `repos/${OWNER}/${REPO}`;
const HEAD_ENDPOINTS = [`${BASE}/git/ref/ai-workflows/state`, `${BASE}/git/refs/ai-workflows/state`];
const GENERIC = 'Something went wrong while executing your query on 2026-09-13T20:55:20Z.';

interface Call {
  readonly args: readonly string[];
  readonly endpoint: string;
  readonly method: string;
  readonly body: Record<string, unknown> | undefined;
  readonly input: string | undefined;
}

const ok = (value: unknown): GhRun => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: '' });
const httpError = (status: number, message: string): GhRun => ({
  exitCode: 1,
  stdout: JSON.stringify({ message, status: String(status) }),
  stderr: `gh: ${message} (HTTP ${status})`,
});
const graphqlError = (exitCode: number): GhRun => ({
  exitCode,
  stdout: JSON.stringify({ data: { updateRefs: null }, errors: [{ message: GENERIC }] }),
  stderr: exitCode === 0 ? '' : `gh: ${GENERIC}`,
});
const base64Lines = (text: string): string =>
  Buffer.from(text, 'utf8').toString('base64').replace(/.{60}/g, '$&\n');

function fakeGh(route: (call: Call) => GhRun | undefined) {
  const calls: Call[] = [];
  const run = async (args: readonly string[], input?: string): Promise<GhRun> => {
    const flag = args.findIndex((arg) => arg === '-X' || arg === '--method');
    const method =
      flag === -1 ? (input === undefined ? 'GET' : 'POST') : (args[flag + 1] ?? '').toUpperCase();
    const call: Call = {
      args,
      endpoint: args.find((arg) => arg.startsWith('repos/') || arg === 'graphql') ?? '',
      method,
      body: input === undefined ? undefined : (JSON.parse(input) as Record<string, unknown>),
      input,
    };
    calls.push(call);
    const reply = route(call);
    if (reply === undefined) throw new Error(`unexpected gh call: ${method} ${call.endpoint}`);
    return reply;
  };
  return { run, calls };
}

const repositoryId = (call: Call): GhRun | undefined => {
  if (call.endpoint === BASE && call.method === 'GET') return ok({ node_id: 'R_1' });
  if (call.endpoint === 'graphql' && !call.input?.includes('updateRefs')) {
    return ok({ data: { repository: { id: 'R_1' } } });
  }
  return undefined;
};

const port = (run: ReturnType<typeof fakeGh>['run'], ref?: string) =>
  createGitHubStatePort({ owner: OWNER, repo: REPO, run, ...(ref === undefined ? {} : { ref }) });

describe('where the state lives', () => {
  it('reads the head of refs/ai-workflows/state by default, through gh api', async () => {
    const gh = fakeGh((call) =>
      HEAD_ENDPOINTS.includes(call.endpoint) && call.method === 'GET'
        ? ok({ ref: DEFAULT_STATE_REF, object: { sha: 'c1', type: 'commit' } })
        : undefined,
    );

    expect(DEFAULT_STATE_REF).toBe('refs/ai-workflows/state');
    expect(await port(gh.run).head()).toBe('c1');
    expect(gh.calls.every((call) => call.args[0] === 'api')).toBe(true);
  });

  it('says there is no state yet when the ref does not exist', async () => {
    const gh = fakeGh((call) =>
      HEAD_ENDPOINTS.includes(call.endpoint) ? httpError(404, 'Not Found') : repositoryId(call),
    );

    expect(await port(gh.run).head()).toBeUndefined();
  });

  it('does not read a repository it cannot see as «no state yet»', async () => {
    // GitHub answers 404 both for a missing ref and for a repository the account cannot see.
    // Reading the second as empty would show «no pieces» for a typo in the owner's name.
    const gh = fakeGh((call) =>
      HEAD_ENDPOINTS.includes(call.endpoint) || call.endpoint === BASE || call.endpoint === 'graphql'
        ? httpError(404, 'Not Found')
        : undefined,
    );

    await expect(port(gh.run).head()).rejects.toThrow(/luismichelcf\/ai-workflows|repositor/i);
  });

  it('reports any other failure instead of pretending the ref is missing', async () => {
    const gh = fakeGh((call) => (HEAD_ENDPOINTS.includes(call.endpoint) ? httpError(502, 'Bad Gateway') : undefined));

    await expect(port(gh.run).head()).rejects.toThrow(/502|Bad Gateway/);
  });

  it('uses the ref the project configured', async () => {
    const gh = fakeGh((call) =>
      call.endpoint === `${BASE}/git/ref/ai-workflows/other` || call.endpoint === `${BASE}/git/refs/ai-workflows/other`
        ? ok({ ref: 'refs/ai-workflows/other', object: { sha: 'c7', type: 'commit' } })
        : undefined,
    );

    expect(await port(gh.run, 'refs/ai-workflows/other').head()).toBe('c7');
  });

  it.each(['refs/heads/state', 'refs/tags/state'])(
    'refuses %s: writing a branch or a tag fires deployments and push workflows',
    (ref) => {
      const gh = fakeGh(() => undefined);

      expect(() => port(gh.run, ref)).toThrow(/deploy|push|branch|tag/i);
    },
  );

  it.each(['state', '', 'refs/ai-workflows/../heads/x', 'refs/ai-workflows/', 'refs/ai workflows/state'])(
    'refuses a ref that is not a well-formed name outside branches and tags: %j',
    (ref) => {
      const gh = fakeGh(() => undefined);

      expect(() => port(gh.run, ref)).toThrow(/ref/i);
    },
  );

  it.each([
    ['', REPO],
    ['a/b', REPO],
    [OWNER, '..'],
    [OWNER, 'x y'],
  ])('refuses an owner or repository that is not a plain name: %j/%j', (owner, repo) => {
    const gh = fakeGh(() => undefined);

    expect(() => createGitHubStatePort({ owner, repo, run: gh.run })).toThrow(/owner|repo/i);
  });
});

describe('reading files', () => {
  const TEXT = '{"reason":"Construcción en verde — «sí»"}'.repeat(4);
  const tree = (truncated: boolean) => (call: Call): GhRun | undefined => {
    if (call.method === 'GET' && call.endpoint.startsWith(`${BASE}/git/trees/c1`)) {
      return ok({
        sha: 't1',
        truncated,
        tree: [
          { path: 'pieces', type: 'tree', sha: 'tp', mode: '040000' },
          { path: 'pieces/997', type: 'tree', sha: 'tq', mode: '040000' },
          { path: 'pieces/997/status.json', type: 'blob', sha: 'b1', mode: '100644' },
          { path: 'pieces/997/journal.json', type: 'blob', sha: 'b2', mode: '100644' },
          { path: 'piecesX/a.json', type: 'blob', sha: 'b3', mode: '100644' },
          { path: 'zones/z.json', type: 'blob', sha: 'b4', mode: '100644' },
        ],
      });
    }
    if (call.method === 'GET' && call.endpoint === `${BASE}/git/blobs/b1`) {
      return ok({ sha: 'b1', encoding: 'base64', content: base64Lines(TEXT) });
    }
    if (call.method === 'GET' && call.endpoint.startsWith(`${BASE}/git/commits/c1`)) {
      return ok({ sha: 'c1', tree: { sha: 't1' } });
    }
    return undefined;
  };

  it('reads a file at a commit, decoding what GitHub sends', async () => {
    const gh = fakeGh(tree(false));

    expect(await port(gh.run).read('c1', 'pieces/997/status.json')).toBe(TEXT);
  });

  it('says a file is absent instead of failing', async () => {
    const gh = fakeGh(tree(false));

    expect(await port(gh.run).read('c1', 'pieces/1000/status.json')).toBeUndefined();
  });

  it('lists the files under a folder, and only that folder', async () => {
    const gh = fakeGh(tree(false));

    const listed = await port(gh.run).list('c1', 'pieces');

    expect([...listed].sort()).toEqual(['pieces/997/journal.json', 'pieces/997/status.json']);
  });

  it('refuses to answer from a truncated tree, where a missing entry would read as absent', async () => {
    const gh = fakeGh(tree(true));

    await expect(port(gh.run).read('c1', 'pieces/1000/status.json')).rejects.toThrow();
    await expect(port(gh.run).list('c1', 'pieces')).rejects.toThrow();
  });
});

describe('writing a commit', () => {
  const treeCalls = (calls: readonly Call[]) =>
    calls.filter((call) => call.method === 'POST' && call.endpoint === `${BASE}/git/trees`);
  const commitCalls = (calls: readonly Call[]) =>
    calls.filter((call) => call.method === 'POST' && call.endpoint === `${BASE}/git/commits`);
  const updateRefsCalls = (calls: readonly Call[]) =>
    calls.filter((call) => call.endpoint === 'graphql' && call.input?.includes('updateRefs'));

  const creating = (refReply: GhRun) => (call: Call): GhRun | undefined => {
    if (call.method === 'POST' && call.endpoint === `${BASE}/git/trees`) return ok({ sha: 't1' });
    if (call.method === 'POST' && call.endpoint === `${BASE}/git/commits`) return ok({ sha: 'c1' });
    if (call.method === 'POST' && call.endpoint === `${BASE}/git/refs`) return refReply;
    return undefined;
  };

  it('creates the ref with the first commit, which has no parent', async () => {
    const gh = fakeGh(creating(ok({ ref: DEFAULT_STATE_REF, object: { sha: 'c1' } })));

    const landed = await port(gh.run).commit(undefined, { 'pieces/997/status.json': '{"a":1}' }, 'first');

    expect(landed).toBe('c1');
    const [treeCall] = treeCalls(gh.calls);
    expect(treeCall?.body?.['base_tree']).toBeUndefined();
    expect(treeCall?.body?.['tree']).toEqual([
      { path: 'pieces/997/status.json', mode: '100644', type: 'blob', content: '{"a":1}' },
    ]);
    const [commitCall] = commitCalls(gh.calls);
    expect(commitCall?.body?.['parents']).toEqual([]);
    expect(commitCall?.body?.['tree']).toBe('t1');
    const refCall = gh.calls.find((call) => call.endpoint === `${BASE}/git/refs`);
    expect(refCall?.body).toEqual({ ref: DEFAULT_STATE_REF, sha: 'c1' });
    expect(updateRefsCalls(gh.calls)).toHaveLength(0);
  });

  it('loses the race when someone created the ref first', async () => {
    const gh = fakeGh(creating(httpError(422, 'Reference already exists')));

    expect(await port(gh.run).commit(undefined, { 'a.json': '{}' }, 'first')).toBeUndefined();
  });

  it('reports a refusal to create the ref that is not a race', async () => {
    const gh = fakeGh(creating(httpError(403, 'Resource not accessible by integration')));

    await expect(port(gh.run).commit(undefined, { 'a.json': '{}' }, 'first')).rejects.toThrow(
      /403|not accessible/i,
    );
  });

  const moving = (updateReply: GhRun, headAfterError: string) => (call: Call): GhRun | undefined => {
    if (call.method === 'GET' && call.endpoint.startsWith(`${BASE}/git/commits/c1`)) {
      return ok({ sha: 'c1', tree: { sha: 't1' } });
    }
    if (call.method === 'POST' && call.endpoint === `${BASE}/git/trees`) return ok({ sha: 't2' });
    if (call.method === 'POST' && call.endpoint === `${BASE}/git/commits`) return ok({ sha: 'c2' });
    if (call.endpoint === 'graphql' && call.input?.includes('updateRefs')) return updateReply;
    if (HEAD_ENDPOINTS.includes(call.endpoint) && call.method === 'GET') {
      return ok({ ref: DEFAULT_STATE_REF, object: { sha: headAfterError, type: 'commit' } });
    }
    return repositoryId(call);
  };
  const CHANGES = { 'pieces/997/status.json': '{"a":2}', 'pieces/997/lease.json': null };

  it('moves the ref with updateRefs only if it still points at the parent', async () => {
    const gh = fakeGh(moving(ok({ data: { updateRefs: { clientMutationId: null } } }), 'c2'));

    const landed = await port(gh.run).commit('c1', CHANGES, 'second');

    expect(landed).toBe('c2');
    const [treeCall] = treeCalls(gh.calls);
    expect(treeCall?.body?.['base_tree']).toBe('t1');
    expect(treeCall?.body?.['tree']).toEqual(
      expect.arrayContaining([
        { path: 'pieces/997/status.json', mode: '100644', type: 'blob', content: '{"a":2}' },
        { path: 'pieces/997/lease.json', mode: '100644', type: 'blob', sha: null },
      ]),
    );
    const [commitCall] = commitCalls(gh.calls);
    expect(commitCall?.body?.['parents']).toEqual(['c1']);
    expect(commitCall?.body?.['tree']).toBe('t2');
    const [update] = updateRefsCalls(gh.calls);
    for (const expected of ['c1', 'c2', DEFAULT_STATE_REF, 'R_1']) {
      expect(update?.input).toContain(expected);
    }
    // REST PATCH does not compare on these refs: it must never be the way the ref moves.
    expect(gh.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it.each([1, 0])(
    'reads a generic updateRefs error (gh exit %i) as a lost race when the ref moved elsewhere',
    async (exitCode) => {
      const gh = fakeGh(moving(graphqlError(exitCode), 'c9'));

      expect(await port(gh.run).commit('c1', CHANGES, 'second')).toBeUndefined();
    },
  );

  it('reads it as landed when the ref already points at the new commit', async () => {
    const gh = fakeGh(moving(graphqlError(1), 'c2'));

    expect(await port(gh.run).commit('c1', CHANGES, 'second')).toBe('c2');
  });

  it('reports it as a failure when the ref did not move at all', async () => {
    const gh = fakeGh(moving(graphqlError(1), 'c1'));

    await expect(port(gh.run).commit('c1', CHANGES, 'second')).rejects.toThrow(/Something went wrong/);
  });
});
