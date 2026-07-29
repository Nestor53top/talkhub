/* TalkHub — Full Messenger */

const $ = id => document.getElementById(id);
const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('th_' + k)) } catch { return d } },
  set(k, v) { localStorage.setItem('th_' + k, JSON.stringify(v)) },
  del(k) { localStorage.removeItem('th_' + k) }
};

let supabase = null;
let peer = null;
let localStream = null;
let call = null;
let currentUser = null;
let currentChatId = null;
let chatSubscriptions = [];
let currentPeerId = null;
let remotePeerId = null;
let callTimerInterval = null;
let callStartTime = null;
let isGroupChat = false;

// -- Supabase init --
function initSupabase(url, key) {
  if (typeof supabaseClient === 'undefined') return toast('Supabase SDK не загружен');
  supabase = supabaseClient.createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true }
  });
  LS.set('supabase_url', url);
  LS.set('supabase_key', key);
}

function loadSupabaseConfig() {
  const url = LS.get('supabase_url');
  const key = LS.get('supabase_key');
  if (url && key) {
    initSupabase(url, key);
    return true;
  }
  return false;
}

// -- Helpers --
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.remove('active');
    s.style.display = 'none';
  });
  const el = $(id);
  if (el) { el.classList.add('active'); el.style.display = 'flex'; }
}

function toast(msg, duration = 2500) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => el.style.display = 'none', duration);
}

function timeStr(d) {
  const t = new Date(d);
  return String(t.getHours()).padStart(2,'0') + ':' + String(t.getMinutes()).padStart(2,'0');
}

function dateStr(d) {
  const t = new Date(d);
  return t.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function formatAvatarUrl(path) {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path);
  return publicUrl;
}

// -- Auth --
async function register(email, username, displayName, password) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { username, display_name: displayName }
    }
  });
  if (error) throw error;
  return data;
}

async function login(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

async function sendOTP(email) {
  const { error } = await supabase.auth.signInWithOtp({ email });
  if (error) throw error;
}

async function verifyOTP(email, token) {
  const { data, error } = await supabase.auth.verifyOtp({
    email,
    token,
    type: 'email'
  });
  if (error) throw error;
  return data;
}

async function logout() {
  chatSubscriptions.forEach(s => s.unsubscribe());
  chatSubscriptions = [];
  await supabase.auth.signOut();
  currentUser = null;
  currentChatId = null;
  LS.del('session');
  showScreen('landing');
}

// -- Profile --
async function loadProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { showScreen('landing'); return null; }
  const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single();
  if (data) currentUser = data;
  return data;
}

async function updateDisplayName(name) {
  const { error } = await supabase.from('profiles').update({ display_name: name }).eq('id', currentUser.id);
  if (error) throw error;
  currentUser.display_name = name;
}

async function updateAvatar(file) {
  const ext = file.name.split('.').pop();
  const path = `avatars/${currentUser.id}.${ext}`;
  await supabase.storage.from('avatars').upload(path, file, { upsert: true });
  const url = formatAvatarUrl(path);
  await supabase.from('profiles').update({ avatar_url: path }).eq('id', currentUser.id);
  currentUser.avatar_url = path;
  return url;
}

async function changePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

async function toggle2FA(enabled) {
  const { error } = await supabase.from('profiles').update({ twofa_enabled: enabled }).eq('id', currentUser.id);
  if (error) throw error;
  currentUser.twofa_enabled = enabled;
}

// -- Search --
async function searchUsers(query) {
  if (!query || query.length < 2) return [];
  const { data } = await supabase.from('profiles')
    .select('id, username, display_name, avatar_url')
    .ilike('username', query + '%')
    .limit(10);
  return data || [];
}

async function getUserByUsername(username) {
  const { data } = await supabase.from('profiles')
    .select('id, username, display_name, avatar_url')
    .eq('username', username)
    .single();
  return data;
}

