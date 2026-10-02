import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { checkPr } = createRequire(import.meta.url)("./check-pr.cjs");
const template = readFileSync(
  new URL("../pull_request_template.md", import.meta.url),
  "utf8",
);

/** The template as a teammate would fill it in. */
const filled = template
  .replace(/## Summary\n/, "## Summary\nTenants can rename their venue.\n")
  .replace("- [ ] Feature", "- [x] Feature")
  .replace("- [ ] City", "- [x] City")
  .replace(
    /## Why\n/,
    "## Why\nOwners want their own brand (e.g. Escala Bar).\n",
  )
  .replace(
    /## What changed\n/,
    "## What changed\n- `services/api/city.go`: PUT /api/city/venue\n",
  )
  .replace(
    /## How to test\n/,
    "## How to test\nRent a venue, click Rename. Go test TestRename.\n",
  )
  .replace(/## Screenshots\n/, "## Screenshots\nN/A\n")
  .replace(
    /## Risk & rollback\n/,
    "## Risk & rollback\nLow; revert the commit.\n",
  )
  .replace(/## Deploy notes\n/, "## Deploy notes\nN/A\n")
  .replaceAll("- [ ] ", "- [x] ");

describe("PR checks", () => {
  it("passes a filled-in template with a proper title", () => {
    expect(
      checkPr({
        title: "feat(city): let tenants rename their venue",
        body: filled,
      }),
    ).toEqual([]);
    expect(
      checkPr({
        title: "fix(api,web)!: refuse stock when the warehouse is short",
        body: filled,
      }),
    ).toEqual([]);
  });

  it("rejects bad titles", () => {
    for (const title of [
      "Update stuff",
      "feat: no scope",
      "feature(city): wrong type",
      "feat(shop): unknown scope",
      "feat(city):x",
    ])
      expect(checkPr({ title, body: filled }).join()).toMatch(/Title/);
  });

  it("rejects the untouched template: every empty section, no type/area, open checklist", () => {
    const p = checkPr({
      title: "feat(city): rename venues",
      body: template,
    }).join("\n");
    for (const s of [
      "Summary",
      "Why",
      "What changed",
      "How to test",
      "Risk & rollback",
    ])
      expect(p).toContain(`"## ${s}" is empty`);
    expect(p).toContain('"## Type": tick at least one box');
    expect(p).toContain('"## Area": tick at least one box');
    expect(p).toContain("Checklist not done");
  });

  it("rejects a missing section, N/A where it can't be, and comments-only text", () => {
    const noRisk = filled.replace(/## Risk & rollback\n[^#]*/, "");
    expect(checkPr({ title: "fix(web): x yz", body: noRisk }).join()).toContain(
      '"## Risk & rollback" is missing',
    );
    const naWhy = filled.replace(/## Why\n.*\n/, "## Why\nN/A\n");
    expect(checkPr({ title: "fix(web): x yz", body: naWhy }).join()).toContain(
      `"## Why" can't be N/A`,
    );
    const commentOnly = filled.replace(
      /## Summary\n.*\n/,
      "## Summary\n<!-- todo -->\n",
    );
    expect(
      checkPr({ title: "fix(web): x yz", body: commentOnly }).join(),
    ).toContain('"## Summary" is empty');
  });
});
