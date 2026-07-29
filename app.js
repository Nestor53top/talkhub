/* TalkHub — P2P Messenger (localStorage + PeerJS) */

const $ = id => document.getElementById(id);

const DB = {
  _data: null,
  load() {
    try {
      this._data = JSON.parse(localStorage.getItem('th_data'));
      if (!this._data || typeof this._data !== 'object') throw 0;
    } catch {
      this._data = { users: {}, chats: [], messages: {} };
    }
    return this;
  },
  save() { localStorage.setItem('th_data', JSON.stringify(this._data)); },
  getUser(name) { return this._data.users[name] || null; },
  setUser(name, data) { this._data.users[name] = data; this.save(); },
  userExists(name) { return name in this._data.users; },
  allUsers() { return Object.values(this._data.users); },
  getChat(id) { return this._data.chats.find(c => c.id === id) || null; },
  addChat(chat) { this._data.chats.push(chat); this.save(); return chat; },
  userChats(username) { return this._data.chats.filter(c => c.members.includes(username)); },
  getMessages(chatId) { return this._data.messages[chatId] || []; },
  addMessage(chatId, msg) {
    if (!this._data.messages[chatId]) this._data.messages[chatId] = [];
    this._data.messages[chatId].push(msg);
    this.save();
  }
};

let peer = null;
let peerReady = false;
let peerQueue = [];
let localStream = null;
let call = null;
let currentUser = null;
let currentChatId = null;
let callTimerInterval = null;
let callStartTime = null;
let isGroupChat = false;
let remotePeerId = null;
let dataConns = {};
let currentChatName = '';

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.remove('active', 'fade-out');
    s.style.display = 'none';
  });
  const el = $(id);
  if (el) {
    el.style.display = 'flex';
    el.classList.remove('screenIn');
    void el.offsetWidth;
    el.classList.add('active');
  }
}

function toast(msg, duration = 2500) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => el.style.display = 'none', duration);
}

function timeStr(d) {
  const t = new Date(d);
  return String(t.getHours()).padStart(2,'0') + ':' + String(t.getMinutes()).padStart(2,'0');
}

function uid() { return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10); }

// -- Crypto --
function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;:,.<>?';
  const arr = new Uint8Array(256);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => chars[b % chars.length]).join('');
}

async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const saltBytes = salt ? Uint8Array.from(atob(salt), c => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(32));
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256);
  const hash = btoa(String.fromCharCode(...new Uint8Array(bits)));
  if (!salt) return { hash, salt: btoa(String.fromCharCode(...saltBytes)) };
  return { hash, salt };
}

async function encryptKey(key, password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
  );
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(key));
  return {
    salt: btoa(String.fromCharCode(...salt)),
    iv: btoa(String.fromCharCode(...iv)),
    data: btoa(String.fromCharCode(...new Uint8Array(encrypted)))
  };
}

async function decryptKey(encrypted, password) {
  const enc = new TextEncoder();
  const salt = Uint8Array.from(atob(encrypted.salt), c => c.charCodeAt(0));
  const iv = Uint8Array.from(atob(encrypted.iv), c => c.charCodeAt(0));
  const data = Uint8Array.from(atob(encrypted.data), c => c.charCodeAt(0));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
  );
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, data);
  return new TextDecoder().decode(decrypted);
}

// -- Auth --
async function registerUser(username, displayName, password) {
  DB.load();
  if (DB.userExists(username)) throw new Error('Username уже занят');
  const encKey = generateKey();
  const pwHash = await hashPassword(password);
  const enc = await encryptKey(encKey, password);
  DB.setUser(username, {
    username, display_name: displayName,
    password_hash: pwHash.hash, pw_salt: pwHash.salt,
    enc_salt: enc.salt, enc_iv: enc.iv, encrypted_key: enc.data
  });
  localStorage.setItem('th_reg_enc_key', encKey);
  localStorage.setItem('th_reg_username', username);
  localStorage.setItem('th_reg_display_name', displayName);
  return encKey;
}

async function loginUser(username, password) {
  DB.load();
  const user = DB.getUser(username);
  if (!user) throw new Error('Пользователь не найден');
  const pwHash = await hashPassword(password, user.pw_salt);
  if (pwHash.hash !== user.password_hash) throw new Error('Неверный пароль');
  const encKey = await decryptKey({
    salt: user.enc_salt, iv: user.enc_iv, data: user.encrypted_key
  }, password);
  localStorage.setItem('th_session_key', encKey);
  localStorage.setItem('th_session_user', username);
  currentUser = { id: username, username, display_name: user.display_name };
  return encKey;
}

