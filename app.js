/* TalkHub — Room Chat (PeerJS + localStorage) */

const $ = id => document.getElementById(id);

let peer = null, myNick = '', roomHash = '', peerReady = false;
let dataConns = {}, slotNames = {}, mySlot = '', mySlotIdx = -1;
let call = null, localStream = null, callTimer = null, callStart = null;
let discoInterval = null;

function uid() { return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10); }
function ts() { return Date.now(); }
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

// --- Storage ---
function loadMsgs() { try { return JSON.parse(localStorage.getItem('th_msgs_' + roomHash)) || []; } catch { return []; } }
function saveMsgs(a) { localStorage.setItem('th_msgs_' + roomHash, JSON.stringify(a)); }
function addMsg(m) { const a = loadMsgs(); a.push(m); saveMsgs(a); }
function getLastTs() { const a = loadMsgs(); return a.length ? a[a.length-1].ts : 0; }

function peerId(slot) { return 'th_' + roomHash + '_' + slot; }

// --- PeerJS ---
function tryClaimSlot(attempt) {
  if (attempt > 25) return toast('Комната переполнена');
  mySlotIdx = attempt; mySlot = String.fromCharCode(97 + attempt);
  if (peer) { peer.destroy(); peer = null; }
  peerReady = false;
  if (discoInterval) { clearInterval(discoInterval); discoInterval = null; }
  peer = new Peer(peerId(mySlot), {
    config: { iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]}
  });
  peer.on('open', () => {
    peerReady = true;
    $('chatScreenStatus').textContent = 'Ожидание собеседника...';
    for (let i = attempt + 1; i < 26; i++) connectToSlot(String.fromCharCode(97 + i));
    discoInterval = setInterval(() => {
      if (!peerReady) return;
      for (let i = 0; i < 26; i++) {
        const s = String.fromCharCode(97 + i);
        if (i !== mySlotIdx && !dataConns[s]) connectToSlot(s);
      }
    }, 4000);
    const q = window._peerQ || []; window._peerQ = [];
    q.forEach(p => broadcast(p.type, p.data));
  });
  peer.on('connection', (conn) => {
    const sid = conn.peer.replace('th_' + roomHash + '_', '');
    if (!sid || sid === mySlot) return;
    dataConns[sid] = conn;
    conn.send({ type: 'hello', nick: myNick, lastTs: getLastTs() });
    conn.on('data', d => onData(d, sid, conn));
    conn.on('close', () => { delete dataConns[sid]; });
  });
  peer.on('call', (incoming) => {
    const sid = incoming.peer.replace('th_' + roomHash + '_', '');
    const name = slotNames[sid] || sid;
    if (confirm('Входящий звонок от ' + name)) {
      navigator.mediaDevices.getUserMedia({ audio: true, video: true })
        .then(stream => {
          localStream = stream; $('localVideo').srcObject = stream; $('callOverlay').style.display = 'flex'; stopTimer();
          incoming.answer(stream); call = incoming;
          call.on('stream', rs => { $('remoteVideo').srcObject = rs; startTimer(); });
          call.on('close', endCall); call.on('error', endCall);
        }).catch(() => { incoming.close(); toast('Доступ к камере/микрофону запрещён'); });
    } else incoming.close();
  });
  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') {
      if (peer) { peer.destroy(); peer = null; }
      tryClaimSlot(attempt + 1);
    }
  });
}

function connectToSlot(slot) {
  if (!peer || !peerReady || dataConns[slot]) return;
  const tid = peerId(slot);
  if (tid === peer.id) return;
  const conn = peer.connect(tid, { reliable: true });
  const t = setTimeout(() => { if (dataConns[slot] === conn) { delete dataConns[slot]; conn.close(); } }, 4000);
  conn.on('open', () => {
    clearTimeout(t); dataConns[slot] = conn;
    conn.send({ type: 'hello', nick: myNick, lastTs: getLastTs() });
  });
  conn.on('data', d => onData(d, slot, conn));
  conn.on('close', () => { delete dataConns[slot]; });
  conn.on('error', () => { delete dataConns[slot]; });
}

