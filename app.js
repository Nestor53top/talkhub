/* TalkHub — Full Messenger (localStorage + PeerJS) */

const $ = id => document.getElementById(id);
const RS = id => document.querySelectorAll(id);

const DB = {
  _data: null,
  _changed: false,
  load() {
    try {
      this._data = JSON.parse(localStorage.getItem('th_data'));
      if (!this._data || typeof this._data !== 'object') throw 0;
    } catch {
      this._data = { users: {}, chats: [], messages: {}, peer_id: '' };
    }
    return this;
  },
  save() {
    localStorage.setItem('th_data', JSON.stringify(this._data));
    this._changed = false;
  },
  _mark() { this._changed = true; },
  // Users
  getUser(name) { return this._data.users[name] || null; },
  setUser(name, data) { this._data.users[name] = data; this._mark(); },
  userExists(name) { return name in this._data.users; },
  allUsers() { return Object.values(this._data.users); },
  // Chats
  getChat(id) { return this._data.chats.find(c => c.id === id) || null; },
  addChat(chat) { this._data.chats.push(chat); this._mark(); return chat; },
  updateChat(id, data) { const i = this._data.chats.findIndex(c => c.id === id); if (i >= 0) { Object.assign(this._data.chats[i], data); this._mark(); } },
  userChats(username) { return this._data.chats.filter(c => c.members.includes(username)); },
  // Messages
  getMessages(chatId) { return this._data.messages[chatId] || []; },
  addMessage(chatId, msg) {
    if (!this._data.messages[chatId]) this._data.messages[chatId] = [];
    this._data.messages[chatId].push(msg);
    this._mark();
  }
};

let peer = null;
let localStream = null;
let call = null;
let currentUser = null;
let currentChatId = null;
let callTimerInterval = null;
let callStartTime = null;
let isGroupChat = false;
let remotePeerId = null;
let peerInitAttempted = false;

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

async function hashAnswer(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.toLowerCase().trim()));
  return btoa(String.fromCharCode(...new Uint8Array(hash)));
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

const QUESTIONS = [
  'Имя вашего отца?',
  'Отчество вашей матери?',
  'Город вашего рождения?',
  'Кличка вашего первого питомца?',
  'Название вашей первой школы?'
];

async function registerUser(username, displayName, password) {
  DB.load();
  if (DB.userExists(username)) throw new Error('Username уже занят');

  const encKey = generateKey();
  const pwHash = await hashPassword(password);
  const enc = await encryptKey(encKey, password);

  DB.setUser(username, {
    username,
    display_name: displayName,
    password_hash: pwHash.hash,
    pw_salt: pwHash.salt,
    enc_salt: enc.salt,
    enc_iv: enc.iv,
    encrypted_key: enc.data,
    questions: null,
    rec_salt: null,
    rec_iv: null,
    recovery_key: null
  });
  DB.save();

  // Store temp registration data
  localStorage.setItem('th_reg_enc_key', encKey);
  localStorage.setItem('th_reg_username', username);
  localStorage.setItem('th_reg_display_name', displayName);
  localStorage.setItem('th_reg_password', password);
  return encKey;
}

async function saveQuestions(username, answers) {
  DB.load();
  const user = DB.getUser(username);
  if (!user) throw new Error('Пользователь не найден');

  const hashed = [];
  for (let i = 0; i < QUESTIONS.length; i++) {
    hashed.push({ q: QUESTIONS[i], a: await hashAnswer(answers[i] || '') });
  }

  const encKey = localStorage.getItem('th_reg_enc_key');
  const recoveryPass = answers.join('|').toLowerCase().trim();
  const recSalt = crypto.getRandomValues(new Uint8Array(32));
  const recIv = crypto.getRandomValues(new Uint8Array(12));
  const recKeyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(recoveryPass), 'PBKDF2', false, ['deriveKey']);
  const recAesKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: recSalt, iterations: 100000, hash: 'SHA-256' },
    recKeyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt']
  );
  const recEncrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: recIv }, recAesKey, new TextEncoder().encode(encKey)
  );

  user.questions = JSON.stringify(hashed);
  user.rec_salt = btoa(String.fromCharCode(...recSalt));
  user.rec_iv = btoa(String.fromCharCode(...recIv));
  user.recovery_key = btoa(String.fromCharCode(...new Uint8Array(recEncrypted)));
  DB.save();
}