// -- Chats --
async function loadChatList() {
  const { data: memberships } = await supabase.from('chat_members')
    .select('chat_id, chats!inner(id, type, name, created_at)')
    .eq('user_id', currentUser.id)
    .order('chat_id', { ascending: false });

  if (!memberships) return [];

  const chatIds = memberships.map(m => m.chat_id);
  if (chatIds.length === 0) return [];

  const { data: chats } = await supabase.from('chats')
    .select('*')
    .in('id', chatIds)
    .order('created_at', { ascending: false });

  // Get last message for each chat
  const result = [];
  for (const chat of chats || []) {
    const { data: lastMsg } = await supabase.from('messages')
      .select('content, created_at, file_url')
      .eq('chat_id', chat.id)
      .order('created_at', { ascending: false })
      .limit(1);

    let name = chat.name;
    let avatar = null;

    if (chat.type === 'dm') {
      const { data: members } = await supabase.from('chat_members')
        .select('user_id')
        .eq('chat_id', chat.id);
      const otherId = members?.find(m => m.user_id !== currentUser.id)?.user_id;
      if (otherId) {
        const { data: other } = await supabase.from('profiles')
          .select('display_name, avatar_url')
          .eq('id', otherId)
          .single();
        if (other) {
          name = other.display_name;
          avatar = formatAvatarUrl(other.avatar_url);
        }
      }
    }

    result.push({
      ...chat,
      display_name: name,
      avatar_url: avatar,
      last_message: lastMsg?.[0]?.content || lastMsg?.[0]?.file_url ? 'Файл' : '',
      last_time: lastMsg?.[0]?.created_at || chat.created_at
    });
  }

  result.sort((a, b) => new Date(b.last_time) - new Date(a.last_time));
  return result;
}

async function createOrGetDM(otherUserId) {
  // Check if DM already exists
  const { data: myChats } = await supabase.from('chat_members')
    .select('chat_id')
    .eq('user_id', currentUser.id);
  const chatIds = myChats?.map(c => c.chat_id) || [];

  if (chatIds.length > 0) {
    for (const cid of chatIds) {
      const { data: members } = await supabase.from('chat_members')
        .select('user_id')
        .eq('chat_id', cid);
      const ids = members?.map(m => m.user_id) || [];
      if (ids.length === 2 && ids.includes(currentUser.id) && ids.includes(otherUserId)) {
        return cid;
      }
    }
  }

  // Create new DM
  const { data: chat, error } = await supabase.from('chats')
    .insert({ type: 'dm' })
    .select()
    .single();
  if (error) throw error;

  await supabase.from('chat_members').insert([
    { chat_id: chat.id, user_id: currentUser.id },
    { chat_id: chat.id, user_id: otherUserId }
  ]);

  return chat.id;
}

async function createGroup(name, memberIds) {
  const allMembers = [...new Set([currentUser.id, ...memberIds])];
  const { data: chat, error } = await supabase.from('chats')
    .insert({ type: 'group', name })
    .select()
    .single();
  if (error) throw error;

  await supabase.from('chat_members').insert(
    allMembers.map(uid => ({ chat_id: chat.id, user_id: uid }))
  );

  return chat.id;
}

async function getChatInfo(chatId) {
  const { data } = await supabase.from('chats').select('*').eq('id', chatId).single();
  return data;
}

async function getChatMembers(chatId) {
  const { data } = await supabase.from('chat_members').select('user_id').eq('chat_id', chatId);
  return data?.map(m => m.user_id) || [];
}

// -- Messages --
async function loadMessages(chatId) {
  const { data } = await supabase.from('messages')
    .select('*')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: true })
    .limit(100);
  return data || [];
}

async function getMessageSender(senderId) {
  const { data } = await supabase.from('profiles')
    .select('display_name, avatar_url')
    .eq('id', senderId)
    .single();
  return data;
}

async function sendMessage(chatId, content, fileUrl = null, fileName = null) {
  const { error } = await supabase.from('messages').insert({
    chat_id: chatId,
    sender_id: currentUser.id,
    content,
    file_url: fileUrl,
    file_name: fileName
  });
  if (error) throw error;
}

