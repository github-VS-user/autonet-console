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

  // Try to get FX rate for CHF conversion
  const fxPath = path.join(DATA_DIR, 'fx-cache.json');
  let fxRate = 0.88;
  try {
    if (fs.existsSync(fxPath)) {
      const fx = JSON.parse(fs.readFileSync(fxPath, 'utf-8'));
      if (fx.rate) fxRate = fx.rate;
    }
  } catch {}
  const chfToUsd = fxRate; // 1 CHF = fxRate USD (actually 1 USD = fxRate CHF, so 1 CHF = 1/fxRate USD)
  // Wait: fxRate is USD/CHF = 0.78, meaning 1 USD = 0.78 CHF
  // So 1 CHF = 1/0.78 = 1.28 USD
  const usdPerChf = 1 / fxRate;

  // Per-customer breakdown
  const customers = [];
  let totalAPICost = 0;
  let totalHomeworkCount = 0;

  Object.keys(config.customers || {}).forEach(name => {
    const cfg = config.customers[name];
    const plan = config.plans?.[cfg.plan] || { name: '—', monthlyPriceCHF: 0, homeworkLimit: 0 };
    const usage = costs[name] || { totalCost: 0, totalTokens: 0, homeworks: [] };
    const code = Object.keys(codes).find(k => codes[k] === name) || '—';

    const priceCHF = plan.monthlyPriceCHF || 0;
    const priceUSD = priceCHF * usdPerChf;

    totalAPICost += usage.totalCost;
    totalHomeworkCount += usage.homeworks.length;

    customers.push({
      name,
      code,
      plan: cfg.plan,
      planName: plan.name,
      planPriceCHF: priceCHF,
      planPriceUSD: Math.round(priceUSD * 100) / 100,
      homeworkLimit: plan.homeworkLimit,
      apiCost: usage.totalCost,
      totalTokens: usage.totalTokens,
      homeworksDone: usage.homeworks.length,
      grossProfitUSD: Math.round((priceUSD - usage.totalCost) * 100) / 100,
      grossProfitCHF: Math.round((priceCHF - usage.totalCost * fxRate) * 100) / 100,
      homeworks: usage.homeworks.slice(-10)
    });
  });

  const totalRevenueCHF = customers.reduce((s, c) => s + c.planPriceCHF, 0);
  const totalRevenueUSD = customers.reduce((s, c) => s + c.planPriceUSD, 0);
  const totalNetProfitUSD = Math.round((totalRevenueUSD - totalFixedMonthly - totalAPICost) * 100) / 100;
  const totalNetProfitCHF = Math.round((totalRevenueCHF - (totalFixedMonthly + totalAPICost) * fxRate) * 100) / 100;

  res.json({
    fxRate,
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
      totalMonthlyUSD: totalRevenueUSD,
      totalMonthlyCHF: totalRevenueCHF,
      totalYearlyUSD: Math.round(totalRevenueUSD * 100) / 100 * 12,
      totalYearlyCHF: totalRevenueCHF * 12
    },
    profit: {
      monthlyNetUSD: totalNetProfitUSD,
      monthlyNetCHF: totalNetProfitCHF,
      yearlyNetUSD: Math.round(totalNetProfitUSD * 100) / 100 * 12,
      yearlyNetCHF: Math.round(totalNetProfitCHF * 100) / 100 * 12,
      marginPercent: totalRevenueUSD > 0 ? Math.round((totalNetProfitUSD / totalRevenueUSD) * 100) : 0
    },
    customers,
    availablePlans: config.plans || {}
  });
});

// GET /api/admin/fx-rate — get current USD/CHF rate (cached 7 days)
router.get('/fx-rate', requireAuth, requireAdmin, async (req, res) => {
  const fxPath = path.join(DATA_DIR, 'fx-cache.json');
  let cache = {};
  try {
    if (fs.existsSync(fxPath)) cache = JSON.parse(fs.readFileSync(fxPath, 'utf-8'));
  } catch {}

  const now = Date.now();
  const weekMs = 7 * 24 * 60 * 60 * 1000;

  // Return cached if still valid
  if (cache.rate && cache.fetched && (now - cache.fetched < weekMs)) {
    return res.json({ rate: cache.rate, date: cache.date, cached: true });
  }

  // Fetch fresh rate
  try {
    const resp = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await resp.json();
    const rate = data.rates?.CHF;
    if (rate) {
      cache = { rate, date: data.date || new Date().toISOString().split('T')[0], fetched: now };
      fs.writeFileSync(fxPath, JSON.stringify(cache, null, 2));
      return res.json({ rate, date: cache.date, cached: false });
    }
  } catch {}

  // Fallback: use old cache or default
  res.json({ rate: cache.rate || 0.88, date: cache.date || '—', cached: true });
});

// PUT /api/admin/config — update admin config (fixed costs, plans, customer plans)
router.put('/config', requireAuth, requireAdmin, (req, res) => {
  const configPath = path.join(DATA_DIR, 'admin-config.json');
  const { fixedCosts, plans, customers } = req.body;

  let config = {};
  try {
    if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {}

  if (fixedCosts) {
    if (fixedCosts.vps?.monthlyCost !== undefined) config.fixedCosts.vps.monthlyCost = Number(fixedCosts.vps.monthlyCost);
    if (fixedCosts.domain?.yearlyCost !== undefined) config.fixedCosts.domain.yearlyCost = Number(fixedCosts.domain.yearlyCost);
  }
  if (plans) config.plans = plans;
  if (customers) config.customers = customers;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  res.json({ ok: true });
});

module.exports = { router };
