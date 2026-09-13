import { describe, expect, it } from 'vitest';

import { DEFAULT_STATE_NAMESPACE, createGitHubStatePort, type GhRun } from '../src/index.js';

// The GitHub side of the git-backed store (ai-workflows#6). Measured against GitHub on 13-sep-2026:
//   - REST `PATCH git/refs` does NOT compare on refs outside refs/heads: a stale write overwrote a
//     newer commit, even 5 s later. Only GraphQL `updateRefs` with `beforeOid` refuses it.
//   - That refusal comes back as a generic «Something went wrong», so after any updateRefs error
//     the port re-reads the ref to tell a lost race from a landed write from a real failure.
//   - `POST git/refs` answers 422 «Reference already exists», which makes creating a ref safe.
// Flock findings built in here: one ref per piece under a namespace; a write that landed under a
// newer one is still landed (checked with compare); SHAs are checked before they become URLs; a
// reply that cannot be read is refused, never read as empty; old trees are not kept forever.
// Request bodies travel as JSON on stdin (`--input -`), so these fakes read them from there.

const OWNER = 'luismichelcf';
const REPO = 'ai-workflows';
const BASE = `repos/${OWNER}/${REPO}`;
const GENERIC = 'Something went wrong while executing your query on 2026-09-13T20:55:20Z.';

const sha = (n: number): string => n.toString(16).padStart(40, '0');
const C1 = sha(0xc1);
const C2 = sha(0xc2);
const C9 = sha(0xc9);
const T1 = sha(0x71);
const T2 = sha(0x72);
const B1 = sha(0xb1);

const refEndpoints = (name: string, namespace = 'ai-workflows'): string[] => [
  `${BASE}/git/ref/${namespace}/${name}`,
  `${BASE}/git/refs/${namespace}/${name}`,
];
const HEAD_997 = refEndpoints('pieces/997');

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
/** Runs `make` inside a promise, so a synchronous throw and a rejection look the same. */
const attempt = (make: () => Promise<unknown>): Promise<unknown> => Promise.resolve().then(make);

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

const refsQuery = (call: Call): boolean => call.endpoint === 'graphql' && call.input?.includes('refPrefix') === true;
const updateRefsCall = (call: Call): boolean => call.endpoint === 'graphql' && call.input?.includes('updateRefs') === true;

const repositoryId = (call: Call): GhRun | undefined => {
  if (call.endpoint === BASE && call.method === 'GET') return ok({ node_id: 'R_1' });
  if (call.endpoint === 'graphql' && !updateRefsCall(call) && !refsQuery(call)) {
    return ok({ data: { repository: { id: 'R_1' } } });
  }
  return undefined;
};

const port = (run: ReturnType<typeof fakeGh>['run'], namespace?: string) =>
  createGitHubStatePort({ owner: OWNER, repo: REPO, run, ...(namespace === undefined ? {} : { namespace }) });

