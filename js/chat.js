/* Chat – render, send, subscribe */

const TH = window.TalkHub;

TH.renderMessage = function(msg, isMine) {
  const cont = document.getElementById('messagesContainer');
  const el = document.createElement('div');
  el.className = 'message ' + (isMine ? 'mine' : 'theirs');
  el.dataset.msgid = msg.id;

  const name = document.createElement('div');
  name.className = 'msg-name';
  name.textContent = msg.nick === TH.myNick ? 'Вы' : msg.nick;
  el.appendChild(name);

  if (msg.file_url && msg.file_url.match(/\.(jpg|jpeg|png|gif|webp|bmp)(\?|$)/i)) {
    const img = document.createElement('img'); img.src = msg.file_url;
    img.onclick = () => {
      const v = document.createElement('div'); v.className = 'img-viewer';
      v.onclick = () => v.remove();
      const i = document.createElement('img'); i.src = msg.file_url;
      v.appendChild(i); document.body.appendChild(v);
    };
    el.appendChild(img);
  } else if (msg.file_url) {
    const a = document.createElement('a'); a.href = msg.file_url; a.download = msg.file_name || 'file'; a.className = 'file-link';
    a.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M14 2v6h6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg> ' + (msg.file_name || 'Файл');
    el.appendChild(a);
  }

  if (msg.text) { const t = document.createElement('div'); t.textContent = msg.text; el.appendChild(t); }
  const time = document.createElement('div'); time.className = 'msg-time'; time.textContent = TH.timeStr(msg.created_at); el.appendChild(time);
  cont.appendChild(el);
  cont.scrollTop = cont.scrollHeight;
};

TH.joinRoom = async function(nick, roomHash) {
  TH.myNick = nick;
  TH.roomHash = roomHash;

  document.getElementById('chatTitle').textContent = 'Комната';
  document.getElementById('chatStatus').textContent = 'Загрузка...';
  document.getElementById('messagesContainer').innerHTML = '';

  TH.showScreen('chatScreen');

  try { await TH.initSupabase(); } catch (e) {
    document.getElementById('chatStatus').textContent = 'Ошибка: ' + e.message;
    TH.toast('Не удалось подключиться к серверу');
    return;
  }

  const supabase = TH.getDb();

  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('room_hash', roomHash)
    .order('created_at', { ascending: true })
    .limit(200);

  if (error) {
    document.getElementById('chatStatus').textContent = 'Ошибка загрузки';
    TH.toast(error.message);
    return;
  }

  (data || []).forEach(m => TH.renderMessage(m, m.nick !== nick));
  document.getElementById('chatStatus').textContent = 'В сети';

  // Subscribe to new messages
  TH._channel = supabase
    .channel('room_' + roomHash)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: 'room_hash=eq.' + roomHash },
      (payload) => {
        const m = payload.new;
        if (!document.querySelector('[data-msgid="' + m.id + '"]')) {
          TH.renderMessage(m, m.nick !== TH.myNick);
        }
      }
    )
    .subscribe();
};

TH.sendMessage = async function(text) {
  const supabase = TH.getDb();
  if (!supabase || !text) return;
  const { error } = await supabase.from('messages').insert({
    room_hash: TH.roomHash, nick: TH.myNick, text
  });
  if (error) TH.toast('Ошибка: ' + error.message);
};

TH.sendFile = async function(file) {
  const supabase = TH.getDb();
  if (!supabase || !file) return;
  try {
    const ext = file.name.split('.').pop();
    const path = TH.roomHash + '/' + Date.now() + '_' + TH.uid() + '.' + ext;
    await supabase.storage.from('chat_files').upload(path, file);
    const { data: { publicUrl } } = supabase.storage.from('chat_files').getPublicUrl(path);
    await supabase.from('messages').insert({
      room_hash: TH.roomHash, nick: TH.myNick,
      file_url: publicUrl, file_name: file.name
    });
  } catch (e) { TH.toast('Ошибка файла: ' + e.message); }
};

TH.leaveRoom = function() {
  if (TH._channel) { TH.getDb()?.removeChannel(TH._channel); TH._channel = null; }
  if (TH.endCall) TH.endCall();
  document.getElementById('fileInput').value = '';
};
