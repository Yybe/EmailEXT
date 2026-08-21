// Pipeline tests for Identity Recall's stage -> confirm -> record logic.
// Loads the REAL content.js and background.js into node vm sandboxes with
// stubbed browser APIs, then walks realistic user journeys through them.
//
// Run: node tests/pipeline.test.js

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const CONTENT_SOURCE = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
const BACKGROUND_SOURCE = fs.readFileSync(path.join(ROOT, "background.js"), "utf8");

let failed = 0;
function check(name, got, expected) {
  const pass = JSON.stringify(got) === JSON.stringify(expected);
  if (!pass) {
    failed++;
    console.log(`FAIL : ${name}\n       got:      ${JSON.stringify(got)}\n       expected: ${JSON.stringify(expected)}`);
  } else {
    console.log(`PASS : ${name}`);
  }
}
const drain = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };

// Map-backed sessionStorage stand-in; one instance per tab, shared across legs.
function makeStorage() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k)
  };
}

// ---------- content.js sandbox ----------
// Each call simulates ONE full page load in a tab: sessionStorage persists
// across legs via the shared storage object, timers do not survive the unload.
function loadContent({ storage, initialHref, navType = "navigate", visibleInputs = 0, bodyText = "" }) {
  const sent = [];
  const listeners = {};
  const timers = [];
  let clock = 0;
  let timerSeq = 0;
  let href = initialHref;
  let inputs = visibleInputs;
  let text = bodyText;

  const api = {};
  const locationObj = {
    get href() { return href; },
    set href(v) { href = String(v); },
    get protocol() { return new URL(href).protocol; },
    get hostname() { return new URL(href).hostname; },
    get pathname() { return new URL(href).pathname; }
  };
  const sandbox = {
    console,
    URL,
    Date,
    Math,
    JSON,
    Number,
    String,
    __IDENTITY_RECALL_TEST__: hooks => Object.assign(api, hooks),
    performance: { getEntriesByType: () => [{ type: navType }] },
    sessionStorage: storage,
    chrome: {
      runtime: {
        sendMessage: async msg => {
          sent.push(msg);
          if (msg.type === "GET_SITE") return { site: null, settings: null };
          return { ok: true };
        }
      }
    },
    document: {
      addEventListener: () => {},
      getElementById: () => null,
      documentElement: { appendChild: () => {} },
      querySelectorAll: () => Array.from({ length: inputs }, () => ({ getClientRects: () => [{}] })),
      closest: () => null,
      body: { get innerText() { return typeof text === "function" ? text() : text; } }
    },
    window: (() => {
      // Top-level page: window.top must reference window itself or the
      // content script's iframe guard returns before anything runs.
      const win = {
        addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); }
      };
      win.top = win;
      return win;
    })(),
    history: {
      pushState: (state, title, url) => { if (url) href = new URL(url, href).href; },
      replaceState: (state, title, url) => { if (url) href = new URL(url, href).href; }
    },
    setTimeout: (fn, ms) => { const id = ++timerSeq; timers.push({ id, at: clock + ms, fn }); return id; },
    clearTimeout: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); }
  };
  sandbox.location = locationObj;
  vm.createContext(sandbox);
  vm.runInContext(CONTENT_SOURCE, sandbox, { filename: "content.js" });

  return {
    sent,
    api,
    setVisible(n) { inputs = n; },
    setBody(t) { text = t; },
    navigate(url, mode = "push") {
      href = new URL(url, href).href;
      if (mode === "push") sandbox.history.pushState(null, "", url);
      else if (mode === "replace") sandbox.history.replaceState(null, "", url);
      else if (mode === "pop") (listeners.popstate || []).forEach(fn => fn());
    },
    async flush(ms) {
      const until = clock + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > until) break;
        clock = next.at;
        timers.shift();
        next.fn();
        await drain();
      }
      clock = until;
      await drain();
    }
  };
}

