import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

import {
  TypeSafeClient,
  choice,
  noul,
  score,
} from "@typesafe-ai/sdk";

import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";

// TYPESAFE_API_KEY comes from the environment; omp also loads ~/.omp/agent/.env into it.

type Route = "smol" | "default" | "skip";

type Classification = {
  route: Route;

  tierChoice?: "economy" | "standard" | "difficult";
  tierConfidence?: number;

  complexity?: number;
  complexityConfidence?: number;

  safeDowngrade?: number;
  highImpact?: number;
  needsWeb?: number;

  latencyMs: number;

  jevInputTokens?: number;
  jevOutputTokens?: number;

  reason: string;
  error?: string;
};

type RouteRecord = Classification & {
  timestamp: string;
  promptHash: string;

  modelBefore?: string;
  modelAfter?: string;

  switched: boolean;
};

/**
 * Dynamic worker classes used for delegated task/subagent routing.
 *
 * The main agent still decides how to decompose work. Jev decides the
 * smallest model/effort tier that should execute each proposed child task.
 */
type WorkerClass =
  | "mechanical"
  | "bounded"
  | "reasoning"
  | "architecture";

type WorkerRoute = {
  delegate: boolean;
  workerClass: WorkerClass;
  confidence: number;
  delegateProbability: number;
  latencyMs: number;
  reason: string;
};

const CONFIG = {
  // If Jev takes too long, fail upward to the configured @default model.
  timeoutMs: 1800,

  // Very large main-turn prompts stay on the configured @default model.
  maxPromptChars: 12_000,

  // @smol is only selected when ALL conservative gates pass.
  economyChoiceConfidenceMin: 0.88,
  safeDowngradeMin: 0.90,

  // Jev score uses 0..4.
  complexityMaxForSmol: 1.25,
  complexityConfidenceMin: 0.65,

  highImpactMaxForSmol: 0.15,

  // Currently logged only.
  // Automatic Exa triggering can be added in router v2.
  needsWebThreshold: 0.65,

  cacheTtlMs: 30_000,

  // Subagent routing policy.
  // Low-confidence classifications use the safe middle tier (jev-reasoning).
  subagentClassConfidenceMin: 0.65,

  // Only veto a spawn when Jev is strongly against delegation.
  // P(delegate) >= 0.30 is allowed to run as a child.
  subagentDelegateMin: 0.30,
} as const;

/**
 * Layer-0 deterministic safety rules.
 *
 * These only force an UP-route to the configured @default model.
 * A false positive costs more money but does not reduce quality.
 */
const FORCE_DEFAULT_PATTERN =
  /\b(ultrathink|security|authentication|authorization|permissions?|database migration|schema migration|production incident|data loss|race condition|concurrency|deadlock|cryptograph\w*|credentials?|secrets?|payments?|rollback)\b/i;

const FORCE_ARCHITECTURE_SUBAGENT_PATTERN =
  /\b(?:design|redesign|migrat(?:e|ion)|replace|implement|modify|change|deploy|write|delete|rotate|revoke|alter|refactor|cutover|rollback)\b[\s\S]{0,160}\b(?:security|authentication|authorization|permissions?|database|schema|production|credentials?|secrets?|payments?|concurrency|race condition|data loss)\b|\b(?:security|authentication|authorization|permissions?|database|schema|production|credentials?|secrets?|payments?|concurrency|race condition|data loss)\b[\s\S]{0,160}\b(?:design|redesign|migrat(?:e|ion)|replace|implement|modify|change|deploy|write|delete|rotate|revoke|alter|refactor|cutover|rollback)\b/i;
/**
 * Each worker class runs on its own model role (`jev-mechanical`,
 * `jev-bounded`, `jev-reasoning`, `jev-architecture`), so every Maestro
 * model setup supplies its own worker models. The role's
 * `retry.fallbackChains` entry becomes the child's fallback chain.
 */
const modelRoles = lookup("modelRoles");
const fallbackChains = lookup("retry.fallbackChains");

function modelId(model: any): string | undefined {
  if (!model) return undefined;

  return `${model.provider}/${model.id}`;
}

function sameModel(a: any, b: any): boolean {
  return Boolean(
    a &&
      b &&
      a.provider === b.provider &&
      a.id === b.id,
  );
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;

  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0)
    .toString(16)
    .padStart(8, "0");
}

let client: TypeSafeClient | undefined;

