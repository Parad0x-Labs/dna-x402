import crypto from "node:crypto";
import { z } from "zod";
import { AbuseReport, AbuseReportType } from "./types.js";

const reportTypeSchema = z.enum(["scam", "illegal", "malware", "impersonation", "other"]);

export const reportBodySchema = z.object({
  shopId: z.string().min(1),
  reportType: reportTypeSchema,
  reason: z.string().max(1_024).optional(),
});

export type ReportBody = z.infer<typeof reportBodySchema>;

export function createAbuseReport(input: {
  shopId: string;
  reportType: AbuseReportType;
  reason?: string;
  now?: Date;
}): AbuseReport {
  return {
    reportId: crypto.randomUUID(),
    ts: (input.now ?? new Date()).toISOString(),
    shopId: input.shopId,
    reportType: input.reportType,
    reason: input.reason,
  };
}
