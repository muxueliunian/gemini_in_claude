import test from "node:test";
import assert from "node:assert/strict";

import { normalizeSubcommandArgv, parseCliArgs, tokenizeArgumentString } from "../plugins/gemini/scripts/lib/args.mjs";

test("parseCliArgs separates value flags, switch flags, and positionals", () => {
  const { flags, positionals } = parseCliArgs(
    ["--model", "gemini-3.6-flash-high", "--write", "fix", "the", "bug"],
    { valueFlags: ["model"], switchFlags: ["write"] }
  );
  assert.equal(flags.model, "gemini-3.6-flash-high");
  assert.equal(flags.write, true);
  assert.deepEqual(positionals, ["fix", "the", "bug"]);
});

test("parseCliArgs supports --flag=value inline form", () => {
  const { flags } = parseCliArgs(["--model=gemini-3.6-flash-high"], { valueFlags: ["model"] });
  assert.equal(flags.model, "gemini-3.6-flash-high");
});

test("parseCliArgs applies aliases", () => {
  const { flags } = parseCliArgs(["-C", "/tmp/x"], { valueFlags: ["cwd"], aliases: { C: "cwd" } });
  assert.equal(flags.cwd, "/tmp/x");
});

test("parseCliArgs stops flag parsing after --", () => {
  const { positionals } = parseCliArgs(["--", "--write", "not-a-flag"], { switchFlags: ["write"] });
  assert.deepEqual(positionals, ["--write", "not-a-flag"]);
});

test("parseCliArgs throws when a value flag is missing its value", () => {
  assert.throws(() => parseCliArgs(["--model"], { valueFlags: ["model"] }), /expects a value/);
});

test("tokenizeArgumentString handles quoted spans and escapes", () => {
  const tokens = tokenizeArgumentString(`--write "fix the login bug" --model=gemini-3.6-flash-high`);
  assert.deepEqual(tokens, ["--write", "fix the login bug", "--model=gemini-3.6-flash-high"]);
});

test("tokenizeArgumentString preserves a Windows path inside quotes", () => {
  const tokens = tokenizeArgumentString(`--cwd "C:\\Users\\atlas\\repo" go`);
  assert.deepEqual(tokens, ["--cwd", "C:\\Users\\atlas\\repo", "go"]);
});

test("normalizeSubcommandArgv tokenizes a single raw-string argv", () => {
  const argv = normalizeSubcommandArgv(["--write --resume 'do the thing'"]);
  assert.deepEqual(argv, ["--write", "--resume", "do the thing"]);
});

test("normalizeSubcommandArgv returns empty array for blank raw string", () => {
  assert.deepEqual(normalizeSubcommandArgv([""]), []);
  assert.deepEqual(normalizeSubcommandArgv(["   "]), []);
});

test("normalizeSubcommandArgv passes through a real argv array unchanged", () => {
  const argv = normalizeSubcommandArgv(["--write", "prompt", "text"]);
  assert.deepEqual(argv, ["--write", "prompt", "text"]);
});