function getClient(): TypeSafeClient {
  const apiKey =
    process.env.TYPESAFE_API_KEY?.trim();

  if (!apiKey) {
    throw new Error(
      "TYPESAFE_API_KEY is not set (export it or add it to ~/.omp/agent/.env)",
    );
  }

  if (!client) {
    client = new TypeSafeClient({
      apiKey,

      defaultModel: "jev-latest",

      timeout: CONFIG.timeoutMs,

      // Router judgments should be fast.
      // A failure simply routes upward to the configured default model.
      retry: {
        maxRetries: 0,
      },

      logLevel: "off",
    });
  }

  return client;
}

/**
 * Classify one proposed delegated task and choose the model chain that should
 * execute it.
 *
 * This is separate from the main-turn @smol/@default router above: the main
 * model proposes decomposition, then this classifier controls child compute.
 */
async function classifySubagentWithJev(
  input: {
    task: string;
    solutionSpace?: string;
    agent?: string;
  },
): Promise<WorkerRoute> {
  const started = performance.now();

  const task = input.task.slice(
    0,
    CONFIG.maxPromptChars,
  );

  const result = await getClient().systemOne(
    {
      state: {
        task,

        agent:
          input.agent ?? "task",

        solutionSpace:
          input.solutionSpace ?? "",

        routingPolicy:
          "Classify the delegated CHILD TASK itself, not the difficulty of the " +
          "larger parent project. Choose the smallest compute class that can " +
          "reliably complete this specific assignment. A mechanical inventory, " +
          "search, grep, enumeration, or extraction task remains mechanical even " +
          "when it belongs to a difficult migration or security project. Only " +
          "classify architecture when THIS CHILD TASK itself requires architectural " +
          "reasoning, high-risk decisions, migration design, security reasoning, " +
          "or cross-cutting technical judgment. When uncertain, route upward.",
      },

      questions: {
        workerClass: choice(
          "Classify THIS CHILD ASSIGNMENT only. Ignore the overall difficulty of the " +
            "parent project. Choose the smallest compute class that can reliably " +
            "complete this specific task.",
          {
            mechanical:
              "Pure information gathering with little judgment: enumerate, list, grep, " +
              "search, count, locate references, extract facts, or build an inventory.",

            bounded:
              "Focused analysis or implementation within a well-defined subsystem: " +
              "compare configuration, verify consistency, check code against clear " +
              "requirements, identify local mismatches, or make a small well-scoped " +
              "change. No broad architecture decisions are required.",

            reasoning:
              "Requires tracing behavior across several components, debugging interactions, " +
              "understanding control/data flow, comparing hypotheses, or making non-trivial " +
              "technical judgments, but does not require designing the overall system architecture.",

            architecture:
              "Requires designing or changing cross-cutting architecture, migrations, " +
              "security boundaries, persistence strategy, concurrency guarantees, " +
              "rollback/cutover strategy, or other high-blast-radius technical decisions.",
          },
        ),

        delegate: noul(
          "Can this assignment safely and usefully execute as an independent subagent?",
          {
            true:
              "The task is self-contained enough to execute independently and return " +
              "a useful result without requiring the parent's unresolved reasoning state.",

            false:
              "The task depends strongly on unresolved parent reasoning, final synthesis, " +
              "or tightly coupled decisions that should remain centralized in the parent.",
          },
        ),
      },

      model: "jev-latest",
    },
    {
      timeout: CONFIG.timeoutMs,

      retry: {
        maxRetries: 0,
      },
    },
  );

  const classAnswer =
    result.answers.workerClass;

  const delegateAnswer =
    result.answers.delegate;

  let workerClass =
    classAnswer.choice as WorkerClass;

  const confidence =
    classAnswer.probabilities?.[
      classAnswer.choice
    ] ??
    classAnswer.confidence ??
    0;

  const delegateProbability =
    delegateAnswer.noul;

  /**
   * Deterministic architecture floor for high-risk CHANGE tasks.
   *
   * Merely inspecting auth/security/migration code is not enough to force High.
   * The task must combine a high-risk domain with an actual design/change action.
   */
  const architectureFloor =
    FORCE_ARCHITECTURE_SUBAGENT_PATTERN.test(
      task,
    );

  if (architectureFloor) {
    workerClass = "architecture";
  } else if (
    confidence <
    CONFIG.subagentClassConfidenceMin
  ) {
    // Uncertain child routing uses the safe middle tier instead of High.
    workerClass = "reasoning";
  }

  const delegate =
    delegateProbability >=
    CONFIG.subagentDelegateMin;

  const latencyMs = Math.round(
    performance.now() - started,
  );

  return {
    delegate,
    workerClass,
    confidence,
    delegateProbability,
    latencyMs,
    reason:
      `${workerClass} ` +
      `(class=${confidence.toFixed(2)}, ` +
      `delegate=${delegateProbability.toFixed(2)}, ` +
      `source=${architectureFloor ? "architecture-floor" : "jev"})`,
  };
}

