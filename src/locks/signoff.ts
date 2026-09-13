// The owner's sign-off and the merge check: layer 3 of the locks (see ../locks.ts).

import { requireDifferentBuilder, requireFreshVerdicts } from '../identity.js';
import type { ExecutionIdentity, Verdict } from '../identity.js';

export interface PullRequestComment {
  readonly body: string;
  readonly author: string;
  /** GitHub's `user.type`: `User`, `Bot` or `Organization`. */
  readonly authorType: string;
  /** Whether GitHub reports it as posted through an app (`performed_via_github_app`). */
  readonly performedViaApp: boolean;
  /** Whether it was edited after posting: anyone with write access can edit a comment. */
  readonly edited: boolean;
}

export interface SignOffRules {
  /** GitHub logins allowed to sign off. */
  readonly productOwners: readonly string[];
  /** The head of the pull request right now. */
  readonly headSha: string;
}

/** An order alone on its line: the command and exactly one token, nothing else. */
const SIGN_OFF_LINE = /^\/visto-bueno\s+(\S+)$/;

/** An opening fence: three or more backticks or three or more tildes. */
const SIGN_OFF_FENCE = /^(`{3,}|~{3,})/;

/**
 * A full SHA-1 (40 hex) or SHA-256 (64 hex). Seven characters were enough for GitHub to
 * display a version, but two different commits can share their first seven characters, so a
 * prefix cannot name which version was approved. Only the complete hash can.
 */
const FULL_SHA = /^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/;

/**
 * A GitHub login: ASCII letters, digits and hyphens. GitHub logins are plain ASCII, so a
 * Unicode character that lower-cases into an owner's login (for example U+212A KELVIN SIGN
 * folding into "k") must never be treated as that owner.
 */
const LOGIN = /^[A-Za-z0-9-]+$/;

interface OrderLine {
  readonly sha: string;
  /** True where the order is not really written: a quote, a code block or hidden HTML. */
  readonly hidden: boolean;
}

interface SignOffEvaluation {
  readonly ok: boolean;
  readonly hadOrder: boolean;
  readonly sha: string;
  readonly reason: string;
}

/** A region, opened on one line and closed on a later one, where an order does not count. */
interface Fence {
  readonly char: '`' | '~';
  readonly length: number;
}

/** Whether a line would close the open fence: same marker, at least as long as the opener. */
function closesFence(raw: string, fence: Fence): boolean {
  const marker = SIGN_OFF_FENCE.exec(raw.replace(/^ {0,3}/, ''))?.[1];
  return marker !== undefined && marker[0] === fence.char && marker.length >= fence.length;
}

/**
 * Every line that could be an order, marked as hidden when it sits where an order would not
 * really be written. A line counts only when it is exactly `/visto-bueno <sha>`; the caller
 * decides what a hidden one means.
 */
function collectOrderLines(body: string): readonly OrderLine[] {
  const orders: OrderLine[] = [];
  // A fenced block is literal text until its own marker closes it, so tags and quotes inside
  // are content, not regions. HTML comments, <details> and <pre> hide their contents from
  // the rendered page even across lines.
  let fence: Fence | undefined;
  let htmlComment = false;
  let details = false;
  let pre = false;

  for (const raw of body.split(/\r?\n/)) {
    if (fence) {
      if (closesFence(raw, fence)) fence = undefined;
      continue;
    }
    if (htmlComment) {
      if (raw.includes('-->')) htmlComment = false;
      continue;
    }
    if (details) {
      if (raw.includes('</details>')) details = false;
      continue;
    }
    if (pre) {
      if (raw.includes('</pre>')) pre = false;
      continue;
    }

    // A comment that both opens and closes on one line hides only that line.
    if (raw.includes('<!--')) {
      if (!raw.includes('-->')) htmlComment = true;
      continue;
    }
    if (raw.includes('<details')) {
      details = true;
      continue;
    }
    if (raw.includes('<pre')) {
      pre = true;
      continue;
    }

    const opener = SIGN_OFF_FENCE.exec(raw.replace(/^ {0,3}/, ''))?.[1];
    if (opener !== undefined) {
      fence = { char: opener[0] === '~' ? '~' : '`', length: opener.length };
      continue;
    }

    const line = raw.trim();
    const match = SIGN_OFF_LINE.exec(line);
    if (match?.[1] === undefined) continue;

    // Four leading spaces or a tab makes an indented code block; `>` documents someone
    // else's words. Neither is an order the owner gave.
    const indented = raw.startsWith('    ') || raw.startsWith('\t');
    orders.push({ sha: match[1], hidden: indented || line.startsWith('>') });
  }

  return orders;
}

