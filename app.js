const UI = {
  landing: 'landing',
  roomCreated: 'roomCreated',
  chat: 'chat',
  callOverlay: 'callOverlay',
};

// State
let peer = null;
let conn = null;
let call = null;
let localStream = null;
let myName = '';
let myPeerId = '';
let remotePeerId = '';
let isRoomCreator = false;

const $ = (id) => document.getElementById(id);

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = $(id);
  if (el) {
    el.classList.add('active');
    el.style.display = 'flex';
  }
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

function generateKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let key = '';
  for (let i = 0; i < 6; i++) key += chars[Math.floor(Math.random() * chars.length)];
  return key;
}

function addMessage(text, type, extra = {}) {
  const el = document.createElement('div');
  el.className = `message ${type}`;

  if (type === 'system') {
    el.textContent = text;
  } else {
    if (extra.name) {
      const nameEl = document.createElement('div');
      nameEl.className = 'msg-name';
      nameEl.textContent = extra.name;
      el.appendChild(nameEl);
    }
    if (extra.img) {
      const img = document.createElement('img');
      img.src = extra.img;
      img.onclick = () => { const v = document.createElement('div'); v.className = 'img-viewer'; v.onclick = () => v.remove(); const i = document.createElement('img'); i.src = extra.img; v.appendChild(i); document.body.appendChild(v); };
      el.appendChild(img);
    } else if (extra.fileName && extra.fileData) {
      const a = document.createElement('a');
      a.href = extra.fileData;
      a.download = extra.fileName;
      a.className = 'file-link';
      a.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" style="flex-shrink:0"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M14 2v6h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg> ' + extra.fileName;
      el.appendChild(a);
    } else {
      const t = document.createElement('div');
      t.textContent = text;
      el.appendChild(t);
    }
    const time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    el.appendChild(time);
  }

  $('messages').appendChild(el);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function sendMessage(text) {
  if (!conn || !text.trim()) return;
  const data = { type: 'text', text: text.trim(), name: myName };
  conn.send(data);
  addMessage(text, 'mine', { name: myName });
}

function sendFile(file) {
  if (!conn) return toast('Нет подключения');
  const reader = new FileReader();
  reader.onload = (e) => {
    const data = {
      type: 'file',
      fileName: file.name,
      fileData: e.target.result,
      name: myName,
    };
    conn.send(data);
    addMessage(file.name, 'mine', { name: myName, fileName: file.name, fileData: e.target.result });
  };
  reader.readAsDataURL(file);
}

// --- Call handling ---
let callTimerInterval = null;
let callStartTime = null;

function startTimer() {
  callStartTime = Date.now();
  clearInterval(callTimerInterval);
  callTimerInterval = setInterval(() => {
    if (!callStartTime) return;
    const s = Math.floor((Date.now() - callStartTime) / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    $('callTimer').textContent = String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  }, 1000);
}

function stopTimer() {
  clearInterval(callTimerInterval);
  callTimerInterval = null;
  callStartTime = null;
  $('callTimer').textContent = '00:00';
}

async function startCall(isVideo) {
  if (call) return toast('Уже в звонке');
  if (!peer || !conn) return toast('Нет подключения');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: isVideo,
    });
    $('localVideo').srcObject = localStream;
    $('callOverlay').style.display = 'flex';
    $('remoteVideo').srcObject = null;
    stopTimer();

    call = peer.call(remotePeerId, localStream);

    call.on('stream', (remoteStream) => {
      $('remoteVideo').srcObject = remoteStream;
      startTimer();
    });

    call.on('close', endCall);
    call.on('error', () => { toast('Ошибка вызова'); endCall(); });

  } catch (e) {
    toast('Доступ к камере/микрофону запрещён');
  }
}

function answerCall(incomingCall) {
  call = incomingCall;
  navigator.mediaDevices.getUserMedia({
    audio: true,
    video: true,
  }).then((stream) => {
    localStream = stream;
    $('localVideo').srcObject = stream;
    $('callOverlay').style.display = 'flex';
    $('remoteVideo').srcObject = null;
    stopTimer();

    call.answer(stream);

    call.on('stream', (remoteStream) => {
      $('remoteVideo').srcObject = remoteStream;
      startTimer();
    });

    call.on('close', endCall);
    call.on('error', () => { toast('Ошибка вызова'); endCall(); });
  }).catch(() => {
    toast('Доступ к камере/микрофону запрещён');
    call.close();
    call = null;
  });
}

function endCall() {
  stopTimer();
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (call) {
    call.close();
    call = null;
  }
  $('localVideo').srcObject = null;
  $('remoteVideo').srcObject = null;
  $('callOverlay').style.display = 'none';
}

// --- Peer initialization ---
function initPeer(id, creatorName, isCreator) {
  if (peer) peer.destroy();

  isRoomCreator = isCreator;
  myName = creatorName;
  myPeerId = id;

  peer = new Peer(id, {
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    },
  });

  peer._resolveOpen = null;
  peer._openPromise = new Promise(r => { peer._resolveOpen = r; });

  peer.on('open', (id) => {
    console.log('Peer ID:', id);
    if (isCreator) {
      $('roomKeyDisplay').textContent = id;
      showScreen('roomCreated');
    }
    if (peer._resolveOpen) peer._resolveOpen();
  });

  peer.on('connection', (incoming) => {
    conn = incoming;
    setupConnection(conn);
  });

  peer.on('call', (incomingCall) => {
    const name = incomingCall.metadata?.name || 'Собеседник';
    if (confirm(`${name} звонит. Ответить?`)) {
      answerCall(incomingCall);
    } else {
      incomingCall.close();
    }
  });

  peer.on('disconnected', () => {
    $('connectionStatus').className = 'connection-status disconnected';
    $('connectionStatus').textContent = 'Отключено';
  });

  peer.on('error', (err) => {
    console.error('PeerJS error:', err.type, err.message);
    if (err.type === 'peer-unavailable') {
      toast('Ключ недействителен или собеседник не в сети');
    } else if (err.type === 'unavailable-id') {
      toast('Этот ключ уже используется');
    } else if (err.type === 'network') {
      toast('Нет соединения с сервером PeerJS');
      $('connectionStatus').textContent = 'Нет сети';
    } else if (err.type !== 'disconnected') {
      toast('Ошибка: ' + (err.message || err.type));
    }
  });

  peer.on('close', () => {
    toast('Соединение с PeerJS закрыто');
  });
}

