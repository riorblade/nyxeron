// Runs before every install (package.json → preinstall). The repo is a pnpm workspace with one lockfile;
// npm, yarn or bun would ignore pnpm-lock.yaml, resolve different versions and break `workspace:*` links.
const agent = process.env.npm_config_user_agent || "";
if (!agent.startsWith("pnpm/")) {
  console.error(
    "\n  NYXERON uses pnpm. Run:  corepack enable && pnpm install\n" +
      `  (got: ${agent.split(" ")[0] || "unknown"}; npm, yarn and bun are not supported)\n`,
  );
  process.exit(1);
}
