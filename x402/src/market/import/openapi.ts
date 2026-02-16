import { ShopEndpoint } from "../types.js";

export interface OpenApiImportOptions {
  pricingModel?: ShopEndpoint["pricingModel"];
  settlementModes?: ShopEndpoint["settlementModes"];
  availabilityTarget?: number;
  defaultLatencyMs?: number;
}

export interface ImportedOpenApi {
  title: string;
  description?: string;
  endpoints: ShopEndpoint[];
}

function operationDescription(operation: Record<string, unknown>, fallbackPath: string): string {
  const summary = typeof operation.summary === "string" ? operation.summary : undefined;
  const description = typeof operation.description === "string" ? operation.description : undefined;
  return summary ?? description ?? `Imported endpoint ${fallbackPath}`;
}

function operationTags(operation: Record<string, unknown>): string[] {
  const tags = Array.isArray(operation.tags) ? operation.tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0) : [];
  if (tags.length > 0) {
    return tags;
  }
  return ["openapi_imported"];
}

function safeObject(value: unknown): Record<string, unknown> {
  return (value && typeof value === "object") ? value as Record<string, unknown> : {};
}

export function importOpenApiSpec(spec: unknown, options: OpenApiImportOptions = {}): ImportedOpenApi {
  const root = safeObject(spec);
  const info = safeObject(root.info);
  const paths = safeObject(root.paths);

  const title = typeof info.title === "string" && info.title.length > 0 ? info.title : "Imported API";
  const description = typeof info.description === "string" ? info.description : undefined;

  const endpoints: ShopEndpoint[] = [];
  const methods: Array<"GET" | "POST"> = ["GET", "POST"];

  for (const [path, pathObjectRaw] of Object.entries(paths)) {
    if (!path.startsWith("/")) {
      continue;
    }
    const pathObject = safeObject(pathObjectRaw);
    for (const method of methods) {
      const operation = safeObject(pathObject[method.toLowerCase()]);
      if (Object.keys(operation).length === 0) {
        continue;
      }

      const endpointId = `${method.toLowerCase()}-${path.replace(/^\//, "").replace(/[^a-zA-Z0-9_]+/g, "-")}`;
      endpoints.push({
        endpointId,
        method,
        path,
        capabilityTags: operationTags(operation),
        description: operationDescription(operation, path),
        pricingModel: options.pricingModel ?? {
          kind: "flat",
          amountAtomic: "1000",
        },
        settlementModes: options.settlementModes ?? ["transfer", "stream", "netting"],
        sla: {
          maxLatencyMs: options.defaultLatencyMs ?? 1500,
          availabilityTarget: options.availabilityTarget ?? 0.99,
        },
        requestSchema: (operation.requestBody && typeof operation.requestBody === "object") ? operation.requestBody : undefined,
        responseSchema: (operation.responses && typeof operation.responses === "object") ? operation.responses : undefined,
        examples: [
          `curl -X ${method} https://api.example.com${path}`,
        ],
      });
    }
  }

  return {
    title,
    description,
    endpoints,
  };
}