/**
 * Reads what a comment really carries: how many orders, and if exactly one, whether it is
 * genuine and names the current head.
 */
function evaluateSignOff(comment: PullRequestComment, rules: SignOffRules): SignOffEvaluation {
  const orders = collectOrderLines(comment.body);
  const genuine = orders.filter((order) => !order.hidden);
  const hadOrder = orders.length > 0;
  const noOrder = (): SignOffEvaluation => ({
    ok: false,
    hadOrder,
    sha: '',
    reason: 'No hay ninguna orden /visto-bueno en su propia línea en este comentario.',
  });
  const rejected = (reason: string): SignOffEvaluation => ({ ok: false, hadOrder, sha: '', reason });

  const first = genuine[0];
  if (first === undefined) {
    // No genuine order is a valid answer. The caller must be able to tell "nobody signed
    // off" from "someone tried and was rejected", so each gets its own message.
    return noOrder();
  }
  // Two orders in one comment are ambiguous: nobody can say which version was approved.
  if (genuine.length > 1) {
    return rejected(
      `Este comentario trae ${genuine.length} órdenes /visto-bueno: no queda claro cuál vale, así que ninguna cuenta.`,
    );
  }

  // Anyone with write access can edit a comment and GitHub still shows the original author,
  // so an edited comment no longer proves what the owner approved.
  if (comment.edited) {
    return rejected(
      'El comentario fue editado después de publicarse: cualquiera con permiso de escritura pudo cambiar la orden, así que no cuenta.',
    );
  }
  if (comment.performedViaApp) {
    return rejected(
      'El comentario se publicó a través de una aplicación: no prueba que lo escribiera el dueño.',
    );
  }
  // A bot or organization account is never the person whose sign-off this process needs.
  if (comment.authorType !== 'User') {
    return rejected(
      `El comentario no lo escribió una cuenta de persona ("${comment.authorType}"): su visto bueno no cuenta.`,
    );
  }
  // Empty logins never match; a login is ASCII and compared without case, so a character
  // that only folds into an owner's login is refused too. The message names the author so
  // the report says who tried.
  const author = comment.author.toLowerCase();
  const isOwner = LOGIN.test(comment.author)
    && rules.productOwners.some((owner) => LOGIN.test(owner) && owner.toLowerCase() === author);
  if (!isOwner) {
    return rejected(`El autor "${comment.author}" no es un product owner: su visto bueno no cuenta.`);
  }

  if (!FULL_SHA.test(first.sha)) {
    return rejected(
      `"${first.sha}" no es un SHA válido: debe ser hexadecimal de 40 o 64 caracteres.`,
    );
  }
  // Name both versions: the author sees which one they approved and which one is live now.
  if (first.sha.toLowerCase() !== rules.headSha.toLowerCase()) {
    return rejected(
      `El visto bueno es para ${first.sha.slice(0, 7)}, pero la versión actual es ` +
        `${rules.headSha.slice(0, 7)}: un visto bueno no cubre una versión distinta.`,
    );
  }

  return { ok: true, hadOrder, sha: first.sha, reason: '' };
}

/**
 * `/visto-bueno <full sha>` on its own line, unedited, from a product owner, naming the
 * current head. The SHA matters in full: a prefix cannot name one version, and a sign-off of
 * an older version does not cover a newer one.
 */
