import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Art image that quietly swaps to a fallback (usually an icon) if the file is missing or fails. */
export function Img({
  src,
  alt = "",
  className,
  fallback,
}: {
  src: string;
  alt?: string;
  className?: string;
  fallback?: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <>{fallback}</>;
  return (
    <img
      src={src}
      alt={alt}
      draggable={false}
      loading="lazy"
      onError={() => setFailed(true)}
      className={cn("select-none", className)}
    />
  );
}
