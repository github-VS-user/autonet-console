const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { requireAuth } = require('./auth');

const router = express.Router();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

// Ensure customer dirs exist
function ensureCustomerDir(customer) {
  const dir = path.join(DATA_DIR, 'customers', customer, 'incoming');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Configure multer for PDF uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = ensureCustomerDir(req.customer);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    cb(null, `${timestamp}-${file.originalname}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('File type not supported (PDF, images, DOCX, PPTX only)'));
    }
  }
});

// POST /api/upload
router.post('/upload', requireAuth, upload.single('file'), (req, res) => {
  const context = req.body.context || '';

  // Save context alongside the file
  const contextPath = path.join(
    DATA_DIR, 'customers', req.customer, 'incoming',
    `${req.file.filename}.context.txt`
  );
  fs.writeFileSync(contextPath, context);

  res.json({
    ok: true,
    message: `✅ Registered ${req.file.originalname} for ${req.customer}`,
    file: req.file.filename
  });
});

// GET /api/status
router.get('/status', requireAuth, (req, res) => {
  const customerDir = path.join(DATA_DIR, 'customers', req.customer);
  const incoming = path.join(customerDir, 'incoming');
  const completed = path.join(customerDir, 'completed');

  const pending = [];
  const done = [];

  try {
    if (fs.existsSync(incoming)) {
      fs.readdirSync(incoming)
        .filter(f => !f.endsWith('.context.txt'))
        .forEach(f => pending.push(f));
    }
  } catch {}

  try {
    if (fs.existsSync(completed)) {
      fs.readdirSync(completed)
        .filter(f => !f.endsWith('.context.txt'))
        .forEach(f => done.push(f));
    }
  } catch {}

  res.json({ pending, completed: done, customer: req.customer });
});

// POST /api/submit — text-only submission (no PDF)
router.post('/submit', requireAuth, (req, res) => {
  const { context } = req.body;
  if (!context || !context.trim()) {
    return res.status(400).json({ error: 'Context text is required' });
  }

  const dir = path.join(DATA_DIR, 'customers', req.customer, 'incoming');
  fs.mkdirSync(dir, { recursive: true });

  const timestamp = Date.now();
  const textFile = path.join(dir, `${timestamp}-text-submission.txt`);
  fs.writeFileSync(textFile, context.trim());

  res.json({
    ok: true,
    message: `✅ Text submission registered for ${req.customer}`,
    file: `${timestamp}-text-submission.txt`
  });
});

module.exports = { router };
