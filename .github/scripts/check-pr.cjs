// Checks a pull request against .github/pull_request_template.md. Used by .github/workflows/pr-checks.yml
// (actions/github-script) and by its test (check-pr.test.mjs). Returns a list of problems; empty = OK.

const TYPES = [
  "feat",
  "fix",
  "perf",
  "refactor",
  "docs",
  "test",
  "chore",
  "ci",
  "build",
  "revert",
];
const SCOPES = [
  "core",
  "web",
  "admin",
  "api",
  "relay",
  "deploy",
  "docs",
  "repo",
  "city",
  "economy",
  "multiplayer",
  "dj",
  "venue",
  "auth",
];
// Sections that must say something (an "N/A" counts for the ones that may not apply).
const WRITTEN = [
  "Summary",
  "Why",
  "What changed",
  "How to test",
  "Screenshots",
  "Risk & rollback",
  "Deploy notes",
];
// Sections with checkboxes: Type and Area need at least one ticked; the Checklist needs all of them.
const PICK_ONE = ["Type", "Area"];

const TITLE = new RegExp(
  `^(${TYPES.join("|")})\\((${SCOPES.join("|")})(,(${SCOPES.join("|")}))*\\)!?: \\S.{3,}$`,
);

function sections(body) {
  const out = {};
  let name = null;
  for (const line of body.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      name = h[1];
      out[name] = [];
    } else if (name) out[name].push(line);
  }
  return out;
}

function checkPr({ title = "", body = "" }) {
  const problems = [];
  if (!TITLE.test(title.trim()))
    problems.push(
      `Title "${title}" must be "type(scope): summary", e.g. "feat(city): let tenants rename their venue". ` +
        `Types: ${TYPES.join(", ")}. Scopes: ${SCOPES.join(", ")}.`,
    );
  else if (title.trim().length > 72)
    problems.push(`Title is ${title.trim().length} characters; keep it ≤ 72.`);

  const s = sections(body || "");
  for (const name of [...WRITTEN, ...PICK_ONE, "Checklist"])
    if (!(name in s))
      problems.push(`Section "## ${name}" is missing (use the PR template).`);

  for (const name of WRITTEN) {
    if (!(name in s)) continue;
    const text = s[name].join("\n").trim();
    if (!text)
      problems.push(
        `"## ${name}" is empty. Fill it in (or write N/A where it truly doesn't apply).`,
      );
    else if (
      ["Summary", "Why", "What changed", "How to test"].includes(name) &&
      /^n\/?a\.?$/i.test(text)
    )
      problems.push(`"## ${name}" can't be N/A.`);
  }
  for (const name of PICK_ONE) {
    if (name in s && !s[name].some((l) => /^\s*[-*]\s+\[x\]/i.test(l)))
      problems.push(`"## ${name}": tick at least one box.`);
  }
  if ("Checklist" in s) {
    const open = s.Checklist.filter((l) => /^\s*[-*]\s+\[ \]/.test(l)).map(
      (l) => l.replace(/^\s*[-*]\s+\[ \]\s*/, ""),
    );
    if (open.length)
      problems.push(
        `Checklist not done:\n${open.map((x) => `  - ${x}`).join("\n")}`,
      );
  }
  return problems;
}

module.exports = { checkPr, TYPES, SCOPES };
