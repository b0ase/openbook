"use client";

import { satsToDollars } from "@/hooks/useBsvPrice";

interface EarningsSparklineProps {
  history: Array<{ t: string; cumulative: number }>;
  totalSats: number;
  isGoat: boolean;
  bsvPrice: number;
}

export function EarningsSparkline({
  history,
  totalSats,
  isGoat,
  bsvPrice,
}: EarningsSparklineProps) {
  const W = 280;
  const H = 56;
  const PAD = { top: 6, right: 4, bottom: 4, left: 0 };

  const displayTotal = isGoat
    ? `${totalSats.toLocaleString()} sats`
    : satsToDollars(totalSats, bsvPrice);

  // Prepend a zero anchor at the time of the first payout
  const points = history.length === 0 ? [] : [{ t: history[0].t, cumulative: 0 }, ...history];

  if (points.length < 2) {
    return (
      <div>
        <svg width={W} height={H} aria-hidden="true" className="w-full">
          <line
            x1={PAD.left}
            y1={H - PAD.bottom}
            x2={W - PAD.right}
            y2={H - PAD.bottom}
            stroke="#27272a"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
          <text
            x={W / 2}
            y={H / 2}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize="10"
            fill="#52525b"
          >
            Boost a post to start earning
          </text>
        </svg>
      </div>
    );
  }

  const maxVal = points[points.length - 1].cumulative;
  const minT = new Date(points[0].t).getTime();
  const maxT = new Date(points[points.length - 1].t).getTime();
  const rangeT = maxT - minT || 1;

  function toX(t: string) {
    const ratio = (new Date(t).getTime() - minT) / rangeT;
    return PAD.left + ratio * (W - PAD.left - PAD.right);
  }
  function toY(val: number) {
    const ratio = maxVal === 0 ? 0 : val / maxVal;
    return H - PAD.bottom - ratio * (H - PAD.top - PAD.bottom);
  }

  // Build step-function path
  let d = `M ${toX(points[0].t)} ${toY(0)}`;
  for (let i = 1; i < points.length; i++) {
    const x = toX(points[i].t);
    const y = toY(points[i].cumulative);
    const prevY = toY(points[i - 1].cumulative);
    d += ` L ${x} ${prevY} L ${x} ${y}`;
  }

  const lastX = toX(points[points.length - 1].t);
  const baselineY = H - PAD.bottom;
  const areaPath = `${d} L ${lastX} ${baselineY} L ${PAD.left} ${baselineY} Z`;

  return (
    <div>
      <svg
        width={W}
        height={H}
        className="w-full"
        aria-label={`Cumulative earnings: ${displayTotal}`}
      >
        <defs>
          <linearGradient id="earn-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.03" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#earn-fill)" />
        <path d={d} fill="none" stroke="#f59e0b" strokeWidth="1.5" strokeLinejoin="miter" />
        <circle cx={lastX} cy={toY(points[points.length - 1].cumulative)} r="2.5" fill="#f59e0b" />
      </svg>
    </div>
  );
}
