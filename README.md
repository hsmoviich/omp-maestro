# 🎼 Conductor

**My [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) harness as one ensemble — one command to install it, one command to change who plays which part.**

Conductor is the setup I use every day with omp, packaged so anyone can try it. It is mostly **a curated collection of other people's public plugins and skills** — I did not write those, and full credit goes to their authors ([see Credits](#-credits)). What I added on top:

- **Jev Router** — my own omp extension that uses [TypeSafe Jev](https://typesafe.ai) to decide, per prompt and per subagent, how much model each piece of work actually needs.
- **Three model setups** — Claude-only, ChatGPT-only, and a mix where a thinker model orchestrates and a coder model writes the code — switchable with one command.
- **`smart-commit` agent** — a small subagent that inspects, stages, commits, and pushes on the cheap `commit` model.

## Install

You need [omp](https://github.com/can1357/oh-my-pi) installed, plus Node.js (for `npx`) or Bun (for `bunx`), and `git`.

```sh
npx omp-conductor            # the "mix" setup (default)
npx omp-conductor anthropic  # Claude only
npx omp-conductor openai     # ChatGPT / Codex only

# or with bun
bunx omp-conductor mix
```

Then, inside omp:

1. Log in to the providers your setup uses: `/login` → Anthropic and/or OpenAI Codex (ChatGPT plan).
2. Give the router a TypeSafe key: `export TYPESAFE_API_KEY=...` or add `TYPESAFE_API_KEY=...` to `~/.omp/agent/.env`. Without a key the router stays out of the way and omp's normal model roles apply.

Re-running the installer is safe; it updates everything and re-applies the setup you name.

### What gets installed

| Piece | Where it comes from | What it does |
| --- | --- | --- |
| `omp-conductor` plugin | this repo | Jev Router, the `/conductor` command, the `smart-commit` agent |
| `@dietrichgebert/ponytail` plugin | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) | "Lazy senior dev" mode: smallest complete change, `/ponytail`, review/audit commands |
| up to 52 skills into `~/.agents/skills` | the libraries you pick from [`skills.json`](./skills.json), via [`skills`](https://github.com/vercel-labs/skills) | Expo, HyperFrames video, Sanity, UI/animation craft, CodeRabbit review, and more |
| model roles + fallback chains | [`profiles.json`](./profiles.json) | written into your omp `config.yml` (only the roles listed; your other roles stay) |

Before anything is installed, the installer lists the skill libraries with a one-line description each and asks which you want:

```text
🎼 Skill libraries (installed into ~/.agents/skills):

  1. coderabbitai/skills (2) — CodeRabbit code review and auto-fixing of PR review comments
  2. vercel-labs/skills (1) — find-skills: search and install more skills when you need a new capability
  3. expo/skills (25) — Expo / React Native apps: routing, native UI, modules, EAS builds, updates and store releases
  4. heygen-com/hyperframes (7) — HyperFrames: make videos, slideshows and motion graphics from HTML, plus Figma import
  5. sanity-io/agent-toolkit (2) — Sanity CMS: schema/GROQ best practices and migrating content into Sanity
  6. emilkowalski/skills (15) — Emil Kowalski's design engineering: UI polish, web/Expo animation, Apple-style design, Swift

Install which? e.g. 1,3,6 · Enter = all · none = skip:
```

Answer once and the rest runs unattended. Non-interactive runs (CI, piped input) install all of them. Skills come straight from their original repositories, so you always get the authors' current versions; a library that fails to install is skipped with a warning and everything else continues.

## Model setups

Switch at any time inside omp:

```text
/conductor            # show the active setup and the choices
/conductor anthropic
/conductor openai
/conductor mix
```

It rewrites the setup's roles and fallback chains in your global config and moves the current session onto the new `@default` model. Re-running `npx omp-conductor <setup>` from a shell does the same.

| Role | `anthropic` | `openai` | `mix` |
| --- | --- | --- | --- |
| `default` (main agent / orchestrator) | Claude Opus 5.5 · medium | GPT-6.1 Sol · medium | **Claude Opus 5.5** · medium |
| `plan`, `slow` | Claude Opus 5.5 · high | GPT-6.1 Sol · high | Claude Opus 5.5 · high |
| `task` (default subagent: coding) | Claude Sonnet 5.5 | GPT-6.1 Sol | **GPT-6.1 Sol** |
| `designer`, `vision` | Claude Sonnet 5.5 | GPT-6.1 Sol | Claude Sonnet 5.5 |
| `smol`, `tiny`, `memory`, `commit` | Claude Haiku 5.5 · low | GPT-6 Luna · low | GPT-6 Luna · low |
| `jev-mechanical` | Claude Haiku 5.5 · low | GPT-6 Luna · low | GPT-6 Luna · low |
| `jev-bounded` | Claude Haiku 5.5 · medium | GPT-6 Luna · medium | GPT-6 Luna · medium |
| `jev-reasoning` | Claude Sonnet 5.5 | GPT-6.1 Sol | GPT-6.1 Sol |
| `jev-architecture` | Claude Opus 5.5 · high | GPT-6.1 Sol · high | GPT-6.1 Sol · high |
| `judge` | TypeSafe Jev | TypeSafe Jev | TypeSafe Jev |
| `web` | Exa → DuckDuckGo | Exa → DuckDuckGo | Exa → DuckDuckGo |

Every role also gets a fallback chain (see [`profiles.json`](./profiles.json)): single-provider setups fall back within the same provider, the mix falls back across providers, so a usage limit on one plan doesn't stop you.

### How the mix works

The **thinker** (Claude Opus) is the main agent: it reads the request, plans, splits the work, and reviews results. The **coders** (GPT Sol / Luna) do the implementation as subagents — the `task` role, and every worker class the Jev Router picks. Claude Sonnet keeps design and vision work, which it handles well.

Want the orchestrator to *never* edit code itself? Use omp's built-in [`/vibe`](https://github.com/can1357/oh-my-pi) director mode: the main model only reads and directs, while `fast` workers run on `@smol` and `good` workers on `@task` — in the mix that is exactly Opus directing GPT.

## Jev Router

```mermaid
flowchart LR
  P[Your prompt] --> G{Layer 0 guards<br/>images · huge prompt ·<br/>security/migration keywords}
  G -- hit --> D[@default]
  G -- pass --> J[Jev: tier, complexity,<br/>safe-downgrade, impact]
  J -- all gates pass --> S[@smol]
  J -- otherwise / error / timeout --> D
  T[task tool call] --> C[Jev: worker class +<br/>should this be delegated?]
  C --> W[@jev-mechanical · bounded ·<br/>reasoning · architecture]
  C -- keep in parent --> K[parent does it itself]
```

- **Main turns:** before each prompt runs, Jev judges it. Only when every conservative gate passes (economy tier with high confidence, low complexity, safe to downgrade, low blast radius) does the turn run on `@smol`; afterwards the session goes back to `@default`. If you picked some other model by hand, the router leaves it alone.
- **Subagents:** every proposed `task` is classified as `mechanical`, `bounded`, `reasoning`, or `architecture` and spawned on the matching `jev-*` role (with that role's fallback chain). Risky *changes* (auth, migrations, payments, concurrency, …) are floored to `architecture`. Work Jev thinks depends on the parent's unresolved reasoning is kept in the parent.
- **Fails open:** no key, a timeout (1.8 s), or any Jev error means you get normal omp behaviour — never a weaker model.

Commands:

```text
/jev-route status            # counters and the last decision
/jev-route on | off
/jev-route verbose | quiet   # show each routing decision
/jev-route test <prompt>     # dry-run the main-turn router
/jev-route test-task <task>  # dry-run the subagent classifier
```

A 🧭 `jev: ON` indicator in the status line shows whether it is active and has a key.

## Customizing

- Change any role with omp's `/model` (Roles view). `/conductor` shows `custom` once your roles no longer match a setup exactly.
- Fork this repo and edit [`profiles.json`](./profiles.json) to ship your own setups; the command, installer, and router read it, so nothing else needs to change.
- Tune the router's thresholds in the `CONFIG` block at the top of [`extensions/jev-router.ts`](./extensions/jev-router.ts).

## Uninstall

```sh
omp plugin uninstall omp-conductor
omp plugin uninstall @dietrichgebert/ponytail   # if you don't want ponytail either
npx skills remove -g                            # pick skills to remove
```

Your model roles stay as they are; change them with `/model`.

## 🙏 Credits

Conductor is glue. The real work is by these people and teams:

| Project | Author | Used for |
| --- | --- | --- |
| [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) | Can Bölük ([@can1357](https://github.com/can1357)) and contributors | the coding agent harness itself |
| [pi-mono](https://github.com/badlogic/pi-mono) | Mario Zechner ([@badlogic](https://github.com/badlogic)) | the original pi agent omp builds on |
| [ponytail](https://github.com/DietrichGebert/ponytail) | Dietrich Gebert ([@DietrichGebert](https://github.com/DietrichGebert)) | lazy-senior-dev mode plugin |
| [TypeSafe Jev](https://typesafe.ai) + [`@typesafe-ai/sdk`](https://www.npmjs.com/package/@typesafe-ai/sdk) | TypeSafe | the judgment model behind the router |
| [skills CLI + find-skills](https://github.com/vercel-labs/skills) | Vercel Labs | installing and finding skills |
| [expo/skills](https://github.com/expo/skills) | Expo | Expo, EAS, React Native skills |
| [hyperframes](https://github.com/heygen-com/hyperframes) | HeyGen | HyperFrames video and motion skills |
| [emilkowalski/skills](https://github.com/emilkowalski/skills) | Emil Kowalski ([@emilkowalski](https://github.com/emilkowalski)) | design engineering, animation, Swift skills |
| [sanity-io/agent-toolkit](https://github.com/sanity-io/agent-toolkit) | Sanity | Sanity schema and migration skills |
| [coderabbitai/skills](https://github.com/coderabbitai/skills) | CodeRabbit | code review and autofix skills |
| [Exa](https://exa.ai) | Exa | web search (`web` role) |

Each of those projects keeps its own license; Conductor does not copy their code — it installs them from their original sources.

## License

[MIT](./LICENSE) for the Conductor code (Jev Router, `/conductor`, installer, setups).