async function logout() {
  if (peer) { peer.destroy(); peer = null; }
  peerReady = false;
  peerQueue = [];
  dataConns = {};
  localStorage.removeItem('th_session_key');
  localStorage.removeItem('th_session_user');
  currentUser = null;
  currentChatId = null;
  showScreen('landing');
}

// -- Profile --
async function loadProfile() {
  const username = localStorage.getItem('th_session_user');
  if (!username) { showScreen('landing'); return null; }
  DB.load();
  const user = DB.getUser(username);
  if (user) currentUser = { id: user.username, username: user.username, display_name: user.display_name };
  return user;
}

async function updateDisplayName(name) {
  DB.load();
  const user = DB.getUser(currentUser.id);
  if (user) { user.display_name = name; DB.save(); }
  currentUser.display_name = name;
}

async function changePassword(newPassword) {
  const pwHash = await hashPassword(newPassword);
  const sessionKey = localStorage.getItem('th_session_key');
  if (!sessionKey) throw new Error('Нет ключа сессии');
  const enc = await encryptKey(sessionKey, newPassword);
  DB.load();
  const user = DB.getUser(currentUser.id);
  if (!user) throw new Error('Пользователь не найден');
  Object.assign(user, {
    password_hash: pwHash.hash, pw_salt: pwHash.salt,
    enc_salt: enc.salt, enc_iv: enc.iv, encrypted_key: enc.data
  });
  DB.save();
}

// -- Search --
function searchUsers(query) {
  if (!query || query.length < 2) return [];
  DB.load();
  const q = query.toLowerCase();
  return DB.allUsers()
    .filter(u => u.username.startsWith(q))
    .slice(0, 10)
    .map(u => ({ id: u.username, username: u.username, display_name: u.display_name }));
}

function getUserByUsername(username) {
  DB.load();
  const u = DB.getUser(username);
  return u ? { id: u.username, username: u.username, display_name: u.display_name } : null;
}

// -- Chats --
function loadChatList() {
  DB.load();
  const chats = DB.userChats(currentUser.id);
  const result = chats.map(chat => {
    const msgs = DB.getMessages(chat.id);
    const lastMsg = msgs[msgs.length - 1];
    let name = chat.name;
    if (chat.type === 'dm') {
      const otherId = chat.members.find(m => m !== currentUser.id);
      if (otherId) { const u = DB.getUser(otherId); if (u) name = u.display_name; }
    }
    return { ...chat, display_name: name, last_message: lastMsg?.content || (lastMsg?.file_url ? 'Файл' : ''), last_time: lastMsg?.created_at || chat.created_at };
  });
  result.sort((a, b) => new Date(b.last_time) - new Date(a.last_time));
  return result;
}

function createOrGetDM(otherUserId) {
  DB.load();
  const myChats = DB.userChats(currentUser.id);
  for (const chat of myChats) {
    if (chat.type === 'dm' && chat.members.includes(otherUserId)) return chat.id;
  }
  const chat = { id: uid(), type: 'dm', name: null, created_at: new Date().toISOString(), members: [currentUser.id, otherUserId] };
  DB.addChat(chat);
  // Notify the other user about new chat
  sendP2P({ type: 'new_chat', chat }, otherUserId);
  return chat.id;
}

async function createGroup(name, memberIds) {
  DB.load();
  const allMembers = [...new Set([currentUser.id, ...memberIds])];
  const chat = { id: uid(), type: 'group', name, created_at: new Date().toISOString(), members: allMembers };
  DB.addChat(chat);
  for (const mid of allMembers) {
    if (mid !== currentUser.id) sendP2P({ type: 'new_chat', chat }, mid);
  }
  return chat.id;
}

function getChatInfo(chatId) { DB.load(); return DB.getChat(chatId); }
function getChatMembers(chatId) { DB.load(); const c = DB.getChat(chatId); return c?.members || []; }

// -- Messages --
function loadMessages(chatId) { DB.load(); return DB.getMessages(chatId); }
function getMessageSender(senderId) { DB.load(); const u = DB.getUser(senderId); return u ? { display_name: u.display_name } : null; }

