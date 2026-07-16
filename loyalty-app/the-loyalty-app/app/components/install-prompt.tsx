import { useEffect, useState } from "react";
import { Button } from "./ui";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "zetu_install_dismissed";

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(DISMISS_KEY)) return;
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setVisible(true);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  if (!visible || !deferred) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setVisible(false);
  };

  const install = async () => {
    await deferred.prompt();
    await deferred.userChoice;
    setVisible(false);
  };

  return (
    <div className="rise fixed inset-x-3 bottom-24 z-40 mx-auto max-w-md rounded-2xl border border-[var(--card-border)] bg-[var(--card)] p-4 shadow-lg">
      <div className="flex items-center gap-3">
        <img
          src="/loyalty-app/icons/vivo-mark.png"
          alt="Vivo Loyalty"
          className="h-11 w-11 shrink-0 rounded-xl object-cover"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Install Vivo Loyalty</p>
          <p className="text-xs text-muted">Add to your home screen for quick access.</p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <Button variant="ghost" onClick={dismiss} className="flex-1 py-2">
          Not now
        </Button>
        <Button onClick={install} className="flex-1 py-2">
          Install
        </Button>
      </div>
    </div>
  );
}
