const $ = selector => document.querySelector(selector);
let sites = [];
let settings = {};
let editing = null;

function relativeTime(timestamp) {
  const seconds = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
  const units = [[31536000,"year"],[2592000,"month"],[86400,"day"],[3600,"hour"],[60,"minute"]];
  for (const [size,label] of units) if (seconds >= size) { const n=Math.floor(seconds/size);return `${n} ${label}${n===1?"":"s"} ago`; }
  return "just now";
}

function toast(message) {
  const node = $("#toast"); node.textContent = message; node.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove("show"), 1800);
}

function render() {
  const query = $("#search").value.trim().toLowerCase();
  const matches = sites.map(site => ({ ...site, accounts: query ? site.accounts.filter(a => site.siteKey.toLowerCase().includes(query) || site.hostname.toLowerCase().includes(query) || a.email.toLowerCase().includes(query) || (a.note || "").toLowerCase().includes(query)) : site.accounts }))
    .filter(site => site.accounts.length);
  $("#siteTotal").textContent = sites.length;
  $("#accountTotal").textContent = sites.reduce((sum, site) => sum + site.accounts.length, 0);
  $("#resultTitle").textContent = query ? "Search results" : "Recently used";
  $("#resultCount").textContent = query ? `${matches.length} website${matches.length === 1 ? "" : "s"}` : "";
  const list = $("#sites"); list.replaceChildren();
  matches.forEach((site, index) => {
    const card = document.createElement("article"); card.className="site-card"; card.style.animationDelay=`${Math.min(index,8)*30}ms`;
    card.innerHTML = `<div class="site-header"><div class="favicon"></div><div class="site-copy"><div class="site-name"></div><div class="site-sub"></div></div><span class="pill"></span></div><div class="site-accounts"></div>`;
    card.querySelector(".favicon").textContent = site.siteKey[0].toUpperCase();
    card.querySelector(".site-name").textContent = site.siteKey;
    card.querySelector(".site-sub").textContent = `Last activity ${relativeTime(site.updatedAt)}`;
    card.querySelector(".pill").textContent = `${site.accounts.length} account${site.accounts.length===1?"":"s"}`;
    const accountList = card.querySelector(".site-accounts");
    site.accounts.forEach(account => {
      const row = document.createElement("div"); row.className="account-row"; row.tabIndex=0;
      row.innerHTML=`<div class="avatar"></div><div class="account-copy"><div class="email"></div><div class="meta"></div><div class="note"></div></div><span class="muted">•••</span>`;
      row.querySelector(".avatar").textContent=account.email[0]; row.querySelector(".email").textContent=account.email;
      row.querySelector(".meta").textContent=`First used ${relativeTime(account.firstUsedAt)} · Last used ${relativeTime(account.lastUsedAt)} · ${account.useCount} use${account.useCount===1?"":"s"}`;
      row.querySelector(".note").textContent=account.note || "";
      const open=()=>openEdit(site,account); row.addEventListener("click",open); row.addEventListener("keydown",e=>{if(e.key==="Enter")open()}); accountList.appendChild(row);
    }); list.appendChild(card);
  });
  $("#emptyState").hidden = matches.length > 0;
  $("#emptyTitle").textContent = query ? "No matching identities" : "Nothing remembered yet";
  $("#emptyCopy").textContent = query ? "Try a website, domain, email, or note." : "Use the web normally. Accounts will appear here after you log in.";
}

function openEdit(site, account) {
  editing={siteKey:site.siteKey,oldEmail:account.email}; $("#editEmail").value=account.email; $("#editNote").value=account.note || ""; $("#editDialog").showModal();
}

async function reload() {
  const data=await chrome.runtime.sendMessage({type:"GET_ALL"}); sites=data.sites || []; settings=data.settings || {}; $("#reminders").checked=settings.reminders !== false; render();
}

$("#search").addEventListener("input",render);
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!$("#editDialog").open){$("#search").value="";render()}});
document.querySelectorAll(".nav").forEach(button=>button.addEventListener("click",()=>{document.querySelectorAll(".nav").forEach(n=>n.classList.toggle("active",n===button));const settingsView=button.dataset.view==="settings";$("#settingsView").hidden=!settingsView;$("#identitiesView").hidden=settingsView;}));
$("#reminders").addEventListener("change",async e=>{await chrome.runtime.sendMessage({type:"SAVE_SETTINGS",settings:{reminders:e.target.checked}});toast("Preference saved")});
$("#saveButton").addEventListener("click",async e=>{e.preventDefault();if(!$("#editForm").reportValidity())return;const result=await chrome.runtime.sendMessage({type:"UPDATE_ACCOUNT",...editing,newEmail:$("#editEmail").value,note:$("#editNote").value});if(result.ok){$("#editDialog").close();await reload();toast("Account updated")}});
$("#deleteButton").addEventListener("click",async()=>{if(!editing)return;await chrome.runtime.sendMessage({type:"DELETE_ACCOUNT",siteKey:editing.siteKey,email:editing.oldEmail});$("#editDialog").close();await reload();toast("Account removed")});
$("#exportButton").addEventListener("click",async()=>{const stored=await chrome.storage.local.get("identityRecallRecords");const blob=new Blob([JSON.stringify({version:1,exportedAt:new Date().toISOString(),records:stored.identityRecallRecords||{}},null,2)],{type:"application/json"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`identity-recall-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(url);toast("Backup exported")});
$("#importButton").addEventListener("click",()=>{if(sites.length&&!confirm("Import replaces every remembered website with the contents of the backup file. Continue?"))return;$("#importInput").click()});
$("#importInput").addEventListener("change",async e=>{try{const data=JSON.parse(await e.target.files[0].text());const result=await chrome.runtime.sendMessage({type:"IMPORT_DATA",data});if(!result.ok)throw new Error(result.error);await reload();toast("Backup restored")}catch(err){toast(err.message || "Could not import backup")}e.target.value=""});
reload();
