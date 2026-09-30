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
const EXPENSES_FILE = path.join(ROOT, 'expenses.json');

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

/**
 * Business timezone handling — the server (Render) runs in UTC, but the
 * business operates on US Central time. Every "today / this week / this
 * month" boundary must be computed in BUSINESS_TZ, not the server's local
 * time, or anything after ~7pm Central gets attributed to the wrong day.
 */
const BUSINESS_TZ = 'America/Chicago';

function tzParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short'
  });
  const p = {};
  fmt.formatToParts(date).forEach((x) => { p[x.type] = x.value; });
  const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: parseInt(p.year, 10),
    month: parseInt(p.month, 10), // 1-based
    day: parseInt(p.day, 10),
    hour: p.hour === '24' ? 0 : parseInt(p.hour, 10),
    minute: parseInt(p.minute, 10),
    second: parseInt(p.second, 10),
    weekday: WEEKDAYS[p.weekday]
  };
}

// Convert a Y-M-D-H-M-S wall-clock time IN BUSINESS_TZ to the correct UTC instant.
function zonedToUtc(y, mo, d, hh, mm, ss) {
  hh = hh || 0; mm = mm || 0; ss = ss || 0;
  const utcGuess = Date.UTC(y, mo - 1, d, hh, mm, ss);
  const seen = tzParts(new Date(utcGuess));
  const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
  return new Date(utcGuess - (seenAsUtc - utcGuess));
}

function businessNow() {
  return tzParts(new Date());
}

function businessMidnight(y, mo, d) {
  return zonedToUtc(y, mo, d, 0, 0, 0);
}

function fmtBusinessDate(date) {
  const p = tzParts(date);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return p.year + '-' + pad(p.month) + '-' + pad(p.day);
}

function daysInBusinessMonth(y, mo) {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

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
    // No caching at all — this app changes often during active development,
    // and mobile Safari in particular will otherwise keep serving a stale
    // copy of the page indefinitely even across manual reloads.
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache'
    });
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
  const nowParts = businessNow();
  const startOfToday = businessMidnight(nowParts.year, nowParts.month, nowParts.day);
  const startOfMonth = businessMidnight(nowParts.year, nowParts.month, 1);
  const startOfLastMonth = businessMidnight(nowParts.year, nowParts.month - 1, 1);
  const daysInMonth = daysInBusinessMonth(nowParts.year, nowParts.month);
  const dayOfMonth = nowParts.day;
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
  const nowParts = businessNow();
  const defaultStart = businessMidnight(nowParts.year, nowParts.month, 1);
  const defaultEnd = businessMidnight(nowParts.year, nowParts.month + 1, 1);

  const rangeStart = parseDateParam(startStr, defaultStart);
  let rangeEnd = parseDateParam(endStr, null);
  rangeEnd = rangeEnd ? addBusinessDays(rangeEnd, 1) : defaultEnd;

  const toSec = (d) => Math.floor(d.getTime() / 1000);
  const charges = await getChargesInRange(key, toSec(rangeStart), toSec(rangeEnd));
  const collected = netCollected(charges);

  const fmt = fmtBusinessDate;
  const inclusiveEnd = addBusinessDays(rangeEnd, -1);

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
 * Business expenses — stored locally in expenses.json (created automatically
 * on first save). Not pulled from Stripe: Stripe only knows what came IN.
 * Each expense: { id, name, category, amount, frequency: 'once'|'monthly', date }
 * "date" for a one-time expense is when it happened; for a recurring monthly
 * expense it's the month it started (an optional "endDate" marks when it stopped).
 */