describe('where the state lives', () => {
  it('reads the head of a piece under refs/ai-workflows by default, through gh api', async () => {
    const gh = fakeGh((call) =>
      HEAD_997.includes(call.endpoint) && call.method === 'GET'
        ? ok({ ref: 'refs/ai-workflows/pieces/997', object: { sha: C1, type: 'commit' } })
        : undefined,
    );

    expect(DEFAULT_STATE_NAMESPACE).toBe('refs/ai-workflows');
    expect(await port(gh.run).head('pieces/997')).toBe(C1);
    expect(gh.calls.every((call) => call.args[0] === 'api')).toBe(true);
  });

  it('says there is no state yet when the ref does not exist', async () => {
    const gh = fakeGh((call) =>
      HEAD_997.includes(call.endpoint) ? httpError(404, 'Not Found') : repositoryId(call),
    );

    expect(await port(gh.run).head('pieces/997')).toBeUndefined();
  });

  it('does not read a repository it cannot see as «no state yet»', async () => {
    // GitHub answers 404 both for a missing ref and for a repository the account cannot see.
    // Reading the second as empty would show «no pieces» for a typo in the owner's name.
    const gh = fakeGh((call) =>
      HEAD_997.includes(call.endpoint) || call.endpoint === BASE || call.endpoint === 'graphql'
        ? httpError(404, 'Not Found')
        : undefined,
    );

    await expect(port(gh.run).head('pieces/997')).rejects.toThrow(/luismichelcf\/ai-workflows|repositor/i);
  });

  it('reports any other failure instead of pretending the ref is missing', async () => {
    const gh = fakeGh((call) => (HEAD_997.includes(call.endpoint) ? httpError(502, 'Bad Gateway') : undefined));

    await expect(port(gh.run).head('pieces/997')).rejects.toThrow(/502|Bad Gateway/);
  });

  it('uses the namespace the project configured', async () => {
    const endpoints = refEndpoints('pieces/997', 'other-tool');
    const gh = fakeGh((call) =>
      endpoints.includes(call.endpoint)
        ? ok({ ref: 'refs/other-tool/pieces/997', object: { sha: C9, type: 'commit' } })
        : undefined,
    );

    expect(await port(gh.run, 'refs/other-tool').head('pieces/997')).toBe(C9);
  });

  it.each(['refs/heads', 'refs/heads/state', 'refs/tags', 'refs/tags/state'])(
    'refuses the namespace %s: writing a branch or a tag fires deployments and push workflows',
    (namespace) => {
      const gh = fakeGh(() => undefined);

      expect(() => port(gh.run, namespace)).toThrow(/deploy|push|branch|tag/i);
    },
  );

  it.each(['state', '', 'refs', 'refs/', 'refs/ai-workflows/', 'refs/ai workflows', 'refs/a/../b'])(
    'refuses a namespace that is not a well-formed ref prefix: %j',
    (namespace) => {
      const gh = fakeGh(() => undefined);

      expect(() => port(gh.run, namespace)).toThrow(/namespace/i);
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

  it.each(['', 'pieces/', 'pieces//997', '../heads/main', 'pieces/a b', 'pieces/a.b', '/pieces/997'])(
    'refuses a state name the store never writes, before any call: %j',
    async (name) => {
      const gh = fakeGh(() => undefined);
      const statePort = port(gh.run);

      await expect(attempt(() => statePort.head(name))).rejects.toThrow(/name|ref/i);
      expect(gh.calls).toHaveLength(0);
    },
  );
});

describe('listing refs', () => {
  const page = (nodes: Array<[string, string]>, next?: string): GhRun =>
    ok({
      data: {
        repository: {
          refs: {
            nodes: nodes.map(([name, oid]) => ({ name, target: { oid } })),
            pageInfo: { hasNextPage: next !== undefined, endCursor: next ?? null },
          },
        },
      },
    });

  it('lists every ref under a prefix across pages, with the commit each points at', async () => {
    const gh = fakeGh((call) => {
      if (!refsQuery(call)) return undefined;
      return call.input?.includes('CURSOR1') === true ? page([['1000', C2]]) : page([['997', C1]], 'CURSOR1');
    });

    const listed = await port(gh.run).refs('pieces/');

    expect([...listed].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'pieces/1000', commit: C2 },
      { name: 'pieces/997', commit: C1 },
    ]);
    const queries = gh.calls.filter(refsQuery);
    expect(queries).toHaveLength(2);
    expect(queries.every((call) => call.input?.includes('refs/ai-workflows/pieces/'))).toBe(true);
  });

  it('says there are none when nothing matches', async () => {
    const gh = fakeGh((call) => (refsQuery(call) ? page([]) : undefined));

    expect(await port(gh.run).refs('pieces/')).toEqual([]);
  });

  it.each<[string, GhRun]>([
    ['a GraphQL error', { exitCode: 1, stdout: JSON.stringify({ errors: [{ message: GENERIC }] }), stderr: `gh: ${GENERIC}` }],
    [
      'a repository it cannot see',
      {
        exitCode: 1,
        stdout: JSON.stringify({
          data: { repository: null },
          errors: [{ type: 'NOT_FOUND', message: "Could not resolve to a Repository with the name 'luismichelcf/ai-workflows'." }],
        }),
        stderr: 'gh: Could not resolve to a Repository',
      },
    ],
    ['a reply without the list', ok({ data: { repository: null } })],
  ])('reports %s instead of an empty list', async (_label, reply) => {
    const gh = fakeGh((call) => (refsQuery(call) ? reply : undefined));

    await expect(port(gh.run).refs('pieces/')).rejects.toThrow();
  });
});

