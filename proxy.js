#!/usr/bin/env node
'use strict';

/**
 * CTRL local proxy — built-in Node modules only.
 *
 * - Serves the HTML files in this directory as static files on localhost:3001
 * - POST /generate { prompt, system } spawns `claude -p`, pipes the prompt to
 *   stdin, and returns { script: <stdout> } — no API key, uses your existing
 *   Claude Code CLI login.
 *
 * Run:  node proxy.js
 * Open: http://localhost:3001/ai-dashboard.html
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3001;
const ROOT = __dirname;
const MAX_BODY_BYTES = 200 * 1024;       // 200KB — plenty for a script prompt
const GENERATE_TIMEOUT_MS = 120000;      // 2 minutes
const STRIPE_KEY_FILE = path.join(ROOT, 'stripe_key.txt');
const MONTHLY_GOAL = 20000;              // edit this to change your Growth page goal

const GHL_KEY_FILE = path.join(ROOT, 'ghl_key.txt');
const GHL_LOCATION_ID = 'TNBNoUEb4lxzxaQcG2VA';
const GHL_CALENDAR_ID = 'hLHqDqxIg0vFJTlKuiGW';
const GHL_PIPELINE_ID = 'nn9MlokwWPNTFblvKRah';       // Q4/2026
const GHL_CLOSED_STAGE_ID = 'd40fce7e-6f2d-46d3-98e4-6ee87b1d1793'; // "Closed 💸" stage in Q4/2026

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8'
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/ai-dashboard.html';

  // Strip any leading "../" traversal attempts, then resolve inside ROOT.
  const safeSuffix = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(ROOT, safeSuffix);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found: ' + urlPath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function handleGenerate(req, res) {
  let body = '';
  let tooLarge = false;

  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) {
      tooLarge = true;
      req.destroy();
    }
  });

  req.on('end', () => {
    if (tooLarge) {
      sendJson(res, 413, { error: 'Request body too large' });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch (e) {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
    const system = typeof payload.system === 'string' ? payload.system : '';

    if (!prompt.trim()) {
      sendJson(res, 400, { error: 'Missing "prompt" in request body' });
      return;
    }

    const stdinText = system ? (system + '\n\n' + prompt) : prompt;

    let child;
    try {
      child = spawn('claude', ['-p']);
    } catch (err) {
      sendJson(res, 500, { error: 'Failed to launch claude CLI: ' + err.message });
      return;
    }

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGKILL');
      sendJson(res, 504, { error: 'Timed out waiting for claude CLI (>' + (GENERATE_TIMEOUT_MS / 1000) + 's)' });
    }, GENERATE_TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      sendJson(res, 500, {
        error: 'Could not run "claude" CLI — is it installed and on your PATH? (' + err.message + ')'
      });
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) {
        sendJson(res, 500, {
          error: 'claude CLI exited with code ' + code + (stderr ? (': ' + stderr.trim().slice(0, 400)) : '')
        });
        return;
      }
      sendJson(res, 200, { script: stdout.trim() });
    });

    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

/**
 * Stripe finance summary — key is read from a local file, never from the
 * browser, never written into any HTML page.
 */
function readStripeKey() {
  if (process.env.STRIPE_KEY) return process.env.STRIPE_KEY.trim();
  try {
    const raw = fs.readFileSync(STRIPE_KEY_FILE, 'utf8').trim();
    return raw || null;
  } catch (e) {
    return null;
  }
}

