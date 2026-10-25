import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import profiles from "../profiles.json" with { type: "json" };

type Profile = {
  description: string;
  modelRoles: Record<string, string>;
  fallbackChains: Record<string, string[]>;
};

const PROFILES: Record<string, Profile> = profiles;
const NAMES = Object.keys(PROFILES);

/**
 * /conductor [anthropic|openai|mix]
 *
 * Writes the chosen setup's model roles and fallback chains into the global
 * config (only the roles the setup defines; other roles are left alone) and
 * moves the live session onto the new @default model.
 */
export default function conductor(pi: ExtensionAPI) {
  pi.setLabel("Conductor");

  const roles = lookup("modelRoles");
  const chains = lookup("retry.fallbackChains");

  function active(): string {
    const current = (roles?.get(pi.pi.settings) ?? {}) as Record<string, string>;
    return (
      NAMES.find((name) =>
        Object.entries(PROFILES[name].modelRoles).every(([role, model]) => current[role] === model),
      ) ?? "custom"
    );
  }

  pi.registerCommand("conductor", {
    description: `Switch the model setup: ${NAMES.join(" | ")}`,
    getArgumentCompletions: (prefix: string) =>
      NAMES.filter((name) => name.startsWith(prefix)).map((name) => ({
        value: name,
        label: name,
        description: PROFILES[name].description,
      })),
    handler: async (args, ctx) => {
      const name = args.trim().toLowerCase();
      const profile = PROFILES[name];

      if (!profile) {
        ctx.ui.notify(
          [
            `Conductor: active setup = ${active()}`,
            ...NAMES.map((n) => `  /conductor ${n} — ${PROFILES[n].description}`),
          ].join("\n"),
          name ? "warning" : "info",
        );
        return;
      }

      if (!roles || !chains) {
        ctx.ui.notify("Conductor: this omp version has no modelRoles/retry.fallbackChains settings", "error");
        return;
      }

      for (const [role, model] of Object.entries(profile.modelRoles)) {
        roles.setEntry(pi.pi.settings, role, model);
      }
      for (const [role, chain] of Object.entries(profile.fallbackChains)) {
        chains.setEntry(pi.pi.settings, role, chain);
      }

      const selector = profile.modelRoles.default;
      const model = ctx.models.resolve(selector);
      if (model && (await pi.setModel(model))) {
        const thinking = selector.split(":")[1];
        if (thinking) pi.setThinkingLevel(thinking as never);
      }

      ctx.ui.notify(
        `Conductor: switched to "${name}" — ${profile.description}` +
          (model ? "" : ` (could not resolve ${selector}; log in to that provider, then run /model)`),
        model ? "info" : "warning",
      );
    },
  });
}
