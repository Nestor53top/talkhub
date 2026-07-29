/* TalkHub — Server-based chat (Socket.IO + PeerJS calls) */

const $ = id => document.getElementById(id);

// CHANGE THIS to your Render server URL after deploying
const SERVER_URL = 'http://localhost:3000';

let socket = null;
let peer = null;
let myNick = '', roomHash = '';
let call = null, localStream = null, callTimer = null, callStart = null;

function uid() { return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10); }
function timeStr(d) { const t = new Date(d); return String(t.getHours()).padStart(2,'0') + ':' + String(t.getMinutes()).padStart(2,'0'); }

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => { s.classList.remove('active'); s.style.display = 'none'; });
  const el = $(id);
  if (el) { el.style.display = 'flex'; el.classList.remove('screenIn'); void el.offsetWidth; el.classList.add('active'); }
}

function toast(msg, d = 2500) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.style.display = 'block'; clearTimeout(el._t);
  el._t = setTimeout(() => el.style.display = 'none', d);
}

// --- Socket ---
function connectSocket(nick, rh) {
  if (socket) { socket.disconnect(); socket = null; }
  socket = io(SERVER_URL);

  socket.on('connect', () => {
    $('chatScreenStatus').textContent = 'Подключено к серверу';
    socket.emit('join', { roomHash: rh, nick });
  });

  socket.on('history', (msgs) => {
    $('chatMessages').innerHTML = '';
    msgs.forEach(m => renderMessage(m, m.nick !== nick));
  });

  socket.on('message', (msg) => {
    renderMessage(msg, msg.nick !== nick);
  });

  socket.on('members', (list) => {
    const others = list.filter(n => n !== nick);
    $('chatScreenStatus').textContent = others.length ? others.join(', ') : 'Нет собеседников';
  });

  socket.on('user_joined', (n) => {
    toast(n + ' зашёл');
  });

  socket.on('user_left', (n) => {
    toast(n + ' вышел');
  });

  socket.on('disconnect', () => {
    $('chatScreenStatus').textContent = 'Отключено от сервера';
  });

  socket.on('connect_error', () => {
    $('chatScreenStatus').textContent = 'Ошибка подключения';
  });
}

// --- Render ---
function renderMessage(msg, isTheirs) {
  const cont = $('chatMessages');
  const el = document.createElement('div');
  el.className = 'message ' + (isTheirs ? 'theirs' : 'mine');
  const n = document.createElement('div'); n.className = 'msg-name'; n.textContent = msg.nick === myNick ? 'Вы' : msg.nick; el.appendChild(n);
  if (msg.file && msg.file.match(/\.(jpg|jpeg|png|gif|webp|bmp)(;|$)/i)) {
    const img = document.createElement('img'); img.src = msg.file;
    img.onclick = () => { const v = document.createElement('div'); v.className = 'img-viewer'; v.onclick = () => v.remove(); const i = document.createElement('img'); i.src = msg.file; v.appendChild(i); document.body.appendChild(v); };
    el.appendChild(img);
  } else if (msg.file) {
    const a = document.createElement('a'); a.href = msg.file; a.download = msg.fileName || 'file'; a.className = 'file-link';
    a.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M14 2v6h6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg> ' + (msg.fileName || 'Файл');
    el.appendChild(a);
  }
  if (msg.text) { const t = document.createElement('div'); t.textContent = msg.text; el.appendChild(t); }
  const time = document.createElement('div'); time.className = 'msg-time'; time.textContent = timeStr(msg.ts); el.appendChild(time);
  cont.appendChild(el);
  cont.scrollTop = cont.scrollHeight;
}

// --- Join ---
async function doJoin(nick, key) {
  localStorage.setItem('th_last_nick', nick);
  localStorage.setItem('th_last_key', key);
  myNick = nick;
  roomHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))))
    .slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
  $('chatScreenName').textContent = 'Комната';
  $('chatMessages').innerHTML = '';
  showScreen('chat');
  $('chatScreenStatus').textContent = 'Подключение к серверу...';
  connectSocket(nick, roomHash);
  initPeer(nick);
}

$('joinBtn').onclick = async () => {
  const nick = $('joinNick').value.trim();
  const key = $('joinKey').value.trim();
  if (!nick || !key) return $('joinError').textContent = 'Введи ник и ключ';
  $('joinError').textContent = '';
  doJoin(nick, key);
};

