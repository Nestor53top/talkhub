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
      img.onclick = () => window.open(extra.img, '_blank');
      el.appendChild(img);
    } else if (extra.fileName && extra.fileData) {
      const a = document.createElement('a');
      a.href = extra.fileData;
      a.download = extra.fileName;
      a.className = 'file-link';
      a.textContent = '📎 ' + extra.fileName;
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

    call = peer.call(remotePeerId, localStream);

    call.on('stream', (remoteStream) => {
      $('remoteVideo').srcObject = remoteStream;
      $('callStatus').textContent = 'В звонке';
    });

    call.on('close', endCall);
    call.on('error', () => { toast('Ошибка вызова'); endCall(); });

    $('callStatus').textContent = 'Звоним...';
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

    call.answer(stream);

    call.on('stream', (remoteStream) => {
      $('remoteVideo').srcObject = remoteStream;
      $('callStatus').textContent = 'В звонке';
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

  peer.on('open', (id) => {
    console.log('Peer ID:', id);
    if (isCreator) {
      $('roomKeyDisplay').textContent = id;
      showScreen('roomCreated');
    }
  });

  peer.on('connection', (incoming) => {
    conn = incoming;
    setupConnection(conn);
  });

  peer.on('call', (incomingCall) => {
    if (confirm(`${incomingCall.metadata?.name || 'Собеседник'} звонит. Ответить?`)) {
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
    if (err.type === 'peer-unavailable') {
      toast('Ключ недействителен или собеседник не в сети');
    } else if (err.type !== 'disconnected') {
      console.error(err);
    }
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

  // Wait for peer to be ready, then connect
  await new Promise((resolve) => {
    const check = () => {
      if (peer && peer.open) resolve();
      else setTimeout(check, 100);
    };
    check();
  });

  conn = peer.connect(key, { reliable: true });
  setupConnection(conn);

  // Send our info once connected
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

let micOn = true;
let camOn = true;

$('toggleMic').onclick = () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (track) {
    track.enabled = !track.enabled;
    micOn = track.enabled;
    $('toggleMic').textContent = micOn ? '🎤' : '🔇';
  }
};

$('toggleCam').onclick = () => {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (track) {
    track.enabled = !track.enabled;
    camOn = track.enabled;
    $('toggleCam').textContent = camOn ? '📷' : '🚫';
  }
};

// Handle incoming calls when not in call
document.addEventListener('visibilitychange', () => {
  if (document.hidden && call) {
    // Keep call alive
  }
});
