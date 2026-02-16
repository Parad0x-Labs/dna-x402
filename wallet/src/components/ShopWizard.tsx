import React, { useMemo, useState } from 'react';

type SettlementMode = 'transfer' | 'stream' | 'netting';
type WizardMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type WizardPricingKind = 'flat' | 'metered' | 'surge' | 'stream';

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
}

export interface ShopWizardPublishInput {
  name: string;
  description?: string;
  category: string;
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

function inferCategoryFromName(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized.includes('research')) {
    return 'research';
  }
  if (normalized.includes('ops')) {
    return 'ops';
  }
  if (normalized.includes('stream')) {
    return 'stream';
  }
  if (normalized.includes('action')) {
    return 'actions';
  }
  return 'general';
}

function defaultConfig(endpoint: ImportedEndpoint): EndpointConfig {
  const isStream = endpoint.capabilityTags.some((tag) => tag.toLowerCase().includes('stream'));
  return {
    enabled: true,
    pricingKind: isStream ? 'stream' : 'flat',
    amountAtomic: isStream ? '10' : '1000',
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

export const ShopWizard: React.FC<ShopWizardProps> = ({
  x402BaseUrl,
  disabled = false,
  onPublish,
  onPublished,
}) => {
  const [shopName, setShopName] = useState('');
  const [shopDescription, setShopDescription] = useState('');
  const [shopCategory, setShopCategory] = useState('general');

  const [openApiInput, setOpenApiInput] = useState('');
  const [defaultPriceAtomic, setDefaultPriceAtomic] = useState('1000');
  const [defaultLatencyMs, setDefaultLatencyMs] = useState('1500');
  const [importedEndpoints, setImportedEndpoints] = useState<ImportedEndpoint[]>([]);
  const [configs, setConfigs] = useState<Record<string, EndpointConfig>>({});

  const [loadingImport, setLoadingImport] = useState(false);
  const [loadingPublish, setLoadingPublish] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const selectedCount = useMemo(() => (
    importedEndpoints.filter((endpoint) => configs[endpoint.endpointId]?.enabled).length
  ), [configs, importedEndpoints]);

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
            priceAtomic: defaultPriceAtomic,
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
        nextConfigs[endpoint.endpointId] = defaultConfig(endpoint);
      }
      setConfigs(nextConfigs);

      if (!shopName && payload.title) {
        setShopName(payload.title);
      }
      if (!shopDescription && payload.description) {
        setShopDescription(payload.description);
      }
      if (shopCategory === 'general' && payload.title) {
        setShopCategory(inferCategoryFromName(payload.title));
      }
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Failed to import OpenAPI');
    } finally {
      setLoadingImport(false);
    }
  };

  const toggleSettlementMode = (endpointId: string, mode: SettlementMode) => {
    setConfigs((prev) => {
      const current = prev[endpointId] ?? {
        enabled: true,
        pricingKind: 'flat',
        amountAtomic: '1000',
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
        throw new Error('Import endpoints first');
      }

      const selectedEndpoints: ShopWizardEndpointDraft[] = importedEndpoints
        .filter((endpoint) => configs[endpoint.endpointId]?.enabled)
        .map((endpoint) => {
          const config = configs[endpoint.endpointId] ?? defaultConfig(endpoint);
          const amountAtomic = /^\d+$/.test(config.amountAtomic) ? config.amountAtomic : '1000';
          return {
            endpointId: endpoint.endpointId,
            method: endpoint.method,
            path: endpoint.path,
            capabilityTags: endpoint.capabilityTags,
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
          };
        });

      if (selectedEndpoints.length === 0) {
        throw new Error('Select at least one endpoint');
      }

      await onPublish({
        name: shopName.trim(),
        description: shopDescription.trim() || undefined,
        category: shopCategory.trim() || 'general',
        endpoints: selectedEndpoints,
      });
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
        <span>1. Shop</span>
        <span>2. Import</span>
        <span>3. Select & Price</span>
        <span>4. Publish</span>
      </div>

      <div className="market-grid">
        <div className="market-card">
          <h4>Shop Profile</h4>
          <div className="form-group">
            <label>Name</label>
            <input value={shopName} onChange={(e) => setShopName(e.target.value)} placeholder="Deep Research Shop" />
          </div>
          <div className="form-group">
            <label>Description</label>
            <input value={shopDescription} onChange={(e) => setShopDescription(e.target.value)} placeholder="What this shop sells" />
          </div>
          <div className="form-group">
            <label>Category</label>
            <input value={shopCategory} onChange={(e) => setShopCategory(e.target.value)} placeholder="research | ops | actions" />
          </div>
        </div>

        <div className="market-card">
          <h4>Import Source</h4>
          <div className="form-group">
            <label>OpenAPI (JSON or URL)</label>
            <textarea
              value={openApiInput}
              onChange={(e) => setOpenApiInput(e.target.value)}
              placeholder='Paste OpenAPI JSON or URL (for example: {"openapi":"3.1.0", ...})'
            />
          </div>
          <div className="form-group">
            <label>Default Price (atomic)</label>
            <input value={defaultPriceAtomic} onChange={(e) => setDefaultPriceAtomic(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Default Latency (ms)</label>
            <input value={defaultLatencyMs} onChange={(e) => setDefaultLatencyMs(e.target.value)} />
          </div>
          <button className="panel-button" onClick={importOpenApi} disabled={disabled || loadingImport}>
            {loadingImport ? 'Importing...' : 'Import OpenAPI'}
          </button>
        </div>
      </div>

      <div className="quote-list">
        <h4>Selected Endpoints ({selectedCount}/{importedEndpoints.length})</h4>
        {importedEndpoints.map((endpoint) => {
          const config = configs[endpoint.endpointId] ?? defaultConfig(endpoint);
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
        {importedEndpoints.length === 0 ? <p className="panel-note">Import OpenAPI first.</p> : null}
      </div>

      <div className="button-row">
        <button className="panel-button" onClick={publish} disabled={disabled || loadingPublish}>
          {loadingPublish ? 'Publishing...' : 'Publish Shop'}
        </button>
      </div>
      {error ? <div className="panel-error">{error}</div> : null}
      {success ? <p className="panel-note">{success}</p> : null}
    </div>
  );
};

