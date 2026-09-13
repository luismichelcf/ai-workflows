import { randomUUID } from 'node:crypto';

import {
  EffectNeedsReconciliation,
  StaleVersion,
  type EffectRecord,
  type EffectState,
  type JournalEntry,
  type JsonValue,
  type PieceId,
  type PieceStatus,
  type Reservation,
  type RunId,
  type Store,
  type Version,
} from './contract.js';

/** One state ref: its name inside the port's namespace, like `pieces/997`, and its commit. */
export interface StateRef {
  readonly name: string;
  readonly commit: string;
}

/**
 * What the git-backed store needs from wherever its state refs live. Small on purpose: the
 * store's logic is tested over an in-memory remote, and each host (GitHub today) implements
 * these four calls. Each piece and each zone has its own ref, so a write to one never makes a
 * write to another lose its race.
 */
export interface StatePort {
  /** The commit ref `name` points at, or `undefined` while that ref does not exist yet. */
  head(name: string): Promise<string | undefined>;
  /** Every ref whose name starts with `prefix`, with the commit each points at. */
  refs(prefix: string): Promise<readonly StateRef[]>;
  /** One file's contents at a commit, or `undefined` when the file is absent. */
  read(commit: string, path: string): Promise<string | undefined>;
  /**
   * Writes `changes` (`null` deletes a file) as a commit on top of `parent` and moves ref `name`
   * only if it still points at `parent`. Returns the new commit, or `undefined` when the ref had
   * moved: someone else wrote first. Anything else is thrown, never guessed.
   */
  commit(
    name: string,
    parent: string | undefined,
    changes: Readonly<Record<string, string | null>>,
    message: string,
  ): Promise<string | undefined>;
}

export interface GitStoreOptions {
  readonly port: StatePort;
  /** Injected so leases can be tested without waiting on the wall clock. */
  readonly now?: () => number;
  /** Lost races a single write retries before giving up. Defaults to 5. */
  readonly maxAttempts?: number;
  /** Waits between retries; injected so tests never sleep. */
  readonly pause?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 10;
const RETRY_MAX_MS = 250;

/**
 * A round trip through JSON, the exact journey a result makes over the remote store, which
 * keeps it as text. A `Date` must come back a string here too, so the memory and git stores
 * cannot drift on the one path a resume in production exercises. Cloning also stops a caller
 * from mutating what the store holds through the value it was handed.
 */
const throughJson = <T extends JsonValue>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;

/** Freezes a JSON value recursively, so nested evidence is as immutable as the entry holding it. */
const deepFreeze = (value: JsonValue): void => {
  if (value === null || typeof value !== 'object') return;
  const nested = Array.isArray(value) ? value : Object.values(value);
  for (const item of nested) deepFreeze(item);
  Object.freeze(value);
};

/**
 * Stores an entry with its evidence deep-frozen. Freezing the entries — not only the array
 * `journal` hands out — is what stops a caller rewriting a `rejected` into a `passed` inside
 * the store; execution-record gates are checked against this history.
 */
const freezeEntry = (entry: JournalEntry): JournalEntry => {
  if (entry.evidence === undefined) return Object.freeze({ ...entry });
  const evidence = throughJson(entry.evidence);
  deepFreeze(evidence);
  return Object.freeze({ ...entry, evidence });
};

type JsonMap = { readonly [key: string]: unknown };

interface CommitPlan {
  readonly changes: Readonly<Record<string, string | null>>;
  readonly message: string;
}

/**
 * The outcome of one attempt in a write loop. `idle` means the fresh read showed nothing to
 * change, so no commit happens; `write` carries the commit to try and how to turn a landed
 * commit into the caller's answer.
 */
type Decision<T> =
  | { readonly kind: 'idle'; readonly value: T }
  | { readonly kind: 'write'; readonly plan: CommitPlan; readonly after: (commit: string) => T };

/**
 * The git-backed implementation of `Store`: a piece's progress lives on a ref, where every
 * write is «read the head, decide from that one read, commit on top, move the ref only if it
 * did not move». Nothing is instant here, so each mutation retries a lost race from a fresh
 * read until it lands or `maxAttempts` is spent.
 */
export function createGitStore(options: GitStoreOptions): Store {
  const port = options.port;
  const now = options.now ?? Date.now;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const pause = options.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const backoff = (attempt: number): number =>
    Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (attempt + 1));

