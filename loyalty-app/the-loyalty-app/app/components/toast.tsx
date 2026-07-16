import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type ToastKind = "success" | "error" | "info";
interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

const ToastContext = createContext<{
  show: (message: string, kind?: ToastKind) => void;
} | null>(null);

let counter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback((message: string, kind: ToastKind = "info") => {
    const id = ++counter;
    setToasts((t) => [...t, { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-3 z-[100] flex flex-col items-center gap-2 px-4 safe-top">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="rise pointer-events-auto flex max-w-sm items-center gap-2 rounded-2xl px-4 py-3 text-sm font-medium text-white shadow-lg"
            style={{
              background:
                t.kind === "success" ? "#16a34a" : t.kind === "error" ? "#dc2626" : "#4f46e5",
            }}
          >
            <span>{t.kind === "success" ? "✓" : t.kind === "error" ? "✕" : "•"}</span>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx.show;
}