async function loginUser(username, password) {
  DB.load();
  const user = DB.getUser(username);
  if (!user) throw new Error('Пользователь не найден');

  const pwHash = await hashPassword(password, user.pw_salt);
  if (pwHash.hash !== user.password_hash) throw new Error('Неверный пароль');

  const encKey = await decryptKey({
    salt: user.enc_salt,
    iv: user.enc_iv,
    data: user.encrypted_key
  }, password);

  localStorage.setItem('th_session_key', encKey);
  localStorage.setItem('th_session_user', username);
  currentUser = { id: username, username, display_name: user.display_name, avatar_url: null };
  return encKey;
}

async function loadUserForRecovery(username) {
  DB.load();
  const user = DB.getUser(username);
  if (!user) throw new Error('Пользователь не найден');
  let questions;
  try { questions = typeof user.questions === 'string' ? JSON.parse(user.questions) : user.questions; } catch { questions = []; }
  if (!questions || questions.length === 0) throw new Error('Вопросы безопасности не найдены');
  return { username: user.username, display_name: user.display_name, questions };
}

async function recoverKey(username, answers) {
  DB.load();
  const user = DB.getUser(username);
  if (!user) throw new Error('Пользователь не найден');

  let questions;
  try { questions = typeof user.questions === 'string' ? JSON.parse(user.questions) : user.questions; } catch { questions = []; }
  if (!questions || questions.length === 0) throw new Error('Вопросы не найдены');
  if (!user.recovery_key) throw new Error('Ключ восстановления не найден');

  let correct = 0;
  for (let i = 0; i < Math.min(questions.length, answers.length); i++) {
    const hash = await hashAnswer(answers[i] || '');
    if (hash === questions[i].a) correct++;
  }
  if (correct < 3) throw new Error(`Правильных ответов: ${correct} из 5. Нужно минимум 3.`);

  const recoveryPass = answers.join('|').toLowerCase().trim();
  const recSalt = Uint8Array.from(atob(user.rec_salt), c => c.charCodeAt(0));
  const recIv = Uint8Array.from(atob(user.rec_iv), c => c.charCodeAt(0));
  const recData = Uint8Array.from(atob(user.recovery_key), c => c.charCodeAt(0));
  const recKeyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(recoveryPass), 'PBKDF2', false, ['deriveKey']);
  const recAesKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: recSalt, iterations: 100000, hash: 'SHA-256' },
    recKeyMaterial, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
  );
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: recIv }, recAesKey, recData);
  return new TextDecoder().decode(decrypted);
}

async function logout() {
  peer?.destroy();
  peer = null;
  peerInitAttempted = false;
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
  if (user) {
    currentUser = { id: user.username, username: user.username, display_name: user.display_name, avatar_url: null };
  }
  return user;
}

async function updateDisplayName(name) {
  DB.load();
  const user = DB.getUser(currentUser.id);
  if (user) {
    user.display_name = name;
    DB.save();
  }
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
  user.password_hash = pwHash.hash;
  user.pw_salt = pwHash.salt;
  user.enc_salt = enc.salt;
  user.enc_iv = enc.iv;
  user.encrypted_key = enc.data;
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
    .map(u => ({ id: u.username, username: u.username, display_name: u.display_name, avatar_url: null }));
}

function getUserByUsername(username) {
  DB.load();
  const user = DB.getUser(username);
  if (!user) return null;
  return { id: user.username, username: user.username, display_name: user.display_name, avatar_url: null };
}

// -- Chats --
function loadChatList() {
  DB.load();
  const memberships = DB.userChats(currentUser.id);

  const result = memberships.map(chat => {
    const msgs = DB.getMessages(chat.id);
    const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;

    let name = chat.name;
    if (chat.type === 'dm') {
      const otherId = chat.members.find(m => m !== currentUser.id);
      if (otherId) {
        const other = DB.getUser(otherId);
        if (other) name = other.display_name;
      }
    }

    return {
      ...chat,
      display_name: name,
      avatar_url: null,
      last_message: lastMsg?.content || (lastMsg?.file_url ? 'Файл' : ''),
      last_time: lastMsg?.created_at || chat.created_at
    };
  });

  result.sort((a, b) => new Date(b.last_time) - new Date(a.last_time));
  return result;
}

async function createOrGetDM(otherUserId) {
  DB.load();
  const myChats = DB.userChats(currentUser.id);
  for (const chat of myChats) {
    if (chat.type === 'dm' && chat.members.includes(otherUserId)) {
      return chat.id;
    }
  }

  const chat = {
    id: uid(),
    type: 'dm',
    name: null,
    created_at: new Date().toISOString(),
    members: [currentUser.id, otherUserId]
  };
  DB.addChat(chat);
  DB.save();
  return chat.id;
}

