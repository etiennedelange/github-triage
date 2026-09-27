import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";

const EDITABLE = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** `d` (or Cmd/Ctrl+Shift+D) toggles dark mode, unless the user is typing somewhere. */
function useThemeHotkey(toggle: () => void) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable || (target && EDITABLE.has(target.tagName))) return;
      const isD = e.key.toLowerCase() === "d";
      const plain = isD && !e.metaKey && !e.ctrlKey && !e.altKey;
      const withModifier = isD && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey;
      if (!plain && !withModifier) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle]);
}

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const toggle = () => setTheme(resolvedTheme === "dark" ? "light" : "dark");
  useThemeHotkey(toggle);
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Toggle dark mode (d)" title="Toggle dark mode (d)" onClick={toggle}>
      <Sun className="dark:hidden" />
      <Moon className="hidden dark:block" />
    </Button>
  );
}
