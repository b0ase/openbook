"use client";

import { useEffect, useRef, useState } from "react";

const CACHE_KEY = "openbook_bsv_price";
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface CachedPrice {
  usd: number;
  ts: number;
}

/**
 * Returns the current BSV/USD price. Cached for 5 minutes.
 * Falls back to last known price from localStorage.
 */
export function useBsvPrice(): number {
  const [price, setPrice] = useState<number>(() => {
    if (typeof window === "undefined") return 50;
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const parsed: CachedPrice = JSON.parse(cached);
        if (Date.now() - parsed.ts < CACHE_TTL) return parsed.usd;
        return parsed.usd; // stale but better than nothing
      }
    } catch {}
    return 50; // fallback
  });
  const fetchingRef = useRef(false);

  useEffect(() => {
    async function fetchPrice() {
      if (fetchingRef.current) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      fetchingRef.current = true;
      try {
        const res = await fetch("https://api.whatsonchain.com/v1/bsv/main/exchangerate");
        if (!res.ok) return;
        const data = await res.json();
        const usd = data?.rate ?? null;
        if (usd && typeof usd === "number" && usd > 0) {
          setPrice(usd);
          localStorage.setItem(CACHE_KEY, JSON.stringify({ usd, ts: Date.now() }));
        }
      } catch {}
      fetchingRef.current = false;
    }

    // Check if cache is stale
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const parsed: CachedPrice = JSON.parse(cached);
        if (Date.now() - parsed.ts < CACHE_TTL) return; // still fresh
      }
    } catch {}

    fetchPrice();
    const interval = setInterval(fetchPrice, CACHE_TTL);
    return () => clearInterval(interval);
  }, []);

  return price;
}

/**
 * Convert sats to USD string.
 */
export function satsToDollars(sats: number, bsvPrice: number): string {
  const btc = sats / 100_000_000;
  const usd = btc * bsvPrice;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(4)}`;
  if (usd >= 0.0001) return `$${usd.toFixed(6)}`;
  if (usd > 0) return `$${usd.toFixed(8)}`;
  return "$0.00";
}
