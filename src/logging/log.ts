// Frontend logging — thin prefix'd wrapper over the console, so log lines are
// greppable and consistently tagged. Kept deliberately small: the heavy lifting
// (file logging, levels, rotation) lives in the Rust `tauri-plugin-log` layer;
// this is just for the webview side. See AGENTS.md "Logging" for the convention.

const TAG = "[dayapp]";

// Whether to emit debug logs. In a Tauri production build `IS_DEV` is false, so
// debug() becomes a no-op — matching the Rust side's release filter.
const IS_DEV = import.meta.env.DEV;

export const log = {
  debug: (...args: unknown[]) => {
    if (IS_DEV) console.debug(TAG, ...args);
  },
  info: (...args: unknown[]) => console.info(TAG, ...args),
  warn: (...args: unknown[]) => console.warn(TAG, ...args),
  error: (...args: unknown[]) => console.error(TAG, ...args),
};
