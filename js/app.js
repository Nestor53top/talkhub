/* Main – init, navigation, events */

const TH = window.TalkHub;

/* Utils */
TH.uid = function() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); };
TH.timeStr = function(t) {
  if (!t) return '';
  const d = new Date(t);
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
};
TH.toast = function(msg) {
  const el = document.getElementById('joinError');
  el.textContent = msg;
  setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 4000);
};
TH.sha256 = async function(str) {
  const buf = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,'0')).join('').slice(0, 12);
};
TH.showScreen = function(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
};

/* Auto-join on page load */
(async function() {
  const nick = localStorage.getItem('th_last_nick');
  const key = localStorage.getItem('th_last_key');
  if (nick && key) {
    const hash = await TH.sha256(key);
    document.getElementById('nickInput').value = nick;
    document.getElementById('keyInput').value = key;
    TH.joinRoom(nick, hash);
  }
})();

/* DOM refs */
let $ = id => document.getElementById(id);
const nickInp = $('nickInput'), keyInp = $('keyInput'), joinBtn = $('joinBtn');
const msgInp = $('msgInput'), sendBtn = $('sendBtn'), fileInp = $('fileInput');
const menuBtn = $('menuBtn'), menuDropdown = $('menuDropdown');
const voiceBtn = $('voiceBtn'), endCallBtn = $('endCallBtn');

/* Join */
joinBtn.addEventListener('click', async () => {
  const nick = nickInp.value.trim() || 'Аноним';
  const key = keyInp.value.trim();
  if (!key) { TH.toast('Введи ключ комнаты'); return; }
  const hash = await TH.sha256(key);
  localStorage.setItem('th_last_nick', nick);
  localStorage.setItem('th_last_key', key);
  TH.joinRoom(nick, hash);
});

/* Send on Enter */
msgInp.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
});
sendBtn.addEventListener('click', () => {
  TH.sendMessage(msgInp.value); msgInp.value = '';
});

/* File */
$('attachBtn').addEventListener('click', () => fileInp.click());
fileInp.addEventListener('change', () => {
  const f = fileInp.files[0]; if (f) { TH.sendFile(f); fileInp.value = ''; }
});

/* Menu */
menuBtn.addEventListener('click', () => menuDropdown.classList.toggle('show'));
document.addEventListener('click', e => {
  if (!menuBtn.contains(e.target) && !menuDropdown.contains(e.target))
    menuDropdown.classList.remove('show');
});
$('menuLeave').addEventListener('click', () => {
  TH.leaveRoom();
  menuDropdown.classList.remove('show');
  TH.showScreen('joinScreen');
  nickInp.value = TH.myNick || '';
  keyInp.value = '';
});
$('menuRoomInfo').addEventListener('click', () => {
  TH.toast('Комната: ' + TH.roomHash);
  menuDropdown.classList.remove('show');
});
$('menuCopyKey').addEventListener('click', () => {
  const k = localStorage.getItem('th_last_key');
  if (k) { navigator.clipboard.writeText(k).then(() => TH.toast('Ключ скопирован')); }
  menuDropdown.classList.remove('show');
});

/* Call */
voiceBtn.addEventListener('click', () => {
  TH.initPeer();
  TH.startCall(false);
});
endCallBtn.addEventListener('click', TH.endCall);
