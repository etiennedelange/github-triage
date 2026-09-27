import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const toggle = () => setTheme(resolvedTheme === "dark" ? "light" : "dark");

  // `d` (or Cmd/Ctrl+Shift+D) toggles dark mode, unless the user is typing somewhere.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)
      ) {
        return;
      }
      if (e.key.toLowerCase() !== "d" || e.altKey) return;
      const plain = !e.metaKey && !e.ctrlKey;
      const withModifier = (e.metaKey || e.ctrlKey) && e.shiftKey;
      if (!plain && !withModifier) return;
      e.preventDefault();
      setTheme(resolvedTheme === "dark" ? "light" : "dark");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [resolvedTheme, setTheme]);

  return (
    <Button variant="ghost" size="icon-sm" aria-label="Toggle dark mode (d)" title="Toggle dark mode (d)" onClick={toggle}>
      <Sun className="dark:hidden" />
      <Moon className="hidden dark:block" />
    </Button>
  );
}