async function sendMessage(chatId, content, fileUrl = null, fileName = null) {
  DB.load();
  const msg = { id: uid(), chat_id: chatId, sender_id: currentUser.id, content, file_url: fileUrl, file_name: fileName, created_at: new Date().toISOString() };
  DB.addMessage(chatId, msg);
  const chat = DB.getChat(chatId);
  if (chat) {
    for (const memberId of chat.members) {
      if (memberId !== currentUser.id) sendP2P({ type: 'message', msg }, memberId);
    }
  }
  return msg;
}

// -- P2P via PeerJS --
function getPeerId(username) { return 'th_' + username; }

function sendP2P(packet, targetUsername) {
  if (!peer || !peerReady) {
    peerQueue.push({ packet, targetUsername });
    return;
  }
  const targetPeerId = getPeerId(targetUsername);
  let conn = dataConns[targetUsername];
  if (conn && conn.open) { conn.send(packet); return; }
  try {
    conn = peer.connect(targetPeerId, { reliable: true });
    conn.on('open', () => {
      dataConns[targetUsername] = conn;
      conn.send(packet);
    });
    conn.on('error', () => {});
  } catch {}
}

function handleP2PData(data, fromUsername) {
  if (data.type === 'new_chat') {
    DB.load();
    if (!DB.getChat(data.chat.id)) {
      DB.addChat(data.chat);
      toast('Новый чат с ' + (data.chat.members.find(m => m !== fromUsername) || ''));
      renderChatList();
    }
  } else if (data.type === 'message') {
    DB.load();
    const msg = data.msg;
    // Auto-create chat if it doesn't exist (for DM)
    if (!DB.getChat(msg.chat_id)) {
      DB.addChat({ id: msg.chat_id, type: 'dm', name: null, created_at: msg.created_at, members: [fromUsername, currentUser.id] });
      toast('Новое сообщение от ' + fromUsername);
      renderChatList();
    }
    DB.addMessage(msg.chat_id, msg);
    if (currentChatId === msg.chat_id) {
      const sender = getMessageSender(msg.sender_id);
      renderMessage(msg, sender, false);
    }
  }
}

function initPeer(username) {
  if (peer) { peer.destroy(); peer = null; }
  peerReady = false;
  dataConns = {};
  const peerId = getPeerId(username);
  peer = new Peer(peerId, {
    config: { iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]}
  });
  peer.on('open', () => {
    peerReady = true;
    // Flush queue
    const q = peerQueue.slice();
    peerQueue = [];
    for (const item of q) sendP2P(item.packet, item.targetUsername);
  });
  peer.on('connection', (conn) => {
    const fromUsername = conn.peer.startsWith('th_') ? conn.peer.slice(3) : conn.peer;
    dataConns[fromUsername] = conn;
    conn.on('data', (data) => handleP2PData(data, fromUsername));
    conn.on('close', () => { delete dataConns[fromUsername]; });
  });
  peer.on('call', async (incomingCall) => {
    const fromId = incomingCall.peer.startsWith('th_') ? incomingCall.peer.slice(3) : incomingCall.peer;
    const u = getUserByUsername(fromId);
    const name = u?.display_name || fromId;
    if (confirm('Входящий звонок от ' + name + '. Ответить?')) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        $('localVideo').srcObject = localStream;
        $('callOverlay').style.display = 'flex';
        stopTimer();
        incomingCall.answer(localStream);
        call = incomingCall;
        call.on('stream', (rs) => { $('remoteVideo').srcObject = rs; startTimer(); });
        call.on('close', endCall); call.on('error', endCall);
      } catch { incomingCall.close(); toast('Доступ к камере/микрофону запрещён'); }
    } else incomingCall.close();
  });
  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') toast('PeerJS: ID ' + peerId + ' уже занят');
  });
}

// -- Render message --
function renderMessage(msg, sender, isMine) {
  const el = document.createElement('div');
  el.className = `message ${isMine ? 'mine' : 'theirs'}`;
  if (!isMine && isGroupChat && sender) {
    const n = document.createElement('div'); n.className = 'msg-name'; n.textContent = sender.display_name; el.appendChild(n);
  }
  if (msg.file_url && msg.file_name?.match(/\.(jpg|jpeg|png|gif|webp|bmp)$/i)) {
    const img = document.createElement('img');
    img.src = msg.file_url;
    img.onclick = () => { const v = document.createElement('div'); v.className = 'img-viewer'; v.onclick = () => v.remove(); const i = document.createElement('img'); i.src = msg.file_url; v.appendChild(i); document.body.appendChild(v); };
    el.appendChild(img);
  } else if (msg.file_url) {
    const a = document.createElement('a'); a.href = msg.file_url; a.download = msg.file_name || 'file'; a.className = 'file-link';
    a.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M14 2v6h6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg> ' + (msg.file_name || 'Файл');
    el.appendChild(a);
  }
  if (msg.content) { const t = document.createElement('div'); t.textContent = msg.content; el.appendChild(t); }
  const time = document.createElement('div'); time.className = 'msg-time'; time.textContent = timeStr(msg.created_at); el.appendChild(time);
  $('chatMessages').appendChild(el);
  $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
}

