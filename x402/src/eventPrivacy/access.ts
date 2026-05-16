import { EventAccessActor, MarketEventAccessPolicy, PrivateMarketEvent } from "./types.js";

export class MarketEventPrivacyService {
  constructor(private readonly policies: MarketEventAccessPolicy[]) {}

  policyFor(eventType: string): MarketEventAccessPolicy {
    return this.policies.find((policy) => policy.eventType === eventType) ?? {
      eventType,
      defaultVisibility: "PRIVATE_ACTOR_ONLY",
      aggregationThreshold: 5,
      allowedRoles: ["admin", "compliance"],
      redactedFields: ["buyerActorId"],
    };
  }

  canViewRaw(event: PrivateMarketEvent, actor: EventAccessActor): boolean {
    const policy = this.policyFor(event.eventType);
    if (actor.roles.some((role) => policy.allowedRoles.includes(role))) {
      return true;
    }
    switch (policy.defaultVisibility) {
      case "COUNTERPARTY_VISIBLE":
        return actor.actorId === event.buyerActorId || actor.sellerProfileId === event.sellerProfileId;
      case "PRIVATE_ACTOR_ONLY":
        return actor.actorId === event.buyerActorId;
      default:
        return false;
    }
  }

  publicAggregate<T>(rows: T[], threshold: number): { visible: boolean; rows: T[] } {
    if (rows.length < threshold) {
      return { visible: false, rows: [] };
    }
    return { visible: true, rows };
  }

  redact(event: PrivateMarketEvent, actor: EventAccessActor): PrivateMarketEvent {
    if (this.canViewRaw(event, actor)) {
      return event;
    }
    const policy = this.policyFor(event.eventType);
    const redacted: PrivateMarketEvent = {
      ...event,
      payload: { ...event.payload },
    };
    for (const field of policy.redactedFields) {
      if (field in redacted) {
        (redacted as unknown as Record<string, unknown>)[field] = "REDACTED";
      }
      if (field in redacted.payload) {
        redacted.payload[field] = "REDACTED";
      }
    }
    return redacted;
  }
}
