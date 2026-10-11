/**
 * Versioned schema migrations for the server database.
 *
 * Rules:
 * - Append only. Never edit a migration that may have run on a real database;
 *   add a new one instead.
 * - Each migration runs inside its own `BEGIN IMMEDIATE` transaction together
 *   with its `schema_migrations` row, so a failure leaves the previous version
 *   intact and a restart retries the same step.
 * - `version` values are consecutive integers starting at 1.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'sync_core',
    sql: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        token_version INTEGER NOT NULL DEFAULT 0
      );

      -- Bearer tokens. Only the SHA-256 hash is stored.
      -- scope: 'sync' (SuperSync protocol), 'api-read' / 'api-write' (REST API for MCP).
      CREATE TABLE api_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL CHECK (scope IN ('sync', 'api-read', 'api-write')),
        label TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX api_tokens_user ON api_tokens(user_id);

      -- Per-user sequence allocator and full-state markers (mirrors the
      -- SuperSync server's user_sync_state).
      CREATE TABLE sync_state (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        last_seq INTEGER NOT NULL DEFAULT 0,
        latest_full_state_seq INTEGER,
        latest_full_state_vector_clock TEXT,
        latest_state_replacement_seq INTEGER
      );

      -- The authoritative, append-only operation log.
      CREATE TABLE operations (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        server_seq INTEGER NOT NULL,
        client_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        op_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        entity_ids TEXT NOT NULL DEFAULT '[]',
        payload TEXT NOT NULL,
        payload_bytes INTEGER NOT NULL DEFAULT 0,
        vector_clock TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        client_timestamp INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        is_payload_encrypted INTEGER NOT NULL DEFAULT 0,
        sync_import_reason TEXT,
        repair_base_server_seq INTEGER,
        UNIQUE (user_id, server_seq)
      );
      CREATE INDEX operations_user_op_type ON operations(user_id, op_type, server_seq);
      CREATE INDEX operations_user_client ON operations(user_id, client_id, server_seq);

      -- Every entity an operation touches (scalar entity_id UNION entity_ids).
      -- Replaces the Postgres GIN index: "latest op per entity" is a single
      -- index seek on (user_id, entity_type, entity_id, server_seq DESC).
      CREATE TABLE operation_entities (
        user_id INTEGER NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        server_seq INTEGER NOT NULL,
        PRIMARY KEY (user_id, entity_type, entity_id, server_seq),
        FOREIGN KEY (user_id, server_seq) REFERENCES operations(user_id, server_seq)
          ON DELETE CASCADE
      ) WITHOUT ROWID;
      CREATE INDEX operation_entities_seq ON operation_entities(user_id, server_seq);

      CREATE TABLE sync_devices (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL,
        app_version TEXT,
        last_seen_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, client_id)
      );
    `,
  },
  {
    version: 2,
    name: 'projection',
    // Derived tables. Source of truth stays `operations`; everything below is
    // rebuilt from it by the projector (src/projection) and can be dropped and
    // re-created at any time. `bucket`: 'live' (current state), 'young'/'old'
    // (archiveYoung/archiveOld).
    sql: `
      CREATE TABLE projection_status (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        applied_seq INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ok'
          CHECK (status IN ('ok', 'needs_key', 'blocked', 'error')),
        last_error TEXT,
        skipped_ops INTEGER NOT NULL DEFAULT 0,
        latest_import TEXT,
        engine_schema_version INTEGER,
        engine_revision TEXT,
        updated_at INTEGER NOT NULL
      );

      -- Exact persisted model data for lossless engine restarts:
      -- non-entity part of each model slice (ids order, singletons, archives' meta) ...
      CREATE TABLE projection_model (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        model_key TEXT NOT NULL,
        meta TEXT NOT NULL,
        PRIMARY KEY (user_id, model_key)
      );
      -- ... and every entity's full JSON.
      CREATE TABLE entity_data (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        model_key TEXT NOT NULL,
        bucket TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (user_id, model_key, bucket, id)
      ) WITHOUT ROWID;

      -- Typed query tables (MCP / SQL access).
      CREATE TABLE task (
        user_id INTEGER NOT NULL, bucket TEXT NOT NULL, id TEXT NOT NULL,
        title TEXT, project_id TEXT, parent_id TEXT, is_done INTEGER NOT NULL DEFAULT 0,
        done_on INTEGER, created INTEGER, modified INTEGER, due_day TEXT, due_with_time INTEGER,
        deadline_day TEXT, deadline_with_time INTEGER, remind_at INTEGER,
        time_estimate INTEGER, time_spent INTEGER, repeat_cfg_id TEXT,
        issue_id TEXT, issue_type TEXT, issue_provider_id TEXT, notes TEXT,
        PRIMARY KEY (user_id, bucket, id)
      );
      CREATE INDEX task_project ON task(user_id, project_id);
      CREATE INDEX task_parent ON task(user_id, parent_id);
      CREATE INDEX task_due ON task(user_id, due_day);
      CREATE TABLE task_tag (
        user_id INTEGER NOT NULL, bucket TEXT NOT NULL, task_id TEXT NOT NULL,
        tag_id TEXT NOT NULL, position INTEGER NOT NULL,
        PRIMARY KEY (user_id, bucket, task_id, tag_id)
      );
      CREATE INDEX task_tag_tag ON task_tag(user_id, tag_id);
      CREATE TABLE task_subtask (
        user_id INTEGER NOT NULL, bucket TEXT NOT NULL, parent_id TEXT NOT NULL,
        task_id TEXT NOT NULL, position INTEGER NOT NULL,
        PRIMARY KEY (user_id, bucket, parent_id, task_id)
      );
      CREATE TABLE task_time_spent (
        user_id INTEGER NOT NULL, bucket TEXT NOT NULL, task_id TEXT NOT NULL,
        day TEXT NOT NULL, ms INTEGER NOT NULL,
        PRIMARY KEY (user_id, bucket, task_id, day)
      );
      CREATE INDEX task_time_spent_day ON task_time_spent(user_id, day);
      CREATE TABLE project (
        user_id INTEGER NOT NULL, bucket TEXT NOT NULL, id TEXT NOT NULL,
        title TEXT, is_archived INTEGER NOT NULL DEFAULT 0, is_hidden_from_menu INTEGER NOT NULL DEFAULT 0,
        is_enable_backlog INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, bucket, id)
      );
      CREATE TABLE project_task (
        user_id INTEGER NOT NULL, bucket TEXT NOT NULL, project_id TEXT NOT NULL,
        task_id TEXT NOT NULL, list TEXT NOT NULL CHECK (list IN ('today', 'backlog')),
        position INTEGER NOT NULL,
        PRIMARY KEY (user_id, bucket, project_id, list, task_id)
      );
      CREATE TABLE tag (
        user_id INTEGER NOT NULL, bucket TEXT NOT NULL, id TEXT NOT NULL,
        title TEXT, color TEXT,
        PRIMARY KEY (user_id, bucket, id)
      );
      CREATE TABLE tag_task (
        user_id INTEGER NOT NULL, bucket TEXT NOT NULL, tag_id TEXT NOT NULL,
        task_id TEXT NOT NULL, position INTEGER NOT NULL,
        PRIMARY KEY (user_id, bucket, tag_id, task_id)
      );
      CREATE TABLE note (
        user_id INTEGER NOT NULL, bucket TEXT NOT NULL, id TEXT NOT NULL,
        project_id TEXT, content TEXT, is_pinned_to_today INTEGER NOT NULL DEFAULT 0,
        created INTEGER, modified INTEGER,
        PRIMARY KEY (user_id, bucket, id)
      );
      CREATE TABLE section (
        user_id INTEGER NOT NULL, bucket TEXT NOT NULL, id TEXT NOT NULL,
        title TEXT, context_id TEXT, context_type TEXT,
        PRIMARY KEY (user_id, bucket, id)
      );
      CREATE TABLE section_task (
        user_id INTEGER NOT NULL, bucket TEXT NOT NULL, section_id TEXT NOT NULL,
        task_id TEXT NOT NULL, position INTEGER NOT NULL,
        PRIMARY KEY (user_id, bucket, section_id, task_id)
      );
      CREATE TABLE task_repeat_cfg (
        user_id INTEGER NOT NULL, bucket TEXT NOT NULL, id TEXT NOT NULL,
        title TEXT, project_id TEXT, repeat_cycle TEXT, repeat_every INTEGER,
        start_date TEXT, is_paused INTEGER NOT NULL DEFAULT 0, last_task_creation_day TEXT,
        PRIMARY KEY (user_id, bucket, id)
      );
      CREATE TABLE simple_counter (
        user_id INTEGER NOT NULL, bucket TEXT NOT NULL, id TEXT NOT NULL,
        title TEXT, type TEXT, is_enabled INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, bucket, id)
      );
      CREATE TABLE simple_counter_day (
        user_id INTEGER NOT NULL, bucket TEXT NOT NULL, counter_id TEXT NOT NULL,
        day TEXT NOT NULL, value REAL NOT NULL,
        PRIMARY KEY (user_id, bucket, counter_id, day)
      );
      CREATE TABLE issue_provider (
        user_id INTEGER NOT NULL, bucket TEXT NOT NULL, id TEXT NOT NULL,
        issue_provider_key TEXT, is_enabled INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, bucket, id)
      );
      CREATE TABLE metric (
        user_id INTEGER NOT NULL, bucket TEXT NOT NULL, id TEXT NOT NULL,
        PRIMARY KEY (user_id, bucket, id)
      );
      CREATE TABLE reminder (
        user_id INTEGER NOT NULL, bucket TEXT NOT NULL, id TEXT NOT NULL,
        related_id TEXT, type TEXT, remind_at INTEGER, title TEXT,
        PRIMARY KEY (user_id, bucket, id)
      );
      CREATE TABLE board (
        user_id INTEGER NOT NULL, bucket TEXT NOT NULL, id TEXT NOT NULL,
        title TEXT, position INTEGER NOT NULL,
        PRIMARY KEY (user_id, bucket, id)
      );
      CREATE TABLE planner_day (
        user_id INTEGER NOT NULL, bucket TEXT NOT NULL, day TEXT NOT NULL,
        task_id TEXT NOT NULL, position INTEGER NOT NULL,
        PRIMARY KEY (user_id, bucket, day, task_id)
      );
      CREATE TABLE time_tracking (
        user_id INTEGER NOT NULL, bucket TEXT NOT NULL, context TEXT NOT NULL,
        context_type TEXT NOT NULL, context_id TEXT NOT NULL, day TEXT NOT NULL,
        start INTEGER, "end" INTEGER, break_count INTEGER, break_time INTEGER,
        PRIMARY KEY (user_id, bucket, context, day)
      );
      CREATE TABLE global_config (
        user_id INTEGER NOT NULL, bucket TEXT NOT NULL, section TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (user_id, bucket, section)
      );
      CREATE TABLE plugin_data (
        user_id INTEGER NOT NULL, bucket TEXT NOT NULL, id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('user_data', 'metadata')),
        PRIMARY KEY (user_id, bucket, kind, id)
      );
    `,
  },
];
