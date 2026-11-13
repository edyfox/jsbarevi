// Popup: the extension's only user interface. It reads settings from storage and
// asks the page's content script what host it is on — so the extension needs no
// "tabs" permission and never reads a URL it is not already running on.

const DEFAULTS = { enabled: true, disabledHosts: [], editorUrl: "http://127.0.0.1:31416/" };

const $ = (id) => document.getElementById(id);

async function activeTabInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { tab: null, page: null };
  try {
    const page = await chrome.tabs.sendMessage(tab.id, { type: "jsbarevi:hello" });
    return { tab, page };
  } catch {
    // No content script: chrome:// pages, the Web Store, other extensions' pages,
    // and pages loaded before the extension was installed or updated.
    return { tab, page: null };
  }
}

function render({ settings, page }) {
  $("build").textContent = chrome.runtime.getManifest().version_name
    || chrome.runtime.getManifest().version;
  $("enabled").checked = !!settings.enabled;

  const host = page?.host || "";
  const siteRow = $("site-row");
  const unsupported = $("unsupported");
  if (host) {
    siteRow.hidden = false;
    unsupported.hidden = true;
    $("host").textContent = host;
    const disabled = (settings.disabledHosts || []).includes(host);
    $("site").checked = !disabled;
    $("site").disabled = !settings.enabled;
    $("site-hint").textContent = disabled
      ? "Disabled here — turn on to edit text fields on this site."
      : page.attached
        ? `Live — engine attached to ${page.attached} field${page.attached === 1 ? "" : "s"}.`
        : "Focus a text field to start.";
  } else {
    siteRow.hidden = true;
    unsupported.hidden = false;
  }
  $("editor").value = settings.editorUrl || DEFAULTS.editorUrl;
}

async function save(patch) {
  const current = await chrome.storage.local.get(DEFAULTS);
  const next = { ...DEFAULTS, ...current, ...patch };
  await chrome.storage.local.set(next);
  // The content script listens on storage.onChanged and re-reads; repainting here
  // keeps the popup honest about what it just wrote.
  render({ settings: next, page: last.page });
  return next;
}

let last = { settings: { ...DEFAULTS }, page: null };

async function main() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  last.settings = { ...DEFAULTS, ...stored };
  const info = await activeTabInfo();
  last.page = info.page;
  render({ settings: last.settings, page: info.page });

  $("enabled").addEventListener("change", (e) => {
    save({ enabled: e.target.checked });
  });

  $("site").addEventListener("change", async (e) => {
    const host = last.page?.host;
    if (!host) return;
    const disabled = new Set(last.settings.disabledHosts || []);
    if (e.target.checked) disabled.delete(host); else disabled.add(host);
    last.settings = await save({ disabledHosts: [...disabled] });
  });

  $("save").addEventListener("click", async () => {
    const url = $("editor").value.trim() || DEFAULTS.editorUrl;
    last.settings = await save({ editorUrl: url });
    $("save").textContent = "Saved";
    setTimeout(() => { $("save").textContent = "Save"; }, 1200);
  });
}

main();
