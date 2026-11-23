/**
 * 建表语句。启动时幂等执行（CREATE ... IF NOT EXISTS），无需独立迁移工具。
 * 消息表与前端 branches.ts 的消息树完全同构：
 *   parent_id + selected_child_id 决定会话的「可见路径」。
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY,
  email         text NOT NULL,
  email_lower   text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_used_at timestamptz
);

CREATE INDEX IF NOT EXISTS auth_tokens_user_idx ON auth_tokens(user_id);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           text NOT NULL DEFAULT '',
  root_message_id uuid,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  message_count   integer NOT NULL DEFAULT 0,
  -- 软删除：保留墓碑，其他设备才能通过增量接口感知到「这个会话被删了」
  deleted_at      timestamptz
);

-- 已有部署补列（幂等）
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS chat_sessions_user_updated_idx
  ON chat_sessions(user_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  id                uuid PRIMARY KEY,
  session_id        uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  parent_id         uuid,
  selected_child_id uuid,
  role              text NOT NULL CHECK (role IN ('user', 'assistant')),
  content           text NOT NULL DEFAULT '',
  files             jsonb,
  reply             jsonb,
  created_at        timestamptz NOT NULL,
  seq               bigserial
);

CREATE INDEX IF NOT EXISTS chat_messages_session_seq_idx ON chat_messages(session_id, seq);
CREATE INDEX IF NOT EXISTS chat_messages_parent_idx ON chat_messages(session_id, parent_id);

CREATE TABLE IF NOT EXISTS user_model_keys (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  key_cipher text NOT NULL,
  key_mask   text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`
