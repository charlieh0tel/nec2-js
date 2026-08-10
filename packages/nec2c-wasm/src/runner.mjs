// Default entry point: the glue module plus a sibling nec2c.wasm.
//
// Emscripten resolves nec2c.wasm relative to this module's own URL, which is
// correct under Node and any bundler that emits the two files together. Pass
// options.locateFile when the .wasm is served from somewhere else, or import
// nec2c-wasm/inline to sidestep asset resolution entirely.

import createNec2c from "../prebuilts/nec2c.mjs";
import { createRunner } from "./core.mjs";

export { Nec2cError } from "./core.mjs";
export const runNec = createRunner(createNec2c);
