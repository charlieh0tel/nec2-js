// The carried patch, and the behaviour it exists for.
//
// build.sh applies patches/ to a staged copy of the submodule, so nothing in
// the tree shows whether a patch is still live. Without a test, the patch
// silently ceasing to apply -- or ceasing to be needed -- would look exactly
// like everything working.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { runNec } from "../src/runner.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const vendor = join(packageRoot, "third_party", "nec2c");
const patchFile = join(
  packageRoot,
  "patches",
  "0001-line-buf-off-by-one.patch",
);

// nec2c.h's LINE_LEN. load_line() fills a caller's buffer with this many
// characters and then writes a terminator at buff[LINE_LEN], so a line of
// exactly this length is what walks off the end of a char[LINE_LEN].
const LINE_LEN = 132;

describe("the carried line_buf patch", () => {
  it("still applies to the pinned submodule", (t) => {
    if (!existsSync(join(vendor, "main.c"))) {
      t.skip("submodule not checked out");
      return;
    }
    // --dry-run so this checks applicability without touching the checkout.
    // A failure here means upstream has released the fix: delete the patch and
    // move the pin, as TODO.md describes. It does not mean the build is
    // broken.
    execFileSync("patch", ["--dry-run", "-s", "-p1", "-d", vendor], {
      input: readFileSync(patchFile),
    });
  });

  it("is still needed -- the pinned source has the off-by-one", (t) => {
    if (!existsSync(join(vendor, "main.c"))) {
      t.skip("submodule not checked out");
      return;
    }
    const main = readFileSync(join(vendor, "main.c"), "utf8");
    assert.match(
      main,
      /char\s+ain\[3\],\s*line_buf\[LINE_LEN\];/,
      "upstream main.c no longer declares line_buf[LINE_LEN]; if it now has " +
        "room for the terminator, drop the patch and move the pin",
    );
    const misc = readFileSync(join(vendor, "misc.c"), "utf8");
    assert.match(
      misc,
      /buff\[num_chr\]\s*=\s*'\\0';/,
      "load_line no longer terminates with buff[num_chr]",
    );
  });

  it("solves a deck whose card line fills the buffer exactly", async () => {
    // The boundary the patch is about: num_chr reaches LINE_LEN here, so the
    // terminator lands one past the end of an unpatched buffer. It has to be
    // a continuation card -- the first line is read on a different path.
    const comment = "A".repeat(LINE_LEN - "CM ".length);
    const deck = [
      "CM first",
      `CM ${comment}`,
      "CE",
      "GW 1 9 0 0 0 0 0 1 0.001",
      "GE 0",
      "EK",
      "EX 0 1 5 0 1.0 0.0",
      "FR 0 1 0 0 145.9 0",
      "RP 0 3 1 1000 0 0 30 0",
      "EN",
      "",
    ].join("\n");

    const out = await runNec(deck);
    assert.match(out, /ANTENNA INPUT PARAMETERS/);
    // The long card is echoed into the COMMENTS block rather than mangled.
    assert.match(out, new RegExp(`A{${LINE_LEN - 10}}`));
  });
});
