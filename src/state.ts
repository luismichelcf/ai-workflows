import {
  EffectNeedsReconciliation,
  StaleVersion,
  type EffectRecord,
  type JournalEntry,
  type JsonValue,
  type PieceId,
  type PieceStatus,
  type Reservation,
  type RunId,
  type Store,
  type Version,
  type VersionedStatus,
} from './contract.js';

export interface MemoryStoreOptions {
  /** Injected so leases can be tested without waiting on the wall clock. */
  readonly now?: () => number;
}

interface HeldLease {
  readonly runId: RunId;
  readonly expiresAt: number;
}

interface StoredStatus {
  readonly status: PieceStatus;
  readonly version: Version;
}

/**
 * A round trip through JSON, the exact journey a result makes over the remote store, which
 * keeps it as text. The memory store must make the same trip: otherwise a `Date` stays a
 * `Date` here and only comes back a string on a resume in production, the one path nobody
 * exercises by hand. Cloning on the way out also keeps a caller from mutating what is stored.
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

/**
 * In-memory reference implementation of `Store`.
 *
 * It is deliberately the model for the GitHub-backed store to come, so it never relies on
 * writes being instant or on a read and the write that follows being one atomic step: each
 * mutation here re-reads the record it acts on and decides from that single read. Over a
 * remote, that same shape is what makes an optimistic write fail instead of overwrite.
 */
