import React, { useEffect, useMemo, useState } from 'react';
import { SafeCategory } from '../lib/marketSafety';

type SettlementMode = 'transfer' | 'stream' | 'netting';
type WizardMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type WizardPricingKind = 'flat' | 'metered' | 'surge' | 'stream';
type PricingBand = 'cheap' | 'typical' | 'premium';

type WizardPricingModel =
  | {
    kind: 'flat';
    amountAtomic: string;
  }
  | {
    kind: 'metered';
    unitName: string;
    amountPerUnitAtomic: string;
    minUnits: number;
  }
  | {
    kind: 'surge';
    baseAmountAtomic: string;
    minMultiplier: number;
    maxMultiplier: number;
  }
  | {
    kind: 'stream';
    rateAtomicPerSecond: string;
    minTopupAtomic: string;
  };

export interface ShopWizardEndpointDraft {
  endpointId: string;
  method: WizardMethod;
  path: string;
  capabilityTags: string[];
  description: string;
  pricingModel: WizardPricingModel;
  settlementModes: SettlementMode[];
  sla: {
    maxLatencyMs: number;
    availabilityTarget: number;
  };
  examples?: string[];
  requestSchema?: unknown;
  responseSchema?: unknown;
  limits?: Record<string, string | number | boolean>;
}

export interface ShopWizardPublishInput {
  name: string;
  description?: string;
  category: SafeCategory;
  endpoints: ShopWizardEndpointDraft[];
}

interface ShopWizardProps {
  x402BaseUrl: string;
  disabled?: boolean;
  onPublish: (input: ShopWizardPublishInput) => Promise<void>;
  onPublished?: (shopName: string) => void;
}

interface ImportedEndpoint {
  endpointId: string;
  method: WizardMethod;
  path: string;
  capabilityTags: string[];
  description: string;
  settlementModes?: SettlementMode[];
  sla?: {
    maxLatencyMs: number;
    availabilityTarget: number;
  };
  examples?: string[];
  requestSchema?: unknown;
  responseSchema?: unknown;
}

interface EndpointConfig {
  enabled: boolean;
  pricingKind: WizardPricingKind;
  amountAtomic: string;
  settlementModes: SettlementMode[];
}

interface ShopTemplate {
  id: string;
  label: string;
  category: SafeCategory;
  description: string;
  defaultTags: string[];
}

export const SAFE_TEMPLATES: ShopTemplate[] = [
  {
    id: 'template-ai-inference',
    label: 'AI Inference',
    category: 'ai_inference',
    description: 'Sell LLM inference and completion endpoints.',
    defaultTags: ['inference', 'llm'],
  },
  {
    id: 'template-image-generation',
    label: 'Image Generation',
    category: 'image_generation',
    description: 'Sell image generation and transform tools.',
    defaultTags: ['image_generation', 'render'],
  },
  {
    id: 'template-data-enrichment',
    label: 'Data Enrichment',
    category: 'data_enrichment',
    description: 'Sell extraction, normalization, and enrichment jobs.',
    defaultTags: ['data_enrichment', 'extract'],
  },
  {
    id: 'template-workflow-tool',
    label: 'Workflow Tool',
    category: 'workflow_tool',
    description: 'Sell workflow automation and business actions.',
    defaultTags: ['workflow', 'automation'],
  },
];

const PRICE_BANDS: Record<PricingBand, string> = {
  cheap: '500',
  typical: '2000',
  premium: '5000',
};

