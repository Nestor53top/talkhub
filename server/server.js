import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { randomBytes } from 'crypto';

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const rooms = {}; // roomHash -> { messages: [...], members: { socketId: nick, ... } }

app.get('/', (req, res) => res.send('TalkHub server OK'));

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentNick = null;

  socket.on('join', ({ roomHash, nick }) => {
    currentRoom = roomHash;
    currentNick = nick;
    socket.join(roomHash);
    if (!rooms[roomHash]) rooms[roomHash] = { messages: [], members: {} };
    rooms[roomHash].members[socket.id] = nick;

    // Send message history
    socket.emit('history', rooms[roomHash].messages);

    // Notify others
    socket.to(roomHash).emit('user_joined', nick);

    // Update member count for everyone
    const memberList = Object.values(rooms[roomHash].members);
    io.to(roomHash).emit('members', memberList);
  });

  socket.on('message', ({ text, file, fileName }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const msg = {
      id: randomBytes(8).toString('hex'),
      nick: currentNick,
      text: text || null,
      file: file || null,
      fileName: fileName || null,
      ts: Date.now()
    };
    rooms[currentRoom].messages.push(msg);
    io.to(currentRoom).emit('message', msg);
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      delete rooms[currentRoom].members[socket.id];
      const memberList = Object.values(rooms[currentRoom].members);
      io.to(currentRoom).emit('members', memberList);
      socket.to(currentRoom).emit('user_left', currentNick);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('TalkHub server on port', PORT));
