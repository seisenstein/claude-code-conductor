import type { FlowConfig, ProjectProfile } from "./types.js";
import { DEFAULT_FLOW_CONFIG } from "./flow-config.js";

/**
 * Generate a flow-config seed for the project.
 *
 * Pick order (highest priority first):
 *   1. Project archetype (cli / library / web / service / other)
 *      — handled here when no specific framework template exists.
 *   2. Specific framework template (Next.js, React SPA, Vue, ...)
 *   3. Generic DEFAULT_FLOW_CONFIG fallback.
 *
 * v0.7.1: this output is now a SEED — the LLM-based flow-config-analyzer
 * uses it as a reference and refines/replaces it based on actual codebase
 * inspection. If the analyzer is skipped or fails, this seed is what gets
 * written to disk.
 */
export function generateFlowConfig(profile: ProjectProfile): FlowConfig {
  const frameworks = profile.frameworks;

  // 1. Specific frontend frameworks (these take precedence over archetype
  //    so a Next.js app gets the App-Router template, not the generic web one).
  if (frameworks.includes("nextjs")) {
    return NEXTJS_CONFIG;
  }

  if (frameworks.includes("react") && !frameworks.includes("nextjs")) {
    return REACT_SPA_CONFIG;
  }

  if (frameworks.includes("vue")) {
    return VUE_CONFIG;
  }

  if (frameworks.includes("svelte")) {
    return SVELTE_CONFIG;
  }

  if (frameworks.includes("angular")) {
    return ANGULAR_CONFIG;
  }

  // 2. API-only frameworks (covered by SERVICE archetype but kept for
  //    backward compat with profiles that don't have archetype yet).
  if (
    frameworks.includes("express") ||
    frameworks.includes("fastify") ||
    frameworks.includes("hono") ||
    frameworks.includes("koa") ||
    frameworks.includes("nestjs")
  ) {
    return NODE_API_CONFIG;
  }

  if (
    frameworks.includes("fastapi") ||
    frameworks.includes("django") ||
    frameworks.includes("flask")
  ) {
    return PYTHON_API_CONFIG;
  }

  // 3. Archetype-based fallback for projects without a framework template.
  switch (profile.archetype) {
    case "cli":
      return CLI_TOOL_CONFIG;
    case "library":
      return LIBRARY_CONFIG;
    case "service":
      // Reach here only if no specific service-framework matched above
      return NODE_API_CONFIG;
    case "web":
    case "other":
    case undefined:
    default:
      return { ...DEFAULT_FLOW_CONFIG };
  }
}

// ============================================================
// Framework-specific templates
// ============================================================

const NEXTJS_CONFIG: FlowConfig = {
  layers: [
    {
      name: "Pages & Layouts (App Router)",
      checks: [
        "Does the page/layout handle loading and error states?",
        "Are server components used where appropriate (no client-only APIs)?",
        "Is metadata (title, description) set for SEO?",
        "Does the page handle authentication redirects for protected routes?",
        "Are dynamic route params validated before use?",
      ],
    },
    {
      name: "Server Actions & API Routes",
      checks: [
        "Is user input validated before processing?",
        "Are server actions properly authenticated and authorized?",
        "Do API routes return appropriate status codes?",
        "Are database operations wrapped in try/catch with proper error responses?",
        "Is revalidation (revalidatePath/revalidateTag) called after mutations?",
      ],
    },
    {
      name: "Client Components & Hooks",
      checks: [
        "Is 'use client' directive present on components using client-only APIs?",
        "Are forms handling loading, error, and success states?",
        "Is client-side state properly initialized (no hydration mismatches)?",
        "Are event handlers debounced where appropriate (search, resize)?",
        "Do useEffect hooks have proper cleanup functions?",
      ],
    },
    {
      name: "Shared UI Components",
      checks: [
        "Do components use the project's variant system (cva, etc.) instead of inline styles?",
        "Are shared primitives extended via variants, not modified directly?",
        "Is accessibility maintained (keyboard nav, ARIA, semantic HTML)?",
        "Are components responsive across breakpoints?",
      ],
    },
    {
      name: "Database & Data Layer",
      checks: [
        "Are queries parameterized (no SQL injection)?",
        "Do list queries use pagination?",
        "Are N+1 queries avoided (use joins/includes)?",
        "Are migrations reversible?",
        "Are indexes present for filtered/sorted columns?",
      ],
    },
    {
      name: "Cross-Boundary",
      checks: [
        "Does data flow correctly from server components through to client components?",
        "Are RSC serialization boundaries respected (no functions/classes passed as props)?",
        "Is the cache invalidation strategy consistent across related mutations?",
        "Do error boundaries catch and display errors at appropriate granularity?",
      ],
    },
  ],
  actor_types: [
    "owner",
    "admin",
    "member",
    "viewer",
    "anonymous",
    "unauthenticated",
    "server_component",
    "server_action",
    "cron_job",
  ],
  edge_cases: [
    "Hydration mismatch (server vs client render)",
    "RSC serialization boundary violations",
    "Stale cache after mutation",
    "Concurrent form submissions",
    "Token expiry during server action",
    "Pagination boundary (> 100 items)",
    "Empty state (no data)",
    "Network failure during server action",
    "Unauthorized access to protected page",
    "Missing or invalid dynamic route params",
  ],
  example_flows: [],
};