async function createGroup(name, memberIds) {
  DB.load();
  const allMembers = [...new Set([currentUser.id, ...memberIds])];
  const chat = {
    id: uid(),
    type: 'group',
    name,
    created_at: new Date().toISOString(),
    members: allMembers
  };
  DB.addChat(chat);
  DB.save();
  return chat.id;
}

function getChatInfo(chatId) {
  DB.load();
  return DB.getChat(chatId);
}

function getChatMembers(chatId) {
  DB.load();
  const chat = DB.getChat(chatId);
  return chat?.members || [];
}

// -- Messages --
function loadMessages(chatId) {
  DB.load();
  return DB.getMessages(chatId);
}

function getMessageSender(senderId) {
  DB.load();
  const user = DB.getUser(senderId);
  return user ? { display_name: user.display_name, avatar_url: null } : null;
}

async function sendMessage(chatId, content, fileUrl = null, fileName = null) {
  DB.load();
  const msg = {
    id: uid(),
    chat_id: chatId,
    sender_id: currentUser.id,
    content,
    file_url: fileUrl,
    file_name: fileName,
    created_at: new Date().toISOString()
  };
  DB.addMessage(chatId, msg);
  DB.save();
  // Broadcast via PeerJS if recipient is online
  const chat = DB.getChat(chatId);
  if (chat) {
    for (const memberId of chat.members) {
      if (memberId !== currentUser.id) {
        broadcastMessage(memberId, msg);
      }
    }
  }
  return msg;
}

// -- PeerJS messaging --
function getPeerId(username) {
  return 'th_' + username.slice(0, 12);
}

let dataConns = {};

function broadcastMessage(targetUsername, msg) {
  if (!peer || !peer.open) return;
  const targetPeerId = getPeerId(targetUsername);
  try {
    let conn = dataConns[targetUsername];
    if (conn && conn.open) {
      conn.send({ type: 'message', data: msg });
      return;
    }
    conn = peer.connect(targetPeerId, { reliable: true });
    conn.on('open', () => {
      dataConns[targetUsername] = conn;
      conn.send({ type: 'message', data: msg });
    });
    conn.on('error', () => {});
  } catch {}
}

function setupPeerDataListener() {
  if (!peer) return;
  peer.on('connection', (conn) => {
    const username = conn.peer.replace('th_', '');
    dataConns[username] = conn;
    conn.on('data', (data) => {
      if (data.type === 'message') {
        handleIncomingMessage(data.data);
      }
    });
    conn.on('close', () => { delete dataConns[username]; });
  });
}

function handleIncomingMessage(msg) {
  // Re-save to DB
  DB.load();
  DB.addMessage(msg.chat_id, msg);
  DB.save();
  // If current chat is open, render
  if (currentChatId === msg.chat_id) {
    const sender = getMessageSender(msg.sender_id);
    const isMine = false;
    renderMessage(msg, sender, isMine);
  }
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

  const chat = getChatInfo(chatId);
  isGroupChat = chat?.type === 'group';

  const members = getChatMembers(chatId);
  const otherId = members.find(id => id !== currentUser.id);

  let chatName = chat?.name || 'Чат';
  let avatarUrl = null;

  if (chat?.type === 'dm' && otherId) {
    const other = getUserByUsername(otherId);
    if (other) {
      chatName = other.display_name;
      remotePeerId = otherId;
    }
  }

  $('chatScreenName').textContent = chatName;

  $('chatMessages').innerHTML = '';
  showScreen('chat');

  // Load existing messages
  const msgs = loadMessages(chatId);
  for (const msg of msgs) {
    const sender = getMessageSender(msg.sender_id);
    const isMine = msg.sender_id === currentUser.id;
    renderMessage(msg, sender, isMine);
  }
}

// -- Render chat list --
async function renderChatList() {
  const container = $('chatList');
  const empty = $('emptyChats');
  const chats = loadChatList();

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
async function initPeer(username) {
  if (peerInitAttempted) return;
  peerInitAttempted = true;
  if (peer) { peer.destroy(); peer = null; }

  const peerId = getPeerId(username);
  peer = new Peer(peerId, {
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    }
  });

  peer.on('open', () => {
    setupPeerDataListener();
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
      } catch {
        incomingCall.close();
        toast('Доступ к камере/микрофону запрещён');
      }
    } else {
      incomingCall.close();
    }
  });

  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') {
      toast('Ошибка PeerJS: ID занят. Возможно, ты уже онлайн на другом устройстве.');
    }
  });
}