const PUBLISH_DENYLIST_TERMS = [
  'vpn',
  'proxy',
  'socks',
  'tor',
  'residential proxy',
  'rdp',
  'vnc',
  'remote desktop',
  'citrix',
  'malware',
  'stealer',
  'credential',
  'keylogger',
  'exploit',
  'crack',
  'pirated',
  'drm',
  'ddos',
  'botnet',
  'betting',
  'wager',
  'odds',
  'prediction market',
  'binary options',
  'sportsbook',
  'casino',
] as const;

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function findBlockedTerm(input: ShopWizardPublishInput): string | undefined {
  const fields: string[] = [
    input.name,
    input.description ?? '',
    input.category,
  ];
  for (const endpoint of input.endpoints) {
    fields.push(endpoint.path, endpoint.description);
    for (const tag of endpoint.capabilityTags) {
      fields.push(tag);
    }
  }
  const haystack = tokenize(fields.join('\n'));

  for (const term of PUBLISH_DENYLIST_TERMS) {
    const termTokens = tokenize(term);
    if (termTokens.length === 0) {
      continue;
    }
    for (let i = 0; i <= haystack.length - termTokens.length; i += 1) {
      let matches = true;
      for (let j = 0; j < termTokens.length; j += 1) {
        if (haystack[i + j] !== termTokens[j]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        return term;
      }
    }
  }

  return undefined;
}

function amountForBand(band: PricingBand): string {
  return PRICE_BANDS[band];
}

function estimateCallsPerUsdc(amountAtomic: string): number {
  if (!/^\d+$/.test(amountAtomic)) {
    return 0;
  }
  const amount = BigInt(amountAtomic);
  if (amount <= 0n) {
    return 0;
  }
  return Number(1_000_000n / amount);
}

function defaultConfig(endpoint: ImportedEndpoint, pricingBand: PricingBand): EndpointConfig {
  const isStream = endpoint.capabilityTags.some((tag) => tag.toLowerCase().includes('stream'));
  return {
    enabled: true,
    pricingKind: isStream ? 'stream' : 'flat',
    amountAtomic: isStream ? '10' : amountForBand(pricingBand),
    settlementModes: endpoint.settlementModes ?? ['transfer', 'stream', 'netting'],
  };
}

function buildPricingModel(kind: WizardPricingKind, amountAtomic: string): WizardPricingModel {
  if (kind === 'metered') {
    return {
      kind: 'metered',
      unitName: 'unit',
      amountPerUnitAtomic: amountAtomic,
      minUnits: 1,
    };
  }
  if (kind === 'surge') {
    return {
      kind: 'surge',
      baseAmountAtomic: amountAtomic,
      minMultiplier: 0.8,
      maxMultiplier: 3,
    };
  }
  if (kind === 'stream') {
    const perSecond = amountAtomic;
    const minTopup = (BigInt(amountAtomic) * 60n).toString(10);
    return {
      kind: 'stream',
      rateAtomicPerSecond: perSecond,
      minTopupAtomic: minTopup,
    };
  }
  return {
    kind: 'flat',
    amountAtomic,
  };
}

async function parseOpenApiInput(input: string): Promise<unknown> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Paste OpenAPI JSON or URL');
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }
  const response = await fetch(trimmed);
  if (!response.ok) {
    throw new Error(`Failed to fetch OpenAPI URL (${response.status})`);
  }
  return response.json();
}

