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

/**
 * An opening fence: up to three spaces, then three or more backticks or three or more tildes.
 * GitHub treats four or more leading spaces as an indented code block, not a fence, so the
 * `{0,3}` is exact, not a convenience.
 */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** The real `<details` and `<pre` tags: the name must end at a space, `>`, `/` or the line,
 * so `/<details/>` is a tag while a word like `<preview>` is not. The `/` matters because a
 * self-closing `<details/>` still opens a details in HTML: the slash is ignored. Case matters
 * no more in HTML than in GitHub's renderer. They carry the `g` flag because the
 * left-to-right scan advances through a line. */
const DETAILS_OPEN = /<details(?=[\s>/]|$)/gi;
const DETAILS_CLOSE = '</details>';
const PRE_OPEN = /<pre(?=[\s>]|$)/gi;
const PRE_CLOSE = '</pre>';

/** A list item marker at the start: up to three spaces, `-`/`*`/`+` or a number, then a space.
 * It is a container, not content, so removing it is what exposes a fence or quote written
 * at the start of an item. */
const LIST_MARKER = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/;

/** An ATX heading: up to three spaces, one to six `#`, then a space or the end of the line.
 * A heading interrupts the paragraph inside a block quote, so it ends the quote. */
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;

/**
 * Drops inline code spans (matched runs of backticks) from a line. A tag or comment marker
 * written inside backticks is literal text GitHub displays as typed, not markup, so it must
 * not open a hidden region. Fences are found separately; this only serves the tag search.
 */
