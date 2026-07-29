-- Local users (custom auth — no Supabase Auth dependency)
CREATE TABLE local_users (
  username VARCHAR(20) PRIMARY KEY,
  display_name VARCHAR(30) NOT NULL,
  password_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  enc_salt TEXT NOT NULL,
  enc_iv TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  rec_salt TEXT DEFAULT NULL,
  rec_iv TEXT DEFAULT NULL,
  recovery_key TEXT DEFAULT NULL,
  questions JSONB DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE local_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read local_users"
  ON local_users FOR SELECT USING (true);

CREATE POLICY "Anyone can insert local_users"
  ON local_users FOR INSERT WITH CHECK (true);

CREATE POLICY "User can update own record"
  ON local_users FOR UPDATE USING (true);

-- Chats (DM or group)
CREATE TABLE chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(10) CHECK (type IN ('dm', 'group')) NOT NULL,
  name VARCHAR(50) DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE chats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read chats"
  ON chats FOR SELECT USING (true);

CREATE POLICY "Anyone can insert chats"
  ON chats FOR INSERT WITH CHECK (true);

-- Chat members
CREATE TABLE chat_members (
  chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
  user_id VARCHAR(20) REFERENCES local_users(username) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (chat_id, user_id)
);

ALTER TABLE chat_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read chat_members"
  ON chat_members FOR SELECT USING (true);

CREATE POLICY "Anyone can insert chat_members"
  ON chat_members FOR INSERT WITH CHECK (true);

-- Messages
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id UUID REFERENCES chats(id) ON DELETE CASCADE NOT NULL,
  sender_id VARCHAR(20) REFERENCES local_users(username) NOT NULL,
  content TEXT DEFAULT NULL,
  file_url TEXT DEFAULT NULL,
  file_name TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read messages"
  ON messages FOR SELECT USING (true);

CREATE POLICY "Anyone can insert messages"
  ON messages FOR INSERT WITH CHECK (true);

-- Indexes
CREATE INDEX idx_messages_chat_id ON messages(chat_id);
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_chat_members_user_id ON chat_members(user_id);
CREATE INDEX idx_chat_members_chat_id ON chat_members(chat_id);
CREATE INDEX idx_local_users_username ON local_users(username);

-- Storage bucket for chat files
INSERT INTO storage.buckets (id, name, public) VALUES ('files', 'files', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Anyone can read files"
  ON storage.objects FOR SELECT USING (bucket_id = 'files');

CREATE POLICY "Anyone can upload files"
  ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'files');