async function uploadFile(file) {
  const ext = file.name.split('.').pop();
  const path = `chat/${currentChatId}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
  await supabase.storage.from('files').upload(path, file);
  const { data: { publicUrl } } = supabase.storage.from('files').getPublicUrl(path);
  return { url: publicUrl, name: file.name };
}

// -- Subscribe to messages (real-time) --
function subscribeToChat(chatId) {
  // Unsubscribe previous
  chatSubscriptions.forEach(s => s.unsubscribe());
  chatSubscriptions = [];

  const sub = supabase.channel('chat:' + chatId)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `chat_id=eq.${chatId}` },
      async (payload) => {
        const msg = payload.new;
        const sender = await getMessageSender(msg.sender_id);
        const isMine = msg.sender_id === currentUser.id;
        renderMessage(msg, sender, isMine);
      }
    )
    .subscribe();
  chatSubscriptions.push(sub);
}

// -- Render message --
function renderMessage(msg, sender, isMine) {
  const el = document.createElement('div');
  el.className = `message ${isMine ? 'mine' : 'theirs'}`;

  if (!isMine && isGroupChat && sender) {
    const nameEl = document.createElement('div');
    nameEl.className = 'msg-name';
    nameEl.textContent = sender.display_name;
    el.appendChild(nameEl);
  }

  if (msg.file_url && msg.file_name?.match(/\.(jpg|jpeg|png|gif|webp|bmp)$/i)) {
    const img = document.createElement('img');
    img.src = msg.file_url;
    img.onclick = () => {
      const v = document.createElement('div'); v.className = 'img-viewer';
      v.onclick = () => v.remove();
      const i = document.createElement('img'); i.src = msg.file_url;
      v.appendChild(i); document.body.appendChild(v);
    };
    el.appendChild(img);
  } else if (msg.file_url) {
    const a = document.createElement('a');
    a.href = msg.file_url;
    a.download = msg.file_name || 'file';
    a.className = 'file-link';
    a.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M14 2v6h6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg> ' + (msg.file_name || 'Файл');
    el.appendChild(a);
  }

  if (msg.content) {
    const t = document.createElement('div');
    t.textContent = msg.content;
    el.appendChild(t);
  }

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = timeStr(msg.created_at);
  el.appendChild(time);

  $('chatMessages').appendChild(el);
  $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
}

// -- Open chat --
async function openChat(chatId) {
  currentChatId = chatId;
  isGroupChat = false;

  const chat = await getChatInfo(chatId);
  isGroupChat = chat?.type === 'group';

  const members = await getChatMembers(chatId);
  const otherId = members.find(id => id !== currentUser.id);

  let chatName = chat?.name || 'Чат';
  let avatarUrl = null;

  if (chat?.type === 'dm' && otherId) {
    const { data: other } = await supabase.from('profiles')
      .select('display_name, avatar_url')
      .eq('id', otherId)
      .single();
    if (other) {
      chatName = other.display_name;
      avatarUrl = formatAvatarUrl(other.avatar_url);
      remotePeerId = otherId.slice(0, 8); // Use first 8 chars of UUID as PeerJS ID
    }
  }

  $('chatScreenName').textContent = chatName;

  $('chatMessages').innerHTML = '';
  showScreen('chat');

  // Load existing messages
  const msgs = await loadMessages(chatId);
  for (const msg of msgs) {
    const sender = await getMessageSender(msg.sender_id);
    const isMine = msg.sender_id === currentUser.id;
    renderMessage(msg, sender, isMine);
  }

  subscribeToChat(chatId);
}

// -- Render chat list --
async function renderChatList() {
  const container = $('chatList');
  const empty = $('emptyChats');
  const chats = await loadChatList();

  // Remove old items (keep empty state)
  container.querySelectorAll('.chat-list-item').forEach(el => el.remove());

  if (chats.length === 0) {
    empty.style.display = 'flex';
    return;
  }

  empty.style.display = 'none';

  for (const chat of chats) {
    const item = document.createElement('div');
    item.className = 'chat-list-item';
    item.dataset.chatId = chat.id;

    const avatarHtml = chat.avatar_url
      ? `<img src="${chat.avatar_url}" alt="">`
      : `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;

    item.innerHTML = `
      <div class="cli-avatar">${avatarHtml}</div>
      <div class="cli-info">
        <div class="cli-name">${chat.display_name || chat.name || 'Без имени'}</div>
        <div class="cli-preview">${chat.last_message || ''}</div>
      </div>
      <div class="cli-time">${chat.last_time ? timeStr(chat.last_time) : ''}</div>
    `;

    item.onclick = () => openChat(chat.id);
    container.appendChild(item);
  }
}

