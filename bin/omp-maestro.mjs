#!/usr/bin/env node
// Usage: npx omp-maestro [anthropic|openai|mix]    (or: bunx omp-maestro ...)
// Installs the plugins and skills, then applies the chosen model setup (default: mix).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { emitKeypressEvents } from "node:readline";

const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
const pkg = read("package.json");
const profiles = read("profiles.json");
const skills = read("skills.json");

const setup = (process.argv[2] ?? "mix").toLowerCase();
if (!profiles[setup]) {
  console.error(`Usage: omp-maestro [${Object.keys(profiles).join("|")}]`);
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

// First line of `<cmd> --version`, or null when the command is missing or fails.
function probe(cmd) {
  const result = spawnSync(win ? `${cmd} --version` : cmd, win ? [] : ["--version"], {
    shell: win,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0 ? (result.stdout || result.stderr).trim().split("\n")[0] : null;
}

// Check what's installed before touching anything: omp is required, git + npx only for skills.
function preflight() {
  console.log(`\n🎼 Maestro ${pkg.version}: checking your setup\n`);
  const omp = probe("omp");
  const git = probe("git");
  const npx = probe("npx");
  console.log(omp ? `  ✔ omp is installed (${omp})` : `  ✖ omp not found`);
  console.log(git ? `  ✔ git (${git.replace(/^git version /, "")})` : `  ⚠ git not found — needed to install skills`);
  console.log(npx ? `  ✔ npx (${npx})` : `  ⚠ npx not found — needed to install skills (comes with Node.js)`);
  if (!omp) {
    console.error(`\n✖ Install omp first (https://github.com/can1357/oh-my-pi), make sure \`omp --version\` works, then run this again.`);
    process.exit(1);
  }
  if (!git || !npx) console.warn(`\n  Skills will be skipped; plugins and the model setup still install.`);
  return Boolean(git && npx);
}

// Checklist of skill libraries: ↑/↓ move, space toggles, enter confirms. All start selected.
// Non-interactive runs (CI, piped input) get all of them.
function pickSkillLibraries() {
  console.log(`\n🎼 Skill libraries (installed into ~/.agents/skills)`);
  const lines = skills.map(({ repo, description, skills: names }) => `${repo} (${names.length}) — ${description}`);
  if (!process.stdin.isTTY) {
    for (const line of lines) console.log(`  ◉ ${line}`);
    return Promise.resolve(skills);
  }

  console.log(`   ↑/↓ move · space select/deselect · enter confirm\n`);
  const selected = skills.map(() => true);
  let cursor = 0;
  const render = (redraw) => {
    // Rows are cut to the terminal width so none wrap and the redraw stays aligned.
    const width = (process.stdout.columns || 80) - 1;
    if (redraw) process.stdout.write(`\x1b[${lines.length}A`);
    lines.forEach((line, i) => {
      const row = `${i === cursor ? "❯" : " "} ${selected[i] ? "◉" : "◯"} ${line}`;
      process.stdout.write(`\x1b[2K${row.slice(0, width)}\n`);
    });
  };
  render(false);

  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve) => {
    const done = () => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    const onKey = (_text, key = {}) => {
      if (key.ctrl && key.name === "c") {
        done();
        process.exit(130);
      }
      if (key.name === "up") cursor = (cursor + lines.length - 1) % lines.length;
      else if (key.name === "down") cursor = (cursor + 1) % lines.length;
      else if (key.name === "space") selected[cursor] = !selected[cursor];
      else if (key.name === "return" || key.name === "enter") {
        done();
        const chosen = skills.filter((_, i) => selected[i]);
        console.log(`\n  ${chosen.length ? `Selected: ${chosen.map((s) => s.repo).join(", ")}` : "No skill libraries selected"}`);
        return resolve(chosen);
      } else return;
      render(true);
    };
    process.stdin.on("keypress", onKey);
  });
}

const canInstallSkills = preflight();

// Ask up front so the rest of the install runs unattended.
const chosenSkills = canInstallSkills ? await pickSkillLibraries() : [];

console.log(`\n🎼 Installing plugins`);
run("omp", ["plugin", "install", "@dietrichgebert/ponytail"]);
run("omp", ["plugin", "install", process.env.OMP_MAESTRO_SPEC ?? `${pkg.name}@${pkg.version}`]);

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
✔ Maestro is leading with the "${setup}" setup — ${profiles[setup].description}

Next:
  • Jev routing needs a TypeSafe key: export TYPESAFE_API_KEY or add it to ~/.omp/agent/.env
  • Switch setups inside omp:  /maestro ${Object.keys(profiles).join(" | ")}
  • Router controls:           /jev-route status | on | off | verbose

Built on the work of (thank you!):
  • oh-my-pi (omp) ............ github.com/can1357/oh-my-pi
  • ponytail .................. github.com/DietrichGebert/ponytail
  • TypeSafe Jev + SDK ........ typesafe.ai
${skills.map(({ repo }) => `  • ${`${repo} `.padEnd(27, ".")} github.com/${repo}`).join("\n")}
`);
