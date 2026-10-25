#!/usr/bin/env node
// Usage: npx omp-switchyard [anthropic|openai|mix]    (or: bunx omp-switchyard ...)
// Installs the plugins and skills, then applies the chosen model setup (default: mix).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
const pkg = read("package.json");
const profiles = read("profiles.json");
const skills = read("skills.json");

const setup = (process.argv[2] ?? "mix").toLowerCase();
if (!profiles[setup]) {
  console.error(`Usage: omp-switchyard [${Object.keys(profiles).join("|")}]`);
  process.exit(1);
}

const win = process.platform === "win32";
// Windows needs a shell for omp.cmd/npx.cmd; quote args so JSON values survive cmd.exe.
const quote = (arg) => (win ? `"${arg.replace(/"/g, '\\"')}"` : arg);

function run(cmd, args, { optional = false, capture = false } = {}) {
  if (!capture) console.log(`\n> ${cmd} ${args.join(" ")}`);
  // Windows: one pre-quoted command line (passing args alongside shell:true is deprecated).
  const result = spawnSync(win ? [cmd, ...args.map(quote)].join(" ") : cmd, win ? [] : args, {
    shell: win,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.status === 0) return result.stdout ?? "";
  if (optional) {
    console.warn(`  ! failed, continuing without it`);
    return "";
  }
  console.error(`\n✖ "${cmd} ${args.join(" ")}" failed${result.error ? `: ${result.error.message}` : ""}`);
  process.exit(result.status ?? 1);
}

run("omp", ["--version"], { capture: true });

console.log(`\n🚂 Switchyard ${pkg.version}: installing plugins`);
run("omp", ["plugin", "install", "@dietrichgebert/ponytail"]);
run("omp", ["plugin", "install", process.env.OMP_SWITCHYARD_SPEC ?? `${pkg.name}@${pkg.version}`]);

console.log(`\n🚂 Installing skills into ~/.agents/skills`);
for (const { repo, skills: names } of skills) {
  run("npx", ["-y", "skills", "add", repo, "-g", "-y", "-a", "codex", "--skill", ...names], { optional: true });
}

console.log(`\n🚂 Applying the "${setup}" model setup`);
for (const [key, field] of [["modelRoles", "modelRoles"], ["retry.fallbackChains", "fallbackChains"]]) {
  const current = JSON.parse(run("omp", ["config", "get", key], { capture: true }).trim() || "{}");
  // Merge: only the roles this setup defines are replaced, the user's other roles stay.
  run("omp", ["config", "set", key, JSON.stringify({ ...current, ...profiles[setup][field] })]);
}

console.log(`
✔ Switchyard is on the "${setup}" track — ${profiles[setup].description}

Next:
  • Jev routing needs a TypeSafe key: export TYPESAFE_API_KEY or add it to ~/.omp/agent/.env
  • Switch setups inside omp:  /switchyard ${Object.keys(profiles).join(" | ")}
  • Router controls:           /jev-route status | on | off | verbose

Built on the work of (thank you!):
  • oh-my-pi (omp) ............ github.com/can1357/oh-my-pi
  • ponytail .................. github.com/DietrichGebert/ponytail
  • TypeSafe Jev + SDK ........ typesafe.ai
${skills.map(({ repo }) => `  • ${`${repo} `.padEnd(27, ".")} github.com/${repo}`).join("\n")}
`);