function stripeGet(urlPath, key) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(key + ':').toString('base64');
    const options = {
      hostname: 'api.stripe.com',
      path: urlPath,
      method: 'GET',
      headers: { 'Authorization': 'Basic ' + auth }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        let data;
        try { data = JSON.parse(body); } catch (e) {
          reject(new Error('Stripe returned invalid JSON'));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error((data.error && data.error.message) || ('Stripe API error ' + res.statusCode)));
          return;
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getChargesInRange(key, gteSec, ltSec) {
  const charges = [];
  let startingAfter = null;
  for (let page = 0; page < 20; page++) { // hard cap: 20 pages = 2000 charges
    let qp = 'created[gte]=' + gteSec + '&created[lt]=' + ltSec + '&limit=100';
    if (startingAfter) qp += '&starting_after=' + startingAfter;
    const data = await stripeGet('/v1/charges?' + qp, key);
    charges.push.apply(charges, data.data);
    if (!data.has_more || data.data.length === 0) break;
    startingAfter = data.data[data.data.length - 1].id;
  }
  return charges;
}

function netCollected(charges) {
  return charges
    .filter((c) => c.status === 'succeeded')
    .reduce((sum, c) => sum + (c.amount - (c.amount_refunded || 0)), 0) / 100;
}

function countTier(charges, cents) {
  return charges.filter((c) => c.status === 'succeeded' && c.amount === cents).length;
}

async function computeFinanceSummary() {
  const key = readStripeKey();
  if (!key) {
    throw new Error('No stripe_key.txt found next to proxy.js — create it with your restricted Stripe key.');
  }

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  const daysLeft = Math.max(daysInMonth - dayOfMonth, 0);

  const toSec = (d) => Math.floor(d.getTime() / 1000);

  const [monthCharges, lastMonthCharges] = await Promise.all([
    getChargesInRange(key, toSec(startOfMonth), toSec(now) + 86400),
    getChargesInRange(key, toSec(startOfLastMonth), toSec(startOfMonth))
  ]);

  const todayCharges = monthCharges.filter((c) => c.created >= toSec(startOfToday));

  const collectedToday = netCollected(todayCharges);
  const collectedMonth = netCollected(monthCharges);
  const collectedLastMonth = netCollected(lastMonthCharges);

  const pace = (MONTHLY_GOAL / daysInMonth) * dayOfMonth;
  const behind = pace - collectedMonth;
  const needPerDay = daysLeft > 0 ? (MONTHLY_GOAL - collectedMonth) / daysLeft : 0;
  const todayTarget = MONTHLY_GOAL / daysInMonth;

  return {
    syncedAt: now.toISOString(),
    today: { collected: collectedToday, target: todayTarget },
    month: {
      collected: collectedMonth, goal: MONTHLY_GOAL, pace: pace, behind: behind,
      needPerDay: needPerDay, dayOfMonth: dayOfMonth, daysInMonth: daysInMonth, daysLeft: daysLeft
    },
    lastMonth: { collected: collectedLastMonth },
    lowTicket: { count97: countTier(monthCharges, 9700), count297: countTier(monthCharges, 29700) }
  };
}

function handleFinanceSummary(req, res) {
  computeFinanceSummary()
    .then((summary) => sendJson(res, 200, summary))
    .catch((err) => sendJson(res, 500, { error: err.message }));
}

async function computeCashSummary(startStr, endStr) {
  const key = readStripeKey();
  if (!key) {
    throw new Error('No stripe_key.txt found next to proxy.js — create it with your restricted Stripe key.');
  }

  const now = new Date();
  const defaultStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const defaultEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const rangeStart = parseDateParam(startStr, defaultStart);
  let rangeEnd = parseDateParam(endStr, null);
  rangeEnd = rangeEnd ? new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), rangeEnd.getDate() + 1) : defaultEnd;

  const toSec = (d) => Math.floor(d.getTime() / 1000);
  const charges = await getChargesInRange(key, toSec(rangeStart), toSec(rangeEnd));
  const collected = netCollected(charges);

  const fmt = (d) => d.toISOString().slice(0, 10);
  const inclusiveEnd = new Date(rangeEnd.getTime() - 86400000);

  return {
    syncedAt: now.toISOString(),
    start: fmt(rangeStart),
    end: fmt(inclusiveEnd),
    collected: collected,
    lowTicket: { count97: countTier(charges, 9700), count297: countTier(charges, 29700) }
  };
}

function handleCashSummary(req, res) {
  const parsed = new URL(req.url, 'http://localhost');
  const startStr = parsed.searchParams.get('start');
  const endStr = parsed.searchParams.get('end');
  computeCashSummary(startStr, endStr)
    .then((summary) => sendJson(res, 200, summary))
    .catch((err) => sendJson(res, 500, { error: err.message }));
}

/**
 * Recurring Monthly Revenue — needs the "Subscriptions: Read" permission
 * enabled on the same restricted key (Stripe dashboard -> API keys -> edit
 * this key -> Subscriptions -> Read). The key value itself doesn't change
 * when you add a permission, so stripe_key.txt does not need to be touched.
 */
async function getAllSubscriptions(key) {
  const subs = [];
  let startingAfter = null;
  for (let page = 0; page < 20; page++) { // hard cap: 20 pages = 2000 subscriptions
    let qp = 'status=all&limit=100';
    if (startingAfter) qp += '&starting_after=' + startingAfter;
    const data = await stripeGet('/v1/subscriptions?' + qp, key);
    subs.push.apply(subs, data.data);
    if (!data.has_more || data.data.length === 0) break;
    startingAfter = data.data[data.data.length - 1].id;
  }
  return subs;
}

