import crypto from "node:crypto";
import { DurableRepository } from "../db/schema/tables.js";

export interface EmergencyPauseState {
  id: "global";
  quotePaused: boolean;
  finalizePaused: boolean;
  marketplacePaused: boolean;
  webhookPaused: boolean;
  sellerListingUpdatesPaused: boolean;
  reason: string;
  actorId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface EmergencyPauseEvent {
  id: string;
  stateId: "global";
  flag: keyof Pick<EmergencyPauseState,
    | "quotePaused"
    | "finalizePaused"
    | "marketplacePaused"
    | "webhookPaused"
    | "sellerListingUpdatesPaused">;
  enabled: boolean;
  reason: string;
  actorId: string;
  createdAt: string;
}

export type EmergencyPauseFlag =
  | "quotePaused"
  | "finalizePaused"
  | "marketplacePaused"
  | "webhookPaused"
  | "sellerListingUpdatesPaused";

const DEFAULT_ID = "global";

function defaultState(now: Date): EmergencyPauseState {
  const ts = now.toISOString();
  return {
    id: DEFAULT_ID,
    quotePaused: false,
    finalizePaused: false,
    marketplacePaused: false,
    webhookPaused: false,
    sellerListingUpdatesPaused: false,
    reason: "initial",
    actorId: "system",
    version: 1,
    createdAt: ts,
    updatedAt: ts,
  };
}

export class EmergencyPauseController {
  private state: EmergencyPauseState;
  private readonly events: EmergencyPauseEvent[] = [];

  constructor(
    private readonly stateRepository?: DurableRepository<EmergencyPauseState>,
    private readonly eventRepository?: DurableRepository<EmergencyPauseEvent>,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.state = defaultState(this.now());
  }

  async load(): Promise<EmergencyPauseState> {
    const saved = await this.stateRepository?.get(DEFAULT_ID);
    if (saved) {
      this.state = saved.payload;
    }
    return this.snapshot();
  }

  snapshot(): EmergencyPauseState {
    return { ...this.state };
  }

  isPaused(flag: EmergencyPauseFlag): boolean {
    return this.state[flag];
  }

  async setFlag(input: {
    flag: EmergencyPauseFlag;
    enabled: boolean;
    reason: string;
    actorId: string;
  }): Promise<EmergencyPauseState> {
    if (input.reason.trim().length === 0) {
      throw new Error("emergency pause reason is required");
    }
    if (input.actorId.trim().length === 0) {
      throw new Error("emergency pause actorId is required");
    }

    const ts = this.now().toISOString();
    this.state = {
      ...this.state,
      [input.flag]: input.enabled,
      reason: input.reason,
      actorId: input.actorId,
      version: this.state.version + 1,
      updatedAt: ts,
    };
    await this.stateRepository?.put(DEFAULT_ID, this.state);

    const event: EmergencyPauseEvent = {
      id: crypto.randomUUID(),
      stateId: DEFAULT_ID,
      flag: input.flag,
      enabled: input.enabled,
      reason: input.reason,
      actorId: input.actorId,
      createdAt: ts,
    };
    this.events.push(event);
    await this.eventRepository?.append(event.id, event);
    return this.snapshot();
  }

  history(): EmergencyPauseEvent[] {
    return [...this.events];
  }
}