function broadcast(type, data) {
  if (!peer || !peerReady) {
    if (!window._peerQ) window._peerQ = [];
    window._peerQ.push({ type, data });
    return;
  }
  const pkt = { type, ...data };
  for (const [s, conn] of Object.entries(dataConns)) {
    if (conn.open) conn.send(pkt);
  }
}

function onData(d, fromSlot, conn) {
  if (d.type === 'hello') {
    slotNames[fromSlot] = d.nick;
    const names = Object.values(slotNames).filter(n => n !== myNick);
    $('chatScreenStatus').textContent = names.length ? names.join(', ') : 'Ожидание собеседника...';
    const msgs = loadMsgs().filter(m => m.ts > d.lastTs);
    if (msgs.length) conn.send({ type: 'sync', msgs });
  } else if (d.type === 'sync') {
    const existing = loadMsgs();
    let changed = false;
    for (const m of d.msgs) {
      if (!existing.some(x => x.id === m.id)) { existing.push(m); changed = true; renderMessage(m, m.nick !== myNick); }
    }
    if (changed) saveMsgs(existing);
  } else if (d.type === 'message') {
    const existing = loadMsgs();
    if (existing.some(x => x.id === d.msg.id)) return;
    existing.push(d.msg); saveMsgs(existing);
    renderMessage(d.msg, d.msg.nick !== myNick);
    // Relay to others (exclude sender)
    for (const [s, c] of Object.entries(dataConns)) {
      if (s !== fromSlot && c.open) c.send(d);
    }
  }
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
$('joinBtn').onclick = async () => {
  const nick = $('joinNick').value.trim();
  const key = $('joinKey').value.trim();
  if (!nick || !key) return $('joinError').textContent = 'Введи ник и ключ';
  $('joinError').textContent = '';
  localStorage.setItem('th_last_nick', nick);
  localStorage.setItem('th_last_key', key);
  myNick = nick;
  roomHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))))
    .slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
  $('chatScreenName').textContent = 'Комната: ' + nick;
  $('chatMessages').innerHTML = '';
  loadMsgs().forEach(m => renderMessage(m, m.nick !== myNick));
  showScreen('chat');
  tryClaimSlot(0);
};

$('leaveBtn').onclick = () => {
  if (discoInterval) { clearInterval(discoInterval); discoInterval = null; }
  if (peer) { peer.destroy(); peer = null; }
  peerReady = false; dataConns = {}; slotNames = {}; window._peerQ = [];
  if (call) endCall();
  showScreen('join');
};

// --- Send ---
$('chatSendBtn').onclick = () => {
  const text = $('chatInput').value.trim();
  if (!text) return;
  $('chatInput').value = '';
  const msg = { id: uid(), nick: myNick, text, ts: ts() };
  addMsg(msg); renderMessage(msg, false);
  broadcast('message', { msg });
};

$('chatInput').onkeydown = e => { if (e.key === 'Enter') $('chatSendBtn').click(); };

$('chatAttachBtn').onclick = () => $('chatFileInput').click();
$('chatFileInput').onchange = (e) => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const msg = { id: uid(), nick: myNick, file: ev.target.result, fileName: file.name, ts: ts() };
    addMsg(msg); renderMessage(msg, false);
    broadcast('message', { msg });
  };
  reader.readAsDataURL(file); $('chatFileInput').value = '';
};

// --- Calls ---
function startCall(isVideo) {
  if (!peer || !peerReady) return toast('Peer не готов');
  const slots = Object.keys(dataConns);
  if (!slots.length) return toast('Нет собеседника');
  if (call) return toast('Уже в звонке');
  const target = dataConns[slots[0]].peer;
  navigator.mediaDevices.getUserMedia({ audio: true, video: isVideo })
    .then(stream => {
      localStream = stream; $('localVideo').srcObject = stream; $('callOverlay').style.display = 'flex'; stopTimer();
      call = peer.call(target, stream);
      call.on('stream', rs => { $('remoteVideo').srcObject = rs; startTimer(); });
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

// --- Restore last session ---
const prevNick = localStorage.getItem('th_last_nick');
const prevKey = localStorage.getItem('th_last_key');
if (prevNick && prevKey) { $('joinNick').value = prevNick; $('joinKey').value = prevKey; }
showScreen('join');
