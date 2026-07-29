/* Calls – PeerJS */

const TH = window.TalkHub;

TH._call = null;
TH._localStream = null;
TH._callTimer = null;
TH._callStart = null;

TH.initPeer = function() {
  if (TH._peer) return;
  TH._peer = new Peer('th_' + TH.uid(), {
    config: { iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]}
  });
  TH._peer.on('call', (incoming) => {
    if (confirm('Входящий звонок')) {
      navigator.mediaDevices.getUserMedia({ audio: true, video: true })
        .then(stream => {
          TH._localStream = stream;
          document.getElementById('localVideo').srcObject = stream;
          document.getElementById('callOverlay').style.display = 'flex';
          TH._stopTimer();
          incoming.answer(stream);
          TH._call = incoming;
          TH._call.on('stream', rs => { document.getElementById('remoteVideo').srcObject = rs; TH._startTimer(); });
          TH._call.on('close', TH.endCall);
          TH._call.on('error', TH.endCall);
        }).catch(() => { incoming.close(); TH.toast('Доступ запрещён'); });
    } else incoming.close();
  });
  TH._peer.on('error', () => {});
};

TH.startCall = function(isVideo) {
  if (!TH._peer) return TH.toast('Peer не готов');
  TH.toast('Звонки временно недоступны');
};

TH.endCall = function() {
  TH._stopTimer();
  if (TH._localStream) { TH._localStream.getTracks().forEach(t => t.stop()); TH._localStream = null; }
  if (TH._call) { TH._call.close(); TH._call = null; }
  document.getElementById('localVideo').srcObject = null;
  document.getElementById('remoteVideo').srcObject = null;
  document.getElementById('callOverlay').style.display = 'none';
};

TH._startTimer = function() {
  TH._callStart = Date.now();
  clearInterval(TH._callTimer);
  TH._callTimer = setInterval(() => {
    const s = Math.floor((Date.now() - TH._callStart) / 1000);
    document.getElementById('callTimer').textContent =
      String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }, 1000);
};

TH._stopTimer = function() {
  clearInterval(TH._callTimer);
  TH._callTimer = null;
  TH._callStart = null;
  document.getElementById('callTimer').textContent = '00:00';
};