describe('reading files', () => {
  const TEXT = '{"reason":"Construcción en verde — «sí»"}'.repeat(4);
  const ENTRIES = [
    { path: 'status.json', type: 'blob', sha: B1, mode: '100644' },
    { path: 'journal.json', type: 'blob', sha: sha(0xb2), mode: '100644' },
  ];
  const reading = (tree: GhRun) => (call: Call): GhRun | undefined => {
    if (call.method === 'GET' && call.endpoint.startsWith(`${BASE}/git/trees/${C1}`)) return tree;
    if (call.method === 'GET' && call.endpoint === `${BASE}/git/blobs/${B1}`) {
      return ok({ sha: B1, encoding: 'base64', content: base64Lines(TEXT) });
    }
    return undefined;
  };
  const treeCalls = (calls: readonly Call[]) =>
    calls.filter((call) => call.method === 'GET' && call.endpoint.includes('/git/trees/'));

  it('reads a file at a commit, decoding what GitHub sends', async () => {
    const gh = fakeGh(reading(ok({ sha: T1, truncated: false, tree: ENTRIES })));

    expect(await port(gh.run).read(C1, 'status.json')).toBe(TEXT);
  });

  it('says a file is absent instead of failing, and lists the tree once for both reads', async () => {
    const gh = fakeGh(reading(ok({ sha: T1, truncated: false, tree: ENTRIES })));
    const statePort = port(gh.run);

    expect(await statePort.read(C1, 'effects.json')).toBeUndefined();
    expect(await statePort.read(C1, 'status.json')).toBe(TEXT);
    expect(treeCalls(gh.calls)).toHaveLength(1);
  });

  it('refuses to answer from a truncated tree, where a missing entry would read as absent', async () => {
    const gh = fakeGh(reading(ok({ sha: T1, truncated: true, tree: ENTRIES })));

    await expect(port(gh.run).read(C1, 'effects.json')).rejects.toThrow();
  });

  it.each<[string, unknown]>([
    ['a listing that is not a list', 'nope'],
    ['an entry with missing fields', [{ path: 'status.json', type: 'blob' }]],
  ])('refuses a tree with %s, instead of reading every file as absent', async (_label, tree) => {
    const gh = fakeGh(reading(ok({ sha: T1, truncated: false, tree })));

    await expect(port(gh.run).read(C1, 'effects.json')).rejects.toThrow();
  });

  it.each(['c1', 'x?recursive=0', '../..', '', sha(1).slice(0, 39)])(
    'refuses a commit that is not a SHA before building a URL from it: %j',
    async (commit) => {
      const gh = fakeGh(() => undefined);
      const statePort = port(gh.run);

      await expect(attempt(() => statePort.read(commit, 'status.json'))).rejects.toThrow();
      expect(gh.calls).toHaveLength(0);
    },
  );

  it('does not keep every tree it ever read', async () => {
    const fetched = new Map<string, number>();
    const gh = fakeGh((call) => {
      const match = /\/git\/trees\/([0-9a-f]{40})/.exec(call.endpoint);
      const commit = match?.[1];
      if (call.method !== 'GET' || commit === undefined) return undefined;
      fetched.set(commit, (fetched.get(commit) ?? 0) + 1);
      return ok({ sha: T1, truncated: false, tree: [] });
    });
    const statePort = port(gh.run);

    for (let n = 1; n <= 40; n += 1) await statePort.read(sha(n), 'status.json');
    await statePort.read(sha(1), 'status.json');

    expect(fetched.get(sha(1))).toBe(2);
  });
});

