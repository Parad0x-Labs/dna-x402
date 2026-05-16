export type EventVisibility =
  | "PRIVATE_ACTOR_ONLY"
  | "COUNTERPARTY_VISIBLE"
  | "SELLER_AGGREGATE"
  | "PUBLIC_AGGREGATE"
  | "ADMIN_ONLY"
  | "COMPLIANCE_ONLY";

export interface MarketEventAccessPolicy {
  eventType: string;
  defaultVisibility: EventVisibility;
  aggregationThreshold: number;
  allowedRoles: string[];
  redactedFields: string[];
}

export interface EventAccessActor {
  actorId?: string;
  sellerProfileId?: string;
  roles: string[];
}

export interface PrivateMarketEvent {
  eventId: string;
  eventType: string;
  buyerActorId?: string;
  sellerProfileId?: string;
  amountAtomic?: string;
  payload: Record<string, unknown>;
}
