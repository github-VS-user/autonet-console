const express = require('express');
const fs = require('fs');
const path = require('path');
const { requireAuth } = require('./auth');

const router = express.Router();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const COST_FILE = path.join(DATA_DIR, 'cost-tracking.json');

// Only admin can access these routes
function requireAdmin(req, res, next) {
  if (req.customer !== 'admin') {
    return res.status(403).json({ error: 'Admin access only' });
  }
  next();
}

// Load or init cost tracking
function loadCosts() {
  try {
    if (!fs.existsSync(COST_FILE)) return {};
    return JSON.parse(fs.readFileSync(COST_FILE, 'utf-8'));
  } catch { return {}; }
}

// GET /api/admin/stats — full system stats
router.get('/stats', requireAuth, requireAdmin, (req, res) => {
  const customersDir = path.join(DATA_DIR, 'customers');
  const costs = loadCosts();
  const perUser = [];

  let totalPending = 0;
  let totalCompleted = 0;

  try {
    if (fs.existsSync(customersDir)) {
      const users = fs.readdirSync(customersDir);
      users.forEach(user => {
        const inc = path.join(customersDir, user, 'incoming');
        const com = path.join(customersDir, user, 'completed');
        let pending = 0, completed = 0;

        try {
          if (fs.existsSync(inc)) {
            pending = fs.readdirSync(inc).filter(f => !f.endsWith('.context.txt')).length;
          }
        } catch {}

        try {
          if (fs.existsSync(com)) {
            completed = fs.readdirSync(com).filter(f => !f.endsWith('.context.txt')).length;
          }
        } catch {}

        totalPending += pending;
        totalCompleted += completed;

        // Get code for this user from access-codes
        const codes = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'access-codes.json'), 'utf-8'));
        const code = Object.keys(codes).find(k => codes[k] === user) || '—';

        perUser.push({
          name: user,
          code,
          pending,
          completed,
          cost: costs[user] || { totalCost: 0, totalTokens: 0, homeworks: [] }
        });
      });
    }
  } catch {}

  res.json({
    totalPending,
    totalCompleted,
    totalFiles: totalPending + totalCompleted,
    perUser
  });
});

// POST /api/admin/track-cost — record API cost for a homework run
// Called by the Autonet orchestration after processing
// Stores full audit trail: model, prompt/completion tokens, rate used
router.post('/track-cost', requireAuth, requireAdmin, (req, res) => {
  const { customer, homeworkName, model, promptTokens, completionTokens, inputRatePerM, outputRatePerM } = req.body;
  if (!customer || !homeworkName) {
    return res.status(400).json({ error: 'customer and homeworkName required' });
  }

  const pTokens = promptTokens || 0;
  const cTokens = completionTokens || 0;
  const totalTokens = pTokens + cTokens;
  const inRate = inputRatePerM || 0.14;
  const outRate = outputRatePerM || 0.28;
  const cost = (pTokens * inRate / 1000000) + (cTokens * outRate / 1000000);

  const costs = loadCosts();
  if (!costs[customer]) {
    costs[customer] = { totalCost: 0, totalTokens: 0, homeworks: [] };
  }

  costs[customer].totalCost += cost;
  costs[customer].totalTokens += totalTokens;
  costs[customer].homeworks.push({
    name: homeworkName,
    model: model || 'deepseek/deepseek-v4-flash',
    promptTokens: pTokens,
    completionTokens: cTokens,
    totalTokens,
    cost: Math.round(cost * 100000) / 100000,
    date: new Date().toISOString().split('T')[0]
  });

  fs.writeFileSync(COST_FILE, JSON.stringify(costs, null, 2));
  res.json({ ok: true, cost, breakdown: `${pTokens} × $${inRate}/1M = $${(pTokens * inRate / 1000000).toFixed(6)} + ${cTokens} × $${outRate}/1M = $${(cTokens * outRate / 1000000).toFixed(6)} = $${cost.toFixed(6)}` });
});

// GET /api/admin/billing — full financial picture
router.get('/billing', requireAuth, requireAdmin, (req, res) => {
  const configPath = path.join(DATA_DIR, 'admin-config.json');
  let config = { fixedCosts: {}, plans: {}, customers: {} };
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch {}

  const costs = loadCosts();
  const codesPath = path.join(DATA_DIR, 'access-codes.json');
  let codes = {};
  try { codes = JSON.parse(fs.readFileSync(codesPath, 'utf-8')); } catch {}

  // Fixed costs breakdown
  const vpsMonthly = config.fixedCosts?.vps?.monthlyCost || 0;
  const domainYearly = config.fixedCosts?.domain?.yearlyCost || 0;
  const domainMonthly = domainYearly / 12;
  const totalFixedMonthly = vpsMonthly + domainMonthly;

  // Per-customer breakdown
  const customers = [];
  let totalAPICost = 0;
  let totalHomeworkCount = 0;

  Object.keys(config.customers || {}).forEach(name => {
    const cfg = config.customers[name];
    const plan = config.plans?.[cfg.plan] || { name: '—', monthlyPrice: 0, homeworkLimit: 0 };
    const usage = costs[name] || { totalCost: 0, totalTokens: 0, homeworks: [] };
    const code = Object.keys(codes).find(k => codes[k] === name) || '—';

    totalAPICost += usage.totalCost;
    totalHomeworkCount += usage.homeworks.length;

    customers.push({
      name,
      code,
      plan: cfg.plan,
      planName: plan.name,
      planPrice: plan.monthlyPrice,
      homeworkLimit: plan.homeworkLimit,
      apiCost: usage.totalCost,
      totalTokens: usage.totalTokens,
      homeworksDone: usage.homeworks.length,
      // Profit per customer: plan price - API cost - shared cost share
      grossProfit: plan.monthlyPrice - usage.totalCost,
      homeworks: usage.homeworks.slice(-10) // last 10
    });
  });

  // Shared costs per customer
  const customerCount = customers.length || 1;
  const sharedCostPerCustomer = totalFixedMonthly / customerCount;

  const totalRevenue = customers.reduce((s, c) => s + c.planPrice, 0);
  const totalNetProfit = totalRevenue - totalFixedMonthly - totalAPICost;

  res.json({
    fixedCosts: {
      vps: { name: config.fixedCosts?.vps?.name || 'VPS', monthly: vpsMonthly },
      domain: { name: config.fixedCosts?.domain?.name || 'Domaine', yearly: domainYearly, monthly: domainMonthly },
      totalMonthly: totalFixedMonthly
    },
    apiTotals: {
      totalCost: totalAPICost,
      totalTokens: Object.values(costs).reduce((s, c) => s + (c.totalTokens || 0), 0)
    },
    revenue: {
      totalMonthly: totalRevenue,
      totalYearly: totalRevenue * 12
    },
    profit: {
      monthlyNet: totalNetProfit,
      yearlyNet: totalNetProfit * 12,
      marginPercent: totalRevenue > 0 ? Math.round((totalNetProfit / totalRevenue) * 100) : 0
    },
    customers,
    availablePlans: config.plans || {}
  });
});

module.exports = { router };
