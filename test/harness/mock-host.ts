import hostHookNames from "../fixtures/host-hook-names.json" with { type: "json" };

/** Hook names the current (2026.7.x) host recognizes. */
export const MODERN_HOOK_NAMES: readonly string[] = hostHookNames.pluginHookNames;

/** Conversation hooks the host gates behind `allowConversationAccess`. */
export const CONVERSATION_HOOK_NAMES: readonly string[] = hostHookNames.conversationHookNames;

/** The host version the fixture was vendored from. */
export const VENDORED_HOST_VERSION: string = hostHookNames.hostVersion;

/**
 * A pre-2026.7 host: no `before_agent_run`, no `tool_result_persist`, no
 * `model_call_*`, and compaction still under the `*_context_prune` names.
 * Used to prove the plugin degrades gracefully instead of throwing.
 */
export const LEGACY_HOOK_NAMES: readonly string[] = [
  "before_agent_start",
  "before_agent_reply",
  "llm_input",
  "llm_output",
  "agent_end",
  "before_context_prune",
  "after_context_prune",
  "inbound_claim",
  "message_received",
  "message_sending",
  "message_sent",
  "before_tool_call",
  "after_tool_call",
  "session_start",
  "session_end",
  "gateway_start",
  "gateway_stop",
];

export type HostProfile = {
  name: string;
  knownHooks: readonly string[];
  /** Mirrors `plugins.entries.<id>.hooks.allowConversationAccess`. */
  allowConversationAccess: boolean;
};

export const MODERN_HOST: HostProfile = {
  name: "modern",
  knownHooks: MODERN_HOOK_NAMES,
  allowConversationAccess: true,
};

export const LEGACY_HOST: HostProfile = {
  name: "legacy",
  knownHooks: LEGACY_HOOK_NAMES,
  allowConversationAccess: true,
};

export const MODERN_HOST_NO_CONVERSATION_ACCESS: HostProfile = {
  name: "modern-no-conversation-access",
  knownHooks: MODERN_HOOK_NAMES,
  allowConversationAccess: false,
};

type Registration = {
  hookName: string;
  handler: (...args: unknown[]) => unknown;
  priority: number;
};

export type MockHost = {
  api: {
    logger: { info: (m: string) => void; warn: (m: string) => void; debug: (m: string) => void };
    on: (name: string, fn: (...args: unknown[]) => unknown, opts?: unknown) => void;
    registerService?: (svc: {
      id: string;
      start: () => void | Promise<void>;
      stop: () => void | Promise<void>;
    }) => void;
  };
  /** Hook names that actually wired up on this host profile. */
  registeredHookNames: () => string[];
  /** Registrations the host rejected, with the reason (mirrors host diagnostics). */
  rejected: Array<{ hookName: string; reason: string }>;
  logs: string[];
  services: Array<{ id: string; start: () => void | Promise<void>; stop: () => void | Promise<void> }>;
  /** Dispatch one hook to all registered handlers, in host priority order. */
  dispatch: (hookName: string, event: unknown, ctx?: unknown) => Promise<unknown[]>;
  /** True when at least one handler is registered for the name. */
  hasHooks: (hookName: string) => boolean;
};

/**
 * A stand-in for the OpenClaw plugin host that reproduces the three registry
 * behaviors that matter for hook capture (see host `registerTypedHook`):
 *
 *  1. Unknown hook names are ignored with a warning — never thrown.
 *  2. Conversation hooks are blocked unless `allowConversationAccess` is true.
 *  3. Handlers run sequentially in descending priority; ties keep registration order.
 */
export function createMockHost(profile: HostProfile = MODERN_HOST): MockHost {
  const registrations: Registration[] = [];
  const rejected: Array<{ hookName: string; reason: string }> = [];
  const logs: string[] = [];
  const services: MockHost["services"] = [];

  const api: MockHost["api"] = {
    logger: {
      info: (m: string) => logs.push(`info: ${m}`),
      warn: (m: string) => logs.push(`warn: ${m}`),
      debug: (m: string) => logs.push(`debug: ${m}`),
    },
    on: (name, fn, opts) => {
      if (!profile.knownHooks.includes(name)) {
        rejected.push({ hookName: name, reason: `unknown typed hook "${name}" ignored` });
        return;
      }
      if (CONVERSATION_HOOK_NAMES.includes(name) && !profile.allowConversationAccess) {
        rejected.push({
          hookName: name,
          reason: `typed hook "${name}" blocked because non-bundled plugins must set allowConversationAccess=true`,
        });
        return;
      }
      const priority =
        opts && typeof opts === "object" && typeof (opts as { priority?: unknown }).priority === "number"
          ? (opts as { priority: number }).priority
          : 0;
      registrations.push({ hookName: name, handler: fn, priority });
    },
    registerService: (svc) => {
      services.push(svc);
    },
  };

  const dispatch = async (hookName: string, event: unknown, ctx: unknown = {}): Promise<unknown[]> => {
    // Stable sort by descending priority (registration order preserved on ties).
    const handlers = registrations
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.hookName === hookName)
      .sort((a, b) => b.r.priority - a.r.priority || a.i - b.i)
      .map(({ r }) => r);

    const results: unknown[] = [];
    for (const { handler } of handlers) {
      const out = handler(event, ctx);
      // `tool_result_persist` and `before_message_write` are synchronous in the
      // host: a Promise return is ignored and warned about. Fail loudly here so
      // an accidental `async` handler cannot slip through.
      if (hookName === "tool_result_persist" || hookName === "before_message_write") {
        if (out instanceof Promise) {
          throw new Error(
            `${hookName} handler returned a Promise; this hook is synchronous and the host would ignore the result`
          );
        }
        results.push(out);
      } else {
        results.push(await out);
      }
    }
    return results;
  };

  return {
    api,
    registeredHookNames: () => [...new Set(registrations.map((r) => r.hookName))],
    rejected,
    logs,
    services,
    dispatch,
    hasHooks: (hookName: string) => registrations.some((r) => r.hookName === hookName),
  };
}
