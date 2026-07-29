-- Profiles (extends auth.users)
CREATE TABLE profiles (
  id UUID REFERENCES auth.users PRIMARY KEY,
  username VARCHAR(20) UNIQUE NOT NULL,
  display_name VARCHAR(30) NOT NULL,
  avatar_url TEXT DEFAULT NULL,
  twofa_enabled BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- Chats (DM or group)
CREATE TABLE chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(10) CHECK (type IN ('dm', 'group')) NOT NULL,
  name VARCHAR(50) DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE chats ENABLE ROW LEVEL SECURITY;

-- Chat members
CREATE TABLE chat_members (
  chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (chat_id, user_id)
);

ALTER TABLE chat_members ENABLE ROW LEVEL SECURITY;

-- Messages
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id UUID REFERENCES chats(id) ON DELETE CASCADE NOT NULL,
  sender_id UUID REFERENCES profiles(id) NOT NULL,
  content TEXT DEFAULT NULL,
  file_url TEXT DEFAULT NULL,
  file_name TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Indexes
CREATE INDEX idx_messages_chat_id ON messages(chat_id);
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_chat_members_user_id ON chat_members(user_id);
CREATE INDEX idx_chat_members_chat_id ON chat_members(chat_id);
CREATE INDEX idx_profiles_username ON profiles(username);

-- RLS Policies

-- Profiles: users can read all profiles, update only their own
CREATE POLICY "Anyone can read profiles"
  ON profiles FOR SELECT USING (true);

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE USING (auth.uid() = id);

-- Chats: members can read
CREATE POLICY "Members can read chats"
  ON chats FOR SELECT USING (
    EXISTS (SELECT 1 FROM chat_members WHERE chat_id = id AND user_id = auth.uid())
  );

CREATE POLICY "Users can create chats"
  ON chats FOR INSERT WITH CHECK (true);

-- Chat members
CREATE POLICY "Members can read chat_members"
  ON chat_members FOR SELECT USING (
    user_id = auth.uid() OR
    EXISTS (SELECT 1 FROM chat_members cm WHERE cm.chat_id = chat_id AND cm.user_id = auth.uid())
  );

CREATE POLICY "Users can insert chat_members"
  ON chat_members FOR INSERT WITH CHECK (
    auth.uid() = user_id OR
    EXISTS (SELECT 1 FROM chat_members cm WHERE cm.chat_id = chat_id AND cm.user_id = auth.uid())
  );

-- Messages
CREATE POLICY "Members can read messages"
  ON messages FOR SELECT USING (
    EXISTS (SELECT 1 FROM chat_members WHERE chat_id = messages.chat_id AND user_id = auth.uid())
  );

CREATE POLICY "Members can insert messages"
  ON messages FOR INSERT WITH CHECK (
    sender_id = auth.uid() AND
    EXISTS (SELECT 1 FROM chat_members WHERE chat_id = messages.chat_id AND user_id = auth.uid())
  );

-- Storage bucket for avatars
INSERT INTO storage.buckets (id, name, public) VALUES ('avatars', 'avatars', true);

-- Storage bucket for chat files
INSERT INTO storage.buckets (id, name, public) VALUES ('files', 'files', true);

CREATE POLICY "Anyone can read avatars"
  ON storage.objects FOR SELECT USING (bucket_id = 'avatars');

CREATE POLICY "Users can upload own avatar"
  ON storage.objects FOR INSERT WITH CHECK (
    bucket_id = 'avatars' AND auth.role() = 'authenticated'
  );

CREATE POLICY "Users can update own avatar"
  ON storage.objects FOR UPDATE USING (
    bucket_id = 'avatars' AND auth.role() = 'authenticated'
  );

-- Function to create profile on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO profiles (id, username, display_name)
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data->>'username',
    NEW.raw_user_meta_data->>'display_name'
  );
  RETURN NEW;
END;
$$;

-- Trigger for new user signup
CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_user();