function monthlyAmountCents(item) {
  const price = item.price;
  if (!price || !price.recurring) return 0;
  const amount = (price.unit_amount || 0) * (item.quantity || 1);
  const interval = price.recurring.interval;
  const count = price.recurring.interval_count || 1;
  if (interval === 'day') return amount * (30 / count);
  if (interval === 'week') return amount * (4.345 / count);
  if (interval === 'month') return amount / count;
  if (interval === 'year') return amount / (12 * count);
  return 0;
}

async function computeMrrSummary(asOfStr) {
  const key = readStripeKey();
  if (!key) {
    throw new Error('No stripe_key.txt found next to proxy.js — create it with your restricted Stripe key.');
  }

  const now = new Date();
  let asOfDate = parseDateParam(asOfStr, now);
  if (asOfDate > now) asOfDate = now; // can't compute future MRR
  // Treat "as of" as end-of-day, so a subscription that started that same day still counts.
  const asOfSec = Math.floor(asOfDate.getTime() / 1000) + 86399;

  const subs = await getAllSubscriptions(key);
  let totalCents = 0;
  let activeCount = 0;
  subs.forEach((sub) => {
    const start = sub.start_date;
    const end = sub.ended_at || sub.canceled_at || null;
    const activeAtDate = typeof start === 'number' && start <= asOfSec && (end === null || end > asOfSec);
    if (!activeAtDate) return;
    activeCount++;
    (sub.items && sub.items.data || []).forEach((item) => {
      totalCents += monthlyAmountCents(item);
    });
  });

  const fmt = (d) => d.toISOString().slice(0, 10);

  return {
    syncedAt: now.toISOString(),
    asOf: fmt(asOfDate),
    mrr: totalCents / 100,
    activeSubscriptions: activeCount
  };
}

function handleMrrSummary(req, res) {
  const parsed = new URL(req.url, 'http://localhost');
  const asOfStr = parsed.searchParams.get('asOf');
  computeMrrSummary(asOfStr)
    .then((summary) => sendJson(res, 200, summary))
    .catch((err) => sendJson(res, 500, { error: err.message }));
}

/**
 * GoHighLevel (LeadConnector) — key is read from a local file, never from
 * the browser, never written into any HTML page.
 */
function readGhlKey() {
  if (process.env.GHL_KEY) return process.env.GHL_KEY.trim();
  try {
    const raw = fs.readFileSync(GHL_KEY_FILE, 'utf8').trim();
    return raw || null;
  } catch (e) {
    return null;
  }
}

function ghlGet(urlPath, key, version) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'services.leadconnectorhq.com',
      path: urlPath,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Version': version,
        'Accept': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        let data;
        try { data = JSON.parse(body); } catch (e) {
          reject(new Error('GHL returned invalid JSON (status ' + res.statusCode + ')'));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error((data.message) || ('GHL API error ' + res.statusCode)));
          return;
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function computeGhlPipelines() {
  const key = readGhlKey();
  if (!key) {
    throw new Error('No ghl_key.txt found next to proxy.js — create it with your GHL Private Integration Token.');
  }
  const data = await ghlGet(
    '/opportunities/pipelines?locationId=' + GHL_LOCATION_ID,
    key,
    '2021-07-28'
  );
  const pipelines = (data.pipelines || []).map((p) => ({
    id: p.id,
    name: p.name,
    stages: (p.stages || []).map((s) => ({ id: s.id, name: s.name }))
  }));
  return { pipelines: pipelines };
}

function handleGhlPipelines(req, res) {
  computeGhlPipelines()
    .then((summary) => sendJson(res, 200, summary))
    .catch((err) => sendJson(res, 500, { error: err.message }));
}

async function getCalendarEvents(key, startMs, endMs) {
  const data = await ghlGet(
    '/calendars/events?locationId=' + GHL_LOCATION_ID +
      '&calendarId=' + GHL_CALENDAR_ID +
      '&startTime=' + startMs + '&endTime=' + endMs,
    key,
    'v3'
  );
  return (data.events || []).filter((e) => !e.deleted);
}

async function getClosedOpportunities(key) {
  const opps = [];
  let page = 1;
  for (let i = 0; i < 20; i++) { // hard cap: 20 pages = 2000 opportunities
    const data = await ghlGet(
      '/opportunities/search?location_id=' + GHL_LOCATION_ID +
        '&pipeline_id=' + GHL_PIPELINE_ID +
        '&pipeline_stage_id=' + GHL_CLOSED_STAGE_ID +
        '&limit=100&page=' + page,
      key,
      '2023-02-21'
    );
    const batch = data.opportunities || [];
    opps.push.apply(opps, batch);
    const total = (data.meta && data.meta.total) || 0;
    if (opps.length >= total || batch.length === 0) break;
    page++;
  }
  return opps;
}

