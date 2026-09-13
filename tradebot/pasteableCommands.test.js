'use strict';
/*
 * ⚠️ A COMMAND AN OPERATOR CAN PASTE MUST CONTAIN ONLY REAL VALUES.
 *
 * This repo's own first rule, and it has now been broken three times, twice by
 * the code written to diagnose something else:
 *
 *   · `/path/to/dexvra` was pasted literally into a live shell;
 *   · `REPORT_CHANNEL_ID=-100xxxxxxxxxx` was appended verbatim to a live .env,
 *     where it overrode a working default and silently stopped every ops
 *     report — `post()` swallows its own failures, so nothing said why;
 *   · `npm run abi:check -- 0xTOKEN_YANG_ANDA_BELI --curve` was pasted exactly
 *     as written, because that is what the script's own usage line offered.
 *
 * The angle-bracket spelling is worse than it looks: bash reads `<` and `>` as
 * redirects, so the command dies with `syntax error near unexpected token`
 * BEFORE the script it was meant to run ever starts — which reads as a broken
 * tool rather than an unfilled blank. The Pons `--tx 0x<your own buy>`
 * instruction cost exactly that.
 *
 * So: no line a script PRINTS may start with a shell command and carry a
 * placeholder. The fix is never to reword the placeholder — it is to print a
 * real value (ask the chain, or use a row already on screen), or to describe
 * the argument in prose and print no command at all.
 *
 * ⚠️ SCOPE, STATED RATHER THAN LEFT TO BE REDISCOVERED. This checks lines that
 * would fail in a SHELL. `launchpads:check` prints a .env reference table
 * (`LAUNCHPAD_<PAD>_API=…`) which is deliberately not covered: it is framed as
 * variable names to edit by hand, it explains `<PAD>` on the next line, and
 * there is no real value to substitute for a base URL. That is a judgement,
 * not an oversight — if it ever grows into something offered for pasting, it
 * belongs here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['tradebot/scripts', 'bot/scripts', 'scripts'];

/** A line carrying something a shell would try to RUN.
 *
 *  ⚠️ NOT anchored to the start of the line, and the vacuity test below is what
 *  proved it had to be: the line that was actually pasted read
 *  `usage: node scripts/abi-check.js 0x<contract>` — a label, then the command.
 *  Anchored, the guard passed happily on the exact revision it exists to
 *  catch. A source scan that matches nothing is worse than no scan. */
const COMMAND_LINE = /(^|\s)(node|npm|npx|pm2|git|curl|cd|bash|sh|apt-get|sudo)\s/;
/** `<thing>` — the spelling that dies in bash before anything runs. */
const BRACKETED = /<[A-Za-z][A-Za-z0-9_ .-]*>/;

function printedLines(src) {
  // Only what a script SAYS. A `<…>` inside a comment is a useful note for
  // whoever edits the file next; on a screen it is an instruction, and this
  // repo has already paid for scanning one and calling it the other.
  //
  // ⚠️ EVERY LINE, NOT ONLY `console.log`'s — and this is the SECOND time this
  // guard has passed on a revision it exists to catch. It matched
  // `console.log(...)` calls alone, so a script with a printer of its own
  // (`firstpaint-check.mjs` says `note(...)`, `fail(...)`, `ok(...)`) walked
  // straight through: the bracketed placeholder reached the operator and the
  // suite stayed green. Widening it to every STRING LITERAL was the obvious
  // next cut and it was still wrong — a regex containing a quote
  // (`/rel="stylesheet"/`) desynchronises a naive literal scanner, and the
  // offending line was silently skipped. Measured, not assumed: the mutant
  // survived twice.
  //
  // So the question is asked of the LINE. A printer cannot be recognised by
  // name — the next one will be called something else, which is how this hole
  // was dug — and `COMMAND_LINE` plus `BRACKETED` together are narrow enough
  // that a line which is not an instruction almost never matches: it has to
  // carry a shell verb AND an angle-bracketed token.
  //
  // A template literal spanning real newlines is one string to the parser, but
  // it is still many lines in the file, so this covers it for free — the very
  // thing the previous cut needed a special case for.
  const noComments = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // BOTH newline spellings: `"a\nnode foo"` is one physical line carrying two.
  return noComments.split(/\\n|\n/);
}

test('⚠️ no script prints a pasteable command with a placeholder in it', () => {
  const offences = [];
  for (const dir of DIRS) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const f of fs.readdirSync(full)) {
      if (!/\.(js|mjs)$/.test(f)) continue;
      const src = fs.readFileSync(path.join(full, f), 'utf8');
      for (const line of printedLines(src)) {
        if (!COMMAND_LINE.test(line)) continue;
        // Strip the ANSI/template noise a printed line carries.
        const bare = line.replace(/\$\{[^}]*\}/g, '');
        if (BRACKETED.test(bare)) offences.push(`${dir}/${f}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offences, [], `these lines die in bash before the script runs:\n  ${offences.join('\n  ')}`);
});

test('the guard can actually SEE a bad line — it is not passing vacuously', () => {
  // A source scan that matches nothing passes on every revision, including the
  // broken one. This proves the matcher fires on the exact line that shipped.
  const broken = 'console.log(`\\nusage: node scripts/abi-check.js 0x<contract>`);';
  const lines = printedLines(broken).filter((l) => COMMAND_LINE.test(l) && BRACKETED.test(l));
  assert.equal(lines.length, 1, 'the guard would not have caught the line that was actually pasted');
});

test('a command carrying a REAL value is left alone', () => {
  const good = 'console.log(`    node scripts/group-ca.js -1001234567890 --clear`);';
  const lines = printedLines(good).filter((l) => COMMAND_LINE.test(l) && BRACKETED.test(l));
  assert.deepEqual(lines, [], 'a real value must not be mistaken for a placeholder');
});