function startCall(isVideo) {
  if (!peer || !remotePeerId) return toast('Нет собеседника для звонка');
  if (call) return toast('Уже в звонке');
  // Derive full peer ID for remote
  const targetPeerId = getPeerId(remotePeerId);
  navigator.mediaDevices.getUserMedia({ audio: true, video: isVideo })
    .then(stream => {
      localStream = stream;
      $('localVideo').srcObject = stream;
      $('callOverlay').style.display = 'flex';
      stopTimer();
      call = peer.call(targetPeerId, stream);
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
$('goRegisterBtn').onclick = () => showScreen('register1');
$('backFromLoginBtn').onclick = () => showScreen('landing');
$('backFromRegister1Btn').onclick = () => showScreen('landing');
$('backFromProfileBtn').onclick = () => showScreen('home');
$('backFromChatBtn').onclick = () => { showScreen('home'); renderChatList(); };
$('backFromGroupBtn').onclick = () => showScreen('home');
$('backFromRecover1Btn').onclick = () => showScreen('login');
$('backFromRecover2Btn').onclick = () => showScreen('recover1');
$('backFromRecover3Btn').onclick = () => showScreen('login');
$('goToLoginFromRecoverBtn').onclick = () => showScreen('login');
$('forgotKeyBtn').onclick = () => showScreen('recover1');

// -- Auth UI --

let pendingEncKey = '';

$('register1Btn').onclick = async () => {
  const username = $('regUsername').value.trim().toLowerCase();
  const displayName = $('regDisplayName').value.trim();
  const password = $('regPassword').value;
  if (!username || !displayName || !password)
    return $('reg1Error').textContent = 'Заполни все поля';
  if (username.length < 3) return $('reg1Error').textContent = 'Username минимум 3 символа';
  if (password.length < 6) return $('reg1Error').textContent = 'Пароль минимум 6 символов';
  $('reg1Error').textContent = '';
  try {
    const encKey = await registerUser(username, displayName, password);
    pendingEncKey = encKey;
    $('encryptionKeyDisplay').textContent = encKey;
    showScreen('register2');
  } catch (e) {
    $('reg1Error').textContent = e.message;
  }
};

$('copyKeyBtn').onclick = () => {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(pendingEncKey).then(() => toast('Ключ скопирован'));
  } else {
    $('encryptionKeyDisplay').select();
    document.execCommand('copy');
    toast('Ключ скопирован');
  }
};

$('keyNextBtn').onclick = () => {
  if (!pendingEncKey) return toast('Ошибка: ключ не найден');
  renderQuestions();
  showScreen('register3');
};

function renderQuestions() {
  const container = $('questionsContainer');
  container.innerHTML = QUESTIONS.map((q, i) => `
    <div class="question-item">
      <label>${q}</label>
      <div class="input-wrap">
        <input type="text" class="question-input" data-idx="${i}" placeholder="Ответ..." autocomplete="off">
      </div>
    </div>
  `).join('');
}

$('register3Btn').onclick = async () => {
  const inputs = document.querySelectorAll('.question-input');
  const answers = Array.from(inputs).map(inp => inp.value.trim());
  if (answers.some(a => !a)) return $('reg3Error').textContent = 'Ответь на все вопросы';
  $('reg3Error').textContent = '';
  const username = localStorage.getItem('th_reg_username');
  try {
    await saveQuestions(username, answers);
    const encKey = localStorage.getItem('th_reg_enc_key');
    localStorage.setItem('th_session_key', encKey);
    localStorage.setItem('th_session_user', username);
    localStorage.removeItem('th_reg_enc_key');
    localStorage.removeItem('th_reg_username');
    localStorage.removeItem('th_reg_display_name');
    localStorage.removeItem('th_reg_password');
    currentUser = { id: username, username, display_name: username, avatar_url: null };
    toast('Аккаунт создан!');
    showScreen('home');
    renderChatList();
    initPeer(username);
  } catch (e) {
    $('reg3Error').textContent = e.message;
  }
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
  } catch (e) {
    $('loginError').textContent = e.message;
  }
};

// Recovery step 1: enter username
let recoverData = null;

$('recover1Btn').onclick = async () => {
  const username = $('recoverUsername').value.trim().toLowerCase();
  if (!username) return $('rec1Error').textContent = 'Введите username';
  $('rec1Error').textContent = '';
  try {
    recoverData = await loadUserForRecovery(username);
    renderRecoverQuestions(recoverData.questions);
    showScreen('recover2');
  } catch (e) {
    $('rec1Error').textContent = e.message;
  }
};

function renderRecoverQuestions(questions) {
  const container = $('recoverQuestionsContainer');
  container.innerHTML = questions.map((q, i) => `
    <div class="question-item">
      <label>${q.q}</label>
      <div class="input-wrap">
        <input type="text" class="recover-answer-input" data-idx="${i}" placeholder="Ответ..." autocomplete="off">
      </div>
    </div>
  `).join('');
}

$('recover2Btn').onclick = async () => {
  const inputs = document.querySelectorAll('.recover-answer-input');
  const answers = Array.from(inputs).map(inp => inp.value.trim());
  if (answers.some(a => !a)) return $('rec2Error').textContent = 'Заполни все ответы';
  $('rec2Error').textContent = '';
  try {
    const key = await recoverKey(recoverData.username, answers);
    $('recoveredKeyDisplay').textContent = key;
    showScreen('recover3');
  } catch (e) {
    $('rec2Error').textContent = e.message;
  }
};

$('copyRecoveredKeyBtn').onclick = () => {
  const key = $('recoveredKeyDisplay').textContent;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(key).then(() => toast('Ключ скопирован'));
  } else {
    const range = document.createRange();
    range.selectNode($('recoveredKeyDisplay'));
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    document.execCommand('copy');
    toast('Ключ скопирован');
  }
};

