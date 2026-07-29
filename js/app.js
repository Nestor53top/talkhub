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
  if (el) el.textContent = msg;
  console.log('[toast]', msg);
  setTimeout(() => { if (el && el.textContent === msg) el.textContent = ''; }, 4000);
};
TH.genHash = function(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16).slice(0, 12);
};
TH.showScreen = function(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
};

/* DOM refs */
let $ = id => document.getElementById(id);
const nickInp = $('nickInput'), keyInp = $('keyInput'), joinBtn = $('joinBtn');
const msgInp = $('msgInput'), sendBtn = $('sendBtn'), fileInp = $('fileInput');
const menuBtn = $('menuBtn'), menuDropdown = $('menuDropdown');
const voiceBtn = $('voiceBtn'), endCallBtn = $('endCallBtn');
const joinError = $('joinError');

/* Auto-join on page load */
try {
  const nick = localStorage.getItem('th_last_nick');
  const key = localStorage.getItem('th_last_key');
  if (nick && key) {
    document.getElementById('nickInput').value = nick;
    document.getElementById('keyInput').value = key;
    TH.joinRoom(nick, TH.genHash(key));
  }
} catch (e) { console.error('autojoin err', e); }

/* Join */
joinBtn.addEventListener('click', () => {
  try {
    const nick = nickInp.value.trim() || 'Аноним';
    const key = keyInp.value.trim();
    if (!key) { TH.toast('Введи ключ комнаты'); return; }
    console.log('join: nick=%s key=%s', nick, key);
    localStorage.setItem('th_last_nick', nick);
    localStorage.setItem('th_last_key', key);
    TH.joinRoom(nick, TH.genHash(key));
  } catch (e) { console.error('join err', e); TH.toast('Ошибка: ' + e.message); }
});

/* Enter on join inputs */
[nickInp, keyInp].forEach(inp => {
  if (inp) inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); joinBtn.click(); }
  });
});

/* Send on Enter */
if (msgInp) msgInp.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
});
if (sendBtn) sendBtn.addEventListener('click', () => {
  TH.sendMessage(msgInp.value); msgInp.value = '';
});

/* File */
const attachBtn = $('attachBtn');
if (attachBtn) attachBtn.addEventListener('click', () => fileInp.click());
fileInp.addEventListener('change', () => {
  const f = fileInp.files[0]; if (f) { TH.sendFile(f); fileInp.value = ''; }
});

/* Menu */
if (menuBtn && menuDropdown) {
  menuBtn.addEventListener('click', () => menuDropdown.classList.toggle('show'));
  document.addEventListener('click', e => {
    if (!menuBtn.contains(e.target) && !menuDropdown.contains(e.target))
      menuDropdown.classList.remove('show');
  });
  const menuLeave = $('menuLeave'), menuRoomInfo = $('menuRoomInfo'), menuCopyKey = $('menuCopyKey');
  if (menuLeave) menuLeave.addEventListener('click', () => {
    TH.leaveRoom();
    menuDropdown.classList.remove('show');
    TH.showScreen('joinScreen');
    nickInp.value = TH.myNick || '';
    keyInp.value = '';
  });
  if (menuRoomInfo) menuRoomInfo.addEventListener('click', () => {
    TH.toast('Комната: ' + TH.roomHash);
    menuDropdown.classList.remove('show');
  });
  if (menuCopyKey) menuCopyKey.addEventListener('click', () => {
    const k = localStorage.getItem('th_last_key');
    if (k) { navigator.clipboard.writeText(k).then(() => TH.toast('Ключ скопирован')); }
    menuDropdown.classList.remove('show');
  });
}

/* Call */
if (voiceBtn) voiceBtn.addEventListener('click', () => {
  TH.initPeer();
  TH.startCall(false);
});
if (endCallBtn) endCallBtn.addEventListener('click', TH.endCall);