$('leaveBtn').onclick = () => {
  if (socket) { socket.disconnect(); socket = null; }
  if (peer) { peer.destroy(); peer = null; }
  if (call) endCall();
  showScreen('join');
};

// --- Send ---
$('chatSendBtn').onclick = () => {
  const text = $('chatInput').value.trim();
  if (!text) return;
  $('chatInput').value = '';
  socket?.emit('message', { text });
};

$('chatInput').onkeydown = e => { if (e.key === 'Enter') $('chatSendBtn').click(); };

$('chatAttachBtn').onclick = () => $('chatFileInput').click();
$('chatFileInput').onchange = (e) => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    socket?.emit('message', { file: ev.target.result, fileName: file.name });
  };
  reader.readAsDataURL(file); $('chatFileInput').value = '';
};

// --- PeerJS calls (P2P only) ---
function initPeer(nick) {
  if (peer) { peer.destroy(); peer = null; }
  const peerId = 'th_' + nick + '_' + Math.random().toString(36).slice(2, 6);
  peer = new Peer(peerId, {
    config: { iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]}
  });
  peer.on('error', () => {});
  peer.on('call', (incoming) => {
    if (confirm('Входящий звонок')) {
      navigator.mediaDevices.getUserMedia({ audio: true, video: true })
        .then(stream => {
          localStream = stream; $('localVideo').srcObject = stream; $('callOverlay').style.display = 'flex'; stopTimer();
          incoming.answer(stream); call = incoming;
          call.on('stream', rs => { $('remoteVideo').srcObject = rs; startTimer(); });
          call.on('close', endCall); call.on('error', endCall);
        }).catch(() => { incoming.close(); toast('Доступ запрещён'); });
    } else incoming.close();
  });
  // Share peer ID via socket
  socket?.on('peer_id', (remotePeerId) => {
    window._remotePeerId = remotePeerId;
  });
  socket?.emit('peer_id', peerId);
}

function startCall(isVideo) {
  if (!peer || !window._remotePeerId) return toast('Нет собеседника');
  if (call) return toast('Уже в звонке');
  navigator.mediaDevices.getUserMedia({ audio: true, video: isVideo })
    .then(stream => {
      localStream = stream; $('localVideo').srcObject = stream; $('callOverlay').style.display = 'flex'; stopTimer();
      call = peer.call(window._remotePeerId, stream);
      call.on('stream', rs => { $('remoteVideo').srcObject = rs; startTimer(); });
      call.on('close', endCall); call.on('error', endCall);
    }).catch(() => toast('Доступ запрещён'));
}

function endCall() {
  stopTimer();
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (call) { call.close(); call = null; }
  $('localVideo').srcObject = null; $('remoteVideo').srcObject = null; $('callOverlay').style.display = 'none';
}

function startTimer() {
  callStart = Date.now(); clearInterval(callTimer);
  callTimer = setInterval(() => {
    const s = Math.floor((Date.now() - callStart) / 1000);
    $('callTimer').textContent = String(Math.floor(s / 60)).padStart(2,'0') + ':' + String(s % 60).padStart(2,'0');
  }, 1000);
}
function stopTimer() { clearInterval(callTimer); callTimer = null; callStart = null; $('callTimer').textContent = '00:00'; }

$('chatVoiceBtn').onclick = () => startCall(false);
$('chatVideoBtn').onclick = () => startCall(true);
$('endCallBtn').onclick = endCall;
let micOn = true, camOn = true;
$('callMicBtn').onclick = () => { if (!localStream) return; const t = localStream.getAudioTracks()[0]; if (t) { t.enabled = !t.enabled; micOn = t.enabled; $('callMicBtn').querySelector('svg').style.opacity = micOn ? '1' : '0.4'; } };
$('callCamBtn').onclick = () => { if (!localStream) return; const t = localStream.getVideoTracks()[0]; if (t) { t.enabled = !t.enabled; camOn = t.enabled; $('callCamBtn').querySelector('svg').style.opacity = camOn ? '1' : '0.4'; } };

// --- Auto-join ---
(async () => {
  const prevNick = localStorage.getItem('th_last_nick');
  const prevKey = localStorage.getItem('th_last_key');
  if (prevNick && prevKey) {
    doJoin(prevNick, prevKey);
  } else {
    showScreen('join');
  }
})();
