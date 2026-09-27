// URL state without a router: the app is one screen whose only state is `?repo=`.

import { useSyncExternalStore, type AnchorHTMLAttributes } from "react";

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export function navigate(href: string) {
  history.pushState(null, "", href);
  listeners.forEach((l) => l());
}

/** The `?repo=owner/name` filter, if valid. */
export function useRepoFilter(): string | undefined {
  const raw = useSyncExternalStore(subscribe, () => new URLSearchParams(location.search).get("repo"), () => null);
  return raw && /^[\w.-]+\/[\w.-]+$/.test(raw) ? raw : undefined;
}

/** An in-app link: a real `<a href>` (so middle-click and copy-link work) that navigates without a reload. */
export function AppLink({ href, onClick, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      href={href}
      {...props}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}