// -- WebRTC Calls (PeerJS) --
async function initPeer(peerId) {
  if (peer) peer.destroy();
  currentPeerId = peerId;
  peer = new Peer(peerId, {
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    }
  });
  peer.on('call', async (incomingCall) => {
    if (confirm('Входящий звонок. Ответить?')) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        $('localVideo').srcObject = localStream;
        $('callOverlay').style.display = 'flex';
        stopTimer();
        incomingCall.answer(localStream);
        call = incomingCall;
        call.on('stream', (remoteStream) => {
          $('remoteVideo').srcObject = remoteStream;
          startTimer();
        });
        call.on('close', endCall);
        call.on('error', endCall);
      } catch (e) {
        incomingCall.close();
        toast('Доступ к камере/микрофону запрещён');
      }
    } else {
      incomingCall.close();
    }
  });
}

function startCall(isVideo) {
  if (!peer || !remotePeerId) return toast('Нет собеседника для звонка');
  if (call) return toast('Уже в звонке');
  navigator.mediaDevices.getUserMedia({ audio: true, video: isVideo })
    .then(stream => {
      localStream = stream;
      $('localVideo').srcObject = stream;
      $('callOverlay').style.display = 'flex';
      stopTimer();
      call = peer.call(remotePeerId, stream);
      call.on('stream', (remoteStream) => {
        $('remoteVideo').srcObject = remoteStream;
        startTimer();
      });
      call.on('close', endCall);
      call.on('error', endCall);
    })
    .catch(() => toast('Доступ к камере/микрофону запрещён'));
}

function endCall() {
  stopTimer();
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (call) { call.close(); call = null; }
  $('localVideo').srcObject = null;
  $('remoteVideo').srcObject = null;
  $('callOverlay').style.display = 'none';
}

function startTimer() {
  callStartTime = Date.now();
  clearInterval(callTimerInterval);
  callTimerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - callStartTime) / 1000);
    $('callTimer').textContent =
      String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }, 1000);
}

function stopTimer() {
  clearInterval(callTimerInterval);
  callTimerInterval = null;
  callStartTime = null;
  $('callTimer').textContent = '00:00';
}

// -- Navigation Events --
$('goLoginBtn').onclick = () => showScreen('login');
$('goRegisterBtn').onclick = () => showScreen('register');
$('backFromLoginBtn').onclick = () => showScreen('landing');
$('backFromRegisterBtn').onclick = () => showScreen('landing');
$('backFromSetupBtn').onclick = () => showScreen('landing');
$('backFromProfileBtn').onclick = () => showScreen('home');
$('backFromChatBtn').onclick = () => { showScreen('home'); renderChatList(); };
$('backFromGroupBtn').onclick = () => showScreen('home');

$('setupBtn').onclick = () => {
  $('supabaseUrl').value = LS.get('supabase_url') || '';
  $('supabaseAnonKey').value = LS.get('supabase_key') || '';
  showScreen('setup');
};

$('saveSupabaseBtn').onclick = () => {
  const url = $('supabaseUrl').value.trim();
  const key = $('supabaseAnonKey').value.trim();
  if (!url || !key) return toast('Заполни оба поля');
  initSupabase(url, key);
  toast('Сохранено!');
  showScreen('landing');
};

