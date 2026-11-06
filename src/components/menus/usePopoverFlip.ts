// usePopoverFlip — keeps a popover menu inside the viewport. When the menu
// would extend past the bottom of the visible window, it flips open upward
// instead of downward. Shared by HideMenu / ProjectMenu / ReminderMenu so all
// three row affordances behave identically.
//
// Why: the menus are `position: absolute` inside `.scroll` (the app's one
// scroll container). A menu opening downward from a row near the bottom
// expands `.scroll`'s scrollable region and makes the page jump/scroll. Flipping
// upward when there's no room below keeps opening a menu a no-op on layout.

import { useLayoutEffect, useState } from "react";

export function usePopoverFlip(
  open: boolean,
  wrapRef: React.RefObject<HTMLElement | null>,
  menuRef: React.RefObject<HTMLElement | null>,
): boolean {
  const [flip, setFlip] = useState(false);

  useLayoutEffect(() => {
    if (!open) return;
    const wrap = wrapRef.current;
    const menu = menuRef.current;
    if (!wrap || !menu) return;

    const measure = () => {
      const wrapRect = wrap.getBoundingClientRect();
      const menuHeight = menu.offsetHeight;
      // If opening downward would overflow the viewport, flip up.
      setFlip(wrapRect.bottom + menuHeight + 8 > window.innerHeight);
    };

    measure();
    // Re-measure when the viewport changes or the scroll position moves the
    // trigger relative to the viewport.
    window.addEventListener("resize", measure);
    const scroll = document.querySelector(".scroll");
    scroll?.addEventListener("scroll", measure, { passive: true });
    return () => {
      window.removeEventListener("resize", measure);
      scroll?.removeEventListener("scroll", measure);
    };
  }, [open, wrapRef, menuRef]);

  return flip;
}
