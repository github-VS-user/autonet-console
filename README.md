# Autonet Console

Customer portal for Autonet — upload homework PDFs with context.

## Structure

```
server/          ← Backend API (Express)
  index.js       ← Main server
  auth.js        ← Access code auth
  storage.js     ← File handling
public/          ← Frontend (built by V0)
  index.html
  app.js
```

## API Endpoints

- `POST /api/auth/login` — access code → JWT
- `POST /api/upload` — upload PDF + context text
- `GET  /api/status` — pending / completed files

## Local Dev

```bash
npm install
npm start
```
