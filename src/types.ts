export const OBSERVATION_SCHEMA_VERSION = "bearing.observation/v2" as const;
export const CATALOG_SCHEMA_VERSION = "bearing.catalog/v2" as const;

export type ObservationKind = "evaluation" | "declaration";
export type SourceClass = "first-party" | "external";
export type MeasurementKind = "fact" | "sample";
export type ScalarValue = string | number | boolean;

export interface ModelIdentity {
  id: string;
  revision: string | null;
  quantization: string | null;
}

export interface ComponentIdentity {
  id: string;
  version: string | null;
}

export interface HardwareProfile {
  class: string;
  accelerator: string | null;
  memoryBytes: number | null;
}

export interface WorkflowProfile {
  id: string;
  version: string | null;
  condition: string | null;
}

export interface ExecutionProfile {
  runtime: ComponentIdentity;
  adapter: ComponentIdentity | null;
  effectiveContextTokens: number | null;
  toolSurface: string[];
  hardware: HardwareProfile | null;
  workflow: WorkflowProfile | null;
}

export interface ExactExecutionScope extends ExecutionProfile {
  kind: "exact";
}

export interface PartialExecutionScope {
  kind: "partial";
  runtime: ComponentIdentity;
  adapter: ComponentIdentity | null;
  effectiveContextTokens: number | null;
  /** null means unknown; an empty array means known-empty. */
  toolSurface: string[] | null;
  hardware: HardwareProfile | null;
  workflow: WorkflowProfile | null;
}

export type ExecutionScope = ExactExecutionScope | PartialExecutionScope;

export interface TaskProfile {
  family: string;
  suite: string | null;
  taskId: string | null;
  evaluator: ComponentIdentity;
}

export interface Measurement {
  key: string;
  kind: MeasurementKind;
  value: ScalarValue;
  unit?: string;
}

export interface EvaluationOutcome {
  status: "accepted" | "rejected" | "invalid";
  reason: string | null;
}

export interface UsageObservation {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  completeness: "complete" | "partial" | "unknown";
  modelCalls: number | null;
  wallTimeMs: number | null;
}

export interface EvidenceDigest {
  algorithm: "sha256";
  value: string;
}

export interface EvidenceReference {
  id: string;
  kind: string;
  uri: string | null;
  digest: EvidenceDigest | null;
  observedAt: string;
}

export interface Freshness {
  observedAt: string;
  validUntil: string | null;
}

export interface Uncertainty {
  level: "low" | "moderate" | "high" | "unknown";
  basis: string[];
  gaps: string[];
}

export interface ObservationInput {
  schemaVersion: typeof OBSERVATION_SCHEMA_VERSION;
  kind: ObservationKind;
  model: ModelIdentity;
  execution: ExecutionScope | null;
  task: TaskProfile | null;
  measurements: Measurement[];
  outcome: EvaluationOutcome | null;
  usage: UsageObservation | null;
  sourceClass: SourceClass;
  evidence: EvidenceReference[];
  freshness: Freshness;
  uncertainty: Uncertainty;
}

export interface CapabilityObservation extends ObservationInput {
  id: string;
}

export interface CatalogModel {
  key: string;
  identity: ModelIdentity;
  observations: CapabilityObservation[];
}

export interface ConflictSet {
  key: string;
  modelKey: string;
  measurementKey: string;
  execution: ExecutionScope | null;
  task: TaskProfile | null;
  observationIds: string[];
  values: ScalarValue[];
}

export interface CatalogSnapshot {
  schemaVersion: typeof CATALOG_SCHEMA_VERSION;
  asOf: string;
  digest: string;
  models: CatalogModel[];
  conflicts: ConflictSet[];
}

export interface CompileCatalogOptions {
  asOf: string;
}
