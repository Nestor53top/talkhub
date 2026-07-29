-- 1. Таблица сообщений
CREATE TABLE messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_hash text NOT NULL,
  nick text NOT NULL,
  text text,
  file_url text,
  file_name text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_messages_room ON messages (room_hash, created_at);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "all_on_messages" ON messages
  FOR ALL USING (true) WITH CHECK (true);

ALTER PUBLICATION supabase_realtime ADD TABLE messages;

-- 2. Storage bucket для файлов
INSERT INTO storage.buckets (id, name, public) VALUES ('chat_files', 'chat_files', true);

CREATE POLICY "public_select" ON storage.objects FOR SELECT USING (true);
CREATE POLICY "public_insert" ON storage.objects FOR INSERT WITH CHECK (true);
