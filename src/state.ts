import {
  EffectNeedsReconciliation,
  StaleVersion,
  type EffectRecord,
  type JournalEntry,
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

  const confirmed = (result: unknown): EffectRecord =>
    result === undefined ? { state: 'confirmed' } : { state: 'confirmed', result };

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
      // Only the holder extends its own lease; anyone else is told who to wait for.
      if (held === undefined || held.runId !== runId) {
        return {
          ok: false,
          heldBy: held?.runId ?? runId,
          expiresAt: held?.expiresAt ?? now(),
        };
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
      const entries = journals.get(piece);
      if (entries === undefined) journals.set(piece, [entry]);
      else entries.push(entry);
    },

    async journal(piece): Promise<readonly JournalEntry[]> {
      // Hand out a frozen copy: the journal is the evidence execution-record gates check,
      // and a caller able to mutate it in place could rewrite that evidence.
      return Object.freeze([...(journals.get(piece) ?? [])]);
    },

    async getEffect(piece, operationId): Promise<EffectRecord | undefined> {
      return effects.get(piece)?.get(operationId);
    },

    async runEffect<T>(
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
        return existing as Promise<T>;
      }

      const record = bucket.get(operationId);
      if (record !== undefined) {
        if (record.state === 'confirmed') {
          // Already reached the outside world once; return that result without repeating it.
          return record.result as T;
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
      return flight;
    },

    async reconcileEffect(piece, operationId, result): Promise<void> {
      effectBucket(piece).set(operationId, confirmed(result));
    },
  };
}