function fallbackEndpointId(method: WizardMethod, path: string): string {
  const norm = `${method}-${path}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return norm || `endpoint-${Date.now().toString(36)}`;
}

export const ShopWizard: React.FC<ShopWizardProps> = ({
  x402BaseUrl,
  disabled = false,
  onPublish,
  onPublished,
}) => {
  const [selectedTemplateId, setSelectedTemplateId] = useState(SAFE_TEMPLATES[0].id);
  const selectedTemplate = useMemo(
    () => SAFE_TEMPLATES.find((template) => template.id === selectedTemplateId) ?? SAFE_TEMPLATES[0],
    [selectedTemplateId],
  );

  const [shopName, setShopName] = useState('');
  const [shopDescription, setShopDescription] = useState('');

  const [openApiInput, setOpenApiInput] = useState('');
  const [defaultLatencyMs, setDefaultLatencyMs] = useState('1500');
  const [importedEndpoints, setImportedEndpoints] = useState<ImportedEndpoint[]>([]);
  const [configs, setConfigs] = useState<Record<string, EndpointConfig>>({});

  const [manualMethod, setManualMethod] = useState<WizardMethod>('POST');
  const [manualPath, setManualPath] = useState('/tool');
  const [manualCapability, setManualCapability] = useState('inference');
  const [manualDescription, setManualDescription] = useState('');

  const [pricingBand, setPricingBand] = useState<PricingBand>('typical');

  const [limitsEnabled, setLimitsEnabled] = useState(true);
  const [limitRatePerMin, setLimitRatePerMin] = useState('60');
  const [limitMaxSpendPerDayAtomic, setLimitMaxSpendPerDayAtomic] = useState('1000000');
  const [limitMaxConcurrency, setLimitMaxConcurrency] = useState('5');

  const [loadingImport, setLoadingImport] = useState(false);
  const [loadingPublish, setLoadingPublish] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const selectedCount = useMemo(() => (
    importedEndpoints.filter((endpoint) => configs[endpoint.endpointId]?.enabled).length
  ), [configs, importedEndpoints]);

  const callsPerUsdc = useMemo(() => estimateCallsPerUsdc(amountForBand(pricingBand)), [pricingBand]);

  useEffect(() => {
    if (!shopName.trim()) {
      setShopName(`${selectedTemplate.label} Shop`);
    }
    if (!shopDescription.trim()) {
      setShopDescription(selectedTemplate.description);
    }
  }, [selectedTemplate, shopName, shopDescription]);

  useEffect(() => {
    setConfigs((previous) => {
      if (Object.keys(previous).length === 0) {
        return previous;
      }
      const next: Record<string, EndpointConfig> = {};
      for (const endpoint of importedEndpoints) {
        const existing = previous[endpoint.endpointId] ?? defaultConfig(endpoint, pricingBand);
        next[endpoint.endpointId] = {
          ...existing,
          amountAtomic: existing.pricingKind === 'stream' ? existing.amountAtomic : amountForBand(pricingBand),
        };
      }
      return next;
    });
  }, [pricingBand, importedEndpoints]);

  const importOpenApi = async () => {
    setLoadingImport(true);
    setError('');
    setSuccess('');
    try {
      const spec = await parseOpenApiInput(openApiInput);
      const response = await fetch(`${x402BaseUrl.replace(/\/$/, '')}/market/import/openapi`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          spec,
          defaults: {
            priceAtomic: amountForBand(pricingBand),
            maxLatencyMs: Number.parseInt(defaultLatencyMs, 10) || 1500,
          },
        }),
      });
      if (!response.ok) {
        throw new Error(`OpenAPI import failed (${response.status})`);
      }

      const payload = await response.json() as { title?: string; description?: string; endpoints?: ImportedEndpoint[] };
      const endpoints = payload.endpoints ?? [];
      if (endpoints.length === 0) {
        throw new Error('Importer returned zero endpoints');
      }

      setImportedEndpoints(endpoints);
      const nextConfigs: Record<string, EndpointConfig> = {};
      for (const endpoint of endpoints) {
        nextConfigs[endpoint.endpointId] = defaultConfig(endpoint, pricingBand);
      }
      setConfigs(nextConfigs);

      if (payload.title && shopName.trim() === `${selectedTemplate.label} Shop`) {
        setShopName(payload.title);
      }
      if (payload.description && shopDescription.trim() === selectedTemplate.description) {
        setShopDescription(payload.description);
      }
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Failed to import OpenAPI');
    } finally {
      setLoadingImport(false);
    }
  };

  const addManualEndpoint = () => {
    setError('');
    if (!manualPath.trim().startsWith('/')) {
      setError('Manual endpoint path must start with /');
      return;
    }
    if (!manualCapability.trim()) {
      setError('Capability tag is required');
      return;
    }

    const endpoint: ImportedEndpoint = {
      endpointId: fallbackEndpointId(manualMethod, manualPath),
      method: manualMethod,
      path: manualPath.trim(),
      capabilityTags: [manualCapability.trim()],
      description: manualDescription.trim() || `${manualCapability.trim()} endpoint`,
      settlementModes: ['transfer', 'stream', 'netting'],
      sla: {
        maxLatencyMs: Number.parseInt(defaultLatencyMs, 10) || 1500,
        availabilityTarget: 0.99,
      },
      examples: [`curl -X ${manualMethod} https://api.example.com${manualPath.trim()}`],
    };

    setImportedEndpoints((previous) => {
      if (previous.some((item) => item.endpointId === endpoint.endpointId)) {
        const withSuffix = {
          ...endpoint,
          endpointId: `${endpoint.endpointId}-${Date.now().toString(36).slice(-4)}`,
        };
        return [...previous, withSuffix];
      }
      return [...previous, endpoint];
    });

    setConfigs((previous) => ({
      ...previous,
      [endpoint.endpointId]: defaultConfig(endpoint, pricingBand),
    }));

    setManualDescription('');
  };

  const toggleSettlementMode = (endpointId: string, mode: SettlementMode) => {
    setConfigs((prev) => {
      const current = prev[endpointId] ?? {
        enabled: true,
        pricingKind: 'flat',
        amountAtomic: amountForBand(pricingBand),
        settlementModes: ['transfer', 'stream', 'netting'] as SettlementMode[],
      };
      const hasMode = current.settlementModes.includes(mode);
      const settlementModes = hasMode
        ? current.settlementModes.filter((value) => value !== mode)
        : [...current.settlementModes, mode];
      return {
        ...prev,
        [endpointId]: {
          ...current,
          settlementModes: settlementModes.length > 0 ? settlementModes : ['transfer'],
        },
      };
    });
  };

  const publish = async () => {
    setLoadingPublish(true);
    setError('');
    setSuccess('');
    try {
      if (!shopName.trim()) {
        throw new Error('Shop name is required');
      }
      if (importedEndpoints.length === 0) {
        throw new Error('Add or import at least one endpoint');
      }

      const selectedEndpoints: ShopWizardEndpointDraft[] = importedEndpoints
        .filter((endpoint) => configs[endpoint.endpointId]?.enabled)
        .map((endpoint) => {
          const config = configs[endpoint.endpointId] ?? defaultConfig(endpoint, pricingBand);
          const amountAtomic = /^\d+$/.test(config.amountAtomic) ? config.amountAtomic : amountForBand(pricingBand);
          return {
            endpointId: endpoint.endpointId,
            method: endpoint.method,
            path: endpoint.path,
            capabilityTags: endpoint.capabilityTags.length > 0 ? endpoint.capabilityTags : selectedTemplate.defaultTags,
            description: endpoint.description,
            pricingModel: buildPricingModel(config.pricingKind, amountAtomic),
            settlementModes: config.settlementModes.length > 0 ? config.settlementModes : ['transfer'],
            sla: endpoint.sla ?? {
              maxLatencyMs: 1500,
              availabilityTarget: 0.99,
            },
            examples: endpoint.examples ?? [`curl -X ${endpoint.method} https://api.example.com${endpoint.path}`],
            requestSchema: endpoint.requestSchema,
            responseSchema: endpoint.responseSchema,
            limits: limitsEnabled
              ? {
                rate_limit_per_minute: Number.parseInt(limitRatePerMin, 10) || 60,
                max_spend_per_day_atomic: /^\d+$/.test(limitMaxSpendPerDayAtomic) ? limitMaxSpendPerDayAtomic : '1000000',
                max_concurrency: Number.parseInt(limitMaxConcurrency, 10) || 5,
              }
              : undefined,
          };
        });

      if (selectedEndpoints.length === 0) {
        throw new Error('Select at least one endpoint');
      }

      const publishInput: ShopWizardPublishInput = {
        name: shopName.trim(),
        description: shopDescription.trim() || undefined,
        category: selectedTemplate.category,
        endpoints: selectedEndpoints,
      };
      const blockedTerm = findBlockedTerm(publishInput);
      if (blockedTerm) {
        throw new Error(`Blocked by safety policy term: ${blockedTerm}`);
      }

      await onPublish(publishInput);
      setSuccess(`Published ${shopName.trim()} with ${selectedEndpoints.length} endpoint(s).`);
      onPublished?.(shopName.trim());
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : 'Failed to publish shop');
    } finally {
      setLoadingPublish(false);
    }
  };

  return (
    <div className="shop-wizard">
      <div className="wizard-steps">
        <span>1. Pick Template</span>
        <span>2. Connect Endpoint</span>
        <span>3. Pricing</span>
        <span>4. Limits</span>
        <span>5. Publish</span>
      </div>
      <p className="wallet-note">
        SAFE-only marketplace categories. High-risk tools are blocked by server policy.
      </p>

      <div className="market-grid">
        <div className="market-card">
          <h4>1) Pick Template</h4>
          <div className="template-grid">
            {SAFE_TEMPLATES.map((template) => (
              <button
                key={template.id}
                className={`template-pill ${selectedTemplateId === template.id ? 'active' : ''}`}
                onClick={() => setSelectedTemplateId(template.id)}
                type="button"
              >
                <strong>{template.label}</strong>
                <span>{template.description}</span>
              </button>
            ))}
          </div>
          <div className="form-group">
            <label>Shop Name</label>
            <input value={shopName} onChange={(e) => setShopName(e.target.value)} placeholder="Deep Research Shop" />
          </div>
          <div className="form-group">
            <label>Description</label>
            <input value={shopDescription} onChange={(e) => setShopDescription(e.target.value)} placeholder="What this shop sells" />
          </div>
          <div className="metric-row">
            <span>Category</span>
            <strong>{selectedTemplate.category}</strong>
          </div>
        </div>

        <div className="market-card">
          <h4>2) Connect Endpoint</h4>
          <div className="form-group">
            <label>OpenAPI (JSON or URL)</label>
            <textarea
              value={openApiInput}
              onChange={(e) => setOpenApiInput(e.target.value)}
              placeholder="Paste OpenAPI JSON or URL"
            />
          </div>
          <div className="form-group">
            <label>Default Latency (ms)</label>
            <input value={defaultLatencyMs} onChange={(e) => setDefaultLatencyMs(e.target.value)} />
          </div>
          <button className="panel-button" onClick={importOpenApi} disabled={disabled || loadingImport}>
            {loadingImport ? 'Importing...' : 'Import OpenAPI'}
          </button>

          <div className="divider" />

          <h5>Manual endpoint</h5>
          <div className="wizard-config">
            <select value={manualMethod} onChange={(e) => setManualMethod(e.target.value as WizardMethod)}>
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
              <option value="DELETE">DELETE</option>
            </select>
            <input value={manualPath} onChange={(e) => setManualPath(e.target.value)} placeholder="/tool" />
          </div>
          <div className="wizard-config">
            <input value={manualCapability} onChange={(e) => setManualCapability(e.target.value)} placeholder="capability tag" />
            <input value={manualDescription} onChange={(e) => setManualDescription(e.target.value)} placeholder="description" />
          </div>
          <button className="panel-button secondary" onClick={addManualEndpoint} type="button">
            Add Endpoint
          </button>
        </div>
      </div>

      <div className="market-card wizard-pricing">
        <h4>3) Pricing</h4>
        <div className="wizard-band-row">
          {(['cheap', 'typical', 'premium'] as PricingBand[]).map((band) => (
            <button
              key={band}
              type="button"
              className={`template-pill ${pricingBand === band ? 'active' : ''}`}
              onClick={() => setPricingBand(band)}
            >
              <strong>{band}</strong>
              <span>{amountForBand(band)} atomic</span>
            </button>
          ))}
        </div>
        <p className="panel-note">Estimated calls per 1 USDC at selected band: <strong>{callsPerUsdc}</strong></p>
      </div>

      <div className="quote-list">
        <h4>Selected Endpoints ({selectedCount}/{importedEndpoints.length})</h4>
        {importedEndpoints.map((endpoint) => {
          const config = configs[endpoint.endpointId] ?? defaultConfig(endpoint, pricingBand);
          return (
            <div className="quote-row wizard-row" key={endpoint.endpointId}>
              <div>
                <label className="wizard-checkbox">
                  <input
                    type="checkbox"
                    checked={config.enabled}
                    onChange={(e) => setConfigs((prev) => ({
                      ...prev,
                      [endpoint.endpointId]: {
                        ...config,
                        enabled: e.target.checked,
                      },
                    }))}
                  />
                  <strong>{endpoint.method} {endpoint.path}</strong>
                </label>
                <div className="panel-note">{endpoint.endpointId} · {endpoint.capabilityTags.join(', ')}</div>
              </div>

              <div className="wizard-config">
                <select
                  value={config.pricingKind}
                  onChange={(e) => setConfigs((prev) => ({
                    ...prev,
                    [endpoint.endpointId]: {
                      ...config,
                      pricingKind: e.target.value as WizardPricingKind,
                    },
                  }))}
                >
                  <option value="flat">flat</option>
                  <option value="metered">metered</option>
                  <option value="surge">surge</option>
                  <option value="stream">stream</option>
                </select>
                <input
                  value={config.amountAtomic}
                  onChange={(e) => setConfigs((prev) => ({
                    ...prev,
                    [endpoint.endpointId]: {
                      ...config,
                      amountAtomic: e.target.value,
                    },
                  }))}
                  placeholder="atomic amount"
                />
              </div>

              <div className="wizard-settlement">
                {(['transfer', 'stream', 'netting'] as SettlementMode[]).map((mode) => (
                  <label key={`${endpoint.endpointId}-${mode}`}>
                    <input
                      type="checkbox"
                      checked={config.settlementModes.includes(mode)}
                      onChange={() => toggleSettlementMode(endpoint.endpointId, mode)}
                    />
                    {mode}
                  </label>
                ))}
              </div>
            </div>
          );
        })}
        {importedEndpoints.length === 0 ? <p className="panel-note">Import OpenAPI or add a manual endpoint first.</p> : null}
      </div>

      <div className="market-card">
        <h4>4) Limits</h4>
        <label className="wizard-checkbox">
          <input type="checkbox" checked={limitsEnabled} onChange={(e) => setLimitsEnabled(e.target.checked)} />
          Default limits ON
        </label>
        {limitsEnabled ? (
          <div className="wizard-config three-col">
            <input value={limitRatePerMin} onChange={(e) => setLimitRatePerMin(e.target.value)} placeholder="rate/min" />
            <input value={limitMaxSpendPerDayAtomic} onChange={(e) => setLimitMaxSpendPerDayAtomic(e.target.value)} placeholder="max spend/day atomic" />
            <input value={limitMaxConcurrency} onChange={(e) => setLimitMaxConcurrency(e.target.value)} placeholder="max concurrency" />
          </div>
        ) : null}
      </div>

      <div className="button-row">
        <button className="panel-button" onClick={publish} disabled={disabled || loadingPublish}>
          {loadingPublish ? 'Publishing...' : '5) Publish Shop'}
        </button>
      </div>
      {error ? <div className="panel-error">{error}</div> : null}
      {success ? <p className="panel-note">{success}</p> : null}
    </div>
  );
};