function setupConnection(c) {
  conn = c;

  c.on('open', () => {
    $('connectionStatus').className = 'connection-status connected';
    $('connectionStatus').textContent = 'Подключено';

    if (!isRoomCreator) {
      c.send({ type: 'join', name: myName, peerId: myPeerId });
    }
  });

  c.on('data', (data) => {
    if (data.type === 'join') {
      remotePeerId = data.peerId;
      const msg = `${data.name} присоединился`;
      addMessage(msg, 'system');
      toast(msg);
      showScreen('chat');
      $('chatRoomKey').textContent = myPeerId;
    } else if (data.type === 'text') {
      addMessage(data.text, 'theirs', { name: data.name });
    } else if (data.type === 'file') {
      addMessage(data.fileName, 'theirs', {
        name: data.name,
        fileName: data.fileName,
        fileData: data.fileData,
      });
    } else if (data.type === 'connect-info') {
      remotePeerId = data.peerId;
    }
  });

  c.on('close', () => {
    $('connectionStatus').className = 'connection-status disconnected';
    $('connectionStatus').textContent = 'Собеседник отключился';
    addMessage('Собеседник отключился', 'system');
  });
}

// --- UI Events ---
$('backFromCreatedBtn').onclick = () => {
  if (peer) { peer.destroy(); peer = null; }
  showScreen('landing');
};

$('createRoomBtn').onclick = async () => {
  const name = prompt('Ваш ник (макс 20 символов):')?.trim();
  if (!name) return;
  if (name.length > 20) return toast('Макс 20 символов');

  const key = generateKey();
  initPeer(key, name, true);
};

$('copyKeyBtn').onclick = () => {
  const key = $('roomKeyDisplay').textContent;
  navigator.clipboard.writeText(key).then(() => toast('Ключ скопирован'))
    .catch(() => {});
};

$('joinRoomBtn').onclick = () => {
  const key = $('joinKey').value.trim().toUpperCase();
  const name = $('joinName').value.trim();
  if (!key) return toast('Введите ключ комнаты');
  if (!name) return toast('Введите ник');
  if (name.length > 20) return toast('Макс 20 символов');
  if (key.length < 4) return toast('Неверный ключ');

  joinRoom(key, name);
};

async function joinRoom(key, name) {
  remotePeerId = key;
  initPeer(null, name, false);

  await (peer._openPromise || Promise.resolve());

  conn = peer.connect(key, { reliable: true });
  setupConnection(conn);

  conn.on('open', () => {
    conn.send({ type: 'connect-info', peerId: myPeerId, name: myName });
  });

  showScreen('chat');
  $('chatRoomKey').textContent = key;
}

$('sendBtn').onclick = () => {
  sendMessage($('messageInput').value);
  $('messageInput').value = '';
};

$('messageInput').onkeydown = (e) => {
  if (e.key === 'Enter') {
    $('sendBtn').click();
  }
};

$('photoBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => {
  if (e.target.files[0]) sendFile(e.target.files[0]);
  e.target.value = '';
};

$('fileBtn').onclick = () => $('anyFileInput').click();
$('anyFileInput').onchange = (e) => {
  if (e.target.files[0]) sendFile(e.target.files[0]);
  e.target.value = '';
};

$('voiceBtn').onclick = () => startCall(false);
$('videoBtn').onclick = () => startCall(true);
$('endCallBtn').onclick = endCall;

const icons = {
  mic: '<svg viewBox="0 0 24 24" width="28" height="28"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M19 10v2a7 7 0 01-14 0v-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 19v4M8 23h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" width="28" height="28"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M19 10v2a7 7 0 01-7 6M5 10v2a7 7 0 008 6M12 19v4M8 23h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M23 1L1 23" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round"/></svg>',
  cam: '<svg viewBox="0 0 24 24" width="28" height="28"><path d="M23 7l-7 5 7 5V7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><rect x="1" y="5" width="15" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  camOff: '<svg viewBox="0 0 24 24" width="28" height="28"><path d="M23 7l-7 5 7 5V7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><rect x="1" y="5" width="15" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M23 1L1 23" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round"/></svg>',
};

let micOn = true;
let camOn = true;

$('toggleMic').onclick = () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (track) {
    track.enabled = !track.enabled;
    micOn = track.enabled;
    $('toggleMic').innerHTML = (micOn ? icons.mic : icons.micOff) + '<span>Микрофон</span>';
  }
};

$('toggleCam').onclick = () => {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (track) {
    track.enabled = !track.enabled;
    camOn = track.enabled;
    $('toggleCam').innerHTML = (camOn ? icons.cam : icons.camOff) + '<span>Камера</span>';
  }
};

// Handle incoming calls when not in call
document.addEventListener('visibilitychange', () => {
  if (document.hidden && call) {
    // Keep call alive
  }
});
