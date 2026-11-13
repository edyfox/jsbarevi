// How a host supplies `:e`, shared by every adapter.
//
// Three ways in, and they must all end up reporting through the ADAPTER: a transport
// that reports into nothing updates the engine's buffer and never commits it to the
// field, which looks exactly like ":e did nothing".
//   * opts.session        — already built, with its own callbacks (leave it alone)
//   * opts.sessionFactory — an extension builds the transport around the engine,
//                           which does not exist until the adapter's constructor runs
//   * opts.editorUrl      — a plain URL, fetched by the host itself

import { HttpEditorSession } from "./editor-session.js";

/**
 * Attach a transport to `engine` (if one was configured) and wire it to `adapter`.
 * The adapter must expose onStatus, _commit() and _emitMode().
 */
export function attachSession(adapter, engine, opts) {
  if (opts.session || !(opts.sessionFactory || opts.editorUrl)) return null;
  const session = opts.sessionFactory
    ? opts.sessionFactory(engine)
    : new HttpEditorSession({
      engine,
      url: opts.editorUrl,
      token: opts.editorToken,
      basic: opts.editorBasic,
    });
  session.onStatus = (msg, kind) => adapter.onStatus?.(msg, kind);
  session.onApplied = () => { adapter._commit(); adapter._emitMode(); };
  engine.session = session;
  return session;
}