// Auto-login check
(async () => {
  try {
    DB.load();
    const sessionUser = localStorage.getItem('th_session_user');
    const sessionKey = localStorage.getItem('th_session_key');
    if (sessionUser && sessionKey && DB.getUser(sessionUser)) {
      await loadProfile();
      showScreen('home');
      renderChatList();
      initPeer(sessionUser);
      return;
    }
  } catch {}
  showScreen('landing');
})();

// -- Profile UI --
$('profileBtn').onclick = async () => {
  const p = currentUser;
  if (!p) return;
  $('profileUsername').textContent = '@' + p.username;
  $('profileDisplayName').value = p.display_name || '';
  showScreen('profile');
};

$('showKeyBtn').onclick = () => {
  const key = localStorage.getItem('th_session_key');
  if (!key) return toast('Ключ не найден');
  toast('Ключ: ' + key.slice(0, 20) + '... (сохранён в сессии)');
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

$('logoutBtn').onclick = logout;

$('changeAvatarBtn') && ($('changeAvatarBtn').onclick = null);
$('avatarFileInput') && ($('avatarFileInput').onchange = null);

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
  const users = searchUsers(q);
  results.innerHTML = users
    .filter(u => u.id !== currentUser.id)
    .map(u => `
      <div class="search-result-item" data-userid="${u.id}">
        <div class="avatar-small"><svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 22c0-6 4-10 8-10s8 4 8 10" fill="none" stroke="currentColor" stroke-width="2"/></svg></div>
        <div>
          <div class="sr-name">${u.display_name}</div>
          <div class="sr-username">@${u.username}</div>
        </div>
      </div>
    `).join('');

  results.querySelectorAll('.search-result-item').forEach(el => {
    el.onclick = async () => {
      const uid = el.dataset.userid;
      const otherUser = getUserByUsername(el.querySelector('.sr-username').textContent.slice(1));
      if (!otherUser) return;
      try {
        const chatId = await createOrGetDM(uid);
        $('searchBar').style.display = 'none';
        $('searchInput').value = '';
        $('searchResults').innerHTML = '';
        openChat(chatId);
      } catch {
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
  selectedGroupMembers.clear();
  showScreen('createGroup');
};

const selectedGroupMembers = new Set();

$('groupSearchInput').oninput = async () => {
  const q = $('groupSearchInput').value.trim();
  const results = $('groupSearchResults');
  if (q.length < 2) { results.innerHTML = ''; return; }
  const users = searchUsers(q);
  results.innerHTML = users
    .filter(u => u.id !== currentUser.id && !selectedGroupMembers.has(u.id))
    .map(u => `
      <div class="search-result-item" data-userid="${u.id}">
        <div class="avatar-small"><svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 22c0-6 4-10 8-10s8 4 8 10" fill="none" stroke="currentColor" stroke-width="2"/></svg></div>
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
    // Render locally immediately
    const msg = DB.getMessages(currentChatId);
    const lastMsg = msg[msg.length - 1];
    if (lastMsg) {
      const sender = getMessageSender(lastMsg.sender_id);
      renderMessage(lastMsg, sender, true);
    }
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
    // Read file as Data URL
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = ev.target.result;
      await sendMessage(currentChatId, null, dataUrl, file.name);
      const msg = DB.getMessages(currentChatId);
      const lastMsg = msg[msg.length - 1];
      if (lastMsg) {
        const sender = getMessageSender(lastMsg.sender_id);
        renderMessage(lastMsg, sender, true);
      }
    };
    reader.readAsDataURL(file);
  } catch {
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
