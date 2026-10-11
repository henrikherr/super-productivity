/**
 * Server-side Super Productivity state engine.
 *
 * Bundled (scripts/build-engine.js, esbuild) from the APP'S OWN SOURCES so the
 * server applies operations with exactly the reducers, meta-reducers, op→action
 * conversion, schema migrations and archive side effects the clients use.
 * Nothing in here re-implements domain rules; it only wires app modules
 * together outside the browser.
 *
 * Output: dist/engine/sp-engine.cjs exporting `createEngine(): SpEngine`.
 */
import '@angular/compiler';
import { Injector } from '@angular/core';
import { Action, ActionReducer, combineReducers, compose, Store } from '@ngrx/store';
import { BehaviorSubject, distinctUntilChanged, map, Observable } from 'rxjs';
import { nanoid } from 'nanoid';
import {
  classifyOpAgainstSyncImport,
  replayOperationBatch,
  type SyncActionLike,
} from '@sp/sync-core';
import { CURRENT_SCHEMA_VERSION, migrateOperation } from '@sp/shared-schema';

import { META_REDUCERS } from '../../../src/app/root-store/meta/meta-reducer-registry';
import { operationCaptureMetaReducer } from '../../../src/app/op-log/capture/operation-capture.meta-reducer';
import { actionLoggerReducer } from '../../../src/app/root-store/meta/action-logger.reducer';
import {
  TASK_FEATURE_NAME,
  taskReducer,
} from '../../../src/app/features/tasks/store/task.reducer';
import {
  PROJECT_FEATURE_NAME,
  projectReducer,
} from '../../../src/app/features/project/store/project.reducer';
import {
  TAG_FEATURE_NAME,
  tagReducer,
} from '../../../src/app/features/tag/store/tag.reducer';
import {
  NOTE_FEATURE_NAME,
  noteReducer,
} from '../../../src/app/features/note/store/note.reducer';
import {
  CONFIG_FEATURE_NAME,
  globalConfigReducer,
} from '../../../src/app/features/config/store/global-config.reducer';
import {
  SIMPLE_COUNTER_FEATURE_NAME,
  simpleCounterReducer,
} from '../../../src/app/features/simple-counter/store/simple-counter.reducer';
import {
  SECTION_FEATURE_NAME,
  sectionReducer,
} from '../../../src/app/features/section/store/section.reducer';
import {
  TASK_REPEAT_CFG_FEATURE_NAME,
  taskRepeatCfgReducer,
} from '../../../src/app/features/task-repeat-cfg/store/task-repeat-cfg.reducer';
import {
  REMINDER_FEATURE_NAME,
  reminderReducer,
} from '../../../src/app/features/reminder/store/reminder.reducer';
import { plannerFeature } from '../../../src/app/features/planner/store/planner.reducer';
import { boardsFeature } from '../../../src/app/features/boards/store/boards.reducer';
import {
  menuTreeFeatureKey,
  menuTreeReducer,
} from '../../../src/app/features/menu-tree/store/menu-tree.reducer';
import { issueProvidersFeature } from '../../../src/app/features/issue/store/issue-provider.reducer';
import {
  METRIC_FEATURE_NAME,
  metricReducer,
} from '../../../src/app/features/metric/store/metric.reducer';
import { timeTrackingFeature } from '../../../src/app/features/time-tracking/store/time-tracking.reducer';
import {
  PLUGIN_USER_DATA_FEATURE_NAME,
  pluginUserDataReducer,
} from '../../../src/app/plugins/store/plugin-user-data.reducer';
import {
  PLUGIN_METADATA_FEATURE_NAME,
  pluginMetadataReducer,
} from '../../../src/app/plugins/store/plugin-metadata.reducer';
import { workContextReducer } from '../../../src/app/features/work-context/store/work-context.reducer';
import { WORK_CONTEXT_FEATURE_NAME } from '../../../src/app/features/work-context/store/work-context.selectors';
import { appStateFeature } from '../../../src/app/root-store/app-state/app-state.reducer';
import { loadAllData } from '../../../src/app/root-store/meta/load-all-data.action';
import { bulkApplyOperations } from '../../../src/app/op-log/apply/bulk-hydration.action';
import { convertOpToAction } from '../../../src/app/op-log/apply/operation-converter.util';
import { runWithBulkReplayFailureCollector } from '../../../src/app/op-log/apply/bulk-replay-failure-collector';
import {
  ArchiveOperationHandler,
  isArchiveAffectingAction,
} from '../../../src/app/op-log/apply/archive-operation-handler.service';
import { ArchiveDbAdapter } from '../../../src/app/core/persistence/archive-db-adapter.service';
import { LockService } from '../../../src/app/op-log/sync/lock.service';
import { ArchiveService } from '../../../src/app/features/archive/archive.service';
import { TaskArchiveService } from '../../../src/app/features/archive/task-archive.service';
import { TimeTrackingService } from '../../../src/app/features/time-tracking/time-tracking.service';
import { ArchiveCompressionService } from '../../../src/app/features/archive/archive-compression.service';
import { TaskSharedActions } from '../../../src/app/root-store/meta/task-shared.actions';
import { DEFAULT_TASK } from '../../../src/app/features/tasks/task.model';
import { INBOX_PROJECT } from '../../../src/app/features/project/project.const';
import { TODAY_TAG } from '../../../src/app/features/tag/tag.const';
import { getDbDateStr } from '../../../src/app/util/get-db-date-str';
import { isDBDateStr } from '../../../src/app/util/get-db-date-str';
import { getStartOfNextDayDiffMs } from '../../../src/app/util/start-of-next-day.util';
import { isTodayWithOffset } from '../../../src/app/util/is-today.util';
import {
  updateTaskRepeatCfg,
  addTaskRepeatCfgToTask,
} from '../../../src/app/features/task-repeat-cfg/store/task-repeat-cfg.actions';
import {
  addProject,
  updateProject,
} from '../../../src/app/features/project/store/project.actions';
import { addSubTask } from '../../../src/app/features/tasks/store/task.actions';
import { addTag, updateTag } from '../../../src/app/features/tag/store/tag.actions';
import {
  addNote,
  updateNote,
  deleteNote,
} from '../../../src/app/features/note/store/note.actions';
import { updateGlobalConfigSection } from '../../../src/app/features/config/store/global-config.actions';
import { MODEL_CONFIGS } from '../../../src/app/op-log/model/model-config';

