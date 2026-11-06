/** Platform sniff (the MobileView UA pattern). Consumers: the header palette
 *  button's glyph and tooltip — the shortcut is ⌘P on macOS, Ctrl+P where
 *  Ctrl is the modifier. */
export const isMac = /Mac/.test(navigator.userAgent);
