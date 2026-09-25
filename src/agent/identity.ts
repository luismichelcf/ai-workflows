// PLAN-13-R4 §1.2 (R21): the agents' own GitHub identity. The engine signs a short JWT with
// the private key of the owner's GitHub App, finds the app's installation in the repository,
// mints an installation token and reuses it until five minutes before it expires. Everything
// goes through an injectable `fetch` (GitHub is the external edge), and no error ever carries
// the token or the key.

import { createSign } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface AgentCredentials {
  readonly appId: number;
  readonly keyFile: string;
}

export type AgentCredentialsResult =
  | AgentCredentials
  | { readonly missing: string }
  | { readonly refused: string };

/** The environment variables that carry the app identity. */
export const APP_ID_ENV = 'AI_WORKFLOWS_APP_ID';
export const APP_KEY_FILE_ENV = 'AI_WORKFLOWS_APP_KEY_FILE';

/** A positive whole number, with no sign, no decimal point and no surrounding space. */
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/**
 * The real path of a file or folder, resolving links and junctions. A path that does not exist
 * yet is left as written: the check then compares spellings, never a resolved path it cannot read.
 */
function realOrWritten(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** Whether `file` resolves inside `root`, however either is spelled or reached; `root` counts. */
function isInsideProject(root: string, file: string): boolean {
  const inside = relative(realOrWritten(root), realOrWritten(file));
  return inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside));
}

/**
 * Reads `AI_WORKFLOWS_APP_ID` and `AI_WORKFLOWS_APP_KEY_FILE`. A variable that is absent says
 * what is missing; a variable that is present but unusable is refused, and so is a key file
 * that lives inside the repository (the key must never travel with the code).
 */
export function agentCredentialsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  projectRoot: string,
): AgentCredentialsResult {
  const rawId = env[APP_ID_ENV];
  if (rawId === undefined) return { missing: `${APP_ID_ENV} is not set` };
  const rawKey = env[APP_KEY_FILE_ENV];
  if (rawKey === undefined) return { missing: `${APP_KEY_FILE_ENV} is not set` };

  if (!POSITIVE_INTEGER.test(rawId)) {
    return { refused: `${APP_ID_ENV} "${rawId}" is not a positive whole number` };
  }
  if (!isAbsolute(rawKey)) {
    return { refused: `${APP_KEY_FILE_ENV} "${rawKey}" is not an absolute path` };
  }
  if (isInsideProject(projectRoot, rawKey)) {
    return { refused: `${APP_KEY_FILE_ENV} is inside the project; the key must live outside it` };
  }
  return { appId: Number.parseInt(rawId, 10), keyFile: rawKey };
}

/** What the token source needs from `fetch`: only the parts the three calls use. */
export interface FetchLike {
  (input: string, init?: FetchInit): Promise<FetchResponse>;
}

export interface FetchInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface AppTokenSourceOptions {
  readonly credentials: AgentCredentials;
  /** `owner/name`, as GitHub reports it. */
  readonly repository: string;
  /** Defaults to the global `fetch`; GitHub is the external edge. */
  readonly fetch?: FetchLike;
  /** Milliseconds since the epoch; injected so the token's life is testable. */
  readonly now?: () => number;
}

export interface AppTokenSource {
  /** A live installation token, minted again only when fewer than five minutes remain. */
  token(): Promise<string>;
  /** The account GitHub reports for the app, as `<slug>[bot]`. */
  account(): Promise<string>;
}

const GITHUB_API = 'https://api.github.com';
/** Reuse the token while more than this many milliseconds remain before it expires. */
const REUSE_MARGIN_MS = 5 * 60_000;

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Signs JWTs for the app and mints the installation tokens of one repository. The private key
 * is read on every signing, so a rotated key is picked up without restarting the engine.
 */
export function createAppTokenSource(options: AppTokenSourceOptions): AppTokenSource {
  const doFetch: FetchLike = options.fetch ?? (fetch as unknown as FetchLike);
  const now = options.now ?? ((): number => Date.now());

  let cachedToken: string | undefined;
  let cachedExpiresAt = 0;
  let cachedSlug: string | undefined;

  function jwt(): string {
    const seconds = Math.floor(now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    // Only these three claims: a signature over anything else would not match the rule.
    const payload = base64url(
      JSON.stringify({ iss: String(options.credentials.appId), iat: seconds - 60, exp: seconds + 540 }),
    );
    const signing = `${header}.${payload}`;

    let key: string;
    try {
      key = readFileSync(options.credentials.keyFile, 'utf8');
    } catch {
      // The filesystem error may carry the path, so it is replaced by a fixed message.
      throw new Error('the app private key file could not be read');
    }
    let signature: Buffer;
    try {
      signature = createSign('RSA-SHA256').update(signing).sign(key);
    } catch {
      // Node's message for an unusable key never carries the file's content; this one cannot
      // either, and the test pins that the content never shows up.
      throw new Error('the app private key is not a usable RSA private key');
    }
    return `${signing}.${base64url(signature)}`;
  }

  async function request(url: string, init: FetchInit, what: string): Promise<Record<string, unknown>> {
    const response = await doFetch(url, init);
    if (!response.ok) {
      // The body may echo the token or the key (a proxy or a log could), so it is never read.
      throw new Error(`GitHub replied ${response.status} while reading ${what}`);
    }
    const body = (await response.json()) as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error(`GitHub did not answer an object while reading ${what}`);
    }
    return body as Record<string, unknown>;
  }

  async function freshToken(): Promise<string> {
    const authorization = `Bearer ${jwt()}`;
    const headers = { authorization, accept: 'application/vnd.github+json' };
    const installation = await request(
      `${GITHUB_API}/repos/${options.repository}/installation`,
      { headers },
      'the app installation of the repository',
    );
    const id = installation['id'];
    if (typeof id !== 'number') {
      throw new Error('GitHub did not report the installation id');
    }
    const issued = await request(
      `${GITHUB_API}/app/installations/${String(id)}/access_tokens`,
      { method: 'POST', headers },
      'an installation token',
    );
    const token = issued['token'];
    const expiresAt = issued['expires_at'];
    if (typeof token !== 'string' || typeof expiresAt !== 'string') {
      throw new Error('GitHub did not report the installation token and its expiry');
    }
    cachedToken = token;
    cachedExpiresAt = Date.parse(expiresAt);
    return token;
  }

  return {
    async token(): Promise<string> {
      if (cachedToken !== undefined && now() < cachedExpiresAt - REUSE_MARGIN_MS) {
        return cachedToken;
      }
      return freshToken();
    },

    async account(): Promise<string> {
      if (cachedSlug !== undefined) return `${cachedSlug}[bot]`;
      const app = await request(
        `${GITHUB_API}/app`,
        { headers: { authorization: `Bearer ${jwt()}`, accept: 'application/vnd.github+json' } },
        'the app identity',
      );
      const slug = app['slug'];
      if (typeof slug !== 'string') throw new Error('GitHub did not report the app slug');
      cachedSlug = slug;
      return `${slug}[bot]`;
    },
  };
}
