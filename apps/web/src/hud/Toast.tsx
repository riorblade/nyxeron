import { useEffect } from "react";
import { useGame } from "@/store";
import { cn } from "@/lib/utils";

export function Toast() {
  const toast = useGame((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => useGame.setState({ toast: null }), 2500);
    return () => clearTimeout(t);
  }, [toast]);
  if (!toast) return null;
  return (
    <div
      key={toast.id}
      role="status"
      className={cn(
        "glass fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg px-5 py-2.5 text-sm",
        toast.error && "animate-shake border-white/40",
      )}
    >
      {toast.text}
    </div>
  );
}
