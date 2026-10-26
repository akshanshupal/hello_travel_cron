#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');
const process = require('node:process');

const BASE_DIR = __dirname;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_SECONDS || 30) * 1000;
const HELLOTRAVEL_URL = process.env.HELLOTRAVEL_URL || 'https://ihook.hellotravel.com/modal/hookleadapi_test.php';
const HELLOTRAVEL_API_KEY = process.env.HELLOTRAVEL_API_KEY || 'HT-SANDBOX-2026-LEADS-API';
const NEODOVE_URL = process.env.NEODOVE_URL || 'https://05477313-6db9-4b4f-8bab-0847fa88bf45.neodove.com/integration/custom/b4f84b54-e1b0-464c-9139-f5565c95ec07/leads';
const STATE_DIR = process.env.STATE_DIR || process.env.DATA_DIR || path.join(BASE_DIR, 'data');
const LEADS_DIR = process.env.LEADS_DIR || path.join(BASE_DIR, 'leads');
const STATE_FILE = process.env.STATE_FILE || path.join(STATE_DIR, 'processed_leads.json');
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_SECONDS || 20) * 1000;
const MAX_FORWARD_ATTEMPTS = Number(process.env.MAX_FORWARD_ATTEMPTS || 3);

const LEAD_FIELDS = [
  'LEAD_ID', 'NAME', 'EMAIL', 'PHONE', 'ADULT', 'FROM_CITY', 'TO_CITY',
  'DESCRIPTION', 'TRAVEL_DATE', 'DAYS', 'FROM_COUNTRY_ISO', 'TO_COUNTRY_ISO',
  'BUDGET', 'VISIT_VALUE',
];
const CSV_FIELDS = [...LEAD_FIELDS, 'received_at', 'forwarded_at', 'forward_status'];
let stopping = false;

function log(message, ...args) {
  console.log(`${new Date().toISOString()} ${message}`, ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postRequest(url, body, contentType) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
      signal: controller.signal,
    });
    return { response, text: await response.text() };
  } finally {
    clearTimeout(timeout);
  }
}

async function postJson(url, body, contentType) {
  const { response, text } = await postRequest(url, body, contentType);
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON response from ${url}: ${text.slice(0, 300)}`);
  }
  return { response, data };
}

async function fetchLeads() {
  const body = new URLSearchParams({ API_KEY: HELLOTRAVEL_API_KEY }).toString();
  const { data } = await postJson(HELLOTRAVEL_URL, body, 'application/x-www-form-urlencoded');
  if (data.status !== true || data.code !== 200) {
    throw new Error(`HelloTravel rejected request: code=${data.code} msg=${data.msg}`);
  }
  if (!Array.isArray(data.data)) {
    throw new Error('HelloTravel response data is not an array');
  }
  return data.data.filter((lead) => lead && typeof lead === 'object');
}

async function loadProcessedIds() {
  try {
    const content = await fs.readFile(STATE_FILE, 'utf8');
    const ids = JSON.parse(content);
    return new Set(ids.map(String));
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw new Error(`Could not read state file ${STATE_FILE}: ${error.message}`);
  }
}

async function saveProcessedIds(processedIds) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const temporaryFile = `${STATE_FILE}.tmp`;
  await fs.writeFile(temporaryFile, `${JSON.stringify([...processedIds].sort(), null, 2)}\n`);
  await fs.rename(temporaryFile, STATE_FILE);
}

function createNeodovePayload(lead) {
  const extraFields = {};
  for (const field of LEAD_FIELDS) {
    if (!['LEAD_ID', 'NAME', 'EMAIL', 'PHONE', 'DESCRIPTION'].includes(field)) {
      extraFields[field] = lead[field] ?? '';
    }
  }
  return {
    name: String(lead.NAME ?? ''),
    phone: String(lead.PHONE ?? ''),
    email: String(lead.EMAIL ?? ''),
    detail1: String(lead.DESCRIPTION ?? ''),
    detail2: JSON.stringify(extraFields),
  };
}

async function forwardToNeodove(lead) {
  const payload = createNeodovePayload(lead);
  let lastError;
  for (let attempt = 1; attempt <= MAX_FORWARD_ATTEMPTS; attempt += 1) {
    try {
      const { response } = await postRequest(NEODOVE_URL, JSON.stringify(payload), 'application/json');
      if (!response.ok) throw new Error(`Neodove returned HTTP ${response.status}`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_FORWARD_ATTEMPTS) await sleep(Math.min(2 ** (attempt - 1), 8) * 1000);
    }
  }
  throw new Error(`Neodove forwarding failed after ${MAX_FORWARD_ATTEMPTS} attempts: ${lastError.message}`);
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function appendCsv(lead, forwardedAt) {
  const date = new Date().toISOString().slice(0, 10);
  const file = path.join(LEADS_DIR, `leads-${date}.csv`);
  await fs.mkdir(LEADS_DIR, { recursive: true });
  let exists = true;
  try {
    await fs.access(file);
  } catch {
    exists = false;
  }
  const row = LEAD_FIELDS.map((field) => csvEscape(lead[field]));
  row.push(csvEscape(new Date().toISOString()), csvEscape(forwardedAt), 'success');
  const output = `${exists ? '' : `${CSV_FIELDS.join(',')}\n`}${row.join(',')}\n`;
  await fs.appendFile(file, output, 'utf8');
}

async function processPoll(processedIds) {
  const leads = await fetchLeads();
  log(`Fetched ${leads.length} lead(s) from HelloTravel`);
  let changed = false;
  for (const lead of leads) {
    const leadId = String(lead.LEAD_ID ?? '').trim();
    if (!leadId) {
      log(`Skipping lead without LEAD_ID: ${JSON.stringify(lead)}`);
      continue;
    }
    if (processedIds.has(leadId)) {
      log(`Skipping already processed lead ${leadId}`);
      continue;
    }
    await forwardToNeodove(lead);
    await appendCsv(lead, new Date().toISOString());
    processedIds.add(leadId);
    changed = true;
    log(`Forwarded and saved lead ${leadId}`);
  }
  if (changed) await saveProcessedIds(processedIds);
}

async function main() {
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });
  const processedIds = await loadProcessedIds();
  log(`Starting worker; polling every ${POLL_INTERVAL_MS / 1000} seconds`);
  while (!stopping) {
    const started = Date.now();
    try {
      await processPoll(processedIds);
    } catch (error) {
      console.error(`${new Date().toISOString()} Poll failed; will retry on the next cycle`, error);
    }
    const remaining = Math.max(0, POLL_INTERVAL_MS - (Date.now() - started));
    if (!stopping) await sleep(remaining);
  }
  log('Worker stopped');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
