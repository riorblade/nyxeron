import {
  bands,
  channels,
  djs,
  tokens,
  permits,
  promoters,
  type GameEvent,
} from "@nyxeron/core";
import { en } from "@/i18n/en";

const names = {
  drink: (id: string) => tokens[id as keyof typeof tokens]?.name ?? id,
  dj: (id: string) => djs[id as keyof typeof djs]?.name ?? id,
  channel: (id: string) => channels[id as keyof typeof channels]?.name ?? id,
  permit: (id: string) => permits[id as keyof typeof permits]?.name ?? id,
  band: (id: string) => bands[id as keyof typeof bands]?.name ?? id,
  promoter: (id: string) => promoters[id as keyof typeof promoters]?.name ?? id,
};

export const eventText = (e: GameEvent) => en.event(e, names);

/** Events that deserve attention in the feed (vs. routine bookkeeping). */
export const isAlert = (e: GameEvent) =>
  [
    "outOfStock",
    "fight",
    "inspection",
    "crowdShutdown",
    "doorForced",
    "venueSealed",
    "rivalPromo",
    "securityStretched",
  ].includes(e.kind);