// -- Auth UI --
$('registerBtn').onclick = async () => {
  const email = $('regEmail').value.trim();
  const username = $('regUsername').value.trim().toLowerCase();
  const displayName = $('regDisplayName').value.trim();
  const password = $('regPassword').value;
  if (!email || !username || !displayName || !password)
    return $('regError').textContent = 'Заполни все поля';
  if (username.length < 3) return $('regError').textContent = 'Username минимум 3 символа';
  if (password.length < 6) return $('regError').textContent = 'Пароль минимум 6 символов';
  $('regError').textContent = '';
  try {
    const data = await register(email, username, displayName, password);
    if (data?.user?.identities?.length === 0) {
      $('regError').textContent = 'Этот email уже зарегистрирован';
      return;
    }
    showScreen('verify');
  } catch (e) {
    $('regError').textContent = e.message;
  }
};

$('checkVerificationBtn').onclick = async () => {
  const { data: { user } } = await supabase.auth.getUser();
  if (user?.email_confirmed_at) {
    toast('Email подтверждён!');
    showScreen('login');
  } else {
    // Force refresh
    const { error } = await supabase.auth.refreshSession();
    const { data: { user: u } } = await supabase.auth.getUser();
    if (u?.email_confirmed_at) {
      toast('Email подтверждён!');
      showScreen('login');
    } else {
      toast('Email ещё не подтверждён');
    }
  }
};

$('resendVerificationBtn').onclick = async () => {
  const email = $('regEmail').value.trim();
  if (email) {
    await supabase.auth.resend({ type: 'signup', email });
    toast('Письмо отправлено снова');
  }
};

$('loginBtn').onclick = async () => {
  const email = $('loginEmail').value.trim();
  const password = $('loginPassword').value;
  if (!email || !password) return $('loginError').textContent = 'Введите email и пароль';
  $('loginError').textContent = '';
  try {
    // Step 1: Sign in with password
    await login(email, password);

    // Step 2: Check if 2FA is enabled
    const profile = await loadProfile();
    if (profile?.twofa_enabled) {
      // Sign out and send OTP
      await supabase.auth.signOut();
      await sendOTP(email);
      $('twofaCode').value = '';
      $('twofaError').textContent = '';
      showScreen('twofa');
      LS.set('2fa_email', email);
      return;
    }

    // Step 3: Load profile and go to home
    await loadProfile();
    LS.set('session', true);
    showScreen('home');
    renderChatList();
    initPeer(currentUser.id.slice(0, 8));
  } catch (e) {
    $('loginError').textContent = e.message;
  }
};

// 2FA handler
$('twofaBtn').onclick = async () => {
  const code = $('twofaCode').value.trim();
  const email = LS.get('2fa_email');
  if (!code || code.length !== 6) return $('twofaError').textContent = 'Введи 6-значный код';
  $('twofaError').textContent = '';
  try {
    await verifyOTP(email, code);
    LS.del('2fa_email');
    await loadProfile();
    LS.set('session', true);
    showScreen('home');
    renderChatList();
    initPeer(currentUser.id.slice(0, 8));
  } catch (e) {
    $('twofaError').textContent = 'Неверный код';
  }
};

// Auto-login check
(async () => {
  if (loadSupabaseConfig()) {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      const profile = await loadProfile();
      if (profile) {
        LS.set('session', true);
        showScreen('home');
        renderChatList();
        initPeer(currentUser.id.slice(0, 8));
        return;
      }
    }
  }
  showScreen('landing');
})();

// -- Profile UI --
$('profileBtn').onclick = async () => {
  const p = currentUser;
  if (!p) return;
  $('profileUsername').textContent = '@' + p.username;
  $('profileDisplayName').value = p.display_name || '';
  const { data: { user } } = await supabase.auth.getUser();
  $('profileEmail').textContent = user?.email || '';
  $('twofaToggle').checked = p.twofa_enabled || false;
  $('twofaStatus').textContent = p.twofa_enabled ? 'Вкл' : 'Выкл';
  const avatarImg = $('profileAvatar').querySelector('img');
  const avatarIcon = $('profileAvatar').querySelector('svg');
  const url = formatAvatarUrl(p.avatar_url);
  if (url) {
    if (!avatarImg) {
      const img = document.createElement('img');
      $('profileAvatar').appendChild(img);
    }
    $('profileAvatar').querySelector('img').src = url;
    $('profileAvatar').querySelector('img').style.display = 'block';
    if (avatarIcon) avatarIcon.style.display = 'none';
  } else {
    const img = $('profileAvatar').querySelector('img');
    if (img) img.style.display = 'none';
    if (avatarIcon) avatarIcon.style.display = 'block';
  }
  showScreen('profile');
};

