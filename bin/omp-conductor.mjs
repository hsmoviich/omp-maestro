#!/usr/bin/env node
// Usage: npx omp-conductor [anthropic|openai|mix]    (or: bunx omp-conductor ...)
// Installs the plugins and skills, then applies the chosen model setup (default: mix).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
const pkg = read("package.json");
const profiles = read("profiles.json");
const skills = read("skills.json");

const setup = (process.argv[2] ?? "mix").toLowerCase();
if (!profiles[setup]) {
  console.error(`Usage: omp-conductor [${Object.keys(profiles).join("|")}]`);
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

// Ask which skill libraries to install. Non-interactive runs (CI, piped input) get all of them.
async function pickSkillLibraries() {
  console.log(`\n🎼 Skill libraries (installed into ~/.agents/skills):\n`);
  skills.forEach(({ repo, description, skills: names }, i) =>
    console.log(`  ${i + 1}. ${repo} (${names.length}) — ${description}`),
  );
  if (!process.stdin.isTTY) return skills;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question("\nInstall which? e.g. 1,3,6 · Enter = all · none = skip: ")).trim().toLowerCase();
      if (!answer || answer === "all") return skills;
      if (answer === "none") return [];
      const picks = answer.split(/[\s,]+/).map(Number);
      if (picks.every((n) => Number.isInteger(n) && n >= 1 && n <= skills.length)) {
        return skills.filter((_, i) => picks.includes(i + 1));
      }
      console.log(`  Please enter numbers from 1 to ${skills.length}, "all", or "none".`);
    }
  } finally {
    rl.close();
  }
}

run("omp", ["--version"], { capture: true });

// Ask up front so the rest of the install runs unattended.
const chosenSkills = await pickSkillLibraries();

console.log(`\n🎼 Conductor ${pkg.version}: installing plugins`);
run("omp", ["plugin", "install", "@dietrichgebert/ponytail"]);
run("omp", ["plugin", "install", process.env.OMP_CONDUCTOR_SPEC ?? `${pkg.name}@${pkg.version}`]);

if (chosenSkills.length) console.log(`\n🎼 Installing skills into ~/.agents/skills`);
for (const { repo, skills: names } of chosenSkills) {
  run("npx", ["-y", "skills", "add", repo, "-g", "-y", "-a", "codex", "--skill", ...names], { optional: true });
}

console.log(`\n🎼 Applying the "${setup}" model setup`);
for (const [key, field] of [["modelRoles", "modelRoles"], ["retry.fallbackChains", "fallbackChains"]]) {
  const current = JSON.parse(run("omp", ["config", "get", key], { capture: true }).trim() || "{}");
  // Merge: only the roles this setup defines are replaced, the user's other roles stay.
  run("omp", ["config", "set", key, JSON.stringify({ ...current, ...profiles[setup][field] })]);
}

console.log(`
✔ Conductor is leading with the "${setup}" setup — ${profiles[setup].description}

Next:
  • Jev routing needs a TypeSafe key: export TYPESAFE_API_KEY or add it to ~/.omp/agent/.env
  • Switch setups inside omp:  /conductor ${Object.keys(profiles).join(" | ")}
  • Router controls:           /jev-route status | on | off | verbose

Built on the work of (thank you!):
  • oh-my-pi (omp) ............ github.com/can1357/oh-my-pi
  • ponytail .................. github.com/DietrichGebert/ponytail
  • TypeSafe Jev + SDK ........ typesafe.ai
${skills.map(({ repo }) => `  • ${`${repo} `.padEnd(27, ".")} github.com/${repo}`).join("\n")}
`);