export function parseSignOff(
  comment: PullRequestComment,
  rules: SignOffRules,
): { readonly ok: true; readonly sha: string } | { readonly ok: false; readonly reason: string } {
  const evaluation = evaluateSignOff(comment, rules);
  return evaluation.ok
    ? { ok: true, sha: evaluation.sha }
    : { ok: false, reason: evaluation.reason };
}

export interface MergeCheckInput {
  readonly headSha: string;
  readonly builder: ExecutionIdentity;
  readonly verdicts: readonly Verdict[];
  readonly requiredAngles?: readonly string[];
  readonly differentProvider?: boolean;
  /** Whether this piece has something visible, and so needs the owner's sign-off. */
  readonly needsSignOff: boolean;
  readonly comments: readonly PullRequestComment[];
  readonly productOwners: readonly string[];
}

export interface MergeCheckResult {
  readonly conclusion: 'success' | 'failure';
  /** Every reason it failed, not just the first. */
  readonly summary: string;
  /** What this check cannot prove even when it passes, said out loud. */
  readonly limits: readonly string[];
}

/**
 * What a sign-off by comment can never prove: while the agents post with the owner's GitHub
 * account, a comment shows which account wrote it, not which person. Declared on every
 * result, including a green one, so nobody reads a pass as more than it is.
 */
const SIGN_OFF_LIMITS: readonly string[] = [
  'El visto bueno por comentario prueba qué cuenta de GitHub lo escribió, no qué persona: mientras los agentes publiquen con la cuenta del dueño, un agente podría escribirlo.',
];

/** What the server check concludes, composed from the identity and sign-off rules. */
export function concludeMergeCheck(input: MergeCheckInput): MergeCheckResult {
  // Every rule is evaluated before deciding, so one report lists the whole task instead of
  // making the author fix the reasons one run at a time. The gate functions are reused, not
  // reimplemented, so the verdict cannot drift from the identity rules.
  const reasons: string[] = [];

  // 1. Nobody approves their own work, judged by execution and not by GitHub account.
  // Optional fields are only set when present: `exactOptionalPropertyTypes` treats an
  // explicit `undefined` as different from an absent key.
  const independence = requireDifferentBuilder(
    input.verdicts,
    input.builder,
    input.differentProvider === undefined ? undefined : { differentProvider: input.differentProvider },
  );
  if (!independence.ok) reasons.push(independence.reason);

  // 2. The reviews must be of the code as it is now and cover every required angle.
  const freshness = requireFreshVerdicts(
    input.verdicts,
    input.headSha,
    input.requiredAngles === undefined ? undefined : { angles: input.requiredAngles },
  );
  if (!freshness.ok) reasons.push(freshness.reason);

  // 3. Something visible needs the owner's sign-off for the current version. One valid
  //    comment is enough: an older sign-off followed by a newer one is exactly the normal
  //    case of a re-review, and each comment is judged on its own.
  if (input.needsSignOff) {
    const evaluations = input.comments.map((comment) =>
      evaluateSignOff(comment, { productOwners: input.productOwners, headSha: input.headSha }),
    );
    if (!evaluations.some((evaluation) => evaluation.ok)) {
      // Name the order so the report says what to do, not just what is missing.
      reasons.push(
        'Falta el visto bueno del dueño: se necesita un comentario con la orden ' +
          '/visto-bueno <sha> que apunte a la versión actual.',
      );
      // "Missing" alone hides whether the order named another version, was edited, or came
      // from someone else. Say why each comment that carried an order did not count.
      for (const evaluation of evaluations) {
        if (!evaluation.ok && evaluation.hadOrder) reasons.push(evaluation.reason);
      }
    }
  }

  if (reasons.length === 0) {
    return {
      conclusion: 'success',
      summary:
        'Todo en orden: revisiones válidas y, si hacía falta, el visto bueno del dueño.',
      limits: SIGN_OFF_LIMITS,
    };
  }

  return { conclusion: 'failure', summary: reasons.join(' '), limits: SIGN_OFF_LIMITS };
}