import type {
  AppData,
  EngineApplyFailure,
  EngineApplyResult,
  EngineLocalDispatchResult,
  EngineOperation,
  EngineState,
  SpEngine,
} from '../src/engine/engine-api';

/** NgRx feature key → MODEL_CONFIGS key. */
const MODEL_KEY_BY_FEATURE: Record<string, string> = {
  [TASK_FEATURE_NAME]: 'task',
  [PROJECT_FEATURE_NAME]: 'project',
  [TAG_FEATURE_NAME]: 'tag',
  [NOTE_FEATURE_NAME]: 'note',
  [CONFIG_FEATURE_NAME]: 'globalConfig',
  [SIMPLE_COUNTER_FEATURE_NAME]: 'simpleCounter',
  [SECTION_FEATURE_NAME]: 'section',
  [TASK_REPEAT_CFG_FEATURE_NAME]: 'taskRepeatCfg',
  [REMINDER_FEATURE_NAME]: 'reminders',
  [plannerFeature.name]: 'planner',
  [boardsFeature.name]: 'boards',
  [menuTreeFeatureKey]: 'menuTree',
  [issueProvidersFeature.name]: 'issueProvider',
  [METRIC_FEATURE_NAME]: 'metric',
  [timeTrackingFeature.name]: 'timeTracking',
  [PLUGIN_USER_DATA_FEATURE_NAME]: 'pluginUserData',
  [PLUGIN_METADATA_FEATURE_NAME]: 'pluginMetadata',
};

