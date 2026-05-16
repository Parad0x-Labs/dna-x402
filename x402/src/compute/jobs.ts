import { stableHash } from "../common/stable.js";

export type ComputeJobStatus =
  | "QUOTE_REQUESTED"
  | "PAID"
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "TIMED_OUT"
  | "CANCELLED"
  | "REFUND_PENDING"
  | "REFUNDED";

export interface ComputeJobProof {
  inputDigest: string;
  environmentDigest: string;
  outputDigest?: string;
  logsDigest?: string;
  runtimeMetrics?: Record<string, number>;
  providerSignature?: string;
}

export interface ComputeJob {
  jobId: string;
  providerId: string;
  quoteId: string;
  status: ComputeJobStatus;
  paidAmountAtomic: string;
  timeoutAt: string;
  proof: ComputeJobProof;
  createdAt: string;
  updatedAt: string;
}

export class ComputeJobStateMachine {
  create(input: Omit<ComputeJob, "jobId" | "status" | "createdAt" | "updatedAt">, now = new Date()): ComputeJob {
    const createdAt = now.toISOString();
    return {
      ...input,
      jobId: stableHash({ providerId: input.providerId, quoteId: input.quoteId, createdAt }),
      status: "QUOTE_REQUESTED",
      createdAt,
      updatedAt: createdAt,
    };
  }

  transition(job: ComputeJob, next: ComputeJobStatus, now = new Date()): ComputeJob {
    const allowed = this.allowedNext(job.status);
    if (!allowed.includes(next)) {
      throw new Error(`invalid compute job transition ${job.status} -> ${next}`);
    }
    return {
      ...job,
      status: next,
      updatedAt: now.toISOString(),
    };
  }

  timeout(job: ComputeJob, now = new Date()): ComputeJob {
    if (new Date(job.timeoutAt).getTime() > now.getTime()) {
      return job;
    }
    if (["COMPLETED", "FAILED", "CANCELLED", "REFUNDED"].includes(job.status)) {
      return job;
    }
    return {
      ...job,
      status: "TIMED_OUT",
      updatedAt: now.toISOString(),
    };
  }

  bindOutput(job: ComputeJob, output: unknown, logs: unknown, now = new Date()): ComputeJob {
    if (job.status !== "RUNNING") {
      throw new Error("compute output can only be bound while running");
    }
    return {
      ...job,
      status: "COMPLETED",
      proof: {
        ...job.proof,
        outputDigest: stableHash(output),
        logsDigest: stableHash(logs),
      },
      updatedAt: now.toISOString(),
    };
  }

  private allowedNext(status: ComputeJobStatus): ComputeJobStatus[] {
    switch (status) {
      case "QUOTE_REQUESTED":
        return ["PAID", "CANCELLED"];
      case "PAID":
        return ["QUEUED", "REFUND_PENDING"];
      case "QUEUED":
        return ["RUNNING", "CANCELLED", "TIMED_OUT"];
      case "RUNNING":
        return ["COMPLETED", "FAILED", "TIMED_OUT"];
      case "FAILED":
      case "TIMED_OUT":
      case "CANCELLED":
        return ["REFUND_PENDING"];
      case "REFUND_PENDING":
        return ["REFUNDED"];
      default:
        return [];
    }
  }
}
