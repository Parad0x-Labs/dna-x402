import { z } from "zod";
import { ShopManifest, shopManifestSchema } from "./schema.js";

export class ManifestValidationError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = "ManifestValidationError";
  }
}

function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "manifest";
    return `${path}: ${issue.message}`;
  });
}

export function validateShopManifest(input: unknown): ShopManifest {
  const parsed = shopManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new ManifestValidationError("Invalid shop manifest", formatZodIssues(parsed.error));
  }

  const endpointIds = new Set<string>();
  for (const endpoint of parsed.data.endpoints) {
    if (endpointIds.has(endpoint.endpointId)) {
      throw new ManifestValidationError("Invalid shop manifest", [
        `endpoints.${endpoint.endpointId}: duplicate endpointId`,
      ]);
    }
    endpointIds.add(endpoint.endpointId);
  }

  return parsed.data;
}
