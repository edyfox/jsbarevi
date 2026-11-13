// Service worker: the only context in the extension with host permissions, so it
// is where `:e` talks to a real editor.
//
// Why a port and not one-shot messages: an editor session stays open while a human
// edits — up to the adapter's 15-minute timeout — and a service worker is torn down
// after ~30 s of idleness. A connected port is the liveness signal, and the content
// script pings it while the request is in flight. One-shot `sendMessage` would be
// killed mid-session and look like "the editor is broken".
//
// Nothing here decides anything about the request: the URL, the method, the headers
// and the body all come from the adapter, so the wire format stays defined in
// src/adapters/editor-session.js and this file cannot drift from it.

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "jsbarevi:fetch") return;
  port.onMessage.addListener((msg) => {
    if (!msg || msg.id == null || msg.ping) return;
    void forward(msg, port);
  });
});

async function forward(msg, port) {
  try {
    const res = await fetch(msg.url, {
      method: msg.method || "GET",
      headers: msg.headers || {},
      body: msg.body,
      cache: "no-store",
    });
    const body = await res.text();
    // Only the one header the protocol cares about is carried back: the adapter
    // asks "did the file change?" and nothing else may influence its verdict.
    const headers = {};
    const changed = res.headers.get("X-File-Changed");
    if (changed !== null) headers["X-File-Changed"] = changed;
    reply(port, { id: msg.id, status: res.status, statusText: res.statusText, body, headers });
  } catch (err) {
    reply(port, { id: msg.id, error: String(err?.message || err) });
  }
}

function reply(port, message) {
  try {
    port.postMessage(message);
  } catch {
    // the tab navigated away or the adapter gave up; nothing to report to
  }
}
