/* TalkHub — Supabase (real-time, serverless) */

const $ = id => document.getElementById(id);

const SUPABASE_URL = 'https://wipjgcydeimjprmfiwvq.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndpcGpnY3lkZWltanBybWZpd3ZxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUzNTE0MzEsImV4cCI6MjEwMDkyNzQzMX0.Qfi4siVns2IVjfQHM52InwDZoE4lncbrwQu8FkhH-1I';

let supabase = null;
let myNick = '', roomHash = '';
let call = null, localStream = null, callTimer = null, callStart = null;
let peer = null;

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

// --- Supabase init ---
async function initSupabase() {
  if (supabase) return;
  const { createClient } = window.supabase;
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: { persistSession: false },
    realtime: { params: { eventsPerSecond: 10 } }
  });
}

// --- Render ---
function renderMessage(msg, isTheirs) {
  const cont = $('chatMessages');
  const el = document.createElement('div');
  el.className = 'message ' + (isTheirs ? 'theirs' : 'mine');
  const n = document.createElement('div'); n.className = 'msg-name'; n.textContent = msg.nick === myNick ? 'Вы' : msg.nick; el.appendChild(n);
  if (msg.file_url && msg.file_url.match(/\.(jpg|jpeg|png|gif|webp|bmp)(\?|$)/i)) {
    const img = document.createElement('img'); img.src = msg.file_url;
    img.onclick = () => { const v = document.createElement('div'); v.className = 'img-viewer'; v.onclick = () => v.remove(); const i = document.createElement('img'); i.src = msg.file_url; v.appendChild(i); document.body.appendChild(v); };
    el.appendChild(img);
  } else if (msg.file_url) {
    const a = document.createElement('a'); a.href = msg.file_url; a.download = msg.file_name || 'file'; a.className = 'file-link';
    a.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M14 2v6h6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg> ' + (msg.file_name || 'Файл');
    el.appendChild(a);
  }
  if (msg.text) { const t = document.createElement('div'); t.textContent = msg.text; el.appendChild(t); }
  const time = document.createElement('div'); time.className = 'msg-time'; time.textContent = timeStr(msg.created_at); el.appendChild(time);
  cont.appendChild(el);
  cont.scrollTop = cont.scrollHeight;
}

// --- Join room ---
async function doJoin(nick, key) {
  localStorage.setItem('th_last_nick', nick);
  localStorage.setItem('th_last_key', key);
  myNick = nick;
  roomHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))))
    .slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
  $('chatScreenName').textContent = 'Комната';
  $('chatMessages').innerHTML = '';
  showScreen('chat');
  $('chatScreenStatus').textContent = 'Загрузка...';

  await initSupabase();

  // Load history
  const { data } = await supabase
    .from('messages')
    .select('*')
    .eq('room_hash', roomHash)
    .order('created_at', { ascending: true })
    .limit(200);
  (data || []).forEach(m => renderMessage(m, m.nick !== myNick));
  $('chatScreenStatus').textContent = 'В сети';

  // Subscribe to new messages
  supabase
    .channel('msgs_' + roomHash)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_hash=eq.${roomHash}` },
      (payload) => {
        const msg = payload.new;
        if (!document.querySelector('[data-msgid="' + msg.id + '"]')) {
          renderMessage(msg, msg.nick !== myNick);
        }
      }
    )
    .subscribe();
}

$('joinBtn').onclick = async () => {
  const nick = $('joinNick').value.trim();
  const key = $('joinKey').value.trim();
  if (!nick || !key) return $('joinError').textContent = 'Введи ник и ключ';
  $('joinError').textContent = '';
  doJoin(nick, key);
};

$('leaveBtn').onclick = () => {
  if (supabase) supabase.removeAllChannels();
  if (call) endCall();
  showScreen('join');
};

// --- Send ---
$('chatSendBtn').onclick = async () => {
  const text = $('chatInput').value.trim();
  if (!text) return;
  $('chatInput').value = '';
  const msg = { room_hash: roomHash, nick: myNick, text };
  // Optimistic render
  const tempId = 'temp_' + uid();
  renderMessage({ id: tempId, ...msg, created_at: new Date().toISOString() }, false);
  await supabase.from('messages').insert(msg);
};

$('chatInput').onkeydown = e => { if (e.key === 'Enter') $('chatSendBtn').click(); };

$('chatAttachBtn').onclick = () => $('chatFileInput').click();
$('chatFileInput').onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return;
  const fileExt = file.name.split('.').pop();
  const filePath = roomHash + '/' + Date.now() + '_' + uid() + '.' + fileExt;
  await supabase.storage.from('chat_files').upload(filePath, file);
  const { data: { publicUrl } } = supabase.storage.from('chat_files').getPublicUrl(filePath);
  await supabase.from('messages').insert({
    room_hash: roomHash, nick: myNick,
    file_url: publicUrl, file_name: file.name
  });
  $('chatFileInput').value = '';
};

// --- Calls (PeerJS) ---
function initPeer() {
  if (peer) return;
  const pid = 'th_' + uid();
  peer = new Peer(pid, {
    config: { iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]}
  });
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
  peer.on('error', () => {});
  // Store peer ID for sharing via Supabase
  window._myPeerId = pid;
}

function startCall(isVideo) {
  if (!peer) return toast('Peer не готов');
  toast('Функция звонков временно недоступна');
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