const REACT_SPA_CONFIG: FlowConfig = {
  layers: [
    {
      name: "UI Components & Pages",
      checks: [
        "Does the component handle loading, error, and empty states?",
        "Are shared components extended via variants, not modified directly?",
        "Is the component accessible (keyboard nav, ARIA)?",
        "Are forms validated before submission?",
      ],
    },
    {
      name: "State Management & Hooks",
      checks: [
        "Is state scoped to the appropriate level (local vs global)?",
        "Are side effects properly cleaned up in useEffect?",
        "Is derived state computed during render, not in useEffect?",
        "Are expensive computations memoized only when needed?",
      ],
    },
    {
      name: "API Client & Data Fetching",
      checks: [
        "Are API calls cancellable on component unmount?",
        "Is error handling consistent across API calls?",
        "Are loading states shown during fetches?",
        "Is authentication token refreshed automatically?",
      ],
    },
    {
      name: "Routing & Navigation",
      checks: [
        "Are protected routes redirecting unauthenticated users?",
        "Do route params get validated before use?",
        "Is navigation state preserved across route changes?",
      ],
    },
  ],
  actor_types: ["owner", "admin", "member", "viewer", "anonymous", "unauthenticated"],
  edge_cases: [
    "Component unmount during pending API call",
    "Concurrent state updates",
    "Token expiry mid-session",
    "Pagination boundary (> 100 items)",
    "Empty state (no data)",
    "Network failure during form submission",
    "Browser back/forward navigation",
  ],
  example_flows: [],
};

const VUE_CONFIG: FlowConfig = {
  layers: [
    {
      name: "Vue Components & Pages",
      checks: [
        "Does the component handle loading, error, and empty states?",
        "Are shared components extended via props/slots, not modified directly?",
        "Is the component accessible?",
        "Are v-model bindings validated?",
      ],
    },
    {
      name: "Composables & State (Pinia/Vuex)",
      checks: [
        "Is reactive state properly scoped?",
        "Are watchers cleaned up on unmount?",
        "Is computed state used instead of watchers for derived values?",
      ],
    },
    {
      name: "API Layer",
      checks: [
        "Are API calls handled with proper error states?",
        "Is authentication consistently applied?",
        "Are responses validated before use?",
      ],
    },
  ],
  actor_types: ["owner", "admin", "member", "viewer", "anonymous", "unauthenticated"],
  edge_cases: [
    "Reactivity edge cases (deep nested objects)",
    "Component lifecycle timing issues",
    "Token expiry mid-session",
    "Pagination boundary",
    "Empty state (no data)",
  ],
  example_flows: [],
};

