# TalkHub Server (Socket.IO)

1. Push this repo to GitHub
2. Go to https://dashboard.render.com → New Web Service
3. Connect your GitHub repo
4. Settings:
   - **Root Directory**: `server`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan**: Free
5. Deploy

After deploy, Render gives you a URL like `https://talkhub-xxxx.onrender.com`
Copy that URL into `app.js` → `SERVER_URL` variable.

## Local dev
```bash
cd server
npm install
node server.js
# Starts on http://localhost:3000
```
