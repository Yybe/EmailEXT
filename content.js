(() => {
  if (window.top !== window || !/^https?:$/.test(location.protocol)) return;

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const POSITIVE = /\b(log[ -]?in|sign[ -]?in|sign[ -]?up|register|create account|continue|next|account|authenticate|join)\b/i;
  const NEGATIVE = /\b(newsletter|subscribe|contact|message|send to|share|invite|updates|marketing|mailing list|notify me|early access|waitlist)\b/i;
  // Auth-flow confirmation: candidates are staged per-tab on submit and only
  // written to storage once navigation shows the auth flow actually completed.
  // Verification intermediates (2FA, OTP, magic-link, reset) count as auth so a
  // half-finished flow never looks like a successful landing page.
  const AUTH_URL_RE = /(log[ -]?in|sign[ -]?in|sign[ -]?up|signup|register|registration|create[-_]?account|auth(?:enticate|orize)?|session|onboard|join|verify|verification|two[-_]?factor|2fa|mfa|otp|one[-_]?time|passcode|magic[-_]?link|check[-_]?email|email[-_]?sent|unlock|recover|reset)/i;
  const FAILURE_TEXT_RE = /(already\s+(?:exists|registered|has\s+an?\s+account)|no\s+(?:account|user)\s+(?:found|exists)|couldn'?t\s+find|(?:incorrect|wrong)\s+(?:password|username|email|credentials)|invalid\s+(?:password|username|credentials)|(?:account|user)\s+not\s+found)/i;
  const PENDING_KEY = "identityRecallPending";
  const PENDING_TTL_MS = 600000;
  const SETTLE_MS = 3000;
  // Per-document identity + client-side route depth. performance.navigation
  // cannot see SPA route changes, so backward movement inside an app is
  // detected by comparing pushState/popstate depth against the staged depth.
  const DOC_ID = Math.random().toString(36).slice(2);
  let spaDepth = 0;
  let lastRecorded = { value: "", at: 0 };
  let watching = false;
  let settleTimer = null;

  function textFor(element) {
    if (!element) return "";
    const form = element.closest("form");
    const button = form?.querySelector('button[type="submit"], input[type="submit"]');
    return [
      form?.getAttribute("action"), form?.getAttribute("name"), form?.id,
      form?.getAttribute("aria-label"), button?.textContent, button?.value,
      element.name, element.id, element.placeholder, element.getAttribute("aria-label"),
      element.getAttribute("autocomplete"), form?.innerText?.slice(0, 600)
    ].filter(Boolean).join(" ");
  }

  function scoreEmailInput(input) {
    const context = textFor(input);
    const form = input.closest("form");
    let score = 0;
    if (form?.querySelector('input[type="password"]')) score += 5;
    if (/username|email/i.test(input.getAttribute("autocomplete") || "")) score += 2;
    if (POSITIVE.test(context)) score += 3;
    if (/login|signin|signup|register|auth|session|account/i.test(form?.getAttribute("action") || "")) score += 2;
    if (NEGATIVE.test(context)) score -= 7;
    return score;
  }

  function findEmail(scope) {
    const inputs = [...scope.querySelectorAll('input[type="email"], input[autocomplete="email"], input[autocomplete="username"], input[name*="email" i], input[id*="email" i]')];
    return inputs
      .map(input => ({ input, email: input.value.trim(), score: scoreEmailInput(input) }))
      .filter(item => EMAIL_RE.test(item.email))
      .sort((a, b) => b.score - a.score)[0];
  }

  function readPending() {
    try { return JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null"); } catch { return null; }
  }

  function writePending(pending) {
    try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending)); } catch {}
  }

  function clearPending() {
    try { sessionStorage.removeItem(PENDING_KEY); } catch {}
  }

  // Pure decision core: given a staged attempt and where the user is now,
  // decide whether the auth flow completed ("confirm"), failed or was
  // abandoned ("discard"), or is still in progress ("wait").
  // Backward movement — a full-page back/forward load, or an SPA route change
  // that drops the client-side depth at or below the staged depth — always
  // discards, even when the destination is not an auth URL: going back to a
  // home or feed page is how an abandoned signup exits, not how success looks.
  function decideResolution(pending, ctx) {
    if (!pending?.email) return "discard";
    if (ctx.now - pending.stagedAt > PENDING_TTL_MS) return "discard";
    let current;
    try { current = new URL(ctx.url); } catch { return "wait"; }
    const movedBackward =
      ctx.navType === "back_forward" ||
      (ctx.docId === pending.docId &&
        ctx.url !== pending.stagedUrl &&
        ctx.spaDepth <= pending.stagedDepth);
    if (movedBackward) return "discard";
    if (!AUTH_URL_RE.test(current.pathname)) return "confirm";
    if (ctx.url !== pending.stagedUrl) return "wait";
    return ctx.formVisible ? "wait" : "confirm";
  }

  function confirmPending(pending) {
    clearPending();
    chrome.runtime.sendMessage({
      type: "RECORD_ACCOUNT",
      payload: { email: pending.email, hostname: pending.hostname, confidence: pending.confidence, source: pending.source }
    }).catch(() => {});
  }

  function stagePending(candidate, source) {
    if (!candidate || candidate.score < 4) return;
    const now = Date.now();
    if (lastRecorded.value === candidate.email.toLowerCase() && now - lastRecorded.at < 5000) return;
    lastRecorded = { value: candidate.email.toLowerCase(), at: now };
    writePending({
      email: candidate.email,
      hostname: location.hostname,
      confidence: Math.min(1, candidate.score / 10),
      source,
      stagedAt: now,
      stagedUrl: location.href,
      docId: DOC_ID,
      stagedDepth: spaDepth
    });
    evaluate();
  }

  function authFormVisible() {
    return [...document.querySelectorAll('input[type="email"], input[type="password"], input[autocomplete="email"], input[autocomplete="username"], input[name*="email" i], input[id*="email" i]')]
      .some(el => el.getClientRects().length > 0);
  }

  function currentNavigationType() {
    try { return performance.getEntriesByType("navigation")[0]?.type || ""; } catch { return ""; }
  }

  function snapshotCtx() {
    return {
      url: location.href,
      navType: currentNavigationType(),
      spaDepth,
      docId: DOC_ID,
      formVisible: authFormVisible(),
      now: Date.now()
    };
  }

  // Never record on first sight of a non-auth page: wait out redirect chains,
  // then re-check. If the bounce landed back on auth or an error appeared, the
  // attempt was not a success.
  function scheduleConfirm(pending) {
    if (settleTimer !== null) return;
    settleTimer = setTimeout(() => {
      settleTimer = null;
      const current = readPending();
      if (!current || current.stagedAt !== pending.stagedAt) return;
      if (FAILURE_TEXT_RE.test((document.body?.innerText || "").slice(0, 4000))) return clearPending();
      if (decideResolution(current, snapshotCtx()) === "confirm") confirmPending(current);
    }, SETTLE_MS);
  }

  function evaluate() {
    const pending = readPending();
    if (!pending) return;
    // A fresh document invalidates the previous document's SPA depth baseline:
    // depth restarts at zero AND the staged URL rebases to this page, otherwise
    // every full-page landing would read as backward movement.
    if (pending.docId !== DOC_ID) {
      pending.docId = DOC_ID;
      pending.stagedDepth = 0;
      pending.stagedUrl = location.href;
      writePending(pending);
    }
    const decision = decideResolution(pending, snapshotCtx());
    if (decision === "confirm") return scheduleConfirm(pending);
    if (decision === "discard") return clearPending();
    if (location.href !== pending.stagedUrl) {
      pending.stagedUrl = location.href;
      writePending(pending);
    }
    watchBriefly(pending);
  }

  // Same-page resolution window: covers SPA logins that never navigate and
  // full reloads of the same auth URL. Uniform 3s checks over an ~18s window;
  // if the form disappears the login completed, failure text or a
  // still-present form discards the attempt.
  function watchBriefly(staged) {
    if (watching) return;
    watching = true;
    const delays = [3000, 3000, 3000, 3000, 3000];
    let index = 0;
    const tick = () => {
      const current = readPending();
      if (!current || current.stagedAt !== staged.stagedAt) { watching = false; return; }
      if (FAILURE_TEXT_RE.test((document.body?.innerText || "").slice(0, 4000))) {
        clearPending();
        watching = false;
        return;
      }
      const decision = decideResolution(current, snapshotCtx());
      if (decision === "confirm") { scheduleConfirm(current); watching = false; return; }
      if (decision === "discard") { clearPending(); watching = false; return; }
      if (location.href !== current.stagedUrl) {
        current.stagedUrl = location.href;
        writePending(current);
      }
      if (index < delays.length) {
        setTimeout(tick, delays[index++]);
        return;
      }
      clearPending();
      watching = false;
    };
    setTimeout(tick, delays[0]);
  }

  document.addEventListener("submit", event => {
    const form = event.target;
    if (form instanceof HTMLFormElement) stagePending(findEmail(form), "form-submit");
  }, true);

  document.addEventListener("click", event => {
    const button = event.target.closest('button, input[type="submit"], [role="button"]');
    if (!button) return;
    // Cheap checks first: reading form.innerText forces a layout pass on every
    // click of every page, so only touch it when the button's own text cannot
    // decide the outcome. Accept/reject semantics match the combined-context test.
    const quick = [button.textContent, button.value, button.getAttribute("aria-label")].filter(Boolean).join(" ");
    if (NEGATIVE.test(quick)) return;
    const form = button.closest("form");
    if (POSITIVE.test(quick)) {
      if (form && NEGATIVE.test(form.innerText?.slice(0, 500) || "")) return;
    } else {
      if (!form) return;
      const formText = form.innerText?.slice(0, 500) || "";
      if (!POSITIVE.test(formText) || NEGATIVE.test(formText)) return;
    }
    const scope = form || document;
    const candidate = findEmail(scope);
    if (candidate) stagePending({ ...candidate, score: candidate.score + 1 }, "auth-click");
  }, true);

  // SPA transitions that swap views without a full page load. Depth increases
  // on pushed/replaced routes and decreases on popstate, so returning to a
  // route at or below the staged depth is detectable as backward movement.
  const wrapHistory = type => {
    const original = history[type];
    history[type] = function (...args) {
      const result = original.apply(this, args);
      spaDepth += 1;
      evaluate();
      return result;
    };
  };
  try { wrapHistory("pushState"); wrapHistory("replaceState"); } catch {}
  window.addEventListener("popstate", () => { spaDepth -= 1; evaluate(); });
  window.addEventListener("hashchange", evaluate);

  // Resolve any attempt staged by a previous page in this tab.
  evaluate();

  function relativeTime(timestamp) {
    const seconds = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
    const units = [[31536000, "year"], [2592000, "month"], [86400, "day"], [3600, "hour"], [60, "minute"]];
    for (const [size, label] of units) {
      if (seconds >= size) {
        const amount = Math.floor(seconds / size);
        return `${amount} ${label}${amount === 1 ? "" : "s"} ago`;
      }
    }
    return "just now";
  }

  function showReminder(site, cooldownHours) {
    if (!site?.accounts?.length || document.getElementById("identity-recall-reminder")) return;
    const cooldownKey = `identityRecallShown:${site.siteKey}`;
    const lastShown = Number(sessionStorage.getItem(cooldownKey) || 0);
    if (Date.now() - lastShown < cooldownHours * 3600000) return;
    sessionStorage.setItem(cooldownKey, String(Date.now()));

    const accounts = site.accounts.slice(0, 3);
    const root = document.createElement("div");
    root.id = "identity-recall-reminder";
    const shadow = root.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
        :host{all:initial} .card{position:fixed;z-index:2147483647;right:18px;top:18px;width:290px;box-sizing:border-box;padding:14px;background:#111318;color:#f4f5f7;border:1px solid rgba(255,255,255,.12);border-radius:14px;box-shadow:0 16px 45px rgba(0,0,0,.32);font:13px/1.4 Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;animation:enter .22s ease-out} @keyframes enter{from{opacity:0;transform:translateY(-8px) scale(.98)}}
        .top{display:flex;align-items:center;gap:9px;margin-bottom:10px}.mark{width:25px;height:25px;border-radius:8px;background:#7c5cff;display:grid;place-items:center;font-weight:800}.title{font-weight:650;flex:1}.close{border:0;background:transparent;color:#858b98;font-size:19px;cursor:pointer;padding:0 2px}.label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#858b98;margin-bottom:4px}.account{padding:8px 0;border-top:1px solid rgba(255,255,255,.08)}.email{font-weight:570;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.time{color:#9298a5;font-size:11px;margin-top:1px}.more{color:#a997ff;font-size:11px;margin-top:5px}
      `;

    const aside = document.createElement("aside");
    aside.className = "card";
    aside.setAttribute("role", "status");
    aside.setAttribute("aria-label", "Previously used accounts");

    const top = document.createElement("div");
    top.className = "top";
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = "i";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = "Previously used here";
    const close = document.createElement("button");
    close.className = "close";
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "×";
    top.append(mark, title, close);

    const label = document.createElement("div");
    label.className = "label";
    label.textContent = accounts.length === 1 ? "Account" : "Accounts";
    aside.append(top, label);

    for (const account of accounts) {
      const row = document.createElement("div");
      row.className = "account";
      const emailNode = document.createElement("div");
      emailNode.className = "email";
      emailNode.textContent = account.email;
      const time = document.createElement("div");
      time.className = "time";
      time.textContent = `Last used ${relativeTime(account.lastUsedAt)}`;
      row.append(emailNode, time);
      aside.appendChild(row);
    }

    if (site.accounts.length > 3) {
      const more = document.createElement("div");
      more.className = "more";
      more.textContent = `+${site.accounts.length - 3} more in Identity Recall`;
      aside.appendChild(more);
    }

    close.addEventListener("click", () => root.remove());
    shadow.append(style, aside);
    document.documentElement.appendChild(root);
    setTimeout(() => root.remove(), 10000);
  }

  setTimeout(async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_SITE", hostname: location.hostname });
      if (response?.settings?.reminders) showReminder(response.site, response.settings.reminderCooldownHours || 24);
    } catch {}
  }, 1100);

  // Test hook: no-op in the browser, used by the node VM test harness.
  if (globalThis.__IDENTITY_RECALL_TEST__) {
    globalThis.__IDENTITY_RECALL_TEST__({
      decideResolution,
      stagePending,
      evaluate,
      readPending,
      clearPending,
      context: snapshotCtx
    });
  }
})();
