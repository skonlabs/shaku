import { useEffect, useState } from "react";

const KEY = "ekonomical.upload.maxMb";
export const DEFAULT_UPLOAD_MAX_MB = 1;
export const HARD_UPLOAD_MAX_MB = 25; // server-enforced ceiling

export function getUploadMaxMb(): number {
  if (typeof window === "undefined") return DEFAULT_UPLOAD_MAX_MB;
  try {
    const raw = localStorage.getItem(KEY);
    const n = raw ? Number(raw) : DEFAULT_UPLOAD_MAX_MB;
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_UPLOAD_MAX_MB;
    return Math.min(Math.max(Math.floor(n), 1), HARD_UPLOAD_MAX_MB);
  } catch {
    return DEFAULT_UPLOAD_MAX_MB;
  }
}

export function setUploadMaxMb(mb: number) {
  const clamped = Math.min(Math.max(Math.floor(mb), 1), HARD_UPLOAD_MAX_MB);
  try {
    localStorage.setItem(KEY, String(clamped));
    window.dispatchEvent(new CustomEvent("ekonomical:upload-max-changed", { detail: clamped }));
  } catch {
    /* noop */
  }
}

export function useUploadMaxMb(): [number, (mb: number) => void] {
  const [mb, setMb] = useState<number>(() => getUploadMaxMb());
  useEffect(() => {
    const onChange = () => setMb(getUploadMaxMb());
    window.addEventListener("ekonomical:upload-max-changed", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("ekonomical:upload-max-changed", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  return [mb, (next: number) => setUploadMaxMb(next)];
}
