// In-app navigation guard (Batch A, A5). A page with unsaved work (the New
// Session builder) registers a guard; app chrome that navigates — the nav bar's
// links and its Escape-to-Dashboard shortcut — asks the guard first. If the
// guard returns true it has taken over (shown its Save / Discard / Cancel
// prompt) and the navigation must not proceed. Browser-level exits (tab close,
// reload, typed URL, browser Back) can only get the native "Leave site?" dialog
// via beforeunload; that's handled in the page.

type Guard = (href: string) => boolean;

let guard: Guard | null = null;

export function setNavGuard(g: Guard | null): void {
  guard = g;
}

/** True if navigation to `href` was intercepted and must not proceed. */
export function guardNavigation(href: string): boolean {
  return guard ? guard(href) : false;
}