const SVELTE_CONFIG: FlowConfig = {
  layers: [
    {
      name: "Svelte Components & Routes",
      checks: [
        "Does the component handle loading, error, and empty states?",
        "Are shared components extended via props, not modified directly?",
        "Is the component accessible?",
        "Are reactive statements ($:) used correctly?",
      ],
    },
    {
      name: "Stores & State",
      checks: [
        "Are stores properly subscribed and unsubscribed?",
        "Is derived state computed via derived stores?",
        "Are writable stores scoped appropriately?",
      ],
    },
    {
      name: "API & Data Loading",
      checks: [
        "Are load functions handling errors?",
        "Is authentication verified before loading protected data?",
        "Is form data validated in actions?",
        "Are API responses typed?",
      ],
    },
  ],
  actor_types: ["owner", "admin", "member", "viewer", "anonymous", "unauthenticated"],
  edge_cases: [
    "Reactive statement ordering",
    "Store memory leaks on navigation",
    "Token expiry mid-session",
    "Unauthorized access to protected route",
    "Empty state (no data)",
  ],
  example_flows: [],
};

const ANGULAR_CONFIG: FlowConfig = {
  layers: [
    {
      name: "Components & Templates",
      checks: [
        "Does the component handle loading, error, and empty states?",
        "Are shared components extended via @Input variants?",
        "Is the component accessible?",
        "Are template expressions simple (no complex logic)?",
        "Are reactive forms validated with Validators before submission?",
      ],
    },
    {
      name: "Services & State",
      checks: [
        "Are observables properly unsubscribed (async pipe or takeUntil)?",
        "Is state management consistent (NgRx, signals, or services)?",
        "Are services scoped to appropriate injector levels?",
      ],
    },
    {
      name: "HTTP & Interceptors",
      checks: [
        "Are HTTP errors handled consistently via interceptors?",
        "Is authentication applied via interceptors?",
        "Are responses typed with interfaces?",
      ],
    },
  ],
  actor_types: ["owner", "admin", "member", "viewer", "anonymous", "unauthenticated"],
  edge_cases: [
    "Observable memory leaks",
    "Change detection issues",
    "Token expiry mid-session",
    "Lazy-loaded module boundaries",
    "Empty state (no data)",
  ],
  example_flows: [],
};

const NODE_API_CONFIG: FlowConfig = {
  layers: [
    {
      name: "Route Handlers / Controllers",
      checks: [
        "Is input validated at the handler boundary?",
        "Are HTTP status codes semantically correct?",
        "Is authentication verified before processing?",
        "Are error responses consistent in shape?",
      ],
    },
    {
      name: "Middleware",
      checks: [
        "Is auth middleware applied to all protected routes?",
        "Are rate limiters configured for sensitive endpoints?",
        "Is request logging structured and correlation-ID-aware?",
      ],
    },
    {
      name: "Service / Business Logic",
      checks: [
        "Is business logic separated from HTTP concerns?",
        "Are transactions used for multi-step mutations?",
        "Are external service calls wrapped with error handling and timeouts?",
      ],
    },
    {
      name: "Database / Data Layer",
      checks: [
        "Are queries parameterized?",
        "Do list queries use pagination?",
        "Are N+1 queries avoided?",
        "Are indexes present for filtered/sorted columns?",
      ],
    },
  ],
  actor_types: ["owner", "admin", "member", "viewer", "service_account", "unauthenticated"],
  edge_cases: [
    "Concurrent writes to same resource",
    "Transaction rollback on partial failure",
    "Token expiry during long operation",
    "Pagination boundary (> 100 items)",
    "Missing required environment variables",
    "External service timeout",
  ],
  example_flows: [],
};

const PYTHON_API_CONFIG: FlowConfig = {
  layers: [
    {
      name: "Endpoints / Views",
      checks: [
        "Is input validated via Pydantic models or form validation?",
        "Are HTTP status codes correct?",
        "Is authentication/authorization checked?",
        "Are error responses consistent?",
      ],
    },
    {
      name: "Dependencies / Middleware",
      checks: [
        "Are dependency injection patterns consistent?",
        "Is auth applied to all protected endpoints?",
        "Are request-scoped resources cleaned up?",
      ],
    },
    {
      name: "Service / Business Logic",
      checks: [
        "Is business logic separated from endpoint handlers?",
        "Are database sessions scoped correctly?",
        "Are external API calls wrapped with error handling?",
      ],
    },
    {
      name: "Database / ORM Layer",
      checks: [
        "Are queries parameterized (no string formatting)?",
        "Do list queries use pagination?",
        "Are N+1 queries avoided (use joinedload/selectinload)?",
        "Are migrations reversible?",
      ],
    },
  ],
  actor_types: ["owner", "admin", "member", "viewer", "service_account", "unauthenticated"],
  edge_cases: [
    "Concurrent writes to same resource",
    "Database connection pool exhaustion",
    "Token expiry during async operation",
    "Pagination boundary (> 100 items)",
    "Missing environment variables",
  ],
  example_flows: [],
};