// -- Open chat --
async function openChat(chatId) {
  currentChatId = chatId; isGroupChat = false;
  const chat = getChatInfo(chatId);
  isGroupChat = chat?.type === 'group';
  const members = getChatMembers(chatId);
  const otherId = members.find(id => id !== currentUser.id);
  let chatName = chat?.name || 'Чат';
  if (chat?.type === 'dm' && otherId) {
    const other = getUserByUsername(otherId);
    if (other) chatName = other.display_name;
    remotePeerId = otherId;
  }
  currentChatName = chatName;
  $('chatScreenName').textContent = chatName;
  $('chatMessages').innerHTML = '';
  showScreen('chat');
  const msgs = loadMessages(chatId);
  for (const msg of msgs) {
    const sender = getMessageSender(msg.sender_id);
    renderMessage(msg, sender, msg.sender_id === currentUser.id);
  }
}

// -- Render chat list --
async function renderChatList() {
  const container = $('chatList');
  const empty = $('emptyChats');
  const chats = loadChatList();
  container.querySelectorAll('.chat-list-item').forEach(el => el.remove());
  if (chats.length === 0) { empty.style.display = 'flex'; return; }
  empty.style.display = 'none';
  for (const chat of chats) {
    const item = document.createElement('div'); item.className = 'chat-list-item'; item.dataset.chatId = chat.id;
    item.innerHTML = `
      <div class="cli-avatar"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="2"/></svg></div>
      <div class="cli-info"><div class="cli-name">${chat.display_name || chat.name || 'Без имени'}</div><div class="cli-preview">${chat.last_message || ''}</div></div>
      <div class="cli-time">${chat.last_time ? timeStr(chat.last_time) : ''}</div>`;
    item.onclick = () => openChat(chat.id);
    container.appendChild(item);
  }
}

// -- Calls --
function startCall(isVideo) {
  if (!peer || !remotePeerId) return toast('Нет собеседника для звонка');
  if (call) return toast('Уже в звонке');
  const targetPeerId = getPeerId(remotePeerId);
  navigator.mediaDevices.getUserMedia({ audio: true, video: isVideo })
    .then(stream => {
      localStream = stream; $('localVideo').srcObject = stream; $('callOverlay').style.display = 'flex'; stopTimer();
      call = peer.call(targetPeerId, stream);
      call.on('stream', (rs) => { $('remoteVideo').srcObject = rs; startTimer(); });
      call.on('close', endCall); call.on('error', endCall);
    }).catch(() => toast('Доступ к камере/микрофону запрещён'));
}

function endCall() {
  stopTimer();
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (call) { call.close(); call = null; }
  $('localVideo').srcObject = null; $('remoteVideo').srcObject = null; $('callOverlay').style.display = 'none';
}

function startTimer() {
  callStartTime = Date.now(); clearInterval(callTimerInterval);
  callTimerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - callStartTime) / 1000);
    $('callTimer').textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }, 1000);
}

function stopTimer() { clearInterval(callTimerInterval); callTimerInterval = null; callStartTime = null; $('callTimer').textContent = '00:00'; }

// -- Navigation --
$('goLoginBtn').onclick = () => showScreen('login');
$('goRegisterBtn').onclick = () => showScreen('register1');
$('backFromLoginBtn').onclick = () => showScreen('landing');
$('backFromRegister1Btn').onclick = () => showScreen('landing');
$('backFromProfileBtn').onclick = () => showScreen('home');
$('backFromChatBtn').onclick = () => { showScreen('home'); renderChatList(); };
$('backFromGroupBtn').onclick = () => showScreen('home');

// -- Auth UI --
let pendingEncKey = '';