function stripInlineCode(raw: string): string {
  return raw.replace(/(`+)([\s\S]*?)\1/g, '');
}

/**
 * Width of a run of text in columns, a tab advancing to the next multiple of four. CommonMark
 * measures indentation this way, so a space plus a tab is four columns — an indented code
 * block — even though it is only two characters.
 */
function columnWidth(text: string): number {
  let columns = 0;
  for (const char of text) {
    if (char === '\t') columns += 4 - (columns % 4);
    else columns += 1;
  }
  return columns;
}

/** How far a line is indented, in columns, before its first non-blank character. */
function indentColumns(raw: string): number {
  let columns = 0;
  for (const char of raw) {
    if (char === ' ') columns += 1;
    else if (char === '\t') columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

/** Where a list item's content starts, or `undefined` when the line opens no item. The marker
 * and the whitespace after it set that column; what follows is the item's own content. */
function listContentColumn(raw: string): number | undefined {
  const match = LIST_MARKER.exec(raw);
  return match === null ? undefined : columnWidth(match[0]);
}

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
  /** The column where a list item's content starts when the fence opened in that item, or
   * `undefined` for a top-level fence. A fence inside an item closes on a marker indented
   * from that column up to three further, and ends early when a non-blank line is less
   * indented than the column, because the item itself has ended. */
  readonly contentColumn: number | undefined;
}

/** The regions that hide the text they wrap from the rendered page. Each can open and close
 * several times on a line, so what matters is the state the last marker leaves behind. */
interface HiddenState {
  readonly comment: boolean;
  /** How many `<details>` are still open. They nest, so only the close that brings this back
   * to zero ends the hidden region; an inner `</details>` closes the inner one alone. */
  readonly details: number;
  readonly pre: boolean;
}

/** The state after scanning a line, plus whether any marker appeared on it. */
interface HiddenScan extends HiddenState {
  readonly touched: boolean;
}

/**
 * Position of the next matching tag from `from` onwards, or `-1`. The regex is shared and
 * stateful, so its cursor is set before every search.
 */
function indexOfTag(lower: string, tag: RegExp, from: number): number {
  tag.lastIndex = from;
  const match = tag.exec(lower);
  return match === null ? -1 : match.index;
}

/**
 * Reads a line left to right and returns the state its last marker leaves, exactly as GitHub
 * does: `<details>a</details><details>` still leaves a details open, and `<!-- a --> b <!--`
 * still leaves a comment open. Inline code is dropped first, because a marker written inside
 * backticks is literal text GitHub shows as typed, not markup.
 */
function scanHidden(raw: string, state: HiddenState): HiddenScan {
  const lower = stripInlineCode(raw).toLowerCase();
  let { comment, details, pre } = state;
  // A line that begins inside a region is already hidden; any marker seen keeps it so.
  let touched = comment || details > 0 || pre;
  let at = 0;

  while (at < lower.length) {
    if (comment) {
      const close = lower.indexOf('-->', at);
      if (close === -1) break;
      comment = false;
      touched = true;
      at = close + 3;
      continue;
    }
    if (pre) {
      const close = lower.indexOf(PRE_CLOSE, at);
      if (close === -1) break;
      pre = false;
      touched = true;
      at = close + PRE_CLOSE.length;
      continue;
    }

    // The earliest marker decides. While a details is open both its nested opens and its
    // closes are candidates, so `<details><details></details>` leaves one open and the next
    // `</details>` is the one that closes the region.
    const commentAt = lower.indexOf('<!--', at);
    const detailsOpenAt = indexOfTag(lower, DETAILS_OPEN, at);
    const detailsCloseAt = details > 0 ? lower.indexOf(DETAILS_CLOSE, at) : -1;
    const preAt = indexOfTag(lower, PRE_OPEN, at);
    const candidates = [commentAt, detailsOpenAt, detailsCloseAt, preAt].filter((index) => index !== -1);
    if (candidates.length === 0) break;
    const next = Math.min(...candidates);
    touched = true;
    if (next === commentAt) {
      comment = true;
      at = next + 4;
    } else if (next === detailsOpenAt) {
      details += 1;
      at = next + '<details'.length;
    } else if (next === detailsCloseAt) {
      details -= 1;
      at = next + DETAILS_CLOSE.length;
    } else {
      pre = true;
      at = next + '<pre'.length;
    }
  }

  return { comment, details, pre, touched };
}

/**
 * A line that is nothing but a fence marker: its indentation in columns and the marker run,
 * or `undefined` when the line carries anything else. The "nothing else" is what GitHub
 * needs: ````` ``` foo ````` inside a fence is content, not the fence's end, so an order
 * written after it is still inside the code block.
 */
function fenceMarker(raw: string): { readonly indent: number; readonly marker: string } | undefined {
  const match = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(raw);
  if (match === null || match[1] === undefined) return undefined;
  return { indent: indentColumns(match[0]), marker: match[1] };
}

/**
 * Whether a line closes the open fence: same marker character, at least as long as the
 * opener, and nothing else on the line. A longer run closes a shorter fence, which is how
 * GitHub nests a smaller fence inside a bigger one. A top-level fence closes with up to
 * three columns of indentation; a fence inside a list item closes with any indentation from
 * the item's content column up to three columns further, because that is where the item's
 * own closing fence can sit.
 */
function closesFence(raw: string, fence: Fence): boolean {
  const close = fenceMarker(raw);
  if (close === undefined || close.marker[0] !== fence.char || close.marker.length < fence.length) {
    return false;
  }
  if (fence.contentColumn === undefined) return close.indent <= 3;
  return close.indent >= fence.contentColumn && close.indent <= fence.contentColumn + 3;
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
  let hidden: HiddenState = { comment: false, details: 0, pre: false };
  let quote = false;

  for (const raw of body.split(/\r?\n/)) {
    if (fence !== undefined) {
      // A fence opened in a list item belongs to that item. A non-blank line less indented
      // than the item's content column ends the item, so it also ends the fence; the same
      // line is read again below as a normal line, which may open another fence or a quote.
      const endedItem =
        fence.contentColumn !== undefined
        && raw.trim() !== ''
        && indentColumns(raw) < fence.contentColumn;
      if (!endedItem) {
        if (closesFence(raw, fence)) fence = undefined;
        continue;
      }
      fence = undefined;
    }

    // Inside a comment, <details> or <pre> the whole line is invisible. The scan still runs
    // so that a marker closing one region and another opening on the same line leave GitHub's
    // real final state, and the next line is hidden or not accordingly.
    if (hidden.comment || hidden.details > 0 || hidden.pre) {
      const scan = scanHidden(raw, hidden);
      hidden = { comment: scan.comment, details: scan.details, pre: scan.pre };
      continue;
    }

    // A list item marker is a container, not content: dropping it (with its indentation) is
    // what lets a fence or a quote written at the start of an item be recognised. Its content
    // column is kept for a fence opened there, since that fence ends with the item.
    const contentColumn = listContentColumn(raw);
    const content = raw.replace(LIST_MARKER, '');

    // A blank line ends a block quote.
    if (raw.trim() === '') {
      quote = false;
      continue;
    }

    // A heading or a fence ends an open quote: both interrupt the quote's paragraph, so the
    // owner's own text starts again after them. Any other line without `>` is a lazy
    // continuation, which GitHub keeps inside the quote.
    if (quote) {
      if (/^ {0,3}>/.test(content)) continue;
      if (!HEADING.test(content) && FENCE_OPEN.exec(content)?.[1] === undefined) continue;
      quote = false;
    }

    // A quote written on this line opens one.
    if (/^ {0,3}>/.test(content)) {
      quote = true;
      continue;
    }

    // A fence is literal from here on, so any marker on its opener line is content, not
    // markup. Detect it before looking for tags, after the list marker was removed. The
    // item's content column is carried into the fence so it can end with the item.
    const openMarker = FENCE_OPEN.exec(content)?.[1];
    if (openMarker !== undefined) {
      fence = {
        char: openMarker[0] === '~' ? '~' : '`',
        length: openMarker.length,
        contentColumn,
      };
      continue;
    }

    // Comments, <details> and <pre> hide what follows; the left-to-right scan keeps whatever
    // state the last marker leaves. The line carries markup, so it is never an order itself.
    const scan = scanHidden(raw, hidden);
    hidden = { comment: scan.comment, details: scan.details, pre: scan.pre };
    if (scan.touched) continue;

    const line = raw.trim();
    const match = SIGN_OFF_LINE.exec(line);
    if (match?.[1] === undefined) continue;

    // Four or more columns of indentation make an indented code block; a tab counts as
    // advancing to the next multiple of four, so a space plus a tab is four columns. Quoted
    // lines never reach here: the quote state already consumed them above.
    const indented = indentColumns(raw) >= 4;
    orders.push({ sha: match[1], hidden: indented });
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
