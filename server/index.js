const express = require('express');
const cors = require('cors');
const path = require('path');
const { router: authRouter } = require('./auth');
const { router: uploadRouter } = require('./upload');
const { router: adminRouter } = require('./admin');

const app = express();
const PORT = process.env.PORT || 3456;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
app.use('/api/auth', authRouter);
app.use('/api', uploadRouter);
app.use('/api/admin', adminRouter);

// Serve frontend for all other routes (SPA-friendly)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Autonet Console API running on http://127.0.0.1:${PORT}`);
});