function readExpenses() {
  try {
    const raw = fs.readFileSync(EXPENSES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function writeExpenses(list) {
  fs.writeFileSync(EXPENSES_FILE, JSON.stringify(list, null, 2));
}

function handleExpensesGet(req, res) {
  sendJson(res, 200, { expenses: readExpenses() });
}

function handleExpensesPost(req, res) {
  let body = '';
  let tooLarge = false;
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) { tooLarge = true; req.destroy(); }
  });
  req.on('end', () => {
    if (tooLarge) { sendJson(res, 413, { error: 'Request body too large' }); return; }
    let payload;
    try { payload = JSON.parse(body || '{}'); } catch (e) {
      sendJson(res, 400, { error: 'Invalid JSON body' }); return;
    }
    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    const category = typeof payload.category === 'string' ? payload.category.trim() : 'Uncategorized';
    const amount = Number(payload.amount);
    const frequency = payload.frequency === 'monthly' ? 'monthly' : 'once';
    const date = typeof payload.date === 'string' ? payload.date : null;
    if (!name || !isFinite(amount) || amount <= 0 || !date) {
      sendJson(res, 400, { error: 'Missing or invalid name, amount, or date' }); return;
    }
    const list = readExpenses();
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      name: name, category: category, amount: amount, frequency: frequency, date: date,
      endDate: typeof payload.endDate === 'string' ? payload.endDate : null
    };
    list.push(entry);
    writeExpenses(list);
    sendJson(res, 200, { expenses: list });
  });
}

function handleExpensesDelete(req, res) {
  const parsed = new URL(req.url, 'http://localhost');
  const id = parsed.searchParams.get('id');
  if (!id) { sendJson(res, 400, { error: 'Missing id' }); return; }
  const list = readExpenses().filter((e) => e.id !== id);
  writeExpenses(list);
  sendJson(res, 200, { expenses: list });
}

function daysBetween(a, b) {
  return Math.max(Math.round((b.getTime() - a.getTime()) / 86400000), 0);
}

function expenseAmountInRange(expense, rangeStart, rangeEnd) {
  if (expense.frequency === 'once') {
    const d = new Date(expense.date + 'T00:00:00');
    return (d >= rangeStart && d < rangeEnd) ? expense.amount : 0;
  }
  // Recurring monthly: prorate by the overlap between the expense's active
  // window (start date -> optional end date) and the queried range.
  const activeStart = new Date(expense.date + 'T00:00:00');
  const activeEnd = expense.endDate ? new Date(expense.endDate + 'T00:00:00') : null;
  const overlapStart = activeStart > rangeStart ? activeStart : rangeStart;
  const overlapEnd = activeEnd && activeEnd < rangeEnd ? activeEnd : rangeEnd;
  if (overlapStart >= overlapEnd) return 0;
  const overlapDays = daysBetween(overlapStart, overlapEnd);
  const daysInMonth = new Date(rangeStart.getFullYear(), rangeStart.getMonth() + 1, 0).getDate();
  return expense.amount * (overlapDays / daysInMonth);
}

async function computeProfitSummary(startStr, endStr) {
  const cash = await computeCashSummary(startStr, endStr);
  const rangeStart = new Date(cash.start + 'T00:00:00');
  const rangeEnd = new Date(new Date(cash.end + 'T00:00:00').getTime() + 86400000);

  const expenses = readExpenses();
  const totalExpenses = expenses.reduce((sum, e) => sum + expenseAmountInRange(e, rangeStart, rangeEnd), 0);

  const revenue = cash.collected;
  const profit = revenue - totalExpenses;
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

  return {
    syncedAt: new Date().toISOString(),
    start: cash.start,
    end: cash.end,
    revenue: revenue,
    expenses: totalExpenses,
    profit: profit,
    margin: margin
  };
}

