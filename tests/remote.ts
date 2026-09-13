import type { StatePort } from '../src/index.js';

type Method = 'head' | 'read' | 'list' | 'commit';
type Sneak = () => void | Promise<void>;

interface Commit {
  readonly parent: string | undefined;
  readonly files: ReadonlyMap<string, string>;
}

/** Yields to the event loop, so sessions racing through `Promise.all` really interleave. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * A state ref held in memory with the one property that matters: moving it only succeeds if it
 * still points where the writer read it. Each `port()` is a separate session over the same
 * remote, like two terminals. `beforeNextCommit` lets a test slip another writer in between a
 * session's read and its write, which is the race the store exists to survive.
 */
export function fakeRemote() {
  const commits = new Map<string, Commit>();
  let head: string | undefined;
  let counter = 0;
  let attempts = 0;
  const sneaks: Sneak[] = [];
  let sneakAlways: Sneak | undefined;
  const failures = new Map<Method, Error>();

  const filesAt = (commit: string | undefined): ReadonlyMap<string, string> => {
    if (commit === undefined) return new Map();
    const found = commits.get(commit);
    if (found === undefined) throw new Error(`fake remote: unknown commit ${commit}`);
    return found.files;
  };

  const land = (parent: string | undefined, changes: Readonly<Record<string, string | null>>): string => {
    const files = new Map(filesAt(parent));
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) files.delete(path);
      else files.set(path, content);
    }
    counter += 1;
    const sha = `c${counter}`;
    commits.set(sha, { parent, files });
    head = sha;
    return sha;
  };

  const failIfAsked = (method: Method): void => {
    const error = failures.get(method);
    if (error === undefined) return;
    failures.delete(method);
    throw error;
  };

  const port = (): StatePort => ({
    async head() {
      await tick();
      failIfAsked('head');
      return head;
    },
    async read(commit, path) {
      await tick();
      failIfAsked('read');
      return filesAt(commit).get(path);
    },
    async list(commit, dir) {
      await tick();
      failIfAsked('list');
      const prefix = `${dir}/`;
      return [...filesAt(commit).keys()].filter((path) => path.startsWith(prefix)).sort();
    },
    async commit(parent, changes) {
      await tick();
      failIfAsked('commit');
      attempts += 1;
      const sneak = sneaks.shift() ?? sneakAlways;
      if (sneak !== undefined) await sneak();
      if (head !== parent) return undefined;
      return land(parent, changes);
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
    get head(): string | undefined {
      return head;
    },
    /** The files at the head, as plain text. */
    files(): Record<string, string> {
      return Object.fromEntries(filesAt(head));
    },
    /** Writes straight onto the head, as another tool or a corruption would. */
    put(path: string, content: string | null): void {
      land(head, { [path]: content });
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