export function createMemoryStore(options: MemoryStoreOptions = {}): Store {
  const now = options.now ?? Date.now;

  // Monotonic source of optimistic tokens. A fresh token per write, never reused, is what
  // lets a writer prove it saw the current record before overwriting it.
  let counter = 0;
  const nextVersion = (): Version => `v${(counter += 1)}`;

  const leases = new Map<PieceId, HeldLease>();
  // Zones are shared resources, not pieces, so they get their own lease table: a piece and
  // a zone that happen to share a name must not be able to lock each other out.
  const zoneLeases = new Map<string, HeldLease>();
  const statuses = new Map<PieceId, StoredStatus>();
  const journals = new Map<PieceId, JournalEntry[]>();
  const effects = new Map<PieceId, Map<string, EffectRecord>>();

  // Effect calls that are mid-flight, keyed like the records. A second caller arriving
  // before the first finishes must join the promise instead of starting a duplicate effect.
  const inFlight = new Map<PieceId, Map<string, Promise<unknown>>>();

  const effectBucket = (piece: PieceId): Map<string, EffectRecord> => {
    let bucket = effects.get(piece);
    if (bucket === undefined) {
      bucket = new Map();
      effects.set(piece, bucket);
    }
    return bucket;
  };

  const confirmed = (result: JsonValue): EffectRecord => ({
    state: 'confirmed',
    result: throughJson(result),
  });

  return {
    async reserve(piece, runId, leaseMs): Promise<Reservation> {
      const held = leases.get(piece);
      const current = now();
      // A live lease held by a different controller wins. A dead one (expired) or one's own
      // lease is taken over: without expiry a process killed mid-run would reserve forever.
      if (held !== undefined && held.runId !== runId && held.expiresAt > current) {
        return { ok: false, heldBy: held.runId, expiresAt: held.expiresAt };
      }
      const version = nextVersion();
      leases.set(piece, { runId, expiresAt: current + leaseMs });
      return { ok: true, version };
    },

    async renew(piece, runId, leaseMs): Promise<Reservation> {
      const held = leases.get(piece);
      // Only the holder extends its own lease. A free piece has no holder, so we must not
      // name the caller: reporting them as the owner would be a lie about who holds it.
      if (held === undefined) {
        return { ok: false, heldBy: '', expiresAt: now() };
      }
      if (held.runId !== runId) {
        return { ok: false, heldBy: held.runId, expiresAt: held.expiresAt };
      }
      const expiresAt = now() + leaseMs;
      leases.set(piece, { runId, expiresAt });
      return { ok: true, version: nextVersion() };
    },

    async release(piece, runId): Promise<void> {
      const held = leases.get(piece);
      // A late release from a previous holder must not free a lease that someone else now
      // owns, or two controllers could end up running the same piece.
      if (held !== undefined && held.runId === runId) {
        leases.delete(piece);
      }
    },

    async loadStatus(piece): Promise<VersionedStatus | undefined> {
      return statuses.get(piece);
    },

    async saveStatus(status, expected): Promise<Version> {
      const current = statuses.get(status.piece);
      const currentVersion = current?.version;
      // The token must match what the writer read; `undefined` means "no record yet".
      if (expected !== currentVersion) {
        throw new StaleVersion(status.piece);
      }
      const version = nextVersion();
      statuses.set(status.piece, { status, version });
      return version;
    },

    async listStatuses(): Promise<readonly PieceStatus[]> {
      return [...statuses.values()].map((stored) => stored.status);
    },

    async append(piece, entry): Promise<void> {
      const frozen = freezeEntry(entry);
      const entries = journals.get(piece);
      if (entries === undefined) journals.set(piece, [frozen]);
      else entries.push(frozen);
    },

    async journal(piece): Promise<readonly JournalEntry[]> {
      // Hand out a frozen copy: the journal is the evidence execution-record gates check,
      // and a caller able to mutate it in place could rewrite that evidence.
      return Object.freeze([...(journals.get(piece) ?? [])]);
    },

    async forget(piece, stage): Promise<void> {
      // Retiring a stage must not leave a piece wedged on evidence for a stage the pipeline
      // no longer has. Dropping just that stage's entries lets it resume by what remains.
      const entries = journals.get(piece);
      if (entries === undefined) return;
      const remaining = entries.filter((entry) => entry.stage !== stage);
      if (remaining.length === 0) journals.delete(piece);
      else journals.set(piece, remaining);
    },

    async getEffect(piece, operationId): Promise<EffectRecord | undefined> {
      const record = effects.get(piece)?.get(operationId);
      if (record === undefined || record.state !== 'confirmed' || record.result === undefined) {
        return record;
      }
      // Clone the result too: a caller must not be able to edit what is stored through it.
      return { state: 'confirmed', result: throughJson(record.result as JsonValue) };
    },

    async runEffect<T extends JsonValue>(
      piece: PieceId,
      operationId: string,
      effect: () => Promise<T>,
    ): Promise<T> {
      const bucket = effectBucket(piece);

      // Check the in-flight marker first: a duplicate arriving while the first call is still
      // running must join it, not read the `pending` record we just wrote and refuse.
      let bucketFlights = inFlight.get(piece);
      const existing = bucketFlights?.get(operationId);
      if (existing !== undefined) {
        return existing.then((value) => throughJson(value as T));
      }

      const record = bucket.get(operationId);
      if (record !== undefined) {
        if (record.state === 'confirmed') {
          // Already reached the outside world once; return that result without repeating it.
          return throughJson(record.result as T);
        }
        // Pending or uncertain: whether the effect landed is unknown. Blindly retrying is
        // how a second pull request gets opened, so report instead.
        throw new EffectNeedsReconciliation(piece, operationId, record.state);
      }

      // Claim before awaiting anything: two overlapping calls must see this marker. The
      // marker is a promise, so the later caller joins the same effect instead of running it.
      bucket.set(operationId, { state: 'pending' });
      const flight = (async (): Promise<T> => {
        try {
          const result = await effect();
          bucket.set(operationId, confirmed(result));
          return result;
        } catch (error) {
          // The effect may or may not have reached the world; leave it for reconciliation
          // and let the failure propagate rather than swallowing it.
          bucket.set(operationId, { state: 'uncertain' });
          throw error;
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

      if (bucketFlights === undefined) {
        bucketFlights = new Map();
        inFlight.set(piece, bucketFlights);
      }
      bucketFlights.set(operationId, flight);
      return flight.then((value) => throughJson(value));
    },

    async reconcileEffect(piece, operationId, outcome): Promise<void> {
      // The contract has two explicit outcomes. A bare value is also accepted because a
      // caller written against the previous single-result signature still passes one; the
      // wrapper is the only unambiguous way to confirm a value shaped like `didNotHappen`.
      if (typeof outcome === 'object' && outcome !== null && 'didNotHappen' in outcome) {
        // Checked against the outside world and found absent: drop the record so the next
        // `runEffect` genuinely runs again. The alternative is inventing a result to move on.
        const bucket = effects.get(piece);
        if (bucket === undefined) return;
        bucket.delete(operationId);
        if (bucket.size === 0) effects.delete(piece);
        return;
      }
      const value: JsonValue =
        typeof outcome === 'object' && outcome !== null && 'confirmed' in outcome
          ? outcome.confirmed
          : (outcome as JsonValue);
      effectBucket(piece).set(operationId, confirmed(value));
    },

    async reserveZone(zone, _piece, runId, leaseMs): Promise<Reservation> {
      const held = zoneLeases.get(zone);
      const current = now();
      // Same lease semantics as a piece: a live lease held by someone else wins, an expired
      // one is taken over so a zone never stays locked by a dead controller.
      if (held !== undefined && held.runId !== runId && held.expiresAt > current) {
        return { ok: false, heldBy: held.runId, expiresAt: held.expiresAt };
      }
      const version = nextVersion();
      zoneLeases.set(zone, { runId, expiresAt: current + leaseMs });
      return { ok: true, version };
    },

    async releaseZone(zone, runId): Promise<void> {
      const held = zoneLeases.get(zone);
      // A late release must not free a zone that another controller has since taken.
      if (held !== undefined && held.runId === runId) {
        zoneLeases.delete(zone);
      }
    },
  };
}