function handleProfitSummary(req, res) {
  const parsed = new URL(req.url, 'http://localhost');
  const startStr = parsed.searchParams.get('start');
  const endStr = parsed.searchParams.get('end');
  computeProfitSummary(startStr, endStr)
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

  const fmt = fmtBusinessDate;

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

/**
 * Calls tracking — Made / Picked Up / Connected, from GHL's dialer call log
 * (GET /conversations/messages/export, channel=Call). GHL marks a call
 * "completed" whenever the session ends normally — that includes a genuine
 * pickup AND an instant decline/hangup, which the phone network reports the
 * same way. Two duration floors separate the noise from the signal:
 *  - CALLS_PICKUP_THRESHOLD_SEC filters out near-instant declines so they
 *    don't count as "Picked Up" at all.
 *  - CALLS_CONNECT_THRESHOLD_SEC filters picked-up calls further down to
 *    ones that were an actual conversation, not just a longer hang-up.
 */
const CALLS_PICKUP_THRESHOLD_SEC = 3;
const CALLS_CONNECT_THRESHOLD_SEC = 20;

async function getCallMessagesInRange(key, startIso, endIso) {
  const messages = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) { // hard cap: 20 pages = 2000 calls
    let qp = 'locationId=' + GHL_LOCATION_ID + '&channel=Call&limit=100' +
      '&startDate=' + encodeURIComponent(startIso) + '&endDate=' + encodeURIComponent(endIso);
    if (cursor) qp += '&cursor=' + encodeURIComponent(cursor);
    const data = await ghlGet('/conversations/messages/export?' + qp, key, '2021-04-15');
    const batch = data.messages || [];
    messages.push.apply(messages, batch);
    if (!data.nextCursor || batch.length === 0 || messages.length >= (data.total || Infinity)) break;
    cursor = data.nextCursor;
  }
  return messages;
}

async function computeCallsSummary(startStr, endStr) {
  const key = readGhlKey();
  if (!key) {
    throw new Error('No ghl_key.txt found next to proxy.js — create it with your GHL Private Integration Token.');
  }

  const now = new Date();
  const nowParts = businessNow();
  const defaultStart = businessMidnight(nowParts.year, nowParts.month, 1);
  const defaultEnd = businessMidnight(nowParts.year, nowParts.month + 1, 1);
  const rangeStart = parseDateParam(startStr, defaultStart);
  let rangeEnd = parseDateParam(endStr, null);
  rangeEnd = rangeEnd ? addBusinessDays(rangeEnd, 1) : defaultEnd;

  const startIso = rangeStart.toISOString();
  const endIso = new Date(rangeEnd.getTime() - 1).toISOString();

  const messages = await getCallMessagesInRange(key, startIso, endIso);
  const outbound = messages.filter((m) => m.direction === 'outbound');

  const made = outbound.length;
  const uniqueLeadsContacted = new Set(outbound.map((m) => m.contactId)).size;
  const callDurationSec = (m) => (m.meta && m.meta.call && typeof m.meta.call.duration === 'number') ? m.meta.call.duration : null;
  const pickedUpList = outbound.filter((m) => {
    if (m.status !== 'completed') return false;
    const dur = callDurationSec(m);
    return dur !== null && dur >= CALLS_PICKUP_THRESHOLD_SEC;
  });
  const connectedList = pickedUpList.filter((m) => {
    const dur = callDurationSec(m);
    return dur !== null && dur >= CALLS_CONNECT_THRESHOLD_SEC;
  });

  const pickedUp = pickedUpList.length;
  const connected = connectedList.length;
  const pickupRate = made > 0 ? (pickedUp / made) * 100 : 0;
  const connectRate = pickedUp > 0 ? (connected / pickedUp) * 100 : 0;

  // Booking rate: of the leads actually called in this window, how many of
  // THOSE SAME leads (matched by contactId) also got an appointment booked
  // in this window — not just any appointment that happened to land here.
  const calledContactIds = new Set(outbound.map((m) => m.contactId).filter(Boolean));
  const events = await getCalendarEvents(key, rangeStart.getTime(), rangeEnd.getTime());
  const bookedFromCalls = events.filter((e) => e.contactId && calledContactIds.has(e.contactId));
  const booked = bookedFromCalls.length;
  const bookingRate = made > 0 ? (booked / made) * 100 : 0;

  const fmt = fmtBusinessDate;
  const inclusiveEnd = addBusinessDays(rangeEnd, -1);

  return {
    syncedAt: now.toISOString(),
    start: fmt(rangeStart),
    end: fmt(inclusiveEnd),
    made: made,
    uniqueLeadsContacted: uniqueLeadsContacted,
    pickedUp: pickedUp,
    connected: connected,
    pickupRate: pickupRate,
    connectRate: connectRate,
    pickupThresholdSec: CALLS_PICKUP_THRESHOLD_SEC,
    connectThresholdSec: CALLS_CONNECT_THRESHOLD_SEC,
    booked: booked,
    bookingRate: bookingRate
  };
}