$('saveDisplayNameBtn').onclick = async () => {
  const name = $('profileDisplayName').value.trim();
  if (!name) return toast('Имя не может быть пустым');
  try {
    await updateDisplayName(name);
    toast('Имя обновлено');
  } catch (e) {
    toast('Ошибка: ' + e.message);
  }
};

$('changeAvatarBtn').onclick = () => $('avatarFileInput').click();
$('avatarFileInput').onchange = async (e) => {
  if (!e.target.files[0]) return;
  try {
    await updateAvatar(e.target.files[0]);
    toast('Аватар обновлён');
    $('avatarFileInput').value = '';
  } catch (err) {
    toast('Ошибка загрузки');
  }
};

$('changePasswordBtn').onclick = async () => {
  const pwd = $('newPassword').value;
  if (!pwd || pwd.length < 6) return toast('Пароль минимум 6 символов');
  try {
    await changePassword(pwd);
    $('newPassword').value = '';
    toast('Пароль изменён');
  } catch (e) {
    toast('Ошибка: ' + e.message);
  }
};

$('twofaToggle').onchange = async () => {
  const enabled = $('twofaToggle').checked;
  try {
    await toggle2FA(enabled);
    $('twofaStatus').textContent = enabled ? 'Вкл' : 'Выкл';
    toast(enabled ? '2FA включена' : '2FA выключена');
  } catch (e) {
    $('twofaToggle').checked = !enabled;
    toast('Ошибка');
  }
};

$('logoutBtn').onclick = logout;

// -- Search --
$('findUsersBtn').onclick = () => {
  const bar = $('searchBar');
  bar.style.display = bar.style.display === 'none' ? 'block' : 'none';
  if (bar.style.display === 'block') $('searchInput').focus();
};

$('searchInput').oninput = async () => {
  const q = $('searchInput').value.trim();
  const results = $('searchResults');
  if (q.length < 2) { results.innerHTML = ''; return; }
  const users = await searchUsers(q);
  results.innerHTML = users
    .filter(u => u.id !== currentUser.id)
    .map(u => `
      <div class="search-result-item" data-userid="${u.id}">
        <div class="avatar-small">${formatAvatarUrl(u.avatar_url) ? `<img src="${formatAvatarUrl(u.avatar_url)}">` : '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 22c0-6 4-10 8-10s8 4 8 10" fill="none" stroke="currentColor" stroke-width="2"/></svg>'}</div>
        <div>
          <div class="sr-name">${u.display_name}</div>
          <div class="sr-username">@${u.username}</div>
        </div>
      </div>
    `).join('');

  results.querySelectorAll('.search-result-item').forEach(el => {
    el.onclick = async () => {
      const uid = el.dataset.userid;
      const otherUser = await getUserByUsername(el.querySelector('.sr-username').textContent.slice(1));
      if (!otherUser) return;
      try {
        const chatId = await createOrGetDM(uid);
        $('searchBar').style.display = 'none';
        $('searchInput').value = '';
        $('searchResults').innerHTML = '';
        openChat(chatId);
      } catch (e) {
        toast('Ошибка создания чата');
      }
    };
  });
};

// -- Group creation --
$('createGroupBtn').onclick = () => {
  $('groupName').value = '';
  $('groupSearchInput').value = '';
  $('groupSearchResults').innerHTML = '';
  $('selectedMembers').innerHTML = '';
  showScreen('createGroup');
};

const selectedGroupMembers = new Set();

