(() => {
  if (window.top !== window || !/^https?:$/.test(location.protocol)) return;

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const POSITIVE = /\b(log[ -]?in|sign[ -]?in|sign[ -]?up|register|create account|continue|next|account|authenticate|join)\b/i;
  const NEGATIVE = /\b(newsletter|subscribe|contact|message|send to|share|invite|updates|marketing|mailing list|notify me|early access|waitlist)\b/i;
  let lastRecorded = { value: "", at: 0 };

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

  function record(candidate, source) {
    if (!candidate || candidate.score < 4) return;
    const now = Date.now();
    if (lastRecorded.value === candidate.email.toLowerCase() && now - lastRecorded.at < 5000) return;
    lastRecorded = { value: candidate.email.toLowerCase(), at: now };
    chrome.runtime.sendMessage({
      type: "RECORD_ACCOUNT",
      payload: { email: candidate.email, hostname: location.hostname, confidence: Math.min(1, candidate.score / 10), source }
    }).catch(() => {});
  }

  document.addEventListener("submit", event => {
    const form = event.target;
    if (form instanceof HTMLFormElement) record(findEmail(form), "form-submit");
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
    if (candidate) record({ ...candidate, score: candidate.score + 1 }, "auth-click");
  }, true);

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
})();
