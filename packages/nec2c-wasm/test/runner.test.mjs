// The wrapper's own behavior, independent of whether nec2c's numbers are
// right (that is the parity harness's job, and it needs a native binary).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { runNec as runNecInline } from "../src/runner-inline.mjs";
import { Nec2cError, runNec } from "../src/runner.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const deck = readFileSync(join(here, "fixture.nec"), "utf8");
const BAD_DECK = "total garbage not a deck\n";

describe("runNec", () => {
  it("returns nec2c's output for a valid deck", async () => {
    const out = await runNec(deck);
    assert.match(out, /ANTENNA INPUT PARAMETERS/);
    assert.match(out, /RADIATION PATTERNS/);
  });

  it("gives byte-identical output from both entry points", async () => {
    // The inline build embeds the same wasm; it must not be a different
    // solver. Nothing else in CI compares them.
    const [separate, inline] = await Promise.all([
      runNec(deck),
      runNecInline(deck),
    ]);
    assert.equal(separate, inline);
  });

  it("is repeatable across sequential calls", async () => {
    // Each call builds a fresh instance because nec2c keeps file-scope state;
    // this is what proves that isolation holds.
    const first = await runNec(deck);
    for (let i = 0; i < 5; i++) {
      assert.equal(await runNec(deck), first);
    }
  });

  it("is safe under concurrent calls", async () => {
    const outs = await Promise.all([
      runNec(deck),
      runNec(deck),
      runNec(deck),
      runNec(deck),
    ]);
    for (const out of outs) assert.equal(out, outs[0]);
  });
});

describe("Nec2cError", () => {
  it("throws with the exit code and the submitted deck", async () => {
    await assert.rejects(runNec(BAD_DECK), (e) => {
      assert.ok(e instanceof Nec2cError);
      assert.equal(e.name, "Nec2cError");
      assert.notEqual(e.exitCode, 0);
      assert.equal(e.deck, BAD_DECK);
      return true;
    });
  });

  it("carries nec2c's diagnostic, which it writes to the output file", async () => {
    // Not to stderr: on a failed run stdout and stderr are usually both empty.
    await assert.rejects(runNec(BAD_DECK), (e) => {
      assert.match(e.output, /GEOMETRY DATA CARD ERROR/);
      assert.match(e.message, /GEOMETRY DATA CARD ERROR/);
      return true;
    });
  });

  it("leaves the host process exit code untouched", async () => {
    // Emscripten's exit path assigns process.exitCode; a library does not get
    // to decide the exit status of the program embedding it.
    const before = process.exitCode;
    await assert.rejects(runNec(BAD_DECK));
    assert.equal(process.exitCode, before);

    // Including when the caller had deliberately set one.
    process.exitCode = 3;
    await assert.rejects(runNec(BAD_DECK));
    assert.equal(process.exitCode, 3);
    process.exitCode = before;
  });
});
