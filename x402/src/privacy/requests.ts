import { InMemoryRepository, nowIso, stableHash } from "../common/stable.js";
import { MutablePersonalRecord, DataSubjectRequest } from "./types.js";

export class PrivacyRequestService {
  private readonly requests = new InMemoryRepository<DataSubjectRequest>();
  private readonly records = new InMemoryRepository<MutablePersonalRecord>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  putPersonalRecord(record: MutablePersonalRecord): MutablePersonalRecord {
    return this.records.put(record.actorId, record);
  }

  openRequest(input: Omit<DataSubjectRequest, "requestId" | "status" | "createdAt">): DataSubjectRequest {
    const createdAt = nowIso(this.now);
    const request: DataSubjectRequest = {
      ...input,
      requestId: stableHash({ subjectActorId: input.subjectActorId, type: input.type, createdAt }),
      status: "OPEN",
      createdAt,
    };
    return this.requests.put(request.requestId, request);
  }

  processErasure(requestId: string): DataSubjectRequest {
    const request = this.requests.get(requestId);
    if (!request) {
      throw new Error("data subject request not found");
    }
    if (request.type !== "ERASURE") {
      throw new Error("request is not an erasure request");
    }
    const record = this.records.get(request.subjectActorId);
    const completedAt = nowIso(this.now);
    if (record?.legalHold) {
      const denied: DataSubjectRequest = {
        ...request,
        status: "DENIED_LEGAL_RETENTION",
        completedAt,
        denialReason: "legal_or_tax_retention_required",
      };
      return this.requests.put(requestId, denied);
    }
    if (record) {
      this.records.put(request.subjectActorId, {
        ...record,
        encryptedPayload: "",
        deletedAt: completedAt,
      });
    }
    const completed: DataSubjectRequest = {
      ...request,
      status: "COMPLETED",
      completedAt,
    };
    return this.requests.put(requestId, completed);
  }

  exportSubject(actorId: string): Record<string, unknown> {
    const record = this.records.get(actorId);
    const requests = this.requests.list().filter((request) => request.subjectActorId === actorId);
    return {
      actorId,
      personalRecord: record
        ? {
          actorId: record.actorId,
          piiHash: record.piiHash,
          deletedAt: record.deletedAt,
          legalHold: record.legalHold,
        }
        : null,
      requests,
    };
  }
}