  /**
   * A folder name for one id. `encodeURIComponent` leaves `.` alone, but a folder literally
   * named `.` or `..` would escape its parent, so the dot is encoded too: every id stays
   * inside its own single folder. An empty id has no folder at all, which is a caller bug.
   */
  const encodeKey = (id: string): string => {
    if (id.length === 0) throw new Error('a piece or zone id cannot be empty');
    return encodeURIComponent(id).replaceAll('.', '%2E');
  };

  const statusPath = (piece: PieceId): string => `pieces/${encodeKey(piece)}/status.json`;
  const journalPath = (piece: PieceId): string => `pieces/${encodeKey(piece)}/journal.json`;
  const effectsPath = (piece: PieceId): string => `pieces/${encodeKey(piece)}/effects.json`;
  const leasePath = (piece: PieceId): string => `pieces/${encodeKey(piece)}/lease.json`;
  // Zones get their own top-level directory, so a piece and a zone sharing a name can never
  // lock each other out.
  const zonePath = (zone: string): string => `zones/${encodeKey(zone)}.json`;

  const asObject = (value: unknown): JsonMap | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as JsonMap)
      : undefined;

  const isEffectState = (value: unknown): value is EffectState =>
    value === 'pending' || value === 'confirmed' || value === 'uncertain';

  /**
   * Parses stored text, failing closed: a file the store cannot understand is an Error naming
   * the file, never an empty record. A read failure of the port itself is left untouched by
   * the caller, so it can never be mistaken for «there is nothing here».
   */
  const parseJson = (path: string, raw: string): unknown => {
    try {
      return JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(`stored file ${path} is not valid JSON: ${String(error)}`);
    }
  };

  const parseStatus = (path: string, raw: string): { status: PieceStatus; version: Version } => {
    const value = asObject(parseJson(path, raw));
    if (value === undefined || typeof value['version'] !== 'string' || asObject(value['status']) === undefined) {
      throw new Error(`stored file ${path} does not have the shape of a status record`);
    }
    return { version: value['version'], status: value['status'] as PieceStatus };
  };

  const readStatus = async (
    head: string | undefined,
    piece: PieceId,
  ): Promise<{ status: PieceStatus; version: Version } | undefined> => {
    const path = statusPath(piece);
    const raw = head === undefined ? undefined : await port.read(head, path);
    if (raw === undefined) return undefined;
    return parseStatus(path, raw);
  };

  const readJournal = async (head: string | undefined, piece: PieceId): Promise<JournalEntry[]> => {
    const path = journalPath(piece);
    const raw = head === undefined ? undefined : await port.read(head, path);
    if (raw === undefined) return [];
    const value = parseJson(path, raw);
    if (!Array.isArray(value)) {
      throw new Error(`stored file ${path} does not have the shape of a journal`);
    }
    const entries: JournalEntry[] = [];
    for (const item of value) {
      if (asObject(item) === undefined) {
        throw new Error(`stored file ${path} does not have the shape of a journal`);
      }
      entries.push(item as JournalEntry);
    }
    return entries;
  };

  const readEffects = async (
    head: string | undefined,
    piece: PieceId,
  ): Promise<Record<string, EffectRecord>> => {
    const path = effectsPath(piece);
    const raw = head === undefined ? undefined : await port.read(head, path);
    if (raw === undefined) return {};
    const value = asObject(parseJson(path, raw));
    if (value === undefined) {
      throw new Error(`stored file ${path} does not have the shape of an effect table`);
    }
    const records: Record<string, EffectRecord> = {};
    for (const [operationId, record] of Object.entries(value)) {
      const fields = asObject(record);
      if (fields === undefined || !isEffectState(fields['state'])) {
        throw new Error(`stored file ${path} does not have the shape of an effect table`);
      }
      records[operationId] = record as EffectRecord;
    }
    return records;
  };

  const readLease = async (
    head: string | undefined,
    piece: PieceId,
  ): Promise<{ readonly runId: RunId; readonly expiresAt: number } | undefined> => {
    const path = leasePath(piece);
    const raw = head === undefined ? undefined : await port.read(head, path);
    if (raw === undefined) return undefined;
    const value = asObject(parseJson(path, raw));
    if (value === undefined || typeof value['runId'] !== 'string' || typeof value['expiresAt'] !== 'number') {
      throw new Error(`stored file ${path} does not have the shape of a lease`);
    }
    return { runId: value['runId'], expiresAt: value['expiresAt'] };
  };

  const readZone = async (
    head: string | undefined,
    zone: string,
  ): Promise<
    { readonly runId: RunId; readonly piece: PieceId; readonly expiresAt: number } | undefined
  > => {
    const path = zonePath(zone);
    const raw = head === undefined ? undefined : await port.read(head, path);
    if (raw === undefined) return undefined;
    const value = asObject(parseJson(path, raw));
    if (
      value === undefined ||
      typeof value['runId'] !== 'string' ||
      typeof value['piece'] !== 'string' ||
      typeof value['expiresAt'] !== 'number'
    ) {
      throw new Error(`stored file ${path} does not have the shape of a zone lease`);
    }
    return { runId: value['runId'], piece: value['piece'], expiresAt: value['expiresAt'] };
  };

  /**
   * One attempt loop shared by every write. It reads the head, lets the caller decide from
   * that single read, and commits only when there is a change. A commit that lost its race
   * (`undefined`) is retried from a fresh read; after `maxAttempts` losses the ref is
   * declared unstable, which is an Error — not `StaleVersion`, since that is a decision a
   * caller can act on, while a ref that keeps moving is an operational failure.
   */
  const transact = async <T>(
    decide: (head: string | undefined) => Promise<Decision<T>>,
  ): Promise<T> => {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const head = await port.head();
      const decision = await decide(head);
      if (decision.kind === 'idle') return decision.value;
      const committed = await port.commit(head, decision.plan.changes, decision.plan.message);
      if (committed !== undefined) return decision.after(committed);
      await pause(backoff(attempt));
    }
    throw new Error(`the state ref did not stop moving after ${maxAttempts} attempts`);
  };

  const writeEffect = async (
    piece: PieceId,
    operationId: string,
    record: EffectRecord,
    message: string,
  ): Promise<void> => {
    await transact<void>(async (head) => {
      const records = await readEffects(head, piece);
      return {
        kind: 'write',
        plan: {
          changes: { [effectsPath(piece)]: JSON.stringify({ ...records, [operationId]: record }) },
          message,
        },
        after: () => undefined,
      };
    });
  };

  // Effect calls that are mid-flight, keyed like the records. A second caller arriving before
  // the first finishes must join the promise instead of starting a duplicate effect.
  const inFlight = new Map<PieceId, Map<string, Promise<JsonValue>>>();

  type Claim =
    | { readonly claimed: true }
    | { readonly claimed: false; readonly result: JsonValue };

  return {
    async reserve(piece, runId, leaseMs): Promise<Reservation> {
      return transact<Reservation>(async (head) => {
        const held = await readLease(head, piece);
        const current = now();
        // A live lease held by a different controller wins. A dead one (expired) or one's own
        // lease is taken over: without expiry a process killed mid-run would reserve forever.
        if (held !== undefined && held.runId !== runId && held.expiresAt > current) {
          return { kind: 'idle', value: { ok: false, heldBy: held.runId, expiresAt: held.expiresAt } };
        }
        const expiresAt = current + leaseMs;
        return {
          kind: 'write',
          plan: {
            changes: { [leasePath(piece)]: JSON.stringify({ runId, expiresAt }) },
            message: `ai-workflows: reserve piece ${piece}`,
          },
          after: (commit) => ({ ok: true, version: commit }),
        };
      });
    },

    async renew(piece, runId, leaseMs): Promise<Reservation> {
      return transact<Reservation>(async (head) => {
        const held = await readLease(head, piece);
        // Only the holder extends its own lease. A free piece has no holder, so we must not
        // name the caller: reporting them as the owner would be a lie about who holds it.
        if (held === undefined) {
          return { kind: 'idle', value: { ok: false, heldBy: '', expiresAt: now() } };
        }
        if (held.runId !== runId) {
          return { kind: 'idle', value: { ok: false, heldBy: held.runId, expiresAt: held.expiresAt } };
        }
        const expiresAt = now() + leaseMs;
        return {
          kind: 'write',
          plan: {
            changes: { [leasePath(piece)]: JSON.stringify({ runId, expiresAt }) },
            message: `ai-workflows: renew piece ${piece}`,
          },
          after: (commit) => ({ ok: true, version: commit }),
        };
      });
    },

    async release(piece, runId): Promise<void> {
      return transact<void>(async (head) => {
        const held = await readLease(head, piece);
        // A late release from a previous holder must not free a lease someone else now owns,
        // or two controllers could end up running the same piece.
        if (held === undefined || held.runId !== runId) return { kind: 'idle', value: undefined };
        return {
          kind: 'write',
          plan: {
            changes: { [leasePath(piece)]: null },
            message: `ai-workflows: release piece ${piece}`,
          },
          after: () => undefined,
        };
      });
    },

    async loadStatus(piece: PieceId) {
      const head = await port.head();
      if (head === undefined) return undefined;
      return readStatus(head, piece);
    },

    async saveStatus(status, expected): Promise<Version> {
      return transact<Version>(async (head) => {
        const stored = await readStatus(head, status.piece);
        const current = stored?.version;
        // The token must match what the writer read; `undefined` means «no record yet». A
        // stale token is a caller decision, so it throws now instead of retrying.
        if (expected !== current) throw new StaleVersion(status.piece);
        const version = randomUUID();
        return {
          kind: 'write',
          plan: {
            changes: { [statusPath(status.piece)]: JSON.stringify({ version, status }) },
            message: `ai-workflows: save status of ${status.piece}`,
          },
          after: () => version,
        };
      });
    },

    async listStatuses(): Promise<readonly PieceStatus[]> {
      const head = await port.head();
      if (head === undefined) return [];
      const paths = await port.list(head, 'pieces');
      const statuses: PieceStatus[] = [];
      for (const path of paths) {
        if (!path.endsWith('/status.json')) continue;
        const raw = await port.read(head, path);
        if (raw === undefined) continue;
        statuses.push(parseStatus(path, raw).status);
      }
      return statuses;
    },

    async append(piece, entry): Promise<void> {
      return transact<void>(async (head) => {
        const entries = await readJournal(head, piece);
        const next = [...entries, freezeEntry(entry)];
        return {
          kind: 'write',
          plan: {
            changes: { [journalPath(piece)]: JSON.stringify(next) },
            message: `ai-workflows: append to journal of ${piece}`,
          },
          after: () => undefined,
        };
      });
    },

    async journal(piece): Promise<readonly JournalEntry[]> {
      const head = await port.head();
      if (head === undefined) return Object.freeze([]);
      const entries = await readJournal(head, piece);
      // Hand out frozen entries inside a frozen array: the journal is the evidence
      // execution-record gates check, and a caller able to mutate it could rewrite it.
      return Object.freeze(entries.map((item) => freezeEntry(item)));
    },

    async forget(piece, stage): Promise<void> {
      return transact<void>(async (head) => {
        const entries = await readJournal(head, piece);
        const remaining = entries.filter((item) => item.stage !== stage);
        // Nothing of that stage to drop: leave the ref untouched rather than rewrite it.
        if (remaining.length === entries.length) return { kind: 'idle', value: undefined };
        return {
          kind: 'write',
          plan: {
            changes: { [journalPath(piece)]: JSON.stringify(remaining) },
            message: `ai-workflows: forget stage ${stage} of ${piece}`,
          },
          after: () => undefined,
        };
      });
    },

    async getEffect(piece, operationId): Promise<EffectRecord | undefined> {
      const head = await port.head();
      if (head === undefined) return undefined;
      const records = await readEffects(head, piece);
      const record = records[operationId];
      if (record === undefined) return undefined;
      if (record.state === 'confirmed' && record.result !== undefined) {
        // Clone the result: a caller must not be able to edit what is stored through it.
        return { state: 'confirmed', result: throughJson(record.result as JsonValue) };
      }
      return record;
    },

    async runEffect<T extends JsonValue>(
      piece: PieceId,
      operationId: string,
      effect: () => Promise<T>,
    ): Promise<T> {
      const existing = inFlight.get(piece)?.get(operationId);
      // A duplicate arriving while the first call is still running must join it, not read the
      // `pending` record we just wrote and refuse.
      if (existing !== undefined) {
        return existing.then((value) => throughJson(value as T));
      }

      const flight = (async (): Promise<T> => {
        try {
          // Claim the effect before running it, so a crash mid-effect leaves `pending`, not
          // absent. Only a stored claim lets us run the effect.
          const claim = await transact<Claim>(async (head) => {
            const records = await readEffects(head, piece);
            const record = records[operationId];
            if (record !== undefined) {
              if (record.state === 'confirmed') {
                // Already reached the world once; return that result without repeating it.
                return { kind: 'idle', value: { claimed: false, result: record.result as JsonValue } };
              }
              // Pending or uncertain: whether the effect landed is unknown. Blindly retrying
              // is how a second pull request gets opened, so report instead.
              throw new EffectNeedsReconciliation(piece, operationId, record.state);
            }
            return {
              kind: 'write',
              plan: {
                changes: {
                  [effectsPath(piece)]: JSON.stringify({
                    ...records,
                    [operationId]: { state: 'pending' },
                  }),
                },
                message: `ai-workflows: claim effect ${operationId} of ${piece}`,
              },
              after: () => ({ claimed: true }),
            };
          });

          if (!claim.claimed) return throughJson(claim.result as T);

          let result: T;
          try {
            result = await effect();
          } catch (error) {
            // The effect may or may not have reached the world; leave it for reconciliation
            // and let the failure propagate rather than swallowing it.
            await writeEffect(
              piece,
              operationId,
              { state: 'uncertain' },
              `ai-workflows: mark effect ${operationId} of ${piece} uncertain`,
            );
            throw error;
          }
          await writeEffect(
            piece,
            operationId,
            { state: 'confirmed', result },
            `ai-workflows: confirm effect ${operationId} of ${piece}`,
          );
          return result;
        } finally {
          // Clear the marker once settled so a genuine later call re-evaluates the record
          // (confirmed) instead of joining a completed flight forever.
          const flights = inFlight.get(piece);
          if (flights !== undefined) {
            flights.delete(operationId);
            if (flights.size === 0) inFlight.delete(piece);
          }
        }
      })();

      let bucket = inFlight.get(piece);
      if (bucket === undefined) {
        bucket = new Map();
        inFlight.set(piece, bucket);
      }
      bucket.set(operationId, flight);
      return flight.then((value) => throughJson(value));
    },

    async reconcileEffect(piece, operationId, outcome): Promise<void> {
      return transact<void>(async (head) => {
        const records = await readEffects(head, piece);
        // The contract has two explicit outcomes. A bare value is also accepted because a
        // caller written against the previous single-result signature still passes one; the
        // wrapper is the only unambiguous way to confirm a value shaped like `didNotHappen`.
        if (typeof outcome === 'object' && outcome !== null && 'didNotHappen' in outcome) {
          // Checked against the outside world and found absent: drop the record so the next
          // `runEffect` genuinely runs again. Inventing a result would be fabricating evidence.
          if (!(operationId in records)) return { kind: 'idle', value: undefined };
          const next = { ...records };
          delete next[operationId];
          return {
            kind: 'write',
            plan: {
              changes: { [effectsPath(piece)]: JSON.stringify(next) },
              message: `ai-workflows: reconcile effect ${operationId} of ${piece} as not run`,
            },
            after: () => undefined,
          };
        }
        const value: JsonValue =
          typeof outcome === 'object' && outcome !== null && 'confirmed' in outcome
            ? outcome.confirmed
            : (outcome as JsonValue);
        return {
          kind: 'write',
          plan: {
            changes: {
              [effectsPath(piece)]: JSON.stringify({
                ...records,
                [operationId]: { state: 'confirmed', result: throughJson(value) },
              }),
            },
            message: `ai-workflows: reconcile effect ${operationId} of ${piece}`,
          },
          after: () => undefined,
        };
      });
    },

    async reserveZone(zone, piece, runId, leaseMs): Promise<Reservation> {
      return transact<Reservation>(async (head) => {
        const held = await readZone(head, zone);
        const current = now();
        // Same lease semantics as a piece: a live lease held by someone else wins, an expired
        // one is taken over so a zone never stays locked by a dead controller.
        if (held !== undefined && held.runId !== runId && held.expiresAt > current) {
          return { kind: 'idle', value: { ok: false, heldBy: held.runId, expiresAt: held.expiresAt } };
        }
        const expiresAt = current + leaseMs;
        return {
          kind: 'write',
          plan: {
            changes: { [zonePath(zone)]: JSON.stringify({ runId, piece, expiresAt }) },
            message: `ai-workflows: reserve zone ${zone}`,
          },
          after: (commit) => ({ ok: true, version: commit }),
        };
      });
    },

    async releaseZone(zone, runId): Promise<void> {
      return transact<void>(async (head) => {
        const held = await readZone(head, zone);
        // A late release must not free a zone another controller has since taken.
        if (held === undefined || held.runId !== runId) return { kind: 'idle', value: undefined };
        return {
          kind: 'write',
          plan: {
            changes: { [zonePath(zone)]: null },
            message: `ai-workflows: release zone ${zone}`,
          },
          after: () => undefined,
        };
      });
    },
  };
}
