/**
 * Minimal argv parsing for the gemini companion CLI.
 *
 * A flag spec declares which options take a value and which are boolean
 * switches. Unknown flags fall through to positionals so natural-language
 * prompts containing dashes survive intact.
 */

export function parseCliArgs(argv, spec = {}) {
  const takesValue = new Set(spec.valueFlags ?? []);
  const isSwitch = new Set(spec.switchFlags ?? []);
  const aliases = spec.aliases ?? {};

  const flags = {};
  const positionals = [];
  let rest = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (rest || token === "-" || !token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      rest = true;
      continue;
    }

    let name;
    let inline;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      inline = eq === -1 ? undefined : token.slice(eq + 1);
    } else {
      name = token.slice(1);
      inline = undefined;
    }
    const canonical = aliases[name] ?? name;

    if (isSwitch.has(canonical)) {
      flags[canonical] = inline === undefined ? true : inline !== "false";
    } else if (takesValue.has(canonical)) {
      if (inline !== undefined) {
        flags[canonical] = inline;
      } else {
        const next = argv[i + 1];
        if (next === undefined) {
          throw new Error(`Flag ${token} expects a value.`);
        }
        flags[canonical] = next;
        i += 1;
      }
    } else {
      positionals.push(token);
    }
  }

  return { flags, positionals };
}

/**
 * Split a single raw argument string (as forwarded by a slash command) into
 * tokens. Honors single/double quotes and backslash escapes so Windows paths
 * and quoted prompt fragments survive.
 */
export function tokenizeArgumentString(raw) {
  const out = [];
  let buf = "";
  let inQuote = null;
  let escaped = false;
  let hasToken = false;

  for (const ch of String(raw ?? "")) {
    if (inQuote) {
      // Backslashes are literal inside quotes (so Windows paths survive);
      // only the matching quote character closes the span.
      if (ch === inQuote) {
        inQuote = null;
      } else {
        buf += ch;
      }
      continue;
    }
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buf || hasToken) {
        out.push(buf);
        buf = "";
        hasToken = false;
      }
      continue;
    }
    buf += ch;
  }

  if (escaped) {
    buf += "\\";
  }
  if (buf || hasToken) {
    out.push(buf);
  }
  return out;
}

/**
 * Normalize process argv for a subcommand: a single argument is treated as a
 * raw argument string (the slash-command forwarding case) and tokenized.
 */
export function normalizeSubcommandArgv(argv) {
  if (argv.length === 1) {
    const only = argv[0];
    if (!only || !only.trim()) {
      return [];
    }
    return tokenizeArgumentString(only);
  }
  return argv;
}
