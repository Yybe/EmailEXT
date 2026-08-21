const STORAGE_KEY = "identityRecallRecords";
const SETTINGS_KEY = "identityRecallSettings";

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
  if (!email || !siteKey || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false };

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
        const site = records[message.siteKey];
        if (site) {
          delete site.accounts[normalizeEmail(message.email)];
          if (!Object.keys(site.accounts).length) delete records[message.siteKey];
          else site.updatedAt = Date.now();
          await writeRecords(records);
        }
        sendResponse({ ok: true });
        break;
      }
      case "UPDATE_ACCOUNT": {
        const site = records[message.siteKey];
        const oldEmail = normalizeEmail(message.oldEmail);
        const newEmail = normalizeEmail(message.newEmail);
        if (!site?.accounts[oldEmail] || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
          sendResponse({ ok: false });
          break;
        }
        const account = { ...site.accounts[oldEmail], email: newEmail, note: (message.note || "").trim() };
        delete site.accounts[oldEmail];
        site.accounts[newEmail] = account;
        site.updatedAt = Date.now();
        await writeRecords(records);
        sendResponse({ ok: true });
        break;
      }
      case "SAVE_SETTINGS":
        await chrome.storage.local.set({ [SETTINGS_KEY]: { ...settings, ...message.settings } });
        sendResponse({ ok: true });
        break;
      case "IMPORT_DATA": {
        const incoming = message.data?.records;
        if (!incoming || typeof incoming !== "object") {
          sendResponse({ ok: false, error: "Invalid backup file" });
          break;
        }
        await chrome.storage.local.set({ [STORAGE_KEY]: incoming });
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: "Unknown message" });
    }
  })().catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});
