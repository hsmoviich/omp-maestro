#!/usr/bin/env node
// Usage: npx omp-maestro [anthropic|openai|mix]    (or: bunx omp-maestro ...)
// Installs the plugins and skills, then applies the chosen model setup (default: mix).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";

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

// Launched with bunx or npx? Installs use the same tool.
const viaBun = (process.env.npm_config_user_agent ?? "").startsWith("bun/");

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`\n  ${question} [Y/n] `)).trim().toLowerCase();
  rl.close();
  return answer === "" || answer === "y" || answer === "yes";
}

// Where fresh installs land, so they work in this run without opening a new terminal.
function refreshPath() {
  const dirs = [
    join(homedir(), ".bun", "bin"),
    join(homedir(), ".local", "bin"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "omp"),
    win && "C:\\Program Files\\Git\\cmd",
  ];
  for (const dir of dirs) if (dir && existsSync(dir)) process.env.PATH = `${dir}${delimiter}${process.env.PATH}`;
}

function ompInstallCommand() {
  if (viaBun) return ["bun", ["install", "-g", "@oh-my-pi/pi-coding-agent@latest"]];
  // omp runs on Bun: npm can only install a working omp when Bun is present, otherwise use omp's official installer.
  if (probe("bun")) return ["npm", ["install", "-g", "@oh-my-pi/pi-coding-agent@latest"]];
  return win
    ? ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://omp.sh/install.ps1 | iex"]]
    : ["sh", ["-c", "curl -fsSL https://omp.sh/install | sh"]];
}

function gitInstallCommand() {
  if (win) {
    return probe("winget")
      ? ["winget", ["install", "--id", "Git.Git", "-e", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements"]]
      : null;
  }
  if (process.platform === "darwin") return probe("brew") ? ["brew", ["install", "git"]] : ["xcode-select", ["--install"]];
  const managers = [
    ["apt-get", ["install", "-y", "git"]],
    ["dnf", ["install", "-y", "git"]],
    ["pacman", ["-S", "--noconfirm", "git"]],
    ["zypper", ["install", "-y", "git"]],
    ["apk", ["add", "git"]],
  ];
  const found = managers.find(([manager]) => probe(manager));
  return found ? ["sudo", [found[0], ...found[1]]] : null;
}

// Ask before installing anything; returns true when the tool works afterwards.
async function offerInstall(name, command, homepage) {
  if (!command) {
    console.log(`\n  No automatic way to install ${name} here — get it from ${homepage}`);
    return false;
  }
  const [cmd, args] = command;
  if (!(await confirm(`Install ${name} now with \`${cmd} ${args.join(" ")}\`?`))) return false;
  run(cmd, args, { optional: true });
  if (probe(name)) return true;
  refreshPath();
  if (!probe(name)) return false;
  console.log(`\n  ✔ ${name} installed. Open a new terminal before using it yourself; this one doesn't see it yet.`);
  return true;
}

// Check what's installed before touching anything: omp is required, git + npx/bunx only for skills.
// Returns the command prefix that runs the skills CLI, or null when skills must be skipped.
async function preflight() {
  console.log(`\n🎼 Maestro ${pkg.version}: checking your setup\n`);
  const runner = viaBun ? (probe("bun") ? ["bun", "x"] : null) : probe("npx") ? ["npx", "-y"] : null;
  const runnerName = viaBun ? "bunx" : "npx";
  const omp = probe("omp");
  let git = probe("git");
  console.log(omp ? `  ✔ omp is installed (${omp})` : `  ✖ omp not found`);
  console.log(git ? `  ✔ git (${git.replace(/^git version /, "")})` : `  ⚠ git not found — needed to install skills`);
  console.log(runner ? `  ✔ ${runnerName}` : `  ⚠ ${runnerName} not found — needed to install skills`);

  if (!omp && !(await offerInstall("omp", ompInstallCommand(), "https://github.com/can1357/oh-my-pi"))) {
    console.error(
      `\n✖ omp is required. Install it (https://github.com/can1357/oh-my-pi), make sure \`omp --version\` works` +
        ` — open a new terminal if you just installed it — then run this again.`,
    );
    process.exit(1);
  }
  if (!git) git = await offerInstall("git", gitInstallCommand(), "https://git-scm.com/downloads");

  if (!git || !runner) {
    console.warn(`\n  Skills will be skipped; plugins and the model setup still install.`);
    return null;
  }
  return runner;
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

const skillsRunner = await preflight();

// Ask up front so the rest of the install runs unattended.
const chosenSkills = skillsRunner ? await pickSkillLibraries() : [];

console.log(`\n🎼 Installing plugins`);
run("omp", ["plugin", "install", "@dietrichgebert/ponytail"]);
run("omp", ["plugin", "install", process.env.OMP_MAESTRO_SPEC ?? `${pkg.name}@${pkg.version}`]);

if (chosenSkills.length) console.log(`\n🎼 Installing skills into ~/.agents/skills`);
for (const { repo, skills: names } of chosenSkills) {
  const [cmd, ...prefix] = skillsRunner;
  run(cmd, [...prefix, "skills", "add", repo, "-g", "-y", "-a", "codex", "--skill", ...names], { optional: true });
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
