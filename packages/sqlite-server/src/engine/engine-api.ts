/**
 * Contract between the server and the bundled Super Productivity state engine
 * (`engine/entry.ts`, built from the app's own reducers into
 * `dist/engine/sp-engine.cjs`). Kept dependency-free so the server compiles
 * without the Angular sources.
 */

/** Operation shape accepted by the engine (decrypted payload). */
export interface EngineOperation {
  id: string;
  clientId: string;
  actionType: string;
  opType: string;
  entityType: string;
  entityId?: string;
  entityIds?: string[];
  payload: unknown;
  vectorClock: Record<string, number>;
  timestamp: number;
  schemaVersion: number;
  syncImportReason?: string;
  repairBaseServerSeq?: number;
}

/** The persisted app data: one key per MODEL_CONFIGS model (incl. archives). */
export type AppData = Record<string, unknown>;

/** Last applied full-state op; later ops are filtered against it (SYNC_IMPORT semantics). */
export interface ImportMarker {
  id: string;
  clientId: string;
  vectorClock: Record<string, number>;
  opType: string;
}

export interface EngineState {
  /** NgRx root state (feature keys as used by the app's store). */
  root: Record<string, unknown>;
  archiveYoung: unknown;
  archiveOld: unknown;
  latestImport?: ImportMarker;
}

export interface EngineApplyFailure {
  opId: string;
  stage: 'migration' | 'reducer' | 'archive';
  error: string;
}

export interface EngineApplyResult {
  state: EngineState;
  /** Ops whose effects are in `state` (after migration splits: source op ids). */
  appliedOpIds: string[];
  /** Ops that could not be applied; state excludes them (client semantics). */
  failures: EngineApplyFailure[];
  /** True when an op had a newer schema than this engine: processing stopped before it. */
  blockedByNewerSchema?: { opId: string; schemaVersion: number };
}

/** A local action dispatched on behalf of an API client (MCP) and the op it produced. */
export interface EngineLocalDispatchResult {
  state: EngineState;
  /** Op skeleton (without id/clientId/vectorClock/timestamp) for the action, if persistent. */
  op?: {
    actionType: string;
    opType: string;
    entityType: string;
    entityId?: string;
    entityIds?: string[];
    payload: unknown;
  };
}

export interface SpEngine {
  readonly currentSchemaVersion: number;
  /** Feature key → MODEL_CONFIGS key, e.g. `tasks` → `task`. */
  readonly modelKeyByFeature: Readonly<Record<string, string>>;
  createInitialState(): EngineState;
  /** Rebuilds engine state from persisted app data (like hydration from a snapshot). */
  fromAppData(appData: AppData): EngineState;
  /** Extracts the persisted model data (MODEL_CONFIGS keys incl. archives). */
  toAppData(state: EngineState): AppData;
  /**
   * Applies remote-style operations exactly like a client's remote apply
   * (schema migration, bulk reducer replay, archive side effects).
   */
  applyOperations(state: EngineState, ops: EngineOperation[]): Promise<EngineApplyResult>;
  /** Dispatches a local action (MCP write) and returns the resulting op skeleton. */
  dispatchLocal(
    state: EngineState,
    action: { type: string } & Record<string, unknown>,
  ): Promise<EngineLocalDispatchResult>;
  /** Action creators used by the REST API, keyed by name. */
  readonly actions: Readonly<Record<string, (...args: never[]) => { type: string }>>;
  /** App helpers used by the REST API (task factory, date helpers). */
  readonly helpers: {
    createTask(input: Record<string, unknown>): Record<string, unknown>;
    getDbDateStr(date?: Date | number): string;
    /** Logical day offset from globalConfig.misc (DateService semantics). */
    getStartOfNextDayDiffMs(misc: Record<string, unknown> | undefined): number;
    isTodayWithOffset(ts: number, todayStr: string, diffMs: number): boolean;
  };
}