// ============================================================
// Archetype-specific templates (v0.7.1)
// ============================================================

/**
 * CLI tool / developer tool template.
 *
 * Designed for projects shaped like `conduct`, `eslint`, `prettier`, `tsc`:
 * a binary entry point that parses args, loads config, performs file/system
 * operations, and emits structured output. No web layers, no actor RBAC.
 */
const CLI_TOOL_CONFIG: FlowConfig = {
  layers: [
    {
      name: "CLI Entry & Argument Parsing",
      checks: [
        "Are required arguments validated with clear error messages on missing/invalid input?",
        "Are flag combinations validated (mutually exclusive flags, required pairs)?",
        "Does --help describe every option and accurately reflect current behavior?",
        "Are exit codes correct and consistent (0 = ok, non-zero = failure type)?",
        "Is there a global --version that matches package.json?",
      ],
    },
    {
      name: "Configuration & Environment",
      checks: [
        "Does the tool gracefully handle missing or malformed config files (no stack traces leaked)?",
        "Are config-file precedence rules documented (CLI flag > env > file > default)?",
        "Are env vars validated at startup (fail-fast on missing required values)?",
        "Are file paths normalized (absolute vs relative, ~ expansion, symlinks)?",
        "Are sensitive config values (tokens, keys) redacted from logs/errors?",
      ],
    },
    {
      name: "Core Logic & I/O",
      checks: [
        "Are file operations atomic (write to temp + rename) for crash safety?",
        "Are file/directory permissions set explicitly (no umask surprises)?",
        "Is stdin/stdout used correctly (don't mix logs with structured output)?",
        "Are long-running operations interruptible (SIGINT/SIGTERM cleanup)?",
        "Are subprocess invocations validated and quoted (no shell injection)?",
        "Are network calls bounded by timeouts and retried with backoff?",
      ],
    },
    {
      name: "State & Persistence",
      checks: [
        "Is on-disk state validated on read (schema check + version migration)?",
        "Are concurrent invocations serialized via lock files or rejected?",
        "Are stale locks (dead PID, old timestamp) detected and cleaned up?",
        "Are partial writes recoverable (transactional or torn-write detection)?",
      ],
    },
    {
      name: "Output & Exit",
      checks: [
        "Are errors written to stderr with actionable remediation hints?",
        "Is the output format stable (programmatic consumers, --json flag)?",
        "Is verbose/debug output gated behind a flag?",
        "Are background processes / file handles cleaned up on exit?",
      ],
    },
    {
      name: "Cross-Boundary",
      checks: [
        "When the tool spawns subprocesses, do failures propagate cleanly to the user?",
        "Do environment changes made by the tool persist as documented (or revert on failure)?",
        "When the tool calls external services, are credentials sourced consistently?",
      ],
    },
  ],
  actor_types: [
    "interactive_user",
    "ci_runner",
    "scripted_invocation",
    "subprocess_caller",
  ],
  edge_cases: [
    "Missing required CLI arg",
    "Conflicting flag combinations",
    "Malformed or missing config file",
    "Required env var unset",
    "Stale lock file from crashed previous run",
    "Concurrent invocations on the same project",
    "Disk full mid-write",
    "SIGINT during a multi-step operation",
    "Symlink loop or permission denied on a file path",
    "Subprocess returns non-zero exit",
    "Network partition during external API call",
    "Unicode / non-ASCII in file paths or args",
  ],
  example_flows: [
    {
      id: "cli-init",
      name: "First-time init",
      description: "User runs `<tool> init` in an empty project to scaffold config files.",
      entry_points: ["src/cli.ts", "src/core/init.ts"],
      actors: ["interactive_user"],
      edge_cases: [
        "Some config files already exist (don't clobber)",
        "Project directory not writable",
        "Detection heuristics return ambiguous results",
      ],
    },
    {
      id: "cli-resume",
      name: "Resume a previous run",
      description: "User runs `<tool> resume` after a crash or pause to continue from saved state.",
      entry_points: ["src/cli.ts"],
      actors: ["interactive_user", "ci_runner"],
      edge_cases: [
        "State file missing or corrupted",
        "State schema is older than current binary version",
        "Resume requested while another instance is running",
      ],
    },
    {
      id: "cli-pipe",
      name: "Tool used in a pipeline",
      description: "Output of the tool is consumed by another process via stdout pipe.",
      entry_points: ["src/cli.ts"],
      actors: ["subprocess_caller", "scripted_invocation"],
      edge_cases: [
        "Downstream process closes pipe early (SIGPIPE)",
        "Logs accidentally written to stdout instead of stderr",
        "Output format changes break the consumer",
      ],
    },
  ],
};

