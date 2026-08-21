# Identity Recall

A local-first browser extension that remembers which email account you used on each website. It stores no passwords and sends no data anywhere.

## Install locally

**Chrome / Edge / Brave / Arc**

1. Open `chrome://extensions` in Chrome (or `edge://extensions` in Edge).
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select this folder.
4. Pin **Identity Recall** to the toolbar.

**Firefox 140+**

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on…** and select `manifest.json`.
3. Site access is opt-in on Firefox: open the extension's **Permissions** tab and grant access to the sites you want remembered.

No package installation or build step is required.

## How the MVP works

- A content script watches for email submissions in forms that also contain strong login or registration signals.
- Newsletter, contact, sharing, waitlist, and marketing language lowers the detection score to avoid false records.
- Records are grouped by registrable-style domain, with a small built-in set of common multi-part suffixes such as `co.uk` and `co.in`.
- Returning to a known website shows a quiet reminder at most once per browser tab session.
- The popup supports manual additions. The dashboard supports website/email search, editing, deletion, export, and import.
- Everything is kept in `chrome.storage.local` on the current browser profile.

## Intentional limitations

- OAuth account selection (Google, Apple, Microsoft, GitHub) is not automatically captured because the relying website generally cannot see the selected provider email. Add it manually from the popup.
- Detection is heuristic. It favors avoiding false positives over capturing every unusual login flow.
- Domain grouping uses a compact suffix list rather than the full Public Suffix List in this dependency-free MVP.
- Local data does not sync across devices. Export/import provides a manual backup path; imports are validated and can either replace everything or merge into existing records.
- On Firefox, site access is granted per-user rather than at install time, so automatic detection only runs on sites you allow.

## Privacy

The extension has broad page access because automatic login-form recognition requires reading form structure. It reads email values only when authentication signals are present, never reads password values, and performs no network requests.

## License

MIT — see [LICENSE](LICENSE).