function handleCallsSummary(req, res) {
  const parsed = new URL(req.url, 'http://localhost');
  const startStr = parsed.searchParams.get('start');
  const endStr = parsed.searchParams.get('end');
  computeCallsSummary(startStr, endStr)
    .then((summary) => sendJson(res, 200, summary))
    .catch((err) => sendJson(res, 500, { error: err.message }));
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

function handleGhlLocation(req, res) {
  const key = readGhlKey();
  if (!key) { sendJson(res, 500, { error: 'No GHL key configured' }); return; }
  ghlGet('/locations/' + GHL_LOCATION_ID, key, '2021-07-28')
    .then((data) => sendJson(res, 200, {
      locationId: GHL_LOCATION_ID,
      name: data.location && data.location.name,
      companyName: data.location && data.location.companyName,
      email: data.location && data.location.email
    }))
    .catch((err) => sendJson(res, 500, { error: err.message }));
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
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (!m) return fallback;
  const d = businessMidnight(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
  return isNaN(d.getTime()) ? fallback : d;
}

// Add n calendar days (in business-tz terms) to a business-midnight-aligned Date.
function addBusinessDays(date, n) {
  const p = tzParts(date);
  return businessMidnight(p.year, p.month, p.day + n);
}

async function computeBookingSummary(startStr, endStr) {
  const key = readGhlKey();
  if (!key) {
    throw new Error('No ghl_key.txt found next to proxy.js — create it with your GHL Private Integration Token.');
  }

  const now = new Date();
  const nowParts = businessNow();
  const defaultStart = businessMidnight(nowParts.year, nowParts.month, 1);
  const defaultEnd = businessMidnight(nowParts.year, nowParts.month + 1, 1);

  const rangeStart = parseDateParam(startStr, defaultStart);
  // "end" is inclusive as given (e.g. 2026-08-31); internally we use an
  // exclusive upper bound one day later.
  let rangeEnd = parseDateParam(endStr, null);
  rangeEnd = rangeEnd ? addBusinessDays(rangeEnd, 1) : defaultEnd;

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

  const fmt = fmtBusinessDate;
  const inclusiveEnd = addBusinessDays(rangeEnd, -1);

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
  if (req.method === 'GET' && urlPath === '/ghl-location') {
    handleGhlLocation(req, res);
    return;
  }
  if (req.method === 'GET' && urlPath === '/ghl-pipelines') {
    handleGhlPipelines(req, res);
    return;
  }
  if (req.method === 'GET' && urlPath === '/calls-summary') {
    handleCallsSummary(req, res);
    return;
  }
  if (req.method === 'GET' && urlPath === '/booking-summary') {
    handleBookingSummary(req, res);
    return;
  }
  if (req.method === 'GET' && urlPath === '/expenses') {
    handleExpensesGet(req, res);
    return;
  }
  if (req.method === 'POST' && urlPath === '/expenses') {
    handleExpensesPost(req, res);
    return;
  }
  if (req.method === 'DELETE' && urlPath === '/expenses') {
    handleExpensesDelete(req, res);
    return;
  }
  if (req.method === 'GET' && urlPath === '/profit-summary') {
    handleProfitSummary(req, res);
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
  console.log('GET  /calls-summary?start=YYYY-MM-DD&end=YYYY-MM-DD -> live Made/Picked Up/Connected from GHL dialer');
  console.log('GET/POST/DELETE /expenses -> manage business expenses (stored in expenses.json)');
  console.log('GET  /profit-summary?start=YYYY-MM-DD&end=YYYY-MM-DD -> revenue minus expenses, profit margin');
});
