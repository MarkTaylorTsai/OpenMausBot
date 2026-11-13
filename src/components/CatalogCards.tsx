// Community teams and Grok Bot Marketplace bots as cards shaped like the ready-made bots above them: "+ Add" adds
// the bot (or the whole team) at once, and the name opens the preview first.
import { useState } from "react";
import { Loader2, Plus, Users } from "lucide-react";
import { MausAvatar } from "./Avatar";
import { TEAM_GLYPHS } from "./TeamImportDetails";
import { catalogCopy, type TeamCatalogEntry } from "@/lib/team-catalog";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { MausColor } from "../../shared/wire";

const GROUP_KEYS: Record<string, LocaleKey> = {
  engineering: "templates.grokGroup.engineering", sales: "templates.grokGroup.sales", marketing: "templates.grokGroup.marketing",
  design: "templates.grokGroup.design", personal: "templates.grokGroup.personal", "recruiting & people": "templates.grokGroup.recruiting",
  product: "templates.grokGroup.product", operations: "templates.grokGroup.operations",
  "from grok bot team": "templates.grokGroup.official", bots: "templates.grokGroup.other",
};
const groupLabel = (group: string) => { const key = GROUP_KEYS[group.trim().toLowerCase()]; return key ? t(key) : group; };

export function CatalogCards({ entries, busy, onAdd, onDetails, groups = false }: {
  entries: TeamCatalogEntry[];
  busy: string | null;
  onAdd: (entry: TeamCatalogEntry) => void;
  onDetails: (entry: TeamCatalogEntry) => void;
  /** Show the category chips (the Grok Bot Marketplace section). */
  groups?: boolean;
}) {
  const [group, setGroup] = useState<string | null>(null);
  const names = groups ? [...new Set(entries.map((entry) => entry.card?.group).filter((name): name is string => Boolean(name)))] : [];
  const visible = group ? entries.filter((entry) => entry.card?.group === group) : entries;
  return <>
    {names.length > 1 && <div className="mb-3 mt-2 flex flex-wrap gap-1.5" role="group" aria-label={t("readyBots.categories")}>
      {[null, ...names].map((name) => <button key={name ?? "all"} type="button" aria-pressed={group === name} onClick={() => setGroup(name)}
        className={cn("rounded-full px-3 py-1 text-[13px] transition-colors", group === name ? "bg-ink text-panel" : "bg-raised/70 text-ink-secondary hover:text-ink")}>
        {name ? groupLabel(name) : t("readyBots.all")}
      </button>)}
    </div>}
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
      {visible.map((entry, index) => {
        const copy = catalogCopy(entry);
        const card = entry.card;
        const extras = [
          entry.requires.apps.length > 0 && t("readyBots.worksWith", { apps: entry.requires.apps.slice(0, 4).join(", ") }),
          entry.skills.length > 0 && t("templates.playbookCount", { count: entry.skills.length }),
          card?.routines ? t("templates.suggestedRoutines", { count: card.routines }) : false,
        ].filter(Boolean);
        return <article key={entry.slug} data-catalog-card={entry.slug} className="flex flex-col rounded-2xl border border-hairline/40 bg-card p-4">
          <div className="flex items-center gap-3">
            {card
              ? <MausAvatar color={card.color as MausColor} size={40} animated={false} label={entry.name} />
              : <div className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", TEAM_GLYPHS[index % TEAM_GLYPHS.length])}><Users size={19} /></div>}
            <button type="button" onClick={() => onDetails(entry)} className="min-w-0 flex-1 text-left" title={t("templates.cardDetails")}>
              <h4 className="truncate text-[14px] font-medium text-ink hover:underline">{copy.name}</h4>
              <p className="truncate text-[12px] text-ink-secondary">
                {card ? [card.creator, groupLabel(card.group)].filter(Boolean).join(" · ") : t("templates.botCount", { count: entry.members })}
              </p>
            </button>
            <button type="button" onClick={() => onAdd(entry)} disabled={busy !== null} aria-label={t("readyBots.addAria", { name: copy.name, title: card ? groupLabel(card.group) : t("templates.botCount", { count: entry.members }) })}
              className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-raised px-3 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent">
              {busy === entry.slug ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}{t("readyBots.add")}
            </button>
          </div>
          <p className="mt-3 line-clamp-4 text-[13px] leading-[1.45] text-ink-secondary">{card?.description ?? copy.outcome ?? copy.summary}</p>
          {extras.length > 0 && <p className="mt-auto truncate pt-2 text-[12px] text-ink-tertiary">{extras.join(" · ")}</p>}
        </article>;
      })}
    </div>
  </>;
}
