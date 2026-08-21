-- 0033_parent_conversations.sql
-- Support splitting multi-session recordings into child conversation slices.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS parent_conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS turn_range jsonb;

CREATE INDEX IF NOT EXISTS conversations_parent_id_idx ON conversations(parent_conversation_id);