$('groupSearchInput').oninput = async () => {
  const q = $('groupSearchInput').value.trim();
  const results = $('groupSearchResults');
  if (q.length < 2) { results.innerHTML = ''; return; }
  const users = await searchUsers(q);
  results.innerHTML = users
    .filter(u => u.id !== currentUser.id && !selectedGroupMembers.has(u.id))
    .map(u => `
      <div class="search-result-item" data-userid="${u.id}">
        <div class="avatar-small">${formatAvatarUrl(u.avatar_url) ? `<img src="${formatAvatarUrl(u.avatar_url)}">` : '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 22c0-6 4-10 8-10s8 4 8 10" fill="none" stroke="currentColor" stroke-width="2"/></svg>'}</div>
        <div>
          <div class="sr-name">${u.display_name}</div>
          <div class="sr-username">@${u.username}</div>
        </div>
      </div>
    `).join('');

  results.querySelectorAll('.search-result-item').forEach(el => {
    el.onclick = () => {
      const uid = el.dataset.userid;
      const name = el.querySelector('.sr-name').textContent;
      if (selectedGroupMembers.has(uid)) return;
      selectedGroupMembers.add(uid);
      renderSelectedMembers();
      $('groupSearchInput').value = '';
      results.innerHTML = '';
    };
  });
};

function renderSelectedMembers() {
  const container = $('selectedMembers');
  container.innerHTML = Array.from(selectedGroupMembers).map(id => `
    <div class="member-tag" data-userid="${id}">
      <span>${id.slice(0, 8)}</span>
      <span class="remove-member" data-userid="${id}">&times;</span>
    </div>
  `).join('');
  container.querySelectorAll('.remove-member').forEach(el => {
    el.onclick = () => {
      selectedGroupMembers.delete(el.dataset.userid);
      renderSelectedMembers();
    };
  });
}

$('createGroupBtn2').onclick = async () => {
  const name = $('groupName').value.trim();
  if (!name) return toast('Введи название группы');
  if (selectedGroupMembers.size === 0) return toast('Добавь хотя бы одного участника');
  try {
    const chatId = await createGroup(name, Array.from(selectedGroupMembers));
    selectedGroupMembers.clear();
    toast('Группа создана!');
    showScreen('home');
    renderChatList();
    openChat(chatId);
  } catch (e) {
    toast('Ошибка: ' + e.message);
  }
};

// -- Chat UI --
$('chatSendBtn').onclick = async () => {
  const text = $('chatInput').value.trim();
  if (!text || !currentChatId) return;
  $('chatInput').value = '';
  try {
    await sendMessage(currentChatId, text);
  } catch (e) {
    toast('Ошибка отправки');
  }
};

$('chatInput').onkeydown = (e) => {
  if (e.key === 'Enter') $('chatSendBtn').click();
};

$('chatAttachBtn').onclick = () => $('chatFileInput').click();
$('chatFileInput').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file || !currentChatId) return;
  try {
    const { url, name } = await uploadFile(file);
    await sendMessage(currentChatId, null, url, name);
  } catch (e) {
    toast('Ошибка загрузки файла');
  }
  $('chatFileInput').value = '';
};

$('chatVoiceBtn').onclick = () => startCall(false);
$('chatVideoBtn').onclick = () => startCall(true);

// -- Call controls --
$('endCallBtn').onclick = endCall;

let micOn = true, camOn = true;

$('callMicBtn').onclick = () => {
  if (!localStream) return;
  const t = localStream.getAudioTracks()[0];
  if (t) {
    t.enabled = !t.enabled;
    micOn = t.enabled;
    $('callMicBtn').querySelector('svg').style.opacity = micOn ? '1' : '0.4';
  }
};

$('callCamBtn').onclick = () => {
  if (!localStream) return;
  const t = localStream.getVideoTracks()[0];
  if (t) {
    t.enabled = !t.enabled;
    camOn = t.enabled;
    $('callCamBtn').querySelector('svg').style.opacity = camOn ? '1' : '0.4';
  }
};