async function classifyWithJev(
  prompt: string,
  cwd: string,
): Promise<Classification> {
  const started = performance.now();

  const result = await getClient().systemOne(
    {
      state: {
        task: prompt,

        workspace: cwd,

        routingPolicy:
          "Choose the least expensive capability tier that can complete " +
          "the task without a meaningful reduction in correctness, " +
          "completeness, or reliability. When uncertain, prefer the " +
          "more capable tier.",
      },

      questions: {
        tier: choice(
          "What capability tier does this task require?",
          {
            economy:
              "Localized, mechanical, low-ambiguity work. Examples: " +
              "simple renames, tiny formatting changes, obvious one-file " +
              "edits, simple lookups, straightforward repetitive changes, " +
              "or similarly low-risk engineering work.",

            standard:
              "Normal software engineering requiring repository reasoning, " +
              "implementation, debugging, tests, refactoring, multiple files, " +
              "or coordination across several pieces of code.",

            difficult:
              "Architecture, subtle debugging, ambiguous requirements, " +
              "security-sensitive work, migrations, concurrency, high blast " +
              "radius changes, complex cross-system reasoning, or other " +
              "expert-critical engineering work.",
          },
        ),

        complexity: score(
          "Rate the reasoning and implementation complexity required.",
          [
            "Trivial or mechanical.",
            "Straightforward and well-bounded.",
            "Moderate software engineering.",
            "Hard multi-step reasoning.",
            "Expert-critical or unusually difficult.",
          ],
        ),

        safeDowngrade: noul(
          "Could a materially weaker and faster coding model handle this " +
            "task with negligible risk of reducing correctness, completeness, " +
            "or engineering quality?",
        ),

        highImpact: noul(
          "Would an incorrect or incomplete implementation have a high " +
            "blast radius, security impact, data-loss risk, production " +
            "impact, or require difficult recovery?",
        ),

        needsWeb: noul(
          "Does correctly completing this task depend on fresh external " +
            "information such as current documentation, current APIs, recent " +
            "releases, current compatibility information, or current web data?",
        ),
      },

      model: "jev-latest",
    },
    {
      timeout: CONFIG.timeoutMs,

      retry: {
        maxRetries: 0,
      },
    },
  );

  const tier = result.answers.tier;
  const complexity =
    result.answers.complexity;

  const safeDowngrade =
    result.answers.safeDowngrade.noul;

  const highImpact =
    result.answers.highImpact.noul;

  const needsWeb =
    result.answers.needsWeb.noul;

  const tierConfidence =
    tier.confidence ??
    tier.probabilities?.[tier.choice] ??
    0;

  const failedGates: string[] = [];

  if (tier.choice !== "economy") {
    failedGates.push(
      `tier=${tier.choice}`,
    );
  }

  if (
    tierConfidence <
    CONFIG.economyChoiceConfidenceMin
  ) {
    failedGates.push(
      `tierConfidence=${tierConfidence.toFixed(2)}`,
    );
  }

  if (
    complexity.score >
    CONFIG.complexityMaxForSmol
  ) {
    failedGates.push(
      `complexity=${complexity.score.toFixed(2)}`,
    );
  }

  if (
    complexity.confidence <
    CONFIG.complexityConfidenceMin
  ) {
    failedGates.push(
      `complexityConfidence=${complexity.confidence.toFixed(2)}`,
    );
  }

  if (
    safeDowngrade <
    CONFIG.safeDowngradeMin
  ) {
    failedGates.push(
      `safeDowngrade=${safeDowngrade.toFixed(2)}`,
    );
  }

  if (
    highImpact >
    CONFIG.highImpactMaxForSmol
  ) {
    failedGates.push(
      `highImpact=${highImpact.toFixed(2)}`,
    );
  }

  const route: Route =
    failedGates.length === 0
      ? "smol"
      : "default";

  return {
    route,

    tierChoice: tier.choice,
    tierConfidence,

    complexity:
      complexity.score,

    complexityConfidence:
      complexity.confidence,

    safeDowngrade,
    highImpact,
    needsWeb,

    latencyMs: Math.round(
      performance.now() - started,
    ),

    jevInputTokens:
      result.usage?.input_tokens,

    jevOutputTokens:
      result.usage?.output_tokens,

    reason:
      route === "smol"
        ? "all conservative @smol downgrade gates passed"
        : `@default safety gates: ${failedGates.join(", ")}`,
  };
}

