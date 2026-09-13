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
  /** Lost races a single write retries before giving up. Defaults to 8. */
  readonly maxAttempts?: number;
  /** Waits between retries; injected so tests never sleep. */
  readonly pause?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 8;
const RETRY_BASE_MS = 100;
const RETRY_DOUBLING = 2;
const RETRY_MAX_MS = 2_000;
/** Reads `listStatuses` fires at once, so a fleet of pieces never opens an unbounded fan-out. */
const STATUS_READ_BATCH = 8;

// Every concern is a file inside the identity's own ref: the ref name already carries who it is.
const STATUS_FILE = 'status.json';
const JOURNAL_FILE = 'journal.json';
const EFFECTS_FILE = 'effects.json';
const LEASE_FILE = 'lease.json';

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
 * did not move». Each piece and each zone gets its own ref, so writers on different identities
 * never contend. Nothing is instant here, so each mutation retries a lost race from a fresh
 * read until it lands or `maxAttempts` is spent.
 */
export function createGitStore(options: GitStoreOptions): Store {
  const port = options.port;
  const now = options.now ?? Date.now;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const pause = options.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  /**
   * Exponential backoff with jitter. The base doubles per lost race up to a ceiling, and a random
   * factor in [0.5, 1) breaks the symmetry so two writers that lost together do not collide again
   * on the next attempt.
   */
  const backoff = (attempt: number): number => {
    const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * RETRY_DOUBLING ** attempt);
    return ceiling * (0.5 + Math.random() * 0.5);
  };

  /**
   * A ref-name key for one id: the UTF-8 bytes of the id, with `A-Z`, `a-z`, `0-9` and `-` left
   * alone and every other byte written as `_` plus two uppercase hex digits. Unlike percent
   * encoding this is injective over bytes, so `a_b`, `a-b` and `a/b` never collide, and it never
   * emits `/`, `.`, `%` or a space, so a key is always one path segment that cannot escape its
   * parent. An empty id has no key at all, which is a caller bug.
   */
  const encodeKey = (id: string): string => {
    if (id.length === 0) throw new Error('a piece or zone id cannot be empty');
    let key = '';
    for (const byte of Buffer.from(id, 'utf8')) {
      const safe =
        (byte >= 0x41 && byte <= 0x5a) ||
        (byte >= 0x61 && byte <= 0x7a) ||
        (byte >= 0x30 && byte <= 0x39) ||
        byte === 0x2d;
      key += safe
        ? String.fromCharCode(byte)
        : `_${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    return key;
  };

  // A piece and a zone that happen to share a name get different ref prefixes, so one can never
  // lock out the other.
  const pieceRef = (piece: PieceId): string => `pieces/${encodeKey(piece)}`;
  const zoneRef = (zone: string): string => `zones/${encodeKey(zone)}`;

  const asObject = (value: unknown): JsonMap | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as JsonMap)
      : undefined;

  const isEffectState = (value: unknown): value is EffectState =>
    value === 'pending' || value === 'confirmed' || value === 'uncertain';

  /**
   * Parses stored text, failing closed: a file the store cannot understand is an Error naming
   * the file and its ref, never an empty record. A read failure of the port itself is left
   * untouched by the caller, so it can never be mistaken for «there is nothing here».
   */
  const parseJson = (ref: string, path: string, raw: string): unknown => {
    try {
      return JSON.parse(raw) as unknown;
    } catch (error) {
      throw new Error(`stored file ${path} on ref ${ref} is not valid JSON: ${String(error)}`);
    }
  };

  const parseStatus = (ref: string, raw: string): { status: PieceStatus; version: Version } => {
    const value = asObject(parseJson(ref, STATUS_FILE, raw));
    if (value === undefined || typeof value['version'] !== 'string' || asObject(value['status']) === undefined) {
      throw new Error(`stored file ${STATUS_FILE} on ref ${ref} does not have the shape of a status record`);
    }
    return { version: value['version'], status: value['status'] as PieceStatus };
  };

  const readStatus = async (
    ref: string,
    commit: string | undefined,
  ): Promise<{ status: PieceStatus; version: Version } | undefined> => {
    const raw = commit === undefined ? undefined : await port.read(commit, STATUS_FILE);
    if (raw === undefined) return undefined;
    return parseStatus(ref, raw);
  };

  const readJournal = async (ref: string, commit: string | undefined): Promise<JournalEntry[]> => {
    const raw = commit === undefined ? undefined : await port.read(commit, JOURNAL_FILE);
    if (raw === undefined) return [];
    const value = parseJson(ref, JOURNAL_FILE, raw);
    if (!Array.isArray(value)) {
      throw new Error(`stored file ${JOURNAL_FILE} on ref ${ref} does not have the shape of a journal`);
    }
    const entries: JournalEntry[] = [];
    for (const item of value) {
      if (asObject(item) === undefined) {
        throw new Error(`stored file ${JOURNAL_FILE} on ref ${ref} does not have the shape of a journal`);
      }
      entries.push(item as JournalEntry);
    }
    return entries;
  };

  const readEffects = async (
    ref: string,
    commit: string | undefined,
  ): Promise<Record<string, EffectRecord>> => {
    const raw = commit === undefined ? undefined : await port.read(commit, EFFECTS_FILE);
    if (raw === undefined) return {};
    const value = asObject(parseJson(ref, EFFECTS_FILE, raw));
    if (value === undefined) {
      throw new Error(`stored file ${EFFECTS_FILE} on ref ${ref} does not have the shape of an effect table`);
    }
    const records: Record<string, EffectRecord> = {};
    for (const [operationId, record] of Object.entries(value)) {
      const fields = asObject(record);
      if (fields === undefined || !isEffectState(fields['state'])) {
        throw new Error(`stored file ${EFFECTS_FILE} on ref ${ref} does not have the shape of an effect table`);
      }
      records[operationId] = record as EffectRecord;
    }
    return records;
  };

  const readLease = async (
    ref: string,
    commit: string | undefined,
  ): Promise<{ readonly runId: RunId; readonly expiresAt: number } | undefined> => {
    const raw = commit === undefined ? undefined : await port.read(commit, LEASE_FILE);
    if (raw === undefined) return undefined;
    const value = asObject(parseJson(ref, LEASE_FILE, raw));
    if (value === undefined || typeof value['runId'] !== 'string' || typeof value['expiresAt'] !== 'number') {
      throw new Error(`stored file ${LEASE_FILE} on ref ${ref} does not have the shape of a lease`);
    }
    return { runId: value['runId'], expiresAt: value['expiresAt'] };
  };

  const readZone = async (
    ref: string,
    commit: string | undefined,
  ): Promise<
    { readonly runId: RunId; readonly piece: PieceId; readonly expiresAt: number } | undefined
  > => {
    const raw = commit === undefined ? undefined : await port.read(commit, LEASE_FILE);
    if (raw === undefined) return undefined;
    const value = asObject(parseJson(ref, LEASE_FILE, raw));
    if (
      value === undefined ||
      typeof value['runId'] !== 'string' ||
      typeof value['piece'] !== 'string' ||
      typeof value['expiresAt'] !== 'number'
    ) {
      throw new Error(`stored file ${LEASE_FILE} on ref ${ref} does not have the shape of a zone lease`);
    }
    return { runId: value['runId'], piece: value['piece'], expiresAt: value['expiresAt'] };
  };

  /**
   * One attempt loop shared by every write, over the single ref the write belongs to. It reads
   * that ref's head, lets the caller decide from that one read, and commits only when there is a
   * change. A commit that lost its race (`undefined`) is retried from a fresh read; after
   * `maxAttempts` losses the ref is declared unstable, which is an Error — not `StaleVersion`,
   * since that is a decision a caller can act on, while a ref that keeps moving is an
   * operational failure.
   */
  const transact = async <T>(
    ref: string,
    decide: (head: string | undefined) => Promise<Decision<T>>,
  ): Promise<T> => {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const head = await port.head(ref);
      const decision = await decide(head);
      if (decision.kind === 'idle') return decision.value;
      const committed = await port.commit(ref, head, decision.plan.changes, decision.plan.message);
      if (committed !== undefined) return decision.after(committed);
      await pause(backoff(attempt));
    }
    throw new Error(`the state ref ${ref} did not stop moving after ${maxAttempts} attempts`);
  };

  const writeEffect = async (
    piece: PieceId,
    operationId: string,
    record: EffectRecord,
    message: string,
  ): Promise<void> => {
    const ref = pieceRef(piece);
    await transact<void>(ref, async (head) => {
      const records = await readEffects(ref, head);
      return {
        kind: 'write',
        plan: {
          changes: { [EFFECTS_FILE]: JSON.stringify({ ...records, [operationId]: record }) },
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
      const ref = pieceRef(piece);
      return transact<Reservation>(ref, async (head) => {
        const held = await readLease(ref, head);
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
            changes: { [LEASE_FILE]: JSON.stringify({ runId, expiresAt }) },
            message: `ai-workflows: reserve piece ${piece}`,
          },
          after: (commit) => ({ ok: true, version: commit }),
        };
      });
    },

    async renew(piece, runId, leaseMs): Promise<Reservation> {
      const ref = pieceRef(piece);
      return transact<Reservation>(ref, async (head) => {
        const held = await readLease(ref, head);
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
            changes: { [LEASE_FILE]: JSON.stringify({ runId, expiresAt }) },
            message: `ai-workflows: renew piece ${piece}`,
          },
          after: (commit) => ({ ok: true, version: commit }),
        };
      });
    },

    async release(piece, runId): Promise<void> {
      const ref = pieceRef(piece);
      return transact<void>(ref, async (head) => {
        const held = await readLease(ref, head);
        // A late release from a previous holder must not free a lease someone else now owns,
        // or two controllers could end up running the same piece.
        if (held === undefined || held.runId !== runId) return { kind: 'idle', value: undefined };
        return {
          kind: 'write',
          plan: {
            changes: { [LEASE_FILE]: null },
            message: `ai-workflows: release piece ${piece}`,
          },
          after: () => undefined,
        };
      });
    },

    async loadStatus(piece: PieceId) {
      const ref = pieceRef(piece);
      const head = await port.head(ref);
      if (head === undefined) return undefined;
      return readStatus(ref, head);
    },

    async saveStatus(status, expected): Promise<Version> {
      const ref = pieceRef(status.piece);
      return transact<Version>(ref, async (head) => {
        const stored = await readStatus(ref, head);
        const current = stored?.version;
        // The token must match what the writer read; `undefined` means «no record yet». A
        // stale token is a caller decision, so it throws now instead of retrying.
        if (expected !== current) throw new StaleVersion(status.piece);
        const version = randomUUID();
        return {
          kind: 'write',
          plan: {
            changes: { [STATUS_FILE]: JSON.stringify({ version, status }) },
            message: `ai-workflows: save status of ${status.piece}`,
          },
          after: () => version,
        };
      });
    },

    async listStatuses(): Promise<readonly PieceStatus[]> {
      const refs = await port.refs('pieces/');
      const statuses: PieceStatus[] = [];
      // Read in bounded batches: a fleet of a thousand pieces must not open a thousand reads at
      // once, but sequential reads would be needlessly slow.
      for (let start = 0; start < refs.length; start += STATUS_READ_BATCH) {
        const batch = refs.slice(start, start + STATUS_READ_BATCH);
        const read = await Promise.all(
          batch.map(async ({ name, commit }) => {
            const raw = await port.read(commit, STATUS_FILE);
            if (raw === undefined) return undefined;
            return parseStatus(name, raw).status;
          }),
        );
        for (const status of read) {
          if (status !== undefined) statuses.push(status);
        }
      }
      return statuses;
    },

    async append(piece, entry): Promise<void> {
      const ref = pieceRef(piece);
      return transact<void>(ref, async (head) => {
        const entries = await readJournal(ref, head);
        const next = [...entries, freezeEntry(entry)];
        return {
          kind: 'write',
          plan: {
            changes: { [JOURNAL_FILE]: JSON.stringify(next) },
            message: `ai-workflows: append to journal of ${piece}`,
          },
          after: () => undefined,
        };
      });
    },

    async journal(piece): Promise<readonly JournalEntry[]> {
      const ref = pieceRef(piece);
      const head = await port.head(ref);
      if (head === undefined) return Object.freeze([]);
      const entries = await readJournal(ref, head);
      // Hand out frozen entries inside a frozen array: the journal is the evidence
      // execution-record gates check, and a caller able to mutate it could rewrite it.
      return Object.freeze(entries.map((item) => freezeEntry(item)));
    },

    async forget(piece, stage): Promise<void> {
      const ref = pieceRef(piece);
      return transact<void>(ref, async (head) => {
        const entries = await readJournal(ref, head);
        const remaining = entries.filter((item) => item.stage !== stage);
        // Nothing of that stage to drop: leave the ref untouched rather than rewrite it.
        if (remaining.length === entries.length) return { kind: 'idle', value: undefined };
        return {
          kind: 'write',
          plan: {
            changes: { [JOURNAL_FILE]: JSON.stringify(remaining) },
            message: `ai-workflows: forget stage ${stage} of ${piece}`,
          },
          after: () => undefined,
        };
      });
    },

    async getEffect(piece, operationId): Promise<EffectRecord | undefined> {
      const ref = pieceRef(piece);
      const head = await port.head(ref);
      if (head === undefined) return undefined;
      const records = await readEffects(ref, head);
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

      const ref = pieceRef(piece);
      const flight = (async (): Promise<T> => {
        try {
          // Claim the effect before running it, so a crash mid-effect leaves `pending`, not
          // absent. Only a stored claim lets us run the effect.
          const claim = await transact<Claim>(ref, async (head) => {
            const records = await readEffects(ref, head);
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
                  [EFFECTS_FILE]: JSON.stringify({
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
      const ref = pieceRef(piece);
      return transact<void>(ref, async (head) => {
        const records = await readEffects(ref, head);
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
              changes: { [EFFECTS_FILE]: JSON.stringify(next) },
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
              [EFFECTS_FILE]: JSON.stringify({
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
      const ref = zoneRef(zone);
      return transact<Reservation>(ref, async (head) => {
        const held = await readZone(ref, head);
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
            changes: { [LEASE_FILE]: JSON.stringify({ runId, piece, expiresAt }) },
            message: `ai-workflows: reserve zone ${zone}`,
          },
          after: (commit) => ({ ok: true, version: commit }),
        };
      });
    },

    async releaseZone(zone, runId): Promise<void> {
      const ref = zoneRef(zone);
      return transact<void>(ref, async (head) => {
        const held = await readZone(ref, head);
        // A late release must not free a zone another controller has since taken.
        if (held === undefined || held.runId !== runId) return { kind: 'idle', value: undefined };
        return {
          kind: 'write',
          plan: {
            changes: { [LEASE_FILE]: null },
            message: `ai-workflows: release zone ${zone}`,
          },
          after: () => undefined,
        };
      });
    },
  };
}
