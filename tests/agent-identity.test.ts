import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { agentCredentialsFromEnv, createAppTokenSource } from '../src/index.js';

// PLAN-13-R4 §1.2 (R21): the engine acts on GitHub as the agents' own GitHub App. It signs a
// short JWT with the app's private key, asks for an installation token and reuses it until five
// minutes before it expires. GitHub is the external edge: `fetch` is a fake here, and the key is
// a fresh RSA pair made by the test. What is pinned: the claims, the reuse, the account check, and
// that neither the token nor the key ever appears in an error.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), 'aiw-agent-'));
  roots.push(root);
  return root;
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

function keyFile(): string {
  const dir = folder();
  const path = join(dir, 'app.pem');
  writeFileSync(path, PEM);
  return path;
}

const TOKEN = 'ghs_s3cr3tInstallationToken000000000000';
const NOW = Date.parse('2026-09-24T12:00:00Z');

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function verifyJwt(jwt: string): Record<string, unknown> {
  const [header, payload, signature] = jwt.split('.');
  expect(decode(header ?? '')).toMatchObject({ alg: 'RS256', typ: 'JWT' });
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${header}.${payload}`);
  expect(verifier.verify(publicKey, Buffer.from(signature ?? '', 'base64url'))).toBe(true);
  return decode(payload ?? '');
}

interface Call { method: string; url: string; authorization: string | null }

/** A fake GitHub API for the three calls the token source makes. */
function fakeGitHub(options: { expiresInMs?: number; slug?: string; fail?: { status: number; body: string } } = {}) {
  const calls: Call[] = [];
  let clock = NOW;
  let issued = 0;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ method: init?.method ?? 'GET', url, authorization: headers.get('authorization') });
    if (options.fail !== undefined) return new Response(options.fail.body, { status: options.fail.status });
    if (url === 'https://api.github.com/repos/duena/proyecto/installation') {
      return Response.json({ id: 777 });
    }
    if (url === 'https://api.github.com/app/installations/777/access_tokens' && init?.method === 'POST') {
      issued += 1;
      return Response.json(
        { token: `${TOKEN}${issued}`, expires_at: new Date(clock + (options.expiresInMs ?? 60 * 60_000)).toISOString() },
        { status: 201 },
      );
    }
    if (url === 'https://api.github.com/app') return Response.json({ slug: options.slug ?? 'mi-motor' });
    return new Response('not found', { status: 404 });
  };
  return {
    calls,
    fetch: fetchImpl as typeof fetch,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('agentCredentialsFromEnv', () => {
  it('reads the app id and the key file', () => {
    const key = keyFile();
    expect(agentCredentialsFromEnv({ AI_WORKFLOWS_APP_ID: '12345', AI_WORKFLOWS_APP_KEY_FILE: key }, folder()))
      .toEqual({ appId: 12345, keyFile: key });
  });

  it('says what is missing', () => {
    expect(agentCredentialsFromEnv({}, folder())).toEqual({ missing: expect.stringMatching(/AI_WORKFLOWS_APP_ID/) });
    expect(agentCredentialsFromEnv({ AI_WORKFLOWS_APP_ID: '1' }, folder()))
      .toEqual({ missing: expect.stringMatching(/AI_WORKFLOWS_APP_KEY_FILE/) });
  });

  it('refuses an id that is not a positive whole number, and a relative key path', () => {
    const key = keyFile();
    for (const id of ['abc', '0', '-3', '1.5', '']) {
      expect(agentCredentialsFromEnv({ AI_WORKFLOWS_APP_ID: id, AI_WORKFLOWS_APP_KEY_FILE: key }, folder()), id)
        .toHaveProperty('refused');
    }
    expect(agentCredentialsFromEnv({ AI_WORKFLOWS_APP_ID: '1', AI_WORKFLOWS_APP_KEY_FILE: 'app.pem' }, folder()))
      .toHaveProperty('refused');
  });

  it('refuses a key file inside the project, however it is spelled', () => {
    const project = folder();
    mkdirSync(join(project, 'keys'));
    const inside = join(project, 'keys', 'app.pem');
    writeFileSync(inside, PEM);
    expect(agentCredentialsFromEnv({ AI_WORKFLOWS_APP_ID: '1', AI_WORKFLOWS_APP_KEY_FILE: inside }, project))
      .toEqual({ refused: expect.stringMatching(/inside the project|dentro del proyecto/) });
    const dotted = join(project, 'keys', '..', 'keys', 'app.pem');
    expect(agentCredentialsFromEnv({ AI_WORKFLOWS_APP_ID: '1', AI_WORKFLOWS_APP_KEY_FILE: dotted }, project))
      .toHaveProperty('refused');
  });
});

describe('createAppTokenSource', () => {
  it('signs a JWT the public key verifies, with the app id and a nine-minute life backdated one minute', async () => {
    const github = fakeGitHub();
    const source = createAppTokenSource({ credentials: { appId: 12345, keyFile: keyFile() }, repository: 'duena/proyecto', fetch: github.fetch, now: github.now });

    await source.token();

    // Both app-level calls (find the installation, mint its token) are signed with the JWT.
    const bearer = github.calls[0]?.authorization ?? '';
    expect(github.calls[1]?.authorization).toBe(bearer);
    expect(bearer.startsWith('Bearer ')).toBe(true);
    const claims = verifyJwt(bearer.slice('Bearer '.length));
    expect(claims).toEqual({ iss: '12345', iat: NOW / 1000 - 60, exp: NOW / 1000 + 540 });
  });

  it('finds the installation of the repository and returns its token', async () => {
    const github = fakeGitHub();
    const source = createAppTokenSource({ credentials: { appId: 12345, keyFile: keyFile() }, repository: 'duena/proyecto', fetch: github.fetch, now: github.now });

    expect(await source.token()).toBe(`${TOKEN}1`);
    expect(github.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET https://api.github.com/repos/duena/proyecto/installation',
      'POST https://api.github.com/app/installations/777/access_tokens',
    ]);
  });

  it('reuses the token while more than five minutes remain, and asks for another after', async () => {
    const github = fakeGitHub({ expiresInMs: 60 * 60_000 });
    const source = createAppTokenSource({ credentials: { appId: 12345, keyFile: keyFile() }, repository: 'duena/proyecto', fetch: github.fetch, now: github.now });

    expect(await source.token()).toBe(`${TOKEN}1`);
    github.advance(54 * 60_000);
    expect(await source.token()).toBe(`${TOKEN}1`);
    github.advance(60_001);
    expect(await source.token()).toBe(`${TOKEN}2`);
    expect(github.calls.filter((call) => call.method === 'POST')).toHaveLength(2);
  });

  it('reports the account as <slug>[bot]', async () => {
    const github = fakeGitHub({ slug: 'mi-motor' });
    const source = createAppTokenSource({ credentials: { appId: 12345, keyFile: keyFile() }, repository: 'duena/proyecto', fetch: github.fetch, now: github.now });

    expect(await source.account()).toBe('mi-motor[bot]');
  });

  it('never puts the token or the key in an error', async () => {
    const github = fakeGitHub({ fail: { status: 500, body: `boom ${TOKEN} ${PEM}` } });
    const source = createAppTokenSource({ credentials: { appId: 12345, keyFile: keyFile() }, repository: 'duena/proyecto', fetch: github.fetch, now: github.now });

    const error = await source.token().then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const text = `${(error as Error).message} ${(error as Error).stack ?? ''}`;
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(text).not.toContain(PEM.split('\n')[1] ?? 'unreachable');
    expect(text).toMatch(/500/);
  });

  it('a key file that is not a private key is an error that does not show its content', async () => {
    const dir = folder();
    const bad = join(dir, 'bad.pem');
    writeFileSync(bad, 'not a key but a secret-ish line');
    const github = fakeGitHub();
    const source = createAppTokenSource({ credentials: { appId: 1, keyFile: bad }, repository: 'duena/proyecto', fetch: github.fetch, now: github.now });

    const error = await source.token().then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('secret-ish');
  });
});
