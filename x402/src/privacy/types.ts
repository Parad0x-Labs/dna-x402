export type DataSubjectRequestType = "ACCESS" | "ERASURE" | "RECTIFICATION" | "EXPORT" | "RESTRICT_PROCESSING";
export type DataSubjectRegion = "EU" | "US" | "OTHER";
export type DataSubjectRequestStatus =
  | "OPEN"
  | "VERIFYING"
  | "PROCESSING"
  | "COMPLETED"
  | "DENIED_LEGAL_RETENTION";

export interface DataSubjectRequest {
  requestId: string;
  subjectActorId: string;
  type: DataSubjectRequestType;
  region: DataSubjectRegion;
  status: DataSubjectRequestStatus;
  affectedTables: string[];
  immutableReferences: string[];
  createdAt: string;
  completedAt?: string;
  denialReason?: string;
}

export interface MutablePersonalRecord {
  actorId: string;
  encryptedPayload: string;
  piiHash: string;
  legalHold: boolean;
  deletedAt?: string;
}
