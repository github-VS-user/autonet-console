const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'autonet-console-secret-change-me';
const ACCESS_CODES_PATH = process.env.ACCESS_CODES_PATH || path.join(__dirname, '..', 'data', 'access-codes.json');

function loadAccessCodes() {
  try {
    if (!fs.existsSync(ACCESS_CODES_PATH)) return {};
    return JSON.parse(fs.readFileSync(ACCESS_CODES_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { accessCode } = req.body;
  if (!accessCode) {
    return res.status(400).json({ error: 'Access code required' });
  }

  const codes = loadAccessCodes();
  const customer = codes[accessCode];

  if (!customer) {
    return res.status(401).json({ error: 'Invalid access code' });
  }

  const token = jwt.sign(
    { customer, accessCode },
    JWT_SECRET,
    { expiresIn: '24h' }
  );

  res.json({ token, customer });
});

// Middleware to verify JWT
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid token' });
  }

  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET);
    req.customer = decoded.customer;
    req.accessCode = decoded.accessCode;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { router, requireAuth };
