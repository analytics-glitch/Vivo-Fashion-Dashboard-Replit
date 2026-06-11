import { ReactNode } from "react";

export function MobileLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-[100dvh] w-full bg-background flex flex-col items-center">
      <div className="w-full max-w-md bg-background min-h-[100dvh] flex flex-col shadow-sm">
        {children}
      </div>
    </div>
  );
}