$('register1Btn').onclick = async () => {
  const username = $('regUsername').value.trim().toLowerCase();
  const displayName = $('regDisplayName').value.trim();
  const password = $('regPassword').value;
  if (!username || !displayName || !password) return $('reg1Error').textContent = 'Заполни все поля';
  if (username.length < 3) return $('reg1Error').textContent = 'Username минимум 3 символа';
  if (password.length < 6) return $('reg1Error').textContent = 'Пароль минимум 6 символов';
  $('reg1Error').textContent = '';
  try {
    pendingEncKey = await registerUser(username, displayName, password);
    $('encryptionKeyDisplay').textContent = pendingEncKey;
    showScreen('register2');
  } catch (e) { $('reg1Error').textContent = e.message; }
};

$('copyKeyBtn').onclick = () => {
  if (navigator.clipboard) navigator.clipboard.writeText(pendingEncKey).then(() => toast('Ключ скопирован'));
  else { $('encryptionKeyDisplay').select(); document.execCommand('copy'); toast('Ключ скопирован'); }
};

$('keyNextBtn').onclick = async () => {
  if (!pendingEncKey) return toast('Ошибка: ключ не найден');
  const username = localStorage.getItem('th_reg_username');
  const encKey = localStorage.getItem('th_reg_enc_key');
  localStorage.setItem('th_session_key', encKey);
  localStorage.setItem('th_session_user', username);
  localStorage.removeItem('th_reg_enc_key');
  localStorage.removeItem('th_reg_username');
  localStorage.removeItem('th_reg_display_name');
  currentUser = { id: username, username, display_name: username };
  toast('Аккаунт создан!');
  showScreen('home');
  renderChatList();
  initPeer(username);
};

// Login
$('loginBtn').onclick = async () => {
  const username = $('loginUsername').value.trim().toLowerCase();
  const password = $('loginPassword').value;
  if (!username || !password) return $('loginError').textContent = 'Введите username и пароль';
  $('loginError').textContent = '';
  try {
    await loginUser(username, password);
    await loadProfile();
    showScreen('home');
    renderChatList();
    initPeer(username);
  } catch (e) { $('loginError').textContent = e.message; }
};

// Auto-login
(async () => {
  try {
    DB.load();
    const u = localStorage.getItem('th_session_user');
    const k = localStorage.getItem('th_session_key');
    if (u && k && DB.getUser(u)) { await loadProfile(); showScreen('home'); renderChatList(); initPeer(u); return; }
  } catch {}
  showScreen('landing');
})();

// -- Profile --
$('profileBtn').onclick = () => { if (!currentUser) return; $('profileUsername').textContent = '@' + currentUser.username; $('profileDisplayName').value = currentUser.display_name || ''; showScreen('profile'); };
$('showKeyBtn').onclick = () => { const key = localStorage.getItem('th_session_key'); if (!key) return toast('Ключ не найден'); toast('Ключ: ' + key.slice(0,20) + '...'); };
$('saveDisplayNameBtn').onclick = async () => { const n = $('profileDisplayName').value.trim(); if (!n) return toast('Пусто'); try { await updateDisplayName(n); toast('Сохранено'); } catch { toast('Ошибка'); } };
$('changePasswordBtn').onclick = async () => { const p = $('newPassword').value; if (!p || p.length<6) return toast('Мин 6 символов'); try { await changePassword(p); $('newPassword').value=''; toast('Пароль изменён'); } catch { toast('Ошибка'); } };
$('logoutBtn').onclick = logout;

// -- Search --
$('findUsersBtn').onclick = () => { const b = $('searchBar'); b.style.display = b.style.display === 'none' ? 'block' : 'none'; if (b.style.display === 'block') $('searchInput').focus(); };
$('searchInput').oninput = () => {
  const q = $('searchInput').value.trim(); const results = $('searchResults');
  if (q.length < 2) { results.innerHTML = ''; return; }
  const users = searchUsers(q).filter(u => u.id !== currentUser.id);
  results.innerHTML = users.map(u => `<div class="search-result-item" data-userid="${u.id}"><div class="avatar-small"><svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 22c0-6 4-10 8-10s8 4 8 10" fill="none" stroke="currentColor" stroke-width="2"/></svg></div><div><div class="sr-name">${u.display_name}</div><div class="sr-username">@${u.username}</div></div></div>`).join('');
  results.querySelectorAll('.search-result-item').forEach(el => {
    el.onclick = () => {
      const uid = el.dataset.userid;
      if (!getUserByUsername(uid)) return;
      try { const chatId = createOrGetDM(uid); $('searchBar').style.display = 'none'; $('searchInput').value = ''; $('searchResults').innerHTML = ''; openChat(chatId); } catch { toast('Ошибка'); }
    };
  });
};