const FEATURE_REDUCERS: Record<string, ActionReducer<unknown, Action>> = {
  [TASK_FEATURE_NAME]: taskReducer as never,
  [PROJECT_FEATURE_NAME]: projectReducer as never,
  [TAG_FEATURE_NAME]: tagReducer as never,
  [NOTE_FEATURE_NAME]: noteReducer as never,
  [CONFIG_FEATURE_NAME]: globalConfigReducer as never,
  [SIMPLE_COUNTER_FEATURE_NAME]: simpleCounterReducer as never,
  [SECTION_FEATURE_NAME]: sectionReducer as never,
  [TASK_REPEAT_CFG_FEATURE_NAME]: taskRepeatCfgReducer as never,
  [REMINDER_FEATURE_NAME]: reminderReducer as never,
  [plannerFeature.name]: plannerFeature.reducer as never,
  [boardsFeature.name]: boardsFeature.reducer as never,
  [menuTreeFeatureKey]: menuTreeReducer as never,
  [issueProvidersFeature.name]: issueProvidersFeature.reducer as never,
  [METRIC_FEATURE_NAME]: metricReducer as never,
  [timeTrackingFeature.name]: timeTrackingFeature.reducer as never,
  [PLUGIN_USER_DATA_FEATURE_NAME]: pluginUserDataReducer as never,
  [PLUGIN_METADATA_FEATURE_NAME]: pluginMetadataReducer as never,
  // Not persisted, but present in the client store; some cascades read them.
  [WORK_CONTEXT_FEATURE_NAME]: workContextReducer as never,
  [appStateFeature.name]: appStateFeature.reducer as never,
};

/**
 * The client's meta-reducer chain minus op capture (the server creates ops
 * explicitly) and the dev action logger.
 */
const SERVER_META_REDUCERS = META_REDUCERS.filter(
  (m) => m !== operationCaptureMetaReducer && m !== actionLoggerReducer,
);

const rootReducer: ActionReducer<Record<string, unknown>, Action> = compose(
  ...(SERVER_META_REDUCERS as never[]),
)(combineReducers(FEATURE_REDUCERS as never)) as never;

const emptyArchive = (): unknown =>
  structuredClone(MODEL_CONFIGS.archiveYoung.defaultData) as unknown;

/**
 * Engine-wide "current user" context. The projector processes one user at a
 * time (serialized), so module-level context is safe and lets the app's
 * Angular services read/write the right state.
 */
class EngineContext {
  readonly state$ = new BehaviorSubject<Record<string, unknown>>({});
  archiveYoung: unknown = emptyArchive();
  archiveOld: unknown = emptyArchive();

  load(state: EngineState): void {
    this.state$.next(state.root);
    this.archiveYoung = structuredClone(state.archiveYoung);
    this.archiveOld = structuredClone(state.archiveOld);
  }

  snapshot(): EngineState {
    return {
      root: this.state$.value,
      archiveYoung: this.archiveYoung,
      archiveOld: this.archiveOld,
    };
  }

  dispatch(action: Action): void {
    this.state$.next(rootReducer(this.state$.value, action));
  }
}

const ctx = new EngineContext();

/** Minimal NgRx Store stand-in backed by the engine context. */
class EngineStore extends Observable<Record<string, unknown>> {
  constructor() {
    super((subscriber) => ctx.state$.subscribe(subscriber));
  }
  select<R>(selector: (s: Record<string, unknown>) => R): Observable<R> {
    return ctx.state$.pipe(map(selector), distinctUntilChanged());
  }
  dispatch(action: Action): void {
    ctx.dispatch(action);
  }
}

