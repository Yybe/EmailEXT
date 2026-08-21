const STORAGE_KEY = "identityRecallRecords";
const SETTINGS_KEY = "identityRecallSettings";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidTimestamp(value) {
  return Number.isFinite(value) && value > 0;
}

function validateBackupRecords(records) {
  if (!records || typeof records !== "object" || Array.isArray(records)) return "Invalid backup file";
  for (const [siteKey, site] of Object.entries(records)) {
    if (!siteKey || !site || typeof site !== "object" || Array.isArray(site)) return "Invalid website entry in backup";
    if (!site.accounts || typeof site.accounts !== "object" || Array.isArray(site.accounts)) return `Invalid accounts for ${siteKey}`;
    if (!isValidTimestamp(site.createdAt) || !isValidTimestamp(site.updatedAt)) return `Invalid timestamps for ${siteKey}`;
    for (const [email, account] of Object.entries(site.accounts)) {
      if (!BACKUP_EMAIL_RE.test(email)) return "Invalid email address in backup";
      if (!account || typeof account !== "object" || Array.isArray(account)) return "Invalid account entry in backup";
      if (!isValidTimestamp(account.firstUsedAt) || !isValidTimestamp(account.lastUsedAt)) return `Invalid timestamps for ${email}`;
      if (!Number.isFinite(account.useCount) || account.useCount < 1) return `Invalid usage count for ${email}`;
      if (account.note !== undefined && typeof account.note !== "string") return `Invalid note for ${email}`;
    }
  }
  return null;
}

const DEFAULT_SETTINGS = {
  reminders: true,
  reminderCooldownHours: 24
};

const MULTIPART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au",
  "co.in", "firm.in", "net.in", "org.in", "gen.in", "ind.in", "co.jp",
  "co.nz", "com.br", "com.cn", "com.sg", "com.mx", "co.za"
]);

function siteKeyFromHostname(hostname = "") {
  const host = hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (!host || host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join(".");
  return MULTIPART_SUFFIXES.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

function normalizeEmail(email = "") {
  return email.trim().toLowerCase();
}

async function readState() {
  const data = await chrome.storage.local.get([STORAGE_KEY, SETTINGS_KEY]);
  return {
    records: data[STORAGE_KEY] || {},
    settings: { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) }
  };
}

async function writeRecords(records) {
  await chrome.storage.local.set({ [STORAGE_KEY]: records });
}

// Serializes all read-modify-write cycles on the records blob so concurrent
// messages (e.g. simultaneous logins in two tabs) cannot interleave and lose updates.
let recordsLock = Promise.resolve();

function withRecordsLock(task) {
  const result = recordsLock.then(task);
  recordsLock = result.then(() => {}, () => {});
  return result;
}

function publicSite(site) {
  if (!site) return null;
  return {
    ...site,
    accounts: Object.values(site.accounts || {}).sort((a, b) => b.lastUsedAt - a.lastUsedAt)
  };
}

async function recordAccount(payload) {
  const email = normalizeEmail(payload.email);
  const hostname = (payload.hostname || "").toLowerCase();
  const siteKey = siteKeyFromHostname(hostname);
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email address" };
  if (!siteKey) return { ok: false, error: "Open a website to remember an account for it" };

  return withRecordsLock(async () => {
    const { records } = await readState();
    const now = Date.now();
    const site = records[siteKey] || {
      siteKey,
      hostname,
      hostnames: [],
      createdAt: now,
      updatedAt: now,
      accounts: {}
    };
    if (!site.hostnames.includes(hostname)) site.hostnames.push(hostname);
    const previous = site.accounts[email];
    site.accounts[email] = {
      email,
      firstUsedAt: previous?.firstUsedAt || now,
      lastUsedAt: now,
      useCount: (previous?.useCount || 0) + 1,
      source: payload.source || "detected",
      confidence: Math.max(previous?.confidence || 0, payload.confidence || 0),
      note: previous?.note || ""
    };
    site.updatedAt = now;
    site.hostname = hostname || site.hostname;
    records[siteKey] = site;
    await writeRecords(records);
    return { ok: true, site: publicSite(site) };
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await readState();
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const { records, settings } = await readState();
    switch (message.type) {
      case "RECORD_ACCOUNT":
        sendResponse(await recordAccount({ ...message.payload, hostname: message.payload.hostname || sender.tab?.url && new URL(sender.tab.url).hostname }));
        break;
      case "GET_SITE": {
        const key = siteKeyFromHostname(message.hostname || "");
        sendResponse({ site: publicSite(records[key]), settings, siteKey: key });
        break;
      }
      case "GET_ALL":
        sendResponse({ sites: Object.values(records).map(publicSite).sort((a, b) => b.updatedAt - a.updatedAt), settings });
        break;
      case "DELETE_ACCOUNT": {
        sendResponse(await withRecordsLock(async () => {
          const { records } = await readState();
          const site = records[message.siteKey];
          if (site) {
            delete site.accounts[normalizeEmail(message.email)];
            if (!Object.keys(site.accounts).length) delete records[message.siteKey];
            else site.updatedAt = Date.now();
            await writeRecords(records);
          }
          return { ok: true };
        }));
        break;
      }
      case "UPDATE_ACCOUNT": {
        sendResponse(await withRecordsLock(async () => {
          const { records } = await readState();
          const site = records[message.siteKey];
          const oldEmail = normalizeEmail(message.oldEmail);
          const newEmail = normalizeEmail(message.newEmail);
          if (!site?.accounts[oldEmail] || !EMAIL_RE.test(newEmail)) {
            return { ok: false, error: "Enter a valid email address" };
          }
          const account = { ...site.accounts[oldEmail], email: newEmail, note: (message.note || "").trim() };
          delete site.accounts[oldEmail];
          site.accounts[newEmail] = account;
          site.updatedAt = Date.now();
          await writeRecords(records);
          return { ok: true };
        }));
        break;
      }
      case "SAVE_SETTINGS":
        await chrome.storage.local.set({ [SETTINGS_KEY]: { ...settings, ...message.settings } });
        sendResponse({ ok: true });
        break;
      case "IMPORT_DATA": {
        const error = validateBackupRecords(message.data?.records);
        if (error) {
          sendResponse({ ok: false, error });
          break;
        }
        await withRecordsLock(async () => {
          await chrome.storage.local.set({ [STORAGE_KEY]: message.data.records });
        });
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: "Unknown message" });
    }
  })().catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});