/**
 * Library / SDK template.
 *
 * Designed for packages whose primary deliverable is a public API consumed
 * by other code: SDKs, utility libraries, type packages. Focuses on API
 * stability, error contracts, and integration surface.
 */
const LIBRARY_CONFIG: FlowConfig = {
  layers: [
    {
      name: "Public API Surface",
      checks: [
        "Are all exported symbols documented and intentional (no accidental exports)?",
        "Do exported types accurately describe the runtime contract?",
        "Are breaking changes explicit (semver bump, CHANGELOG entry, deprecation period)?",
        "Are async APIs consistently Promise-based or callback-based (not mixed)?",
        "Are options objects extensible (additive non-breaking changes possible)?",
      ],
    },
    {
      name: "Input Validation & Error Contracts",
      checks: [
        "Are all public function arguments validated with clear error messages?",
        "Are errors typed (custom Error subclasses) so callers can discriminate?",
        "Is failure reporting consistent (throw vs Result<T> vs callback)?",
        "Do error messages avoid leaking internal implementation details?",
      ],
    },
    {
      name: "Internal Logic",
      checks: [
        "Are pure functions actually pure (no hidden module-level state)?",
        "Is shared state thread/async safe (no race conditions across awaits)?",
        "Are caches bounded and invalidatable?",
        "Do internal helpers stay internal (not accidentally re-exported)?",
      ],
    },
    {
      name: "Side-Effect Boundary (I/O, network)",
      checks: [
        "Are network calls wrapped in retry / timeout / cancellation primitives?",
        "Do file or env reads happen lazily (not at module load time)?",
        "Are subprocess spawns bounded (memory, runtime, output size)?",
        "Are platform differences abstracted (path separators, line endings)?",
      ],
    },
    {
      name: "Packaging & Distribution",
      checks: [
        "Does package.json `exports` cover every entry point cleanly (ESM/CJS)?",
        "Are TypeScript declarations published and accurate?",
        "Are peerDependencies declared correctly (no version conflicts for consumers)?",
        "Is the tarball size reasonable (no dev artifacts shipped)?",
      ],
    },
  ],
  actor_types: [
    "library_consumer",
    "type_consumer",
    "transitive_dependency_user",
    "framework_integration",
  ],
  edge_cases: [
    "Caller passes null/undefined to a required argument",
    "Caller awaits a value that's actually synchronous",
    "Two consumers import different versions transitively (peer-dep conflict)",
    "Module imported but never instantiated (tree-shake correctness)",
    "ESM consumer importing a CJS-only entry",
    "Bundler strips a side-effect import the library relies on",
    "Concurrent calls to a stateful API",
    "Backwards-compat break in a minor version (regression)",
  ],
  example_flows: [
    {
      id: "library-import",
      name: "Consumer imports the library",
      description: "A downstream project installs the package and imports its main API.",
      entry_points: ["src/index.ts"],
      actors: ["library_consumer"],
      edge_cases: [
        "Consumer uses ESM but library only ships CJS",
        "Consumer pins an old version with a known bug",
      ],
    },
    {
      id: "library-misuse",
      name: "Consumer calls API incorrectly",
      description: "Consumer passes invalid arguments or calls APIs in the wrong order.",
      entry_points: ["src/*"],
      actors: ["library_consumer"],
      edge_cases: [
        "Wrong type passed (no runtime check)",
        "Required option missing",
        "API called before initialization",
      ],
    },
  ],
};
