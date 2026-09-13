import type { StatePort } from '../src/index.js';

type Method = 'head' | 'refs' | 'read' | 'commit';
type Sneak = () => void | Promise<void>;
type Files = ReadonlyMap<string, string>;

/** Yields to the event loop, so sessions racing through `Promise.all` really interleave. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * State refs held in memory with the one property that matters: moving a ref only succeeds if it
 * still points where the writer read it. Refs are independent, as on GitHub, so a write to one
 * never makes a write to another lose. Each `port()` is a separate session over the same remote,
 * like two terminals. `beforeNextCommit` lets a test slip another writer in between a session's
 * read and its write, which is the race the store exists to survive.
 */
export function fakeRemote() {
  const commits = new Map<string, Files>();
  const heads = new Map<string, string>();
  let counter = 0;
  let attempts = 0;
  const sneaks: Sneak[] = [];
  let sneakAlways: Sneak | undefined;
  const failures = new Map<Method, Error>();

  const filesAt = (commit: string | undefined): Files => {
    if (commit === undefined) return new Map();
    const found = commits.get(commit);
    if (found === undefined) throw new Error(`fake remote: unknown commit ${commit}`);
    return found;
  };

  const land = (
    name: string,
    parent: string | undefined,
    changes: Readonly<Record<string, string | null>>,
  ): string => {
    const files = new Map(filesAt(parent));
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) files.delete(path);
      else files.set(path, content);
    }
    // Like GitHub (measured on 13-sep-2026): deleting the only file of a tree answers 404 and an
    // empty tree 422, so a write that would leave a ref with no files fails.
    if (files.size === 0) throw new Error('Not Found: GitHub refuses a tree with no files');
    counter += 1;
    const sha = counter.toString(16).padStart(40, '0');
    commits.set(sha, files);
    heads.set(name, sha);
    return sha;
  };

  const failIfAsked = (method: Method): void => {
    const error = failures.get(method);
    if (error === undefined) return;
    failures.delete(method);
    throw error;
  };

  const port = (): StatePort => ({
    async head(name) {
      await tick();
      failIfAsked('head');
      return heads.get(name);
    },
    async refs(prefix) {
      await tick();
      failIfAsked('refs');
      return [...heads]
        .filter(([name]) => name.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, commit]) => ({ name, commit }));
    },
    async read(commit, path) {
      await tick();
      failIfAsked('read');
      return filesAt(commit).get(path);
    },
    async commit(name, parent, changes) {
      await tick();
      failIfAsked('commit');
      attempts += 1;
      const sneak = sneaks.shift() ?? sneakAlways;
      if (sneak !== undefined) await sneak();
      if (heads.get(name) !== parent) return undefined;
      return land(name, parent, changes);
    },
  });

  return {
    port,
    /** Commits that landed, from any session or `put`. */
    get commits(): number {
      return counter;
    },
    /** Times any session asked to commit, landed or not. */
    get commitAttempts(): number {
      return attempts;
    },
    /** Every ref that exists, sorted. */
    refNames(): string[] {
      return [...heads.keys()].sort();
    },
    /** The files at the head of one ref, as plain text. */
    files(name: string): Record<string, string> {
      return Object.fromEntries(filesAt(heads.get(name)));
    },
    /** Writes straight onto a ref's head, as another tool or a corruption would. */
    put(name: string, path: string, content: string | null): void {
      land(name, heads.get(name), { [path]: content });
    },
    beforeNextCommit(sneak: Sneak): void {
      sneaks.push(sneak);
    },
    beforeEveryCommit(sneak: Sneak): void {
      sneakAlways = sneak;
    },
    failNext(method: Method, error: Error): void {
      failures.set(method, error);
    },
  };
}