// ---------- background.js sandbox ----------
function loadBackground() {
  const storeMap = new Map();
  let messageHandler = null;
  const sandbox = {
    console,
    JSON,
    Math,
    Date,
    URL,
    chrome: {
      storage: {
        local: {
          get: async keys => {
            const arr = Array.isArray(keys) ? keys : [keys];
            const out = {};
            for (const k of arr) if (storeMap.has(k)) out[k] = storeMap.get(k);
            return out;
          },
          set: async obj => { for (const [k, v] of Object.entries(obj)) storeMap.set(k, v); }
        }
      },
      runtime: {
        onInstalled: { addListener: () => {} },
        onMessage: { addListener: fn => { messageHandler = fn; } }
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(BACKGROUND_SOURCE, sandbox, { filename: "background.js" });
  return {
    drive: msg => new Promise(resolve => messageHandler(msg, {}, resolve)),
    accounts: siteKey => {
      const records = storeMap.get("identityRecallRecords") || {};
      return Object.keys((records[siteKey] || {}).accounts || {}).sort();
    }
  };
}

const RECORDS = sent => sent.filter(m => m.type === "RECORD_ACCOUNT").map(m => m.payload.email);

(async () => {
  // ---------- (1) typed email + abandoned signup = no record ----------
  {
    const storage = makeStorage();
    const leg1 = loadContent({ storage, initialHref: "https://serper.com/signup", visibleInputs: 1 });
    leg1.api.stagePending({ email: "auggie000003@gmail.com", score: 8 }, "form-submit");
    await leg1.flush(2000); // first watcher tick sees the form still there -> wait
    const leg2 = loadContent({ storage, initialHref: "https://serper.com/login", navType: "back_forward", visibleInputs: 1 });
    await leg2.flush(100); // auto-evaluate on load
    check("1a abandoned signup, full-page Back -> no record", RECORDS(leg1.sent).concat(RECORDS(leg2.sent)), []);
    check("1a pending cleared after Back", storage.getItem("identityRecallPending"), null);
  }
  {
    // SPA variant: router pops back to a non-auth page (the serper.com leak)
    const storage = makeStorage();
    const leg = loadContent({ storage, initialHref: "https://serper.com/signup", visibleInputs: 1 });
    leg.api.stagePending({ email: "auggie000003@gmail.com", score: 8 }, "auth-click");
    await leg.flush(100);
    leg.navigate("https://serper.com/", "pop"); // SPA Back: depth drops below staged depth
    await leg.flush(16000);
    check("1b abandoned signup, SPA Back to home -> no record", RECORDS(leg.sent), []);
    check("1b pending cleared after SPA Back", storage.getItem("identityRecallPending"), null);
  }

  // ---------- (2) failed login = no record ----------
  {
    const storage = makeStorage();
    const leg = loadContent({ storage, initialHref: "https://serper.com/login", visibleInputs: 1 });
    leg.api.stagePending({ email: "auggie000002@gmail.com", score: 9 }, "form-submit");
    leg.setBody("Incorrect password. Please try again.");
    await leg.flush(3500); // watcher tick spots the failure text
    check("2a failed login with error text -> no record", RECORDS(leg.sent), []);
    check("2a pending cleared after error", storage.getItem("identityRecallPending"), null);
  }
  {
    const storage = makeStorage();
    const leg = loadContent({ storage, initialHref: "https://serper.com/login", visibleInputs: 1 });
    leg.api.stagePending({ email: "auggie000002@gmail.com", score: 9 }, "form-submit");
    await leg.flush(19000); // nothing ever happens: form stays, no navigation
    check("2b stalled login (no navigation) -> no record", RECORDS(leg.sent), []);
    check("2b pending cleared after timeout", storage.getItem("identityRecallPending"), null);
  }

  // ---------- (3) successful login = record ----------
  {
    const storage = makeStorage();
    const leg1 = loadContent({ storage, initialHref: "https://serper.com/login", visibleInputs: 1 });
    leg1.api.stagePending({ email: "auggie000002@gmail.com", score: 9 }, "form-submit");
    await leg1.flush(100);
    const leg2 = loadContent({ storage, initialHref: "https://serper.com/dashboard", visibleInputs: 0 });
    await leg2.flush(3500); // settle window must elapse before the record lands
    check("3a successful login (full navigation) -> recorded", RECORDS(leg2.sent), ["auggie000002@gmail.com"]);
    check("3a pending cleared after confirm", storage.getItem("identityRecallPending"), null);
  }
  {
    const storage = makeStorage();
    const leg = loadContent({ storage, initialHref: "https://serper.com/login", visibleInputs: 1 });
    leg.api.stagePending({ email: "auggie000002@gmail.com", score: 9 }, "auth-click");
    await leg.flush(100);
    leg.navigate("https://serper.com/dashboard", "push"); // SPA success
    await leg.flush(3500);
    check("3b successful login (SPA pushState) -> recorded", RECORDS(leg.sent), ["auggie000002@gmail.com"]);
  }

  // ---------- (4) successful signup = record ----------
  {
    const storage = makeStorage();
    const leg = loadContent({ storage, initialHref: "https://serper.com/signup", visibleInputs: 1 });
    leg.api.stagePending({ email: "auggie000003@gmail.com", score: 8 }, "form-submit");
    await leg.flush(100);
    leg.navigate("https://serper.com/welcome", "push");
    await leg.flush(3500);
    check("4 successful signup -> recorded", RECORDS(leg.sent), ["auggie000003@gmail.com"]);
  }

  // ---------- (5) multiple successful accounts on the same domain ----------
  {
    const bg = loadBackground();
    await bg.drive({ type: "RECORD_ACCOUNT", payload: { email: "auggie000002@gmail.com", hostname: "serper.com", confidence: 1, source: "detected" } });
    await bg.drive({ type: "RECORD_ACCOUNT", payload: { email: "auggie000003@gmail.com", hostname: "serper.com", confidence: 1, source: "detected" } });
    check("5 background keeps both accounts for serper.com", bg.accounts("serper.com"), ["auggie000002@gmail.com", "auggie000003@gmail.com"]);
    const all = await bg.drive({ type: "GET_ALL" });
    check("5 GET_ALL exposes both accounts", all.sites[0].accounts.map(a => a.email).sort(), ["auggie000002@gmail.com", "auggie000003@gmail.com"]);
  }
  {
    // Content level: two independent confirmed journeys on one domain
    const storage = makeStorage();
    const leg = loadContent({ storage, initialHref: "https://serper.com/login", visibleInputs: 1 });
    leg.api.stagePending({ email: "auggie000002@gmail.com", score: 9 }, "form-submit");
    await leg.flush(100);
    leg.navigate("https://serper.com/dashboard", "push");
    await leg.flush(3500);
    leg.navigate("https://serper.com/login", "push"); // second journey, later sign-in
    leg.setVisible(1);
    leg.api.stagePending({ email: "auggie000003@gmail.com", score: 8 }, "form-submit");
    await leg.flush(100);
    leg.navigate("https://serper.com/dashboard", "push");
    await leg.flush(3500);
    check("5 content pipeline records both journeys", RECORDS(leg.sent).sort(), ["auggie000002@gmail.com", "auggie000003@gmail.com"]);
  }

  // ---------- regressions ----------
  {
    // Multi-step login: email step -> password step -> dashboard
    const storage = makeStorage();
    const leg = loadContent({ storage, initialHref: "https://serper.com/login", visibleInputs: 1 });
    leg.api.stagePending({ email: "auggie000002@gmail.com", score: 9 }, "form-submit");
    await leg.flush(100);
    leg.navigate("https://serper.com/login/password", "push");
    await leg.flush(2000);
    check("R1 multi-step keeps waiting, no premature record", RECORDS(leg.sent), []);
    leg.navigate("https://serper.com/dashboard", "push");
    await leg.flush(3500);
    check("R1 multi-step completes -> recorded once", RECORDS(leg.sent), ["auggie000002@gmail.com"]);
  }
  {
    // 2FA page is an auth intermediate, not a success landing
    const storage = makeStorage();
    const leg = loadContent({ storage, initialHref: "https://serper.com/login", visibleInputs: 1 });
    leg.api.stagePending({ email: "auggie000002@gmail.com", score: 9 }, "form-submit");
    await leg.flush(100);
    leg.navigate("https://serper.com/two-factor", "push");
    await leg.flush(4000);
    check("R2 2FA page does not confirm early", RECORDS(leg.sent), []);
    leg.navigate("https://serper.com/login", "pop"); // user bails on 2FA
    await leg.flush(16000);
    check("R2 bailing out of 2FA discards", RECORDS(leg.sent), []);
    check("R2 pending cleared after 2FA bail", storage.getItem("identityRecallPending"), null);
  }
  {
    // Sites that redirect with replaceState after login still record
    const storage = makeStorage();
    const leg = loadContent({ storage, initialHref: "https://serper.com/login", visibleInputs: 1 });
    leg.api.stagePending({ email: "auggie000002@gmail.com", score: 9 }, "form-submit");
    await leg.flush(100);
    leg.navigate("https://serper.com/dashboard", "replace");
    await leg.flush(3500);
    check("R3 replaceState redirect after login -> recorded", RECORDS(leg.sent), ["auggie000002@gmail.com"]);
  }
  {
    // Settle bounce: flash to a non-auth route, then immediately back
    const storage = makeStorage();
    const leg = loadContent({ storage, initialHref: "https://serper.com/login", visibleInputs: 1 });
    leg.api.stagePending({ email: "auggie000002@gmail.com", score: 9 }, "form-submit");
    await leg.flush(100);
    leg.navigate("https://serper.com/dashboard", "push"); // triggers settle timer
    leg.navigate("https://serper.com/login", "pop");      // bounced back within 3s
    await leg.flush(19000);
    check("R4 bounce back within settle window -> no record", RECORDS(leg.sent), []);
    check("R4 pending eventually cleared", storage.getItem("identityRecallPending"), null);
  }
  {
    // Pure decision matrix spot-checks
    const storage = makeStorage();
    const leg = loadContent({ storage, initialHref: "https://serper.com/login", visibleInputs: 1 });
    const now = Date.now();
    const pending = { email: "x@y.com", stagedAt: now, stagedUrl: "https://s.com/login", docId: "d1", stagedDepth: 0 };
    check("P stale pending discards", leg.api.decideResolution(pending, { url: "https://s.com/login", navType: "", spaDepth: 0, docId: "d1", formVisible: true, now: now + 600001 }), "discard");
    check("P malformed URL waits", leg.api.decideResolution(pending, { url: "::bad::", navType: "", spaDepth: 0, docId: "d1", formVisible: true, now }), "wait");
    check("P missing pending discards", leg.api.decideResolution(null, { url: "https://s.com/", navType: "", spaDepth: 0, docId: "d1", formVisible: false, now }), "discard");
  }

  console.log(failed === 0 ? "\nALL PIPELINE TESTS PASSED" : `\n${failed} PIPELINE TEST(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(err => { console.error(err); process.exit(1); });