describe('writing a commit', () => {
  const treePosts = (calls: readonly Call[]) =>
    calls.filter((call) => call.method === 'POST' && call.endpoint === `${BASE}/git/trees`);
  const commitPosts = (calls: readonly Call[]) =>
    calls.filter((call) => call.method === 'POST' && call.endpoint === `${BASE}/git/commits`);

  const creating = (refReply: GhRun) => (call: Call): GhRun | undefined => {
    if (call.method === 'POST' && call.endpoint === `${BASE}/git/trees`) return ok({ sha: T1 });
    if (call.method === 'POST' && call.endpoint === `${BASE}/git/commits`) return ok({ sha: C1 });
    if (call.method === 'POST' && call.endpoint === `${BASE}/git/refs`) return refReply;
    return undefined;
  };

  it('creates the ref of a piece with its first commit, which has no parent', async () => {
    const gh = fakeGh(creating(ok({ ref: 'refs/ai-workflows/pieces/997', object: { sha: C1 } })));

    const landed = await port(gh.run).commit('pieces/997', undefined, { 'status.json': '{"a":1}' }, 'first');

    expect(landed).toBe(C1);
    const [treePost] = treePosts(gh.calls);
    expect(treePost?.body?.['base_tree']).toBeUndefined();
    expect(treePost?.body?.['tree']).toEqual([
      { path: 'status.json', mode: '100644', type: 'blob', content: '{"a":1}' },
    ]);
    const [commitPost] = commitPosts(gh.calls);
    expect(commitPost?.body?.['parents']).toEqual([]);
    expect(commitPost?.body?.['tree']).toBe(T1);
    const refPost = gh.calls.find((call) => call.endpoint === `${BASE}/git/refs`);
    expect(refPost?.body).toEqual({ ref: 'refs/ai-workflows/pieces/997', sha: C1 });
    expect(gh.calls.some(updateRefsCall)).toBe(false);
  });

  it('loses the race when someone created the ref first', async () => {
    const gh = fakeGh(creating(httpError(422, 'Reference already exists')));

    expect(await port(gh.run).commit('pieces/997', undefined, { 'status.json': '{}' }, 'first')).toBeUndefined();
  });

  it('reports a refusal to create the ref that is not a race', async () => {
    const gh = fakeGh(creating(httpError(403, 'Resource not accessible by integration')));

    await expect(
      port(gh.run).commit('pieces/997', undefined, { 'status.json': '{}' }, 'first'),
    ).rejects.toThrow(/403|not accessible/i);
  });

  const LANDED = ok({ data: { updateRefs: { clientMutationId: null } } });
  const CHANGES = { 'status.json': '{"a":2}', 'lease.json': null };
  const moving =
    (updateReply: GhRun, headAfterError: string, compareStatus = 'diverged') =>
    (call: Call): GhRun | undefined => {
      if (call.method === 'GET' && call.endpoint.startsWith(`${BASE}/git/trees/${C1}`)) {
        return ok({ sha: T1, truncated: false, tree: [{ path: 'lease.json', type: 'blob', sha: B1, mode: '100644' }] });
      }
      if (call.method === 'POST' && call.endpoint === `${BASE}/git/trees`) return ok({ sha: T2 });
      if (call.method === 'POST' && call.endpoint === `${BASE}/git/commits`) return ok({ sha: C2 });
      if (updateRefsCall(call)) return updateReply;
      if (HEAD_997.includes(call.endpoint) && call.method === 'GET') {
        return ok({ ref: 'refs/ai-workflows/pieces/997', object: { sha: headAfterError, type: 'commit' } });
      }
      if (call.method === 'GET' && call.endpoint.startsWith(`${BASE}/compare/${C2}...${headAfterError}`)) {
        return ok({ status: compareStatus });
      }
      return repositoryId(call);
    };

  it('moves the ref with updateRefs only if it still points at the parent, building on the tree it read', async () => {
    const gh = fakeGh(moving(LANDED, C2));

    const landed = await port(gh.run).commit('pieces/997', C1, CHANGES, 'second');

    expect(landed).toBe(C2);
    const [treePost] = treePosts(gh.calls);
    expect(treePost?.body?.['base_tree']).toBe(T1);
    expect(treePost?.body?.['tree']).toEqual(
      expect.arrayContaining([
        { path: 'status.json', mode: '100644', type: 'blob', content: '{"a":2}' },
        { path: 'lease.json', mode: '100644', type: 'blob', sha: null },
      ]),
    );
    const [commitPost] = commitPosts(gh.calls);
    expect(commitPost?.body?.['parents']).toEqual([C1]);
    expect(commitPost?.body?.['tree']).toBe(T2);
    const update = gh.calls.find(updateRefsCall);
    for (const expected of [C1, C2, 'refs/ai-workflows/pieces/997', 'R_1']) {
      expect(update?.input).toContain(expected);
    }
    // REST PATCH does not compare on these refs: it must never be the way a ref moves. And the
    // parent's tree is already in the listing it read, so the commit is not fetched again.
    expect(gh.calls.some((call) => call.method === 'PATCH')).toBe(false);
    expect(gh.calls.some((call) => call.endpoint.includes('/git/commits/'))).toBe(false);
  });

  it('does not take a reply without updateRefs for a landed write', async () => {
    const gh = fakeGh(moving(ok({ data: { updateRefs: null } }), C9, 'diverged'));

    expect(await port(gh.run).commit('pieces/997', C1, CHANGES, 'second')).toBeUndefined();
  });

  it.each([1, 0])(
    'reads a generic updateRefs error (gh exit %i) as a lost race when someone else wrote instead',
    async (exitCode) => {
      const gh = fakeGh(moving(graphqlError(exitCode), C9, 'diverged'));

      expect(await port(gh.run).commit('pieces/997', C1, CHANGES, 'second')).toBeUndefined();
    },
  );

  it('reads it as landed when the ref already points at the new commit', async () => {
    const gh = fakeGh(moving(graphqlError(1), C2));

    expect(await port(gh.run).commit('pieces/997', C1, CHANGES, 'second')).toBe(C2);
  });

  it('reads it as landed when another write already sits on top of it', async () => {
    // Otherwise the store would redo a write that is already there: an entry appended twice, or
    // its own effect claim refused as someone else's.
    const gh = fakeGh(moving(graphqlError(1), C9, 'ahead'));

    expect(await port(gh.run).commit('pieces/997', C1, CHANGES, 'second')).toBe(C2);
  });

  it('reports it as a failure when the ref did not move at all', async () => {
    const gh = fakeGh(moving(graphqlError(1), C1));

    await expect(port(gh.run).commit('pieces/997', C1, CHANGES, 'second')).rejects.toThrow(/Something went wrong/);
  });

  it.each(['c1', '../..'])('refuses a parent that is not a SHA before building a URL from it: %j', async (parent) => {
    const gh = fakeGh(() => undefined);
    const statePort = port(gh.run);

    await expect(attempt(() => statePort.commit('pieces/997', parent, CHANGES, 'x'))).rejects.toThrow();
    expect(gh.calls).toHaveLength(0);
  });
});