// -- Groups --
$('createGroupBtn').onclick = () => { $('groupName').value = ''; $('groupSearchInput').value = ''; $('groupSearchResults').innerHTML = ''; $('selectedMembers').innerHTML = ''; selectedGroupMembers.clear(); showScreen('createGroup'); };
const selectedGroupMembers = new Set();
$('groupSearchInput').oninput = () => {
  const q = $('groupSearchInput').value.trim(); const results = $('groupSearchResults');
  if (q.length < 2) { results.innerHTML = ''; return; }
  const users = searchUsers(q).filter(u => u.id !== currentUser.id && !selectedGroupMembers.has(u.id));
  results.innerHTML = users.map(u => `<div class="search-result-item" data-userid="${u.id}"><div class="avatar-small"><svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 22c0-6 4-10 8-10s8 4 8 10" fill="none" stroke="currentColor" stroke-width="2"/></svg></div><div><div class="sr-name">${u.display_name}</div><div class="sr-username">@${u.username}</div></div></div>`).join('');
  results.querySelectorAll('.search-result-item').forEach(el => { el.onclick = () => { const uid = el.dataset.userid; if (selectedGroupMembers.has(uid)) return; selectedGroupMembers.add(uid); renderSelectedMembers(); $('groupSearchInput').value = ''; results.innerHTML = ''; }; });
};
function renderSelectedMembers() {
  const container = $('selectedMembers');
  container.innerHTML = Array.from(selectedGroupMembers).map(id => `<div class="member-tag" data-userid="${id}"><span>${id.slice(0,8)}</span><span class="remove-member" data-userid="${id}">&times;</span></div>`).join('');
  container.querySelectorAll('.remove-member').forEach(el => { el.onclick = () => { selectedGroupMembers.delete(el.dataset.userid); renderSelectedMembers(); }; });
}
$('createGroupBtn2').onclick = async () => {
  const name = $('groupName').value.trim(); if (!name) return toast('Введи название'); if (selectedGroupMembers.size === 0) return toast('Добавь участников');
  try {
    const chatId = await createGroup(name, Array.from(selectedGroupMembers));
    selectedGroupMembers.clear(); toast('Группа создана!'); showScreen('home'); renderChatList(); openChat(chatId);
  } catch (e) { toast('Ошибка: ' + e.message); }
};

// -- Chat UI --
$('chatSendBtn').onclick = async () => {
  const text = $('chatInput').value.trim(); if (!text || !currentChatId) return;
  $('chatInput').value = '';
  try {
    const msg = await sendMessage(currentChatId, text);
    const sender = getMessageSender(msg.sender_id);
    renderMessage(msg, sender, true);
  } catch { toast('Ошибка'); }
};
$('chatInput').onkeydown = (e) => { if (e.key === 'Enter') $('chatSendBtn').click(); };
$('chatAttachBtn').onclick = () => $('chatFileInput').click();
$('chatFileInput').onchange = (e) => {
  const file = e.target.files[0]; if (!file || !currentChatId) return;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      const msg = await sendMessage(currentChatId, null, ev.target.result, file.name);
      const sender = getMessageSender(msg.sender_id);
      renderMessage(msg, sender, true);
    } catch { toast('Ошибка'); }
  };
  reader.readAsDataURL(file); $('chatFileInput').value = '';
};
$('chatVoiceBtn').onclick = () => startCall(false);
$('chatVideoBtn').onclick = () => startCall(true);

// -- Call controls --
$('endCallBtn').onclick = endCall;
let micOn = true, camOn = true;
$('callMicBtn').onclick = () => { if (!localStream) return; const t = localStream.getAudioTracks()[0]; if (t) { t.enabled = !t.enabled; micOn = t.enabled; $('callMicBtn').querySelector('svg').style.opacity = micOn ? '1' : '0.4'; } };
$('callCamBtn').onclick = () => { if (!localStream) return; const t = localStream.getVideoTracks()[0]; if (t) { t.enabled = !t.enabled; camOn = t.enabled; $('callCamBtn').querySelector('svg').style.opacity = camOn ? '1' : '0.4'; } };
