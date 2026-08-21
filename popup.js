const $ = selector => document.querySelector(selector);
let currentHostname = "";

function relativeTime(timestamp) {
  const seconds = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
  const units = [[31536000,"year"],[2592000,"month"],[86400,"day"],[3600,"hour"],[60,"minute"]];
  for (const [size, label] of units) if (seconds >= size) {
    const n = Math.floor(seconds / size);
    return `${n} ${label}${n === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

function render(site, siteKey) {
  $("#loading").hidden = true;
  $("#content").hidden = false;
  $("#siteName").textContent = siteKey || currentHostname || "This page";
  const accounts = site?.accounts || [];
  $("#count").textContent = `${accounts.length} account${accounts.length === 1 ? "" : "s"}`;
  $("#empty").hidden = accounts.length > 0;
  const container = $("#accounts");
  container.replaceChildren();
  accounts.forEach((account, index) => {
    const row = document.createElement("div");
    row.className = "account-row animate";
    row.style.animationDelay = `${index * 35}ms`;
    row.innerHTML = `<div class="avatar"></div><div class="account-copy"><div class="email"></div><div class="meta"></div></div>`;
    row.querySelector(".avatar").textContent = account.email[0];
    row.querySelector(".email").textContent = account.email;
    row.querySelector(".meta").textContent = `Last used ${relativeTime(account.lastUsedAt)}`;
    container.appendChild(row);
  });
}

async function load() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { currentHostname = new URL(tab.url).hostname; } catch { currentHostname = ""; }
  if (!currentHostname) return render(null, "Unsupported page");
  const response = await chrome.runtime.sendMessage({ type: "GET_SITE", hostname: currentHostname });
  render(response.site, response.siteKey);
}

$("#addForm").addEventListener("submit", async event => {
  event.preventDefault();
  const email = $("#emailInput").value.trim();
  const response = await chrome.runtime.sendMessage({ type:"RECORD_ACCOUNT", payload:{ email, hostname:currentHostname, source:"manual", confidence:1 } });
  if (response.ok) {
    $("#emailInput").value = "";
    render(response.site, response.site.siteKey);
  }
});
$("#openDashboard").addEventListener("click", () => chrome.runtime.openOptionsPage());
load();
