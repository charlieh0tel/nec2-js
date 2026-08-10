// NEC-2 deck emission and nec2c output parsing.
//
// The two halves have different portability. buildDeck writes standard NEC-2
// cards, but the parsers are keyed to nec2c's exact column layout and will not
// read output from other NEC implementations -- hence the package name.

export * from "./nec.js";
