import { hasTeamAuthority, peerAllowed } from "../peer-roster.ts"; import { chiefLevel } from "../chief-level.ts";
import type { BotRecord } from "../store.ts";
import { libraryTeamRoles } from "../team-library.ts";
import { grokTemplateListing } from "../grok-marketplace.ts";
import { DATA_DIR } from "../config.ts";
import { PASS, type RouteHandler } from "./table.ts";

interface CatalogInstance {
  instanceId: string;
  driverKind: string;
  displayName: string;
  snapshot: { state: string };
  models: unknown;
  capabilities?: { effortLevels?: readonly string[] };
}

const NOT_CHIEF = "Only an active Chief may plan team setup";

/** Only dispatch inside the internal capability gate. What a Chief of Staff reads before it changes its team. */
export function createInternalChiefTeamRoutes(deps: {
  /** The calling bot as stored now; read again after every wait. */
  bot(): BotRecord | null;
  requireActive(): void;
  teams(): string[];
  bots(): readonly BotRecord[];
  instances(): Promise<readonly CatalogInstance[]>;
  library?: typeof libraryTeamRoles;
  grokTemplates?: () => ReturnType<typeof grokTemplateListing>;
}): RouteHandler {
  const chief = () => {
    const bot = deps.bot();
    return chiefLevel(bot) && !bot!.hidden ? bot : null;
  };
  return async ({ res, path, method, json }) => {
    if (method !== "GET" || (path !== "/api/internal/team-setup-catalog" && path !== "/api/internal/team-library")) return PASS;
    if (!chief()) return json(res, 403, { error: NOT_CHIEF });
    if (path === "/api/internal/team-library") {
      // The daily Grok Bot Marketplace copy: one bot each, added whole with create_bot's template.
      const grokBots = (deps.grokTemplates ?? (() => grokTemplateListing(DATA_DIR)))();
      const grok = grokBots.length ? { grokBots, grokBotsHow: "Each grokBots entry is one ready-made bot. Add it with create_bot { template: <its template id>, team: <an authorized team> }; name and role are optional (give a Chinese name if the person wants one). Its full instructions and playbooks come with it." } : {};
      let teams: Awaited<ReturnType<typeof libraryTeamRoles>>;
      try {
        teams = await (deps.library ?? libraryTeamRoles)();
      } catch {
        if (grokBots.length) { deps.requireActive(); return chief() ? json(res, 200, { teams: [], ...grok }) : json(res, 403, { error: NOT_CHIEF }); }
        return json(res, 502, { error: "The team library can't be reached right now. Build the team from what the person asked." });
      }
      deps.requireActive();
      return chief() ? json(res, 200, { teams, ...grok }) : json(res, 403, { error: NOT_CHIEF });
    }
    const instances = await deps.instances();
    deps.requireActive();
    const current = chief();
    if (!current) return json(res, 403, { error: NOT_CHIEF });
    return json(res, 200, {
      teams: deps.teams().filter((name) => hasTeamAuthority(current, name)),
      bots: deps.bots().filter((bot) => !bot.hidden && hasTeamAuthority(current, bot.section) && (bot.id === current.id || peerAllowed(current, bot)))
        .map((bot) => ({ id: bot.id, name: bot.name, title: bot.title, section: bot.section ?? "", modelSelection: bot.modelSelection, chiefOfStaff: Boolean(bot.chiefOfStaff) })),
      instances: instances.map((instance) => ({ instanceId: instance.instanceId, driverKind: instance.driverKind, displayName: instance.displayName,
        state: instance.snapshot.state, models: instance.models, effortLevels: instance.capabilities?.effortLevels ?? [] })),
      scope: "Bot model defaults apply to groups and new threads; existing threads retain their models. Requested team setup applies immediately, and the person can undo it. Existing unauthorized teams remain outside this Chief's scope.",
    });
  };
}