function parseDateParam(str, fallback) {
  if (!str) return fallback;
  const d = new Date(str + 'T00:00:00');
  return isNaN(d.getTime()) ? fallback : d;
}

async function computeBookingSummary(startStr, endStr) {
  const key = readGhlKey();
  if (!key) {
    throw new Error('No ghl_key.txt found next to proxy.js — create it with your GHL Private Integration Token.');
  }

  const now = new Date();
  const defaultStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const defaultEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const rangeStart = parseDateParam(startStr, defaultStart);
  // "end" is inclusive as given (e.g. 2026-08-31); internally we use an
  // exclusive upper bound one day later.
  let rangeEnd = parseDateParam(endStr, null);
  rangeEnd = rangeEnd ? new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), rangeEnd.getDate() + 1) : defaultEnd;

  const events = await getCalendarEvents(key, rangeStart.getTime(), rangeEnd.getTime());

  const nowMs = Date.now();
  const booked = events.length;
  const noShow = events.filter((e) => e.appointmentStatus === 'noshow').length;
  const cancelled = events.filter((e) => e.appointmentStatus === 'cancelled').length;
  const invalid = events.filter((e) => e.appointmentStatus === 'invalid').length;
  // "Taken" only counts calls whose scheduled time has actually passed —
  // a future-dated confirmed booking hasn't happened yet, so it isn't taken.
  const taken = events.filter((e) => {
    if (e.appointmentStatus === 'noshow' || e.appointmentStatus === 'cancelled' || e.appointmentStatus === 'invalid') return false;
    return new Date(e.startTime).getTime() <= nowMs;
  }).length;

  const closedOpps = await getClosedOpportunities(key);
  const closes = closedOpps.filter((o) => {
    const changed = new Date(o.lastStageChangeAt || o.updatedAt);
    return changed >= rangeStart && changed < rangeEnd;
  }).length;

  const showRate = booked > 0 ? (taken / booked) * 100 : 0;
  const closeRate = taken > 0 ? (closes / taken) * 100 : 0;

  const fmt = (d) => d.toISOString().slice(0, 10);
  const inclusiveEnd = new Date(rangeEnd.getTime() - 86400000);

  return {
    syncedAt: now.toISOString(),
    start: fmt(rangeStart),
    end: fmt(inclusiveEnd),
    booked: booked,
    taken: taken,
    noShow: noShow,
    cancelled: cancelled,
    closes: closes,
    closeRate: closeRate,
    showRate: showRate
  };
}

function handleBookingSummary(req, res) {
  const parsed = new URL(req.url, 'http://localhost');
  const startStr = parsed.searchParams.get('start');
  const endStr = parsed.searchParams.get('end');
  computeBookingSummary(startStr, endStr)
    .then((summary) => sendJson(res, 200, summary))
    .catch((err) => sendJson(res, 500, { error: err.message }));
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  if (req.method === 'POST' && urlPath === '/generate') {
    handleGenerate(req, res);
    return;
  }
  if (req.method === 'GET' && urlPath === '/finance-summary') {
    handleFinanceSummary(req, res);
    return;
  }
  if (req.method === 'GET' && urlPath === '/cash-summary') {
    handleCashSummary(req, res);
    return;
  }
  if (req.method === 'GET' && urlPath === '/mrr-summary') {
    handleMrrSummary(req, res);
    return;
  }
  if (req.method === 'GET' && urlPath === '/ghl-pipelines') {
    handleGhlPipelines(req, res);
    return;
  }
  if (req.method === 'GET' && urlPath === '/booking-summary') {
    handleBookingSummary(req, res);
    return;
  }
  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405, { 'Content-Type': 'text/plain' });
  res.end('Method not allowed');
});

server.listen(PORT, () => {
  console.log('CTRL proxy running at http://localhost:' + PORT + '/');
  console.log('Serving files from: ' + ROOT);
  console.log('POST /generate -> spawns `claude -p` for script generation');
  console.log('GET  /finance-summary -> reads stripe_key.txt and calls Stripe server-side');
  console.log('GET  /cash-summary?start=YYYY-MM-DD&end=YYYY-MM-DD -> cash collected for any date range');
  console.log('GET  /mrr-summary?asOf=YYYY-MM-DD -> recurring monthly revenue as of a given date (needs Subscriptions:Read)');
  console.log('GET  /ghl-pipelines -> reads ghl_key.txt and lists your GHL pipelines');
  console.log('GET  /booking-summary?start=YYYY-MM-DD&end=YYYY-MM-DD -> live Booked/Taken/Closes from GHL');
});