/** ArchiveDbAdapter backed by the engine context (persisted by the server). */
class EngineArchiveDbAdapter {
  async loadArchiveYoung(): Promise<unknown> {
    return structuredClone(ctx.archiveYoung);
  }
  async saveArchiveYoung(data: unknown): Promise<void> {
    ctx.archiveYoung = structuredClone(data);
  }
  async loadArchiveOld(): Promise<unknown> {
    return structuredClone(ctx.archiveOld);
  }
  async saveArchiveOld(data: unknown): Promise<void> {
    ctx.archiveOld = structuredClone(data);
  }
  async saveArchivesAtomic(young: unknown, old: unknown): Promise<void> {
    ctx.archiveYoung = structuredClone(young);
    ctx.archiveOld = structuredClone(old);
  }
}

/** Single-threaded engine: locks are already guaranteed by the projector queue. */
class EngineLockService {
  async request<T>(_name: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

const injector = Injector.create({
  name: 'sp-engine',
  providers: [
    { provide: Store, useClass: EngineStore },
    { provide: ArchiveDbAdapter, useClass: EngineArchiveDbAdapter },
    { provide: LockService, useClass: EngineLockService },
    { provide: ArchiveService, useClass: ArchiveService },
    { provide: TaskArchiveService, useClass: TaskArchiveService },
    { provide: TimeTrackingService, useClass: TimeTrackingService },
    { provide: ArchiveCompressionService, useClass: ArchiveCompressionService },
    { provide: ArchiveOperationHandler, useClass: ArchiveOperationHandler },
  ],
});

const archiveHandler = (): ArchiveOperationHandler =>
  injector.get(ArchiveOperationHandler);

const isFullStateOpType = (opType: string): boolean =>
  opType === 'SYNC_IMPORT' || opType === 'BACKUP_IMPORT' || opType === 'REPAIR';

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

const applyOperations = async (
  state: EngineState,
  ops: EngineOperation[],
): Promise<EngineApplyResult> => {
  const failures: EngineApplyFailure[] = [];
  const appliedOpIds: string[] = [];
  let marker = state.latestImport;
  ctx.load(state);
  let blockedByNewerSchema: EngineApplyResult['blockedByNewerSchema'];

  // 1) Receiver-side schema migration (RemoteOpsProcessingService STEP 1) and
  // 2) SYNC_IMPORT filter (SyncImportFilterService), in server order.
  const toApply: Array<{ op: EngineOperation; sourceId: string; group?: string[] }> = [];
  for (const op of ops) {
    if ((op.schemaVersion ?? 1) > CURRENT_SCHEMA_VERSION) {
      blockedByNewerSchema = { opId: op.id, schemaVersion: op.schemaVersion };
      break;
    }
    const migrated = migrateOperation(op as never);
    if (!migrated.success) {
      failures.push({
        opId: op.id,
        stage: 'migration',
        error: migrated.error ?? 'migration failed',
      });
      continue;
    }
    if (migrated.data === null || migrated.data === undefined) continue;
    const list = (
      Array.isArray(migrated.data) ? migrated.data : [migrated.data]
    ) as EngineOperation[];
    const group = list.length > 1 ? list.map((o) => o.id) : undefined;
    for (const m of list) {
      if (isFullStateOpType(m.opType)) {
        marker = {
          id: m.id,
          clientId: m.clientId,
          vectorClock: m.vectorClock,
          opType: m.opType,
        };
        toApply.push({ op: m, sourceId: op.id, group });
        continue;
      }
      if (marker) {
        const decision = classifyOpAgainstSyncImport(m, marker);
        const keep =
          decision.shouldKeep ||
          (marker.opType === 'REPAIR' && decision.reason === 'concurrent');
        if (!keep) continue; // clean-slate semantics: invalidated by the import
      }
      toApply.push({ op: m, sourceId: op.id, group });
    }
  }

  if (toApply.length > 0) {
    const reducerFailures: Array<{ op: EngineOperation; error: Error }> = [];
    const atomicReplayGroups = toApply
      .map((t) => t.group)
      .filter((g, i, all): g is string[] => !!g && all.indexOf(g) === i);
    const result = await replayOperationBatch({
      ops: toApply.map((t) => t.op) as never[],
      dispatcher: {
        dispatch: (action: SyncActionLike) =>
          runWithBulkReplayFailureCollector(
            (failure) => reducerFailures.push(failure as never),
            () => ctx.dispatch(action as Action),
          ),
      },
      createBulkApplyAction: (operations) =>
        bulkApplyOperations({
          operations: operations as never,
          // The server never authors synced ops through replay; no op is "own".
          localClientId: undefined,
          ...(atomicReplayGroups.length ? { atomicReplayGroups } : {}),
        }) as SyncActionLike,
      getReducerFailures: () => reducerFailures as never,
      remoteApplyWindow: {
        startApplyingRemoteOps: () => undefined,
        endApplyingRemoteOps: () => undefined,
        startPostSyncCooldown: () => undefined,
      },
      deferredLocalActions: { processDeferredActions: async () => undefined },
      archiveSideEffects: archiveHandler() as never,
      operationToAction: convertOpToAction as never,
      isArchiveAffectingAction: isArchiveAffectingAction as never,
      yieldToEventLoop: async () => undefined,
    });
    const appliedIds = new Set(result.appliedOps.map((o) => (o as EngineOperation).id));
    for (const f of result.reducerFailures ?? []) {
      failures.push({
        opId: (f.op as EngineOperation).id,
        stage: 'reducer',
        error: errorText(f.error),
      });
    }
    if (result.failedOp) {
      failures.push({
        opId: (result.failedOp.op as EngineOperation).id,
        stage: 'archive',
        error: errorText(result.failedOp.error),
      });
    }
    for (const t of toApply) {
      if (appliedIds.has(t.op.id) && !appliedOpIds.includes(t.sourceId))
        appliedOpIds.push(t.sourceId);
    }
  }

  const snap = ctx.snapshot();
  return {
    state: { ...snap, latestImport: marker },
    appliedOpIds,
    failures,
    ...(blockedByNewerSchema ? { blockedByNewerSchema } : {}),
  };
};

const createInitialState = (): EngineState => ({
  root: rootReducer(undefined, { type: '@@sp-server/init' }),
  archiveYoung: emptyArchive(),
  archiveOld: emptyArchive(),
});

const fromAppData = (appData: AppData): EngineState => {
  const root = rootReducer(undefined, loadAllData({ appDataComplete: appData as never }));
  return {
    root,
    archiveYoung: appData['archiveYoung'] ?? emptyArchive(),
    archiveOld: appData['archiveOld'] ?? emptyArchive(),
  };
};

const toAppData = (state: EngineState): AppData => {
  const out: AppData = {};
  for (const [feature, modelKey] of Object.entries(MODEL_KEY_BY_FEATURE)) {
    out[modelKey] = state.root[feature];
  }
  out['archiveYoung'] = state.archiveYoung;
  out['archiveOld'] = state.archiveOld;
  return out;
};

const dispatchLocal = async (
  state: EngineState,
  action: { type: string } & Record<string, unknown>,
): Promise<EngineLocalDispatchResult> => {
  ctx.load(state);
  ctx.dispatch(action as Action);
  const meta = action['meta'] as
    | {
        isPersistent?: boolean;
        entityType: string;
        entityId?: string;
        entityIds?: string[];
        opType: string;
      }
    | undefined;
  const snap = ctx.snapshot();
  const result: EngineLocalDispatchResult = {
    state: { ...snap, latestImport: state.latestImport },
  };
  if (meta?.isPersistent) {
    // Same envelope as OperationLogEffects.writeOperation.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { type, meta: _meta, ...rawActionPayload } = action;
    const entityIds = meta.entityIds ?? (meta.entityId ? [meta.entityId] : undefined);
    result.op = {
      actionType: action.type,
      opType: meta.opType,
      entityType: meta.entityType,
      entityId: meta.entityId ?? entityIds?.[0],
      entityIds,
      payload: { actionPayload: rawActionPayload, entityChanges: [] },
    };
  }
  return result;
};

/**
 * Mirrors TaskService.createNewTaskWithDefaults (without the typia runtime
 * assertion, which needs the TS transformer); the reducers validate structure.
 */
const createTask = (input: Record<string, unknown>): Record<string, unknown> => {
  const workContextType = (input['workContextType'] as string) ?? 'PROJECT';
  const workContextId = (input['workContextId'] as string) ?? INBOX_PROJECT.id;
  const defaultProjectId =
    (input['defaultProjectId'] as string | undefined) || INBOX_PROJECT.id;
  const additional = (input['additional'] as Record<string, unknown>) ?? {};
  const task: Record<string, unknown> = {
    ...DEFAULT_TASK,
    created: Date.now(),
    title: input['title'] as string,
    id: (input['id'] as string) || nanoid(),
    ...(workContextType === 'PROJECT'
      ? { projectId: workContextId }
      : { projectId: defaultProjectId }),
    tagIds:
      workContextType === 'TAG' &&
      !additional['parentId'] &&
      workContextId !== TODAY_TAG.id
        ? [workContextId]
        : [],
    ...(workContextId === TODAY_TAG.id &&
    !additional['parentId'] &&
    !additional['dueWithTime'] &&
    !('dueDay' in additional)
      ? { dueDay: getDbDateStr() }
      : {}),
    ...additional,
  };
  if (
    task['dueDay'] &&
    typeof task['dueDay'] === 'string' &&
    !isDBDateStr(task['dueDay'])
  ) {
    task['dueDay'] = undefined;
  }
  if (
    task['deadlineDay'] &&
    typeof task['deadlineDay'] === 'string' &&
    !isDBDateStr(task['deadlineDay'])
  ) {
    task['deadlineDay'] = undefined;
  }
  if (!task['projectId']) {
    task['projectId'] = workContextType === 'PROJECT' ? workContextId : defaultProjectId;
  }
  return task;
};

export const createEngine = (): SpEngine => ({
  currentSchemaVersion: CURRENT_SCHEMA_VERSION,
  modelKeyByFeature: MODEL_KEY_BY_FEATURE,
  createInitialState,
  fromAppData,
  toAppData,
  applyOperations,
  dispatchLocal,
  actions: {
    addTask: TaskSharedActions.addTask as never,
    updateTask: TaskSharedActions.updateTask as never,
    deleteTask: TaskSharedActions.deleteTask as never,
    moveToArchive: TaskSharedActions.moveToArchive as never,
    restoreTask: TaskSharedActions.restoreTask as never,
    addSubTask: addSubTask as never,
    setDeadline: TaskSharedActions.setDeadline as never,
    removeDeadline: TaskSharedActions.removeDeadline as never,
    clearDeadlineReminder: TaskSharedActions.clearDeadlineReminder as never,
    addProject: addProject as never,
    updateProject: updateProject as never,
    addTag: addTag as never,
    updateTag: updateTag as never,
    addNote: addNote as never,
    updateNote: updateNote as never,
    deleteNote: deleteNote as never,
    updateGlobalConfigSection: updateGlobalConfigSection as never,
    updateTaskRepeatCfg: updateTaskRepeatCfg as never,
    addTaskRepeatCfgToTask: addTaskRepeatCfgToTask as never,
  },
  helpers: {
    createTask,
    getDbDateStr: (date?: Date | number) => getDbDateStr(date ?? new Date()),
    getStartOfNextDayDiffMs: (misc: Record<string, unknown> | undefined) =>
      getStartOfNextDayDiffMs(
        misc?.['startOfNextDayTime'] as string | undefined,
        misc?.['startOfNextDay'] as number | undefined,
      ),
    isTodayWithOffset: (ts: number, todayStr: string, diffMs: number) =>
      isTodayWithOffset(ts, todayStr, diffMs),
  },
});