export default function jevRouter(
  pi: ExtensionAPI,
) {
  pi.setLabel("Jev Router");

  let enabled = true;
  let verbose = false;

  let last:
    | RouteRecord
    | undefined;

  let pending:
    | RouteRecord
    | undefined;

  /**
   * True only when this router explicitly
   * moved the session onto the @smol model.
   */
  let routerOwnsSmol = false;

  const stats = {
    smol: 0,
    default: 0,
    skip: 0,
    judgeErrors: 0,

    subagentMechanical: 0,
    subagentBounded: 0,
    subagentReasoning: 0,
    subagentArchitecture: 0,
    subagentParentVeto: 0,
    subagentJudgeErrors: 0,
  };

  const cache = new Map<
    string,
    {
      expires: number;
      result: Classification;
    }
  >();

  /**
   * Worker routes chosen in `tool_call`, waiting for their child's
   * `before_subagent_spawn`. OMP only accepts a per-task `model` field for
   * the `seance` agent, so the model chain is applied at spawn time.
   *
   * Keyed by the task `name`: OMP allocates the child's agent id (the
   * spawn key) from it, adding `-N` on collision and `Parent.` when nested.
   */
  const spawnRoutes = new Map<
    string,
    { route: WorkerRoute; expires: number }
  >();

  // Generous: queued background jobs may start long after the task call.
  const SPAWN_ROUTE_TTL_MS = 60 * 60_000;

  function isAllocatedFrom(
    id: string,
    name: string,
  ): boolean {
    return (
      id === name ||
      (id.startsWith(name) &&
        /^-\d+$/.test(id.slice(name.length)))
    );
  }

  /**
   * Record a route and return the task name to use. A name that could be
   * confused with a pending one (`Scout` vs `Scout-2`) gets a `_N` suffix,
   * which OMP's `-N` collision suffix can never produce.
   */
  function reserveSpawnRoute(
    requested: string,
    route: WorkerRoute,
  ): string {
    const now = Date.now();

    for (const [key, entry] of spawnRoutes) {
      if (entry.expires <= now) spawnRoutes.delete(key);
    }

    let name = requested;

    for (
      let n = 2;
      [...spawnRoutes.keys()].some(
        (key) =>
          isAllocatedFrom(key, name) ||
          isAllocatedFrom(name, key),
      );
      n++
    ) {
      name = `${requested}_${n}`;
    }

    spawnRoutes.set(name, {
      route,
      expires: now + SPAWN_ROUTE_TTL_MS,
    });

    return name;
  }

  function takeSpawnRoute(
    spawnKey: string,
  ): WorkerRoute | undefined {
    const id = spawnKey.slice(
      spawnKey.lastIndexOf(".") + 1,
    );

    for (const [name, entry] of spawnRoutes) {
      if (
        isAllocatedFrom(spawnKey, name) ||
        isAllocatedFrom(id, name)
      ) {
        spawnRoutes.delete(name);

        return entry.expires > Date.now()
          ? entry.route
          : undefined;
      }
    }

    return undefined;
  }

  function requestedTaskName(
    name: unknown,
    route: WorkerRoute,
  ): string {
    if (typeof name === "string" && name.trim()) {
      return name.trim();
    }

    // A name is required to correlate the spawn; make it say how it was routed.
    return `${route.workerClass[0].toUpperCase()}${route.workerClass.slice(1)}Task`;
  }

  async function classify(
    prompt: string,
    cwd: string,
    imageCount: number,
  ): Promise<Classification> {
    const started =
      performance.now();

    /**
     * Layer 0
     *
     * Deterministic guards execute before
     * spending anything on Jev.
     */

    if (imageCount > 0) {
      return {
        route: "default",

        latencyMs: 0,

        reason:
          "Layer 0: visual/image context present",
      };
    }

    if (
      prompt.length >
      CONFIG.maxPromptChars
    ) {
      return {
        route: "default",

        latencyMs: 0,

        reason:
          "Layer 0: large prompt",
      };
    }

    if (
      FORCE_DEFAULT_PATTERN.test(prompt)
    ) {
      return {
        route: "default",

        latencyMs: 0,

        reason:
          "Layer 0: high-impact keyword guard",
      };
    }

    const cacheKey =
      `${cwd}\0${prompt}\0${imageCount}`;

    const cached =
      cache.get(cacheKey);

    if (
      cached &&
      cached.expires > Date.now()
    ) {
      return {
        ...cached.result,

        reason:
          `${cached.result.reason} [cached]`,
      };
    }

    try {
      const result =
        await classifyWithJev(
          prompt,
          cwd,
        );

      cache.set(
        cacheKey,
        {
          expires:
            Date.now() +
            CONFIG.cacheTtlMs,

          result,
        },
      );

      // Keep the in-memory cache tiny.
      if (cache.size > 32) {
        const first =
          cache
            .keys()
            .next()
            .value;

        if (
          first !== undefined
        ) {
          cache.delete(first);
        }
      }

      return result;
    } catch (error) {
      stats.judgeErrors++;

      return {
        route: "default",

        latencyMs:
          Math.round(
            performance.now() -
              started,
          ),

        reason:
          "Jev unavailable or judgment failed; failing upward to the configured default model",

        error:
          error instanceof Error
            ? error.message
            : String(error),
      };
    }
  }

  function describe(
    record: RouteRecord,
  ): string {
    const tier =
      record.tierChoice
        ? ` tier=${record.tierChoice}/${record.tierConfidence?.toFixed(2)}`
        : "";

    const complexity =
      record.complexity !==
      undefined
        ? ` complexity=${record.complexity.toFixed(2)}/${record.complexityConfidence?.toFixed(2)}`
        : "";

    const downgrade =
      record.safeDowngrade !==
      undefined
        ? ` downgrade=${record.safeDowngrade.toFixed(2)}`
        : "";

    const impact =
      record.highImpact !==
      undefined
        ? ` impact=${record.highImpact.toFixed(2)}`
        : "";

    const web =
      record.needsWeb !==
      undefined
        ? ` web=${record.needsWeb.toFixed(2)}`
        : "";

    return (
      `route=${record.route}` +
      tier +
      complexity +
      downgrade +
      impact +
      web +
      ` ${record.latencyMs}ms` +
      ` — ${record.reason}`
    );
  }

  async function restoreDefault(
    ctx: any,
  ): Promise<void> {
    if (!routerOwnsSmol) {
      return;
    }

    const defaultModel =
      ctx.models.resolve(
        "@default",
      );

    const smolModel =
      ctx.models.resolve(
        "@smol",
      );

    const current =
      ctx.models.current();

    /**
     * Don't override a model the user
     * manually selected during the turn.
     */
    if (
      defaultModel &&
      smolModel &&
      sameModel(
        current,
        smolModel,
      )
    ) {
      await pi.setModel(
        defaultModel,
      );
    }

    routerOwnsSmol = false;
  }

  /**
   * Route when a prompt is actually about
   * to start.
   *
   * This is safer than routing from raw
   * input because queued follow-ups should
   * not change the model of a turn that is
   * already executing.
   */
  pi.on(
    "before_agent_start",
    async (
      event,
      ctx,
    ) => {
      if (!enabled) {
        return;
      }

      /**
       * This hook routes only the main interactive OMP session.
       * Delegated task/subagent routing is handled separately by the
       * `tool_call` hook below.
       */
      if (!ctx.hasUI) {
        return;
      }

      const defaultModel =
        ctx.models.resolve(
          "@default",
        );

      const smolModel =
        ctx.models.resolve(
          "@smol",
        );

      if (
        !defaultModel ||
        !smolModel
      ) {
        ctx.ui.notify(
          "Jev Router: @default or @smol could not be resolved",
          "error",
        );

        return;
      }

      const current =
        ctx.models.current();

      /**
       * Respect manually-selected models
       * outside the router-managed pool.
       *
       * Example:
       * if you manually switch to Astra,
       * the router leaves it alone.
       */
      if (
        current &&
        !sameModel(
          current,
          defaultModel,
        ) &&
        !sameModel(
          current,
          smolModel,
        )
      ) {
        pending = {
          route: "skip",

          latencyMs: 0,

          reason:
            "manual/non-router model active",

          timestamp:
            new Date().toISOString(),

          promptHash:
            hashString(
              event.prompt,
            ),

          modelBefore:
            modelId(current),

          modelAfter:
            modelId(current),

          switched: false,
        };

        return;
      }

      const classification =
        await classify(
          event.prompt,
          ctx.cwd,
          event.images?.length ??
            0,
        );

      const target =
        classification.route ===
        "smol"
          ? smolModel
          : defaultModel;

      const before =
        ctx.models.current();

      let switched = false;

      if (
        !sameModel(
          before,
          target,
        )
      ) {
        switched =
          await pi.setModel(
            target,
          );
      }

      const after =
        ctx.models.current();

      routerOwnsSmol =
        classification.route ===
          "smol" &&
        sameModel(
          after,
          smolModel,
        );

      pending = {
        ...classification,

        timestamp:
          new Date().toISOString(),

        promptHash:
          hashString(
            event.prompt,
          ),

        modelBefore:
          modelId(before),

        modelAfter:
          modelId(after),

        switched,
      };

      if (
        verbose &&
        pending
      ) {
        ctx.ui.notify(
          `Jev Router: ${describe(pending)}`,
          "info",
        );
      }
    },
  );

  /**
   * Classify every proposed task/subagent through Jev before OMP executes it.
   *
   * `tool_call` sees the task text, so it decides delegate-vs-parent and the
   * worker class here, and names each kept child so the route can be found
   * again. The model chain itself is applied in `before_subagent_spawn`
   * below; writing `model` into task items is rejected by OMP.
   *
   * IMPORTANT: this intentionally fails open. If Jev is unavailable, the
   * original task call proceeds untouched and OMP falls back to modelRoles.
   */
  pi.on(
    "tool_call",
    async (event) => {
      if (
        !enabled ||
        event.toolName !== "task"
      ) {
        return;
      }

      const input =
        event.input as Record<
          string,
          any
        >;

      try {
        /**
         * Batch task shape:
         * {
         *   context: "...",
         *   tasks: [{ name, agent, task, solutionSpace, ... }]
         * }
         */
        if (
          Array.isArray(
            input.tasks,
          )
        ) {
          const decisions =
            await Promise.all(
              input.tasks.map(
                async (
                  item: Record<
                    string,
                    any
                  >,
                ) => ({
                  item,
                  route:
                    await classifySubagentWithJev(
                      {
                        task: String(
                          item.task ?? "",
                        ),

                        solutionSpace:
                          typeof item.solutionSpace ===
                          "string"
                            ? item.solutionSpace
                            : undefined,

                        agent:
                          typeof item.agent ===
                          "string"
                            ? item.agent
                            : undefined,
                      },
                    ),
                }),
              ),
            );

          const routedTasks:
            Record<string, any>[] = [];

          const keptInParent:
            string[] = [];

          for (const {
            item,
            route,
          } of decisions) {
            const name =
              typeof item.name ===
              "string"
                ? item.name
                : "UnnamedTask";

            if (
              route.workerClass ===
              "mechanical"
            ) {
              stats.subagentMechanical++;
            } else if (
              route.workerClass ===
              "bounded"
            ) {
              stats.subagentBounded++;
            } else if (
              route.workerClass ===
              "reasoning"
            ) {
              stats.subagentReasoning++;
            } else {
              stats.subagentArchitecture++;
            }

            pi.logger.info(
              `[JEV ROUTER] ${name} ` +
                `class=${route.workerClass} ` +
                `confidence=${route.confidence.toFixed(3)} ` +
                `delegate=${route.delegateProbability.toFixed(3)} ` +
                `latency=${route.latencyMs}ms ` +
                `role=${route.delegate ? `@jev-${route.workerClass}` : "PARENT"}`,
            );

            if (!route.delegate) {
              stats.subagentParentVeto++;

              keptInParent.push(
                `${name}: ${String(
                  item.task ?? "",
                )}`,
              );

              continue;
            }

            routedTasks.push({
              ...item,

              name: reserveSpawnRoute(
                requestedTaskName(item.name, route),
                route,
              ),
            });
          }

          /**
           * Jev rejected the entire fan-out. Block the task call and tell the
           * parent to keep the work itself.
           */
          if (
            routedTasks.length === 0
          ) {
            return {
              block: true,

              reason:
                "Jev compute routing determined that all requested work should " +
                "remain in the parent agent context. Do not spawn subagents; " +
                "complete these assignments directly in the parent.",
            };
          }

          /**
           * Some children can run independently and some should remain in the
           * parent. Execute only the accepted children and inject trusted
           * guidance after the task call returns.
           */
          const additionalContext =
            keptInParent.length > 0
              ? [
                  "Jev compute routing kept these assignments in the parent context:",
                  "",
                  ...keptInParent.map(
                    (task) =>
                      `- ${task}`,
                  ),
                  "",
                  "Complete these directly in the parent instead of delegating them.",
                ].join("\n")
              : undefined;

          return {
            input: {
              ...input,
              tasks: routedTasks,
            },

            ...(additionalContext
              ? {
                  additionalContext,
                }
              : {}),
          };
        }

        /**
         * Flat/single task shape.
         */
        if (
          typeof input.task ===
          "string"
        ) {
          const route =
            await classifySubagentWithJev(
              {
                task: input.task,

                solutionSpace:
                  typeof input.solutionSpace ===
                  "string"
                    ? input.solutionSpace
                    : undefined,

                agent:
                  typeof input.agent ===
                  "string"
                    ? input.agent
                    : undefined,
              },
            );

          if (
            route.workerClass ===
            "mechanical"
          ) {
            stats.subagentMechanical++;
          } else if (
            route.workerClass ===
            "bounded"
          ) {
            stats.subagentBounded++;
          } else if (
            route.workerClass ===
            "reasoning"
          ) {
            stats.subagentReasoning++;
          } else {
            stats.subagentArchitecture++;
          }

          pi.logger.info(
            `[JEV ROUTER] single ` +
              `class=${route.workerClass} ` +
              `confidence=${route.confidence.toFixed(3)} ` +
              `delegate=${route.delegateProbability.toFixed(3)} ` +
              `latency=${route.latencyMs}ms ` +
              `role=${route.delegate ? `@jev-${route.workerClass}` : "PARENT"}`,
          );

          if (!route.delegate) {
            stats.subagentParentVeto++;

            return {
              block: true,

              reason:
                "Jev compute routing determined that this assignment should " +
                "remain in the parent agent context. Complete it directly " +
                "instead of spawning a subagent.",
            };
          }

          return {
            input: {
              ...input,

              name: reserveSpawnRoute(
                requestedTaskName(input.name, route),
                route,
              ),
            },
          };
        }
      } catch (error) {
        stats.subagentJudgeErrors++;

        pi.logger.warn(
          `[JEV ROUTER] subagent classification failed; ` +
            `normal OMP routing will be used: ${
              error instanceof Error
                ? error.message
                : String(error)
            }`,
        );

        // Fail open: preserve the original task call and normal OMP routing.
        return;
      }
    },
  );

  /**
   * Apply the worker model chain chosen in `tool_call`. The candidates
   * replace the spawn's patterns in attempt order, so the later entries
   * remain the child's retry fallback chain.
   */
  pi.on(
    "before_subagent_spawn",
    async (event) => {
      if (
        event.invocationKind !== "task" ||
        !event.spawnKey
      ) {
        return;
      }

      const route = takeSpawnRoute(
        event.spawnKey,
      );

      if (!enabled || !route) {
        return;
      }

      const role = `jev-${route.workerClass}`;
      const roles = modelRoles?.get(pi.pi.settings) as Record<string, string> | undefined;
      const chains = fallbackChains?.get(pi.pi.settings) as Record<string, string[]> | undefined;

      // Fail open: without a configured worker role, OMP keeps its normal model.
      if (!roles?.[role]) {
        return;
      }

      return {
        model: [...roles[role].split(","), ...(chains?.[role] ?? [])],
        note: `Jev: ${route.reason} → @${role}`,
      };
    },
  );

  /**
   * Persist routing telemetry after
   * the agent turn actually begins.
   */
  pi.on(
    "agent_start",
    async () => {
      if (!pending) {
        return;
      }

      last = pending;

      if (
        last.route === "smol"
      ) {
        stats.smol++;
      } else if (
        last.route === "default"
      ) {
        stats.default++;
      } else {
        stats.skip++;
      }

      pi.logger.info(
        `[jev-router] ${JSON.stringify(last)}`,
      );

      try {
        await pi.appendEntry(
          "com.omp.jev-router.route",
          last,
        );
      } catch (error) {
        pi.logger.warn(
          `[jev-router] failed to persist route record: ${String(error)}`,
        );
      }

      pending = undefined;
    },
  );

  /**
   * Always restore the configured default model after
   * a router-owned @smol turn.
   */
  pi.on(
    "agent_end",
    async (
      _event,
      ctx,
    ) => {
      await restoreDefault(
        ctx,
      );
    },
  );

  pi.on(
    "session_stop",
    async (
      _event,
      ctx,
    ) => {
      await restoreDefault(
        ctx,
      );
    },
  );

  /**
   * Persistent status-bar indicator, next to ponytail's.
   *
   * A startup `notify` is not enough: OMP merges back-to-back info notices
   * into one line, so a later extension's notice (ponytail's) replaces ours.
   */
  function syncStatus(ctx: ExtensionContext): void {
    if (!ctx.ui?.setStatus) return;

    let theme: ExtensionContext["ui"]["theme"];

    try {
      theme = ctx.ui.theme;
      if (!theme?.fg) return;
    } catch {
      // Theme proxies can throw before the theme is initialized.
      return;
    }

    const hasKey = Boolean(
      process.env.TYPESAFE_API_KEY?.trim(),
    );

    const state = !enabled
      ? theme.fg("dim", "OFF")
      : hasKey
        ? theme.fg("text", "ON")
        : theme.fg("warning", "NO KEY");

    ctx.ui.setStatus(
      "jev-router",
      "🧭 " + theme.fg("muted", "jev: ") + state,
    );
  }

  pi.on(
    "session_start",
    async (
      _event,
      ctx,
    ) => {
      syncStatus(ctx);

      if (!process.env.TYPESAFE_API_KEY?.trim()) {
        ctx.ui.notify(
          "Jev Router active, but TYPESAFE_API_KEY is not set; routing will fail open to normal OMP modelRoles",
          "warning",
        );
      }
    },
  );

  /**
   * Commands:
   *
   * /jev-route
   * /jev-route status
   * /jev-route on
   * /jev-route off
   * /jev-route verbose
   * /jev-route quiet
   * /jev-route test <prompt>
   * /jev-route test-task <prompt>
   */
  pi.registerCommand(
    "jev-route",
    {
      description:
        "Control or inspect Jev model routing",

      handler: async (
        args,
        ctx,
      ) => {
        const input =
          args.trim();

        if (
          !input ||
          input === "status"
        ) {
          const lastText =
            last
              ? describe(last)
              : "none";

          ctx.ui.notify(
            [
              `enabled=${enabled}`,
              `verbose=${verbose}`,
              `key=${process.env.TYPESAFE_API_KEY ? "yes" : "no"}`,
              `smol=${stats.smol}`,
              `default=${stats.default}`,
              `skip=${stats.skip}`,
              `judgeErrors=${stats.judgeErrors}`,
              `child[mech=${stats.subagentMechanical},bounded=${stats.subagentBounded},reasoning=${stats.subagentReasoning},arch=${stats.subagentArchitecture},parent=${stats.subagentParentVeto},errors=${stats.subagentJudgeErrors}]`,
              `last=${lastText}`,
            ].join(" | "),
            "info",
          );

          return;
        }

        if (
          input === "on"
        ) {
          enabled = true;
          syncStatus(ctx);

          ctx.ui.notify(
            "Jev Router enabled",
            "info",
          );

          return;
        }

        if (
          input === "off"
        ) {
          enabled = false;
          syncStatus(ctx);

          await restoreDefault(
            ctx,
          );

          ctx.ui.notify(
            "Jev Router disabled",
            "info",
          );

          return;
        }

        if (
          input === "verbose"
        ) {
          verbose = true;

          ctx.ui.notify(
            "Jev Router verbose routing notifications enabled",
            "info",
          );

          return;
        }

        if (
          input === "quiet"
        ) {
          verbose = false;

          ctx.ui.notify(
            "Jev Router verbose notifications disabled",
            "info",
          );

          return;
        }

        if (
          input.startsWith(
            "test-task ",
          )
        ) {
          const prompt =
            input
              .slice(10)
              .trim();

          if (!prompt) {
            ctx.ui.notify(
              "Usage: /jev-route test-task <prompt>",
              "warning",
            );

            return;
          }

          try {
            const result =
              await classifySubagentWithJev(
                {
                  task: prompt,
                  agent: "task",
                },
              );

            ctx.ui.notify(
              `TASK TEST: class=${result.workerClass} ` +
                `confidence=${result.confidence.toFixed(2)} ` +
                `delegate=${result.delegateProbability.toFixed(2)} ` +
                `role=${result.delegate ? `@jev-${result.workerClass}` : "PARENT"} ` +
                `${result.latencyMs}ms`,
              "info",
            );
          } catch (error) {
            ctx.ui.notify(
              `TASK TEST failed: ${
                error instanceof Error
                  ? error.message
                  : String(error)
              }`,
              "error",
            );
          }

          return;
        }

        if (
          input.startsWith(
            "test ",
          )
        ) {
          const prompt =
            input
              .slice(5)
              .trim();

          if (!prompt) {
            ctx.ui.notify(
              "Usage: /jev-route test <prompt>",
              "warning",
            );

            return;
          }

          const result =
            await classify(
              prompt,
              ctx.cwd,
              0,
            );

          const testRecord: RouteRecord =
            {
              ...result,

              timestamp:
                new Date().toISOString(),

              promptHash:
                hashString(
                  prompt,
                ),

              switched: false,
            };

          ctx.ui.notify(
            `TEST: ${describe(testRecord)}`,
            "info",
          );

          return;
        }

        ctx.ui.notify(
          "Usage: /jev-route [status|on|off|verbose|quiet|test <prompt>|test-task <prompt>]",
          "warning",
        );
      },
    },
  );
}