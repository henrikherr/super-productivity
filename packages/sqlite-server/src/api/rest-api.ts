/**
 * REST API for MCP / scripts, mounted at `/api/v1`. Paths, envelope
 * (`{ok, data}` / `{ok:false, error:{code,message,details}}`), allowed fields
 * and error codes follow the desktop Local REST API
 * (src/app/core/electron/local-rest-api-handler.service.ts) so
 * superprod-mcp works by pointing SP_API_URL at `<server>/api/v1`.
 *
 * Differences (documented in sqlite-roadmap.md):
 * - Runtime endpoints of a running app (current task timer, focus mode) are
 *   not available on a server → 501 NOT_AVAILABLE_ON_SERVER.
 * - Short syntax (#tag, +project, 30m in titles) is parsed by client-side
 *   effects; the server stores titles literally (= isIgnoreShortSyntax).
 * - New tasks go to `projectId` from the body, else the configured default
 *   project, else Inbox (the desktop uses the currently open view).
 */
import type { App, AppModule } from '../app';
import type { AuthenticatedToken, TokenScope } from '../auth/tokens';
import { DEFAULT_BODY_LIMITS, readJsonBody } from '../http/body';
import { RequestContext, sendJson } from '../http/router';
import type { EngineState } from '../engine/engine-api';
import { ProjectionUnavailableError } from '../projection/projector';
import { ServerWriter, WriteConflictError } from './server-writer';

type AnyRecord = Record<string, unknown>;
type Task = AnyRecord & {
  id: string;
  title: string;
  projectId: string;
  tagIds: string[];
  subTaskIds: string[];
  parentId?: string;
  isDone: boolean;
};

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const ALLOWED_TASK_FIELDS = new Set([
  'title',
  'notes',
  'isDone',
  'timeEstimate',
  'timeSpent',
  'projectId',
  'tagIds',
  'dueDay',
  'dueWithTime',
  'plannedAt',
  'deadlineDay',
  'deadlineWithTime',
  'deadlineRemindAt',
]);
const REJECTED_TASK_FIELDS = ['parentId', 'subTaskIds'];
const SUBTASK_INHERITED_FIELDS = ['projectId', 'tagIds'];
const DEADLINE_FIELDS = ['deadlineDay', 'deadlineWithTime', 'deadlineRemindAt'];

const isRecord = (v: unknown): v is AnyRecord =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const hasOwn = (o: object, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);
const DB_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isValidDbDate = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DB_DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

const pickAllowedFields = (body: AnyRecord): AnyRecord =>
  Object.fromEntries(Object.entries(body).filter(([k]) => ALLOWED_TASK_FIELDS.has(k)));

/** Value types of writable fields (mirror of WritableTaskFields + typia.validate). */
const validateWritableFields = (
  fields: AnyRecord,
): Array<{ path: string; expected: string }> => {
  const errors: Array<{ path: string; expected: string }> = [];
  const check = (key: string, ok: boolean, expected: string): void => {
    if (hasOwn(fields, key) && !ok) errors.push({ path: `$input.${key}`, expected });
  };
  const v = fields;
  const isNum = (x: unknown): boolean => typeof x === 'number' && Number.isFinite(x);
  check('title', typeof v['title'] === 'string', 'string');
  check('notes', typeof v['notes'] === 'string', 'string');
  check('isDone', typeof v['isDone'] === 'boolean', 'boolean');
  check('timeEstimate', isNum(v['timeEstimate']), 'number');
  check('timeSpent', isNum(v['timeSpent']), 'number');
  check('projectId', typeof v['projectId'] === 'string', 'string');
  check(
    'tagIds',
    Array.isArray(v['tagIds']) &&
      (v['tagIds'] as unknown[]).every((t) => typeof t === 'string'),
    'Array<string>',
  );
  check(
    'dueDay',
    v['dueDay'] === null || typeof v['dueDay'] === 'string',
    '(null | string)',
  );
  check(
    'dueWithTime',
    v['dueWithTime'] === null || isNum(v['dueWithTime']),
    '(null | number)',
  );
  check('plannedAt', isNum(v['plannedAt']), 'number');
  check(
    'deadlineDay',
    v['deadlineDay'] === null || typeof v['deadlineDay'] === 'string',
    '(null | string)',
  );
  check(
    'deadlineWithTime',
    v['deadlineWithTime'] === null || isNum(v['deadlineWithTime']),
    '(null | number)',
  );
  check(
    'deadlineRemindAt',
    v['deadlineRemindAt'] === null || isNum(v['deadlineRemindAt']),
    '(null | number)',
  );
  return errors;
};

const validateDeadlineFields = (f: AnyRecord): string | undefined => {
  if (f['deadlineDay'] != null && f['deadlineWithTime'] != null) {
    return 'deadlineDay and deadlineWithTime cannot both be set';
  }
  if (typeof f['deadlineDay'] === 'string' && !isValidDbDate(f['deadlineDay'])) {
    return 'deadlineDay must be a valid YYYY-MM-DD date';
  }
  if (f['deadlineWithTime'] != null && (f['deadlineWithTime'] as number) <= 0) {
    return 'deadlineWithTime must be a positive timestamp';
  }
  if (f['deadlineRemindAt'] != null && (f['deadlineRemindAt'] as number) <= 0) {
    return 'deadlineRemindAt must be a positive timestamp';
  }
  return undefined;
};

type DeadlineChange =
  | { type: 'set'; fields: AnyRecord }
  | { type: 'clearReminder' }
  | { type: 'remove' };

/** Port of resolveDeadlineChange (desktop handler). */
const resolveDeadlineChange = (
  fields: AnyRecord,
  existing?: Task,
): { ok: true; change?: DeadlineChange } | { ok: false; message: string } => {
  const hasDay = hasOwn(fields, 'deadlineDay');
  const hasTime = hasOwn(fields, 'deadlineWithTime');
  const hasReminder = hasOwn(fields, 'deadlineRemindAt');
  if (!hasDay && !hasTime && !hasReminder) return { ok: true };
  const requestedDay = (fields['deadlineDay'] as string | null | undefined) ?? undefined;
  const requestedTime =
    (fields['deadlineWithTime'] as number | null | undefined) ?? undefined;
  let deadlineDay = hasDay
    ? requestedDay
    : ((existing?.['deadlineDay'] as string | undefined) ?? undefined);
  let deadlineWithTime = hasTime
    ? requestedTime
    : ((existing?.['deadlineWithTime'] as number | undefined) ?? undefined);
  if (requestedDay !== undefined) deadlineWithTime = undefined;
  if (requestedTime !== undefined) deadlineDay = undefined;

  if (deadlineDay === undefined && deadlineWithTime === undefined) {
    if (fields['deadlineRemindAt'] != null)
      return { ok: false, message: 'deadlineRemindAt requires a deadline' };
    const hasExisting = Boolean(
      existing?.['deadlineDay'] ||
      existing?.['deadlineWithTime'] ||
      existing?.['deadlineRemindAt'],
    );
    return {
      ok: true,
      change: hasExisting && (hasDay || hasTime) ? { type: 'remove' } : undefined,
    };
  }
  const exDay = (existing?.['deadlineDay'] as string | undefined) ?? undefined;
  const exTime = (existing?.['deadlineWithTime'] as number | undefined) ?? undefined;
  const exRemind = (existing?.['deadlineRemindAt'] as number | undefined) ?? undefined;
  const changed = deadlineDay !== exDay || deadlineWithTime !== exTime;
  let remindAt: number | undefined;
  if (!hasReminder) {
    remindAt = changed ? undefined : exRemind;
  } else {
    const requested =
      (fields['deadlineRemindAt'] as number | null | undefined) ?? undefined;
    if (requested === undefined && !changed && exRemind !== undefined) {
      return { ok: true, change: { type: 'clearReminder' } };
    }
    remindAt = requested;
  }
  if (existing && !changed && remindAt === exRemind) return { ok: true };
  return {
    ok: true,
    change: {
      type: 'set',
      fields: {
        ...(deadlineDay !== undefined ? { deadlineDay } : {}),
        ...(deadlineWithTime !== undefined ? { deadlineWithTime } : {}),
        ...(remindAt !== undefined ? { deadlineRemindAt: remindAt } : {}),
      },
    },
  };
};

const tasksOf = (state: EngineState): Record<string, Task> =>
  ((state.root['tasks'] as AnyRecord)?.['entities'] ?? {}) as Record<string, Task>;
const taskIdsOf = (state: EngineState): string[] =>
  ((state.root['tasks'] as AnyRecord)?.['ids'] ?? []) as string[];
const archivedTasksOf = (state: EngineState): Task[] => {
  const out: Task[] = [];
  for (const archive of [state.archiveYoung, state.archiveOld]) {
    const t = (archive as AnyRecord)?.['task'] as
      | { ids?: string[]; entities?: Record<string, Task> }
      | undefined;
    for (const id of t?.ids ?? []) {
      const task = t?.entities?.[id];
      if (task) out.push(task);
    }
  }
  return out;
};
const getTask = (state: EngineState, id: string): Task | undefined => {
  const t = tasksOf(state)[id];
  return t && t.id === id ? t : undefined;
};
const getArchivedTask = (state: EngineState, id: string): Task | undefined =>
  archivedTasksOf(state).find((t) => t.id === id);
const withSubTasks = (state: EngineState, task: Task): Task & { subTasks: Task[] } => ({
  ...task,
  subTasks: (task.subTaskIds ?? []).map((sid) => tasksOf(state)[sid]).filter(Boolean),
});

export class RestApiModule implements AppModule {
  constructor(private readonly writer: ServerWriter) {}

  register(app: App): void {
    const r = app.router;
    const base = '/api/v1';
    const route = (
      method: string,
      path: string,
      scope: TokenScope,
      handler: (
        ctx: RequestContext,
        auth: AuthenticatedToken,
      ) => Promise<{ status: number; data: unknown }>,
    ): void => {
      r.add(method, `${base}${path}`, async (ctx) => {
        const auth = app.authenticate(ctx, scope);
        if (!auth) return;
        try {
          const { status, data } = await handler(ctx, auth);
          sendJson(ctx.res, status, { ok: true, data });
        } catch (err) {
          if (err instanceof ApiError) {
            sendJson(ctx.res, err.status, {
              ok: false,
              error: {
                code: err.code,
                message: err.message,
                ...(err.details ? { details: err.details } : {}),
              },
            });
          } else if (err instanceof ProjectionUnavailableError) {
            sendJson(ctx.res, 503, {
              ok: false,
              error: {
                code: `PROJECTION_${err.status.toUpperCase()}`,
                message: err.message,
              },
            });
          } else if (err instanceof WriteConflictError) {
            sendJson(ctx.res, err.errorCode === 'NEEDS_KEY' ? 503 : 409, {
              ok: false,
              error: { code: err.errorCode ?? 'CONFLICT', message: err.message },
            });
          } else {
            throw err;
          }
        }
      });
    };
    const body = async (ctx: RequestContext): Promise<AnyRecord> => {
      const parsed = await readJsonBody(ctx.req, DEFAULT_BODY_LIMITS);
      if (!isRecord(parsed))
        throw new ApiError(400, 'INVALID_INPUT', 'Request body must be a JSON object');
      return parsed;
    };

    // Health without auth (desktop API: GET /health).
    r.add('GET', `${base}/health`, (ctx) =>
      sendJson(ctx.res, 200, {
        ok: true,
        data: { status: 'ok', server: 'sp-sqlite-server' },
      }),
    );

    const notOnServer = async (): Promise<never> => {
      throw new ApiError(
        501,
        'NOT_AVAILABLE_ON_SERVER',
        'Timer/focus state belongs to a running app instance and is not available on the server',
      );
    };
    route('GET', '/status', 'api-read', notOnServer);
    route('GET', '/focus', 'api-read', notOnServer);
    route('GET', '/task-control/current', 'api-read', notOnServer);
    route('POST', '/task-control/current', 'api-write', notOnServer);
    route('POST', '/task-control/stop', 'api-write', notOnServer);
    route('POST', '/tasks/:id/start', 'api-write', notOnServer);

    route('GET', '/tasks', 'api-read', async (ctx, auth) => {
      const q = ctx.query;
      const source = ['active', 'archived', 'all'].includes(q['source'] ?? '')
        ? q['source']
        : 'active';
      const includeDone = (q['includeDone'] ?? '').toLowerCase() === 'true';
      return this.writer.read(auth.userId, (state) => {
        const active = taskIdsOf(state)
          .map((id) => tasksOf(state)[id])
          .filter(Boolean);
        let tasks =
          source === 'archived'
            ? archivedTasksOf(state)
            : source === 'all'
              ? [...active, ...archivedTasksOf(state)]
              : active;
        if (q['query']) {
          const lower = q['query'].toLowerCase();
          tasks = tasks.filter((t) => (t.title ?? '').toLowerCase().includes(lower));
        }
        if (q['projectId']) tasks = tasks.filter((t) => t.projectId === q['projectId']);
        if (q['tagId'] === 'TODAY') {
          const misc = (state.root['globalConfig'] as AnyRecord)?.['misc'] as
            | AnyRecord
            | undefined;
          const { helpers } = this.writer.engine;
          const diff = helpers.getStartOfNextDayDiffMs(misc);
          const todayStr = helpers.getDbDateStr(Date.now() - diff);
          tasks = tasks.filter((t) => {
            const dwt = t['dueWithTime'];
            if (typeof dwt === 'number' && Number.isFinite(dwt) && dwt > 0) {
              return helpers.isTodayWithOffset(dwt, todayStr, diff);
            }
            return t['dueDay'] === todayStr;
          });
        } else if (q['tagId']) {
          tasks = tasks.filter((t) => (t.tagIds ?? []).includes(q['tagId']));
        }
        if (!includeDone) tasks = tasks.filter((t) => !t.isDone);
        return { status: 200, data: tasks };
      });
    });

    route('GET', '/tasks/:id', 'api-read', async (ctx, auth) =>
      this.writer.read(auth.userId, (state) => {
        const task = getTask(state, ctx.params['id']);
        if (!task) throw new ApiError(404, 'TASK_NOT_FOUND', 'Task not found');
        return { status: 200, data: task };
      }),
    );

    route('POST', '/tasks', 'api-write', async (ctx, auth) => {
      const b = await body(ctx);
      if (typeof b['title'] !== 'string' || !b['title'].trim()) {
        throw new ApiError(400, 'INVALID_INPUT', 'Task title must be a non-empty string');
      }
      if ('subTaskIds' in b) {
        throw new ApiError(
          400,
          'UNSUPPORTED_FIELD',
          'subTaskIds cannot be set on task creation — create the parent first, then create each child with POST /tasks using parentId',
        );
      }
      if (
        b['isIgnoreShortSyntax'] !== undefined &&
        typeof b['isIgnoreShortSyntax'] !== 'boolean'
      ) {
        throw new ApiError(400, 'INVALID_INPUT', 'isIgnoreShortSyntax must be a boolean');
      }
      const title = (b['title'] as string).trim();
      const fields = pickAllowedFields(b);
      const typeErrors = validateWritableFields(fields);
      if (typeErrors.length) {
        throw new ApiError(
          400,
          'INVALID_INPUT',
          'One or more task fields have an invalid type',
          typeErrors,
        );
      }
      const deadlineError = validateDeadlineFields(fields);
      if (deadlineError) throw new ApiError(400, 'INVALID_INPUT', deadlineError);
      const deadline = resolveDeadlineChange(
        Object.fromEntries(
          DEADLINE_FIELDS.filter((f) => hasOwn(fields, f)).map((f) => [f, fields[f]]),
        ),
      );
      if (!deadline.ok) throw new ApiError(400, 'INVALID_INPUT', deadline.message);
      for (const f of DEADLINE_FIELDS) delete fields[f];
      delete fields['title'];
      const { engine } = this.writer;
      let createdId = '';

      if ('parentId' in b) {
        if (typeof b['parentId'] !== 'string' || !b['parentId']) {
          throw new ApiError(400, 'INVALID_INPUT', 'parentId must be a non-empty string');
        }
        const inherited = SUBTASK_INHERITED_FIELDS.find((f) => f in b);
        if (inherited) {
          throw new ApiError(
            400,
            'UNSUPPORTED_FIELD',
            `${inherited} cannot be set when creating a subtask — it's inherited from the parent`,
          );
        }
        const parentId = b['parentId'] as string;
        const data = await this.writer.write(
          auth.userId,
          (state) => {
            const parent = getTask(state, parentId);
            if (!parent)
              throw new ApiError(
                404,
                'PARENT_NOT_FOUND',
                `Parent task ${parentId} not found`,
              );
            if (parent.parentId) {
              throw new ApiError(
                400,
                'INVALID_PARENT',
                'Cannot nest subtasks: parent task is itself a subtask',
              );
            }
            const task = engine.helpers.createTask({
              title,
              workContextType: 'PROJECT',
              workContextId: parent.projectId,
              additional: {
                dueDay: (fields['dueDay'] as string) || undefined,
                ...fields,
              },
            });
            createdId = task['id'] as string;
            return [
              (engine.actions['addSubTask'] as never as (p: unknown) => never)({
                task,
                parentId,
              }),
              ...deadlineActions(engine, createdId, deadline.change),
            ];
          },
          (state) => getTask(state, createdId),
        );
        return { status: 201, data };
      }

      if (typeof fields['projectId'] === 'string') {
        const projectId = fields['projectId'];
        await this.writer.read(auth.userId, (state) => {
          if (!activeProject(state, projectId)) {
            throw new ApiError(
              404,
              'PROJECT_NOT_FOUND',
              'Destination project not found or archived',
            );
          }
        });
      }
      const data = await this.writer.write(
        auth.userId,
        (state) => {
          const misc = (state.root['globalConfig'] as AnyRecord)?.['tasks'] as
            | AnyRecord
            | undefined;
          const projectId =
            (fields['projectId'] as string | undefined) ??
            (misc?.['defaultProjectId'] as string | undefined) ??
            'INBOX_PROJECT';
          const task = engine.helpers.createTask({
            title,
            workContextType: 'PROJECT',
            workContextId: projectId,
            additional: fields,
          });
          createdId = task['id'] as string;
          return [
            (engine.actions['addTask'] as never as (p: unknown) => never)({
              task,
              workContextId: projectId,
              workContextType: 'PROJECT',
              isAddToBacklog: false,
              isAddToBottom: false,
              isIgnoreShortSyntax: true,
            }),
            ...deadlineActions(engine, createdId, deadline.change),
          ];
        },
        (state) => getTask(state, createdId),
      );
      return { status: 201, data };
    });

    route('PATCH', '/tasks/:id', 'api-write', async (ctx, auth) => {
      const b = await body(ctx);
      if (
        b['isIgnoreShortSyntax'] !== undefined &&
        typeof b['isIgnoreShortSyntax'] !== 'boolean'
      ) {
        throw new ApiError(400, 'INVALID_INPUT', 'isIgnoreShortSyntax must be a boolean');
      }
      const rejected = REJECTED_TASK_FIELDS.find((f) => f in b);
      if (rejected) {
        throw new ApiError(
          400,
          'UNSUPPORTED_FIELD',
          `${rejected} cannot be set via PATCH — re-parenting is not supported by this API`,
        );
      }
      const changes = pickAllowedFields(b);
      const typeErrors = validateWritableFields(changes);
      if (typeErrors.length) {
        throw new ApiError(
          400,
          'INVALID_INPUT',
          'One or more task fields have an invalid type',
          typeErrors,
        );
      }
      const deadlineError = validateDeadlineFields(changes);
      if (deadlineError) throw new ApiError(400, 'INVALID_INPUT', deadlineError);
      const id = ctx.params['id'];
      const { engine } = this.writer;
      const data = await this.writer.write(
        auth.userId,
        (state) => {
          const task = getTask(state, id);
          if (!task) throw new ApiError(404, 'TASK_NOT_FOUND', 'Task not found');
          const deadline = resolveDeadlineChange(
            Object.fromEntries(
              DEADLINE_FIELDS.filter((f) => hasOwn(changes, f)).map((f) => [
                f,
                changes[f],
              ]),
            ),
            task,
          );
          if (!deadline.ok) throw new ApiError(400, 'INVALID_INPUT', deadline.message);
          for (const f of DEADLINE_FIELDS) delete changes[f];
          let projectMoveSubTaskIds: string[] | undefined;
          if (hasOwn(changes, 'projectId')) {
            const target = changes['projectId'];
            if (typeof target !== 'string' || !target.trim()) {
              throw new ApiError(
                400,
                'INVALID_INPUT',
                'projectId must be a non-empty string',
              );
            }
            const isChange = target !== task.projectId;
            if (task.parentId && isChange) {
              throw new ApiError(
                400,
                'UNSUPPORTED_FIELD',
                'projectId cannot be changed directly on a subtask — move its parent task instead',
              );
            }
            if (isChange && !activeProject(state, target)) {
              throw new ApiError(
                404,
                'PROJECT_NOT_FOUND',
                'Destination project not found or archived',
              );
            }
            if (!task.parentId) {
              // Same as TaskService.update: move subtasks along.
              const all = tasksOf(state);
              projectMoveSubTaskIds = Array.from(
                new Set([
                  ...(task.subTaskIds ?? []),
                  ...Object.values(all)
                    .filter((t) => t && t.parentId === id)
                    .map((t) => t.id),
                ]),
              );
            }
          }
          const actions: Array<{ type: string } & AnyRecord> = [];
          if (Object.keys(changes).length > 0) {
            const finalChanges =
              changes['isDone'] === true && typeof changes['doneOn'] !== 'number'
                ? { ...changes, doneOn: Date.now() } // OperationLogEffects.addReplayDateFieldsToActionPayload
                : changes;
            actions.push(
              (engine.actions['updateTask'] as never as (p: unknown) => never)({
                task: { id, changes: finalChanges },
                ...(Object.keys(changes).length === 1 && hasOwn(changes, 'title')
                  ? { isIgnoreShortSyntax: true }
                  : {}),
                ...(projectMoveSubTaskIds !== undefined ? { projectMoveSubTaskIds } : {}),
              }),
            );
          }
          actions.push(...deadlineActions(engine, id, deadline.change));
          return actions;
        },
        (state) => getTask(state, id),
      );
      return { status: 200, data };
    });

    route('DELETE', '/tasks/:id', 'api-write', async (ctx, auth) => {
      const id = ctx.params['id'];
      const { engine } = this.writer;
      await this.writer.write(
        auth.userId,
        (state) => {
          const task = getTask(state, id);
          if (!task) throw new ApiError(404, 'TASK_NOT_FOUND', 'Task not found');
          return [
            (engine.actions['deleteTask'] as never as (p: unknown) => never)({
              task: withSubTasks(state, task),
            }),
          ];
        },
        () => undefined,
      );
      return { status: 200, data: { deleted: true, id } };
    });

    route('POST', '/tasks/:id/archive', 'api-write', async (ctx, auth) => {
      const id = ctx.params['id'];
      const { engine } = this.writer;
      await this.writer.write(
        auth.userId,
        (state) => {
          const task = getTask(state, id);
          if (!task) throw new ApiError(404, 'TASK_NOT_FOUND', 'Task not found');
          return [
            (engine.actions['moveToArchive'] as never as (p: unknown) => never)({
              tasks: [withSubTasks(state, task)],
            }),
          ];
        },
        () => undefined,
      );
      return { status: 200, data: { id, archived: true } };
    });

    route('POST', '/tasks/:id/restore', 'api-write', async (ctx, auth) => {
      const id = ctx.params['id'];
      const { engine } = this.writer;
      const data = await this.writer.write(
        auth.userId,
        (state) => {
          const archived = getArchivedTask(state, id);
          if (!archived)
            throw new ApiError(404, 'TASK_NOT_FOUND', 'Task not found in archive');
          const subTasks = (archived.subTaskIds ?? [])
            .map((sid) => getArchivedTask(state, sid))
            .filter((t): t is Task => !!t);
          return [
            (engine.actions['restoreTask'] as never as (p: unknown) => never)({
              task: archived,
              subTasks,
            }),
          ];
        },
        (state) => getTask(state, id),
      );
      return { status: 200, data };
    });

    route('GET', '/projects', 'api-read', async (ctx, auth) =>
      this.writer.read(auth.userId, (state) => {
        const p = state.root['projects'] as {
          ids: string[];
          entities: Record<string, AnyRecord>;
        };
        let list = p.ids.map((id) => p.entities[id]).filter((x) => x && !x['isArchived']);
        if (ctx.query['query']) {
          const lower = ctx.query['query'].toLowerCase();
          list = list.filter((x) =>
            String(x['title'] ?? '')
              .toLowerCase()
              .includes(lower),
          );
        }
        return { status: 200, data: list };
      }),
    );

    route('GET', '/tags', 'api-read', async (ctx, auth) =>
      this.writer.read(auth.userId, (state) => {
        const t = state.root['tag'] as {
          ids: string[];
          entities: Record<string, AnyRecord>;
        };
        let list = t.ids.map((id) => t.entities[id]).filter(Boolean);
        if (ctx.query['query']) {
          const lower = ctx.query['query'].toLowerCase();
          list = list.filter((x) =>
            String(x['title'] ?? '')
              .toLowerCase()
              .includes(lower),
          );
        }
        return { status: 200, data: list };
      }),
    );
  }
}

const activeProject = (state: EngineState, id: string): AnyRecord | undefined => {
  const p = state.root['projects'] as {
    ids: string[];
    entities: Record<string, AnyRecord>;
  };
  return p.ids.includes(id) &&
    p.entities[id]?.['id'] === id &&
    !p.entities[id]['isArchived']
    ? p.entities[id]
    : undefined;
};

const deadlineActions = (
  engine: ServerWriter['engine'],
  taskId: string,
  change: DeadlineChange | undefined,
): Array<{ type: string } & AnyRecord> => {
  if (!change) return [];
  const call = (name: string, props: AnyRecord): { type: string } & AnyRecord =>
    (engine.actions[name] as never as (p: unknown) => { type: string } & AnyRecord)(
      props,
    );
  if (change.type === 'clearReminder') return [call('clearDeadlineReminder', { taskId })];
  if (change.type === 'remove')
    return [call('removeDeadline', { taskId, isSkipSnack: true })];
  return [call('setDeadline', { taskId, ...change.fields, isSkipSnack: true })];
};
