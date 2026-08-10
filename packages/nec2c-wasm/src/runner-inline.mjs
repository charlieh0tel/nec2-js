// Single-file entry point: the wasm is base64-embedded in the glue, so there
// is no sibling asset to locate. About a third larger than the default entry
// point, and worth it for bundlers or hosts that will not emit or serve a
// separate .wasm. options.locateFile is accepted but unused here.

import createNec2c from "../prebuilts/nec2c-inline.mjs";
import { createRunner } from "./core.mjs";

export { Nec2cError } from "./core.mjs";
export const runNec = createRunner(createNec2c);
