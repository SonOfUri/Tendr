'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  ArrowRightLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  Copy,
  Plus,
  Receipt,
  RotateCcw,
} from 'lucide-react';
import { useDashboard } from '@/components/dashboard/DashboardShell';
import { TokenLogo } from '@/components/dashboard/asset-logos';
import { InfoTip } from '@/components/dashboard/InfoTip';
import { AiInsightsPanel } from '@/components/dashboard/AiInsightsPanel';
import { OverviewSkeleton } from '@/components/dashboard/Skeleton';
import { ErrorState } from '@/components/dashboard/ui';
import { useLoad } from '@/components/dashboard/common';
import { assetInfo, chainLabel, formatAmount, formatTokenAmount, formatUnits } from '@/lib/assets';
import { api, type BalanceRow, type Balances } from '@/lib/api';
import { formatUsd, type PaymentList, type PaymentStatus, type PaymentSummary } from '@/lib/payments';

type Range = 7 | 30;
type Metric = 'volume' | 'count';

const STATUS_LABEL: Record<PaymentStatus, string> = {
  DETECTED: 'Pending',
  PROCESSING: 'Processing',
  SETTLED: 'Completed',
  PARTIALLY_REFUNDED: 'Partial refund',
  REFUNDING: 'Refunding',
  REFUNDED: 'Refunded',
  HELD: 'Held',
  SCREENING_PENDING: 'In review',
};

const SCALE = 8;

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysEndingToday(count: number): Date[] {
  const start = startOfDay(new Date());
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() - (count - 1 - i));
    return d;
  });
}

/** Decimal string (`25.1`) as an integer at 8 decimal places. Null when it is not a plain amount. */
function toScaled(amount: string): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) return null;
  const frac = (m[2] ?? '').padEnd(SCALE, '0').slice(0, SCALE);
  return BigInt(m[1]! + frac);
}

function fromScaled(n: bigint): string {
  const neg = n < 0n;
  const v = (neg ? -n : n).toString().padStart(SCALE + 1, '0');
  const whole = v.slice(0, -SCALE).replace(/^0+(?=\d)/, '');
  const frac = v.slice(-SCALE).replace(/0+$/, '');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${frac ? `${grouped}.${frac}` : grouped}`;
}

function showMoney(amount: bigint, currency: string): string {
  return `${fromScaled(amount)} ${currency}`;
}

/** Shorten a decimal string to at most `dp` places; flag when the full value differs. */
function approxDecimal(raw: string, dp = 3): { short: string; full: string; truncated: boolean } {
  const full = raw.trim();
  const m = /^(-?\d[\d,]*)(?:\.(\d+))?$/.exec(full);
  if (!m) return { short: full, full, truncated: false };
  const whole = m[1]!;
  const frac = m[2] ?? '';
  if (frac.length <= dp) return { short: full, full, truncated: false };
  const cut = frac.slice(0, dp).replace(/0+$/, '');
  return { short: cut ? `${whole}.${cut}` : whole, full, truncated: true };
}

function approxMoney(amount: bigint, currency: string): { short: string; full: string; tip: boolean } {
  const fullNum = fromScaled(amount);
  const approx = approxDecimal(fullNum);
  return {
    short: `${approx.short} ${currency}`,
    full: `${approx.full} ${currency}`,
    tip: approx.truncated,
  };
}

function shortAssetId(asset: string): string {
  const t = asset.trim();
  if (t.length <= 22) return t;
  return `${t.slice(0, 10)}…${t.slice(-8)}`;
}

function approxAssetAmount(
  row: BalanceRow,
  livemode: boolean,
): { short: string; full: string; tip: boolean; label: string; usd: string | null } {
  const full = formatTokenAmount(row.asset, row.amount, livemode, row);
  const info = assetInfo(row.asset, livemode);
  const label =
    (typeof row.symbol === 'string' && row.symbol) ||
    (info.known ? info.symbol : shortAssetId(row.asset));
  const known =
    info.known ||
    (typeof row.symbol === 'string' &&
      row.symbol.length > 0 &&
      typeof row.decimals === 'number' &&
      row.decimals >= 0);
  if (!known) {
    return {
      short: `${row.amount} units`,
      full,
      tip: true,
      label,
      usd: row.amount_usd ?? null,
    };
  }
  const decimals = typeof row.decimals === 'number' ? row.decimals : info.decimals;
  const units = formatUnits(row.amount, decimals);
  const approx = approxDecimal(units);
  return {
    short: `${approx.short} ${label}`,
    full: `${approx.full} ${label}`,
    tip: approx.truncated,
    label,
    usd: row.amount_usd ?? null,
  };
}

/** Sum balance USD strings with fixed-point cents so the hero total never uses floats. */
function sumUsd(rows: BalanceRow[]): string | null {
  let cents = 0n;
  let any = false;
  for (const row of rows) {
    const v = row.amount_usd?.trim();
    if (!v) continue;
    const m = /^(\d+)(?:\.(\d+))?$/.exec(v);
    if (!m) continue;
    any = true;
    const frac = (m[2] ?? '').padEnd(3, '0');
    let c = BigInt(m[1]!) * 100n + BigInt(frac.slice(0, 2));
    if (Number(frac[2] ?? '0') >= 5) c += 1n;
    cents += c;
  }
  if (!any) return null;
  const whole = (cents / 100n).toString();
  const rest = (cents % 100n).toString().padStart(2, '0');
  return `${whole}.${rest}`;
}

function changePill(today: bigint, yesterday: bigint): { text: string; up: boolean } {
  if (yesterday === 0n) return { text: today === 0n ? '0%' : 'New', up: today > 0n };
  const pct = ((today - yesterday) * 1000n) / yesterday;
  const neg = pct < 0n;
  const abs = neg ? -pct : pct;
  return { text: `${neg ? '-' : '+'}${abs / 10n}.${abs % 10n}%`, up: pct > 0n };
}

function dayAt(el: HTMLElement, clientX: number, count: number): number {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || count <= 1) return 0;
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  return Math.round(ratio * (count - 1));
}

function dayLabel(key: string): string {
  return new Date(`${key}T00:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function shortWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusTone(status: PaymentStatus): 'ok' | 'warn' | 'muted' {
  if (status === 'SETTLED') return 'ok';
  if (status === 'PROCESSING' || status === 'DETECTED' || status === 'SCREENING_PENDING') return 'warn';
  return 'muted';
}

function initials(p: PaymentSummary): string {
  const src = (p.external_ref || p.order.currency || 'P').replace(/[^a-z0-9]/gi, '');
  return (src.slice(0, 2) || 'P').toUpperCase();
}

/** Short label for payment ids so status stays on one line (`pay_…A1B2`). */
function shortPayLabel(id: string): string {
  const t = id.trim();
  if (t.length <= 10) return t;
  if (t.startsWith('pay_')) return `pay_…${t.slice(-4)}`;
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

function shortReceived(text: string, max = 28): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(6, max - 5))}…`;
}

/** Merchant-facing reference: order ref, payer note, or the payment link id. */
function referenceLabel(p: PaymentSummary): string {
  const ref = p.external_ref?.trim();
  if (ref) return ref;
  const note = p.payer_note?.trim();
  if (note) return note.length > 32 ? `${note.slice(0, 30)}…` : note;
  if (p.payment_link_id) return shortPayLabel(p.payment_link_id);
  return '—';
}

function CopyIconButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ov-copy-btn"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          },
          () => undefined,
        );
      }}
    >
      {copied ? <Check size={12} strokeWidth={2.2} /> : <Copy size={12} strokeWidth={2} />}
    </button>
  );
}

export default function OverviewPage() {
  const { store, context } = useDashboard();
  const [range, setRange] = useState<Range>(7);
  const [metric, setMetric] = useState<Metric>('volume');
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [walletOpen, setWalletOpen] = useState(true);
  const [hovered, setHovered] = useState<number | null>(null);

  const livemode = context?.livemode ?? false;
  const key = context ? `${context.merchantId}:${context.livemode}` : null;
  const data = useLoad(async () => {
    const from = daysEndingToday(30)[0]!;
    const q = new URLSearchParams({
      limit: '100',
      created_from: from.toISOString(),
    });
    const [balances, first] = await Promise.all([
      api<Balances>('/v1/account/balances'),
      api<PaymentList>(`/v1/payments?${q.toString()}`),
    ]);
    let payments = first.payments;
    let truncated = first.has_more;
    if (first.next_cursor) {
      q.set('starting_after', first.next_cursor);
      const second = await api<PaymentList>(`/v1/payments?${q.toString()}`);
      payments = [...payments, ...second.payments];
      truncated = second.has_more;
    }
    return { balances, payments, truncated };
  }, key);

  const view = useMemo(() => {
    const payments = data.data?.payments ?? [];
    const days = daysEndingToday(range);
    const keys = days.map(dayKey);
    const inRange = payments.filter((p) => keys.includes(dayKey(new Date(p.created_at))));
    const currencies = new Map<string, number>();
    for (const p of inRange) currencies.set(p.order.currency, (currencies.get(p.order.currency) ?? 0) + 1);
    const currency =
      [...currencies.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ??
      'USD';

    const byDay = keys.map((keyDay) => {
      const rows = inRange.filter((p) => dayKey(new Date(p.created_at)) === keyDay && p.order.currency === currency);
      const volume = rows.reduce((sum, p) => sum + (toScaled(p.order.amount) ?? 0n), 0n);
      return { key: keyDay, count: rows.length, volume, rows };
    });

    const todayKey = dayKey(new Date());
    const yKey = dayKey(new Date(startOfDay(new Date()).getTime() - 86_400_000));
    const today = byDay.find((d) => d.key === todayKey);
    const yesterday = byDay.find((d) => d.key === yKey);
    const todayVolume = today?.volume ?? 0n;
    const rangeVolume = byDay.reduce((sum, d) => sum + d.volume, 0n);
    const rangeCount = byDay.reduce((sum, d) => sum + d.count, 0);

    const chains = new Map<string, number>();
    for (const p of inRange) {
      const chain = p.source.chain ? chainLabel(p.source.chain) : 'Unknown';
      chains.set(chain, (chains.get(chain) ?? 0) + 1);
    }
    const chainRows = [...chains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const top = chainRows[0];
    const mix = top && inRange.length > 0 ? Math.round((top[1] / inRange.length) * 100) : 0;

    const peak = byDay.reduce((max, d) => {
      const n = metric === 'volume' ? d.volume : BigInt(d.count);
      return n > max ? n : max;
    }, 0n);

    return {
      currency,
      byDay,
      todayCount: today?.count ?? 0,
      todayVolume,
      yesterdayVolume: yesterday?.volume ?? 0n,
      rangeVolume,
      rangeCount,
      chainRows,
      mix,
      topChain: top?.[0] ?? null,
      peak,
      inRange,
    };
  }, [data.data, range, metric]);

  if (!store || !context) return null;
  if (data.error) return <ErrorState message={data.error} onRetry={() => void data.reload()} />;
  if (!data.data) return <OverviewSkeleton />;

  const balances = data.data.balances.balances.filter((b) => b.amount !== '0');
  const shown = selectedDay ? view.byDay.find((d) => d.key === selectedDay)?.rows ?? [] : view.inRange;
  const recent = view.inRange.slice(0, 4);
  const activeDay =
    (hovered != null ? view.byDay[hovered] : null) ??
    (selectedDay ? view.byDay.find((d) => d.key === selectedDay) : null) ??
    view.byDay[view.byDay.length - 1];
  const delta = changePill(view.todayVolume, view.yesterdayVolume);
  const walletUsd = sumUsd(balances);
  const walletUsdLabel = walletUsd ? formatUsd(walletUsd) : balances.length === 0 ? '$0.00' : '—';
  const revenueAmt = approxMoney(view.todayVolume, view.currency);
  const caption = activeDay
    ? `${dayLabel(activeDay.key)} · ${showMoney(activeDay.volume, view.currency)} · ${activeDay.count} payment${activeDay.count === 1 ? '' : 's'}${selectedDay ? ' · click the day again to clear' : ''}`
    : 'No payments in this range';

  return (
    <div className="ov">
      <section className="ov-hero" aria-label="Balances and volume">
        <article className="ov-stat ov-stat--wallet">
          <p className="ov-kicker">Wallet balance</p>
          <div className="ov-stat-foot">
            <div className="ov-figure-row">
              <p className="ov-figure ov-figure--xl">{walletUsdLabel}</p>
            </div>
            <p className="ov-sub">
              {balances.length === 0
                ? context.livemode
                  ? 'No live balance yet'
                  : 'No test balance yet'
                : `${balances.length} asset${balances.length === 1 ? '' : 's'}`}
            </p>
            <div className="ov-wallet-actions">
              {balances.length > 0 ? (
                <button type="button" className="ov-text-btn" onClick={() => setWalletOpen((v) => !v)}>
                  {walletOpen ? 'Hide assets' : 'Show assets'}
                </button>
              ) : null}
              <Link href="/dashboard/wallet" className="ov-text-link">
                Open wallet
              </Link>
            </div>
            {walletOpen && balances.length > 0 ? (
              <ul className="ov-assets">
                {balances.map((b) => {
                  const row = approxAssetAmount(b, livemode);
                  return (
                    <li key={b.asset}>
                      <span className="ov-assets-left">
                        <TokenLogo symbol={row.label} assetId={b.asset} size={22} />
                        <span className="ov-assets-name" title={b.asset}>
                          {row.label}
                        </span>
                      </span>
                      <strong className="ov-assets-amt">
                        <span className="ov-assets-token" title={row.full}>
                          {row.short}
                          {row.tip ? <InfoTip text={row.full} label="Full asset balance" /> : null}
                        </span>
                        <span className="ov-assets-usd">{formatUsd(row.usd)}</span>
                      </strong>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        </article>

        <article className="ov-stat">
          <p className="ov-kicker">
            Today&apos;s revenue
            <span className={`ov-delta${delta.up ? ' ov-delta--up' : ''}`}>{delta.text}</span>
          </p>
          <div className="ov-stat-foot">
            <div className="ov-figure-row">
              <p className="ov-figure ov-figure--xl">{revenueAmt.short}</p>
              {revenueAmt.tip ? <InfoTip text={revenueAmt.full} label="Full today's revenue" /> : null}
            </div>
            <p className="ov-sub">vs. yesterday</p>
          </div>
        </article>

        <article className="ov-chart-col">
          <header className="ov-chart-head">
            <div className="ov-chart-title">
              <span>Payment volume</span>
              <div className="ov-seg" role="group" aria-label="Chart metric">
                <button type="button" aria-pressed={metric === 'volume'} onClick={() => setMetric('volume')}>
                  Volume
                </button>
                <button type="button" aria-pressed={metric === 'count'} onClick={() => setMetric('count')}>
                  Count
                </button>
              </div>
            </div>
            <div className="ov-seg" role="group" aria-label="Range">
              <button
                type="button"
                aria-pressed={range === 7}
                onClick={() => {
                  setRange(7);
                  setSelectedDay(null);
                }}
              >
                7 days
              </button>
              <button
                type="button"
                aria-pressed={range === 30}
                onClick={() => {
                  setRange(30);
                  setSelectedDay(null);
                }}
              >
                30 days
              </button>
            </div>
          </header>
          <div className="ov-chart" onMouseLeave={() => setHovered(null)}>
            {view.byDay.map((d, i) => {
              const value = metric === 'volume' ? d.volume : BigInt(d.count);
              // True scale vs peak: $0 stays empty; small days stay short vs big days.
              const fill =
                view.peak === 0n || value === 0n
                  ? 0
                  : Math.max(6, Number((value * 100n) / view.peak));
              const label = dayLabel(d.key);
              const barLabel =
                metric === 'volume' ? showMoney(d.volume, view.currency) : `${d.count} payments`;
              const on = hovered === i || d.key === activeDay?.key;
              return (
                <button
                  key={d.key}
                  type="button"
                  className="ov-bar-hit"
                  data-empty={value === 0n ? 'true' : 'false'}
                  data-on={on ? 'true' : 'false'}
                  aria-pressed={selectedDay === d.key}
                  aria-label={`${label}: ${barLabel}`}
                  onMouseEnter={() => setHovered(i)}
                  onFocus={() => setHovered(i)}
                  onClick={() => setSelectedDay((cur) => (cur === d.key ? null : d.key))}
                >
                  {on ? (
                    <span className="ov-bar-tip" role="tooltip">
                      <strong>{barLabel}</strong>
                      <span>{label}</span>
                    </span>
                  ) : null}
                  <span className="ov-bar" data-on={on ? 'true' : 'false'} data-empty={value === 0n ? 'true' : 'false'}>
                    <span className="ov-bar-fill" style={{ height: `${fill}%` }} />
                  </span>
                </button>
              );
            })}
          </div>
          <p className="ov-chart-caption">{caption}</p>
        </article>
      </section>

      <section className="ov-mid" aria-label="Activity">
        <article className="ov-card ov-tone ov-tone--pay">
          <div className="ov-pay-top">
            <div>
              <p className="ov-figure ov-figure--md">{view.todayCount}</p>
              <p className="ov-sub">Payments today</p>
            </div>
            <span className="ov-plus" aria-hidden>
              <Plus size={15} strokeWidth={2.25} />
            </span>
          </div>
          <div className="ov-pay-art" aria-hidden>
            <span />
            <span />
            <span />
          </div>
          <Link href="/dashboard/payments" className="ov-pay-foot">
            <span className="ov-pay-foot-copy">
              <strong>{showMoney(view.todayVolume, view.currency)}</strong>
              <span>Processed today</span>
            </span>
            <ChevronRight size={16} strokeWidth={2.25} aria-hidden />
          </Link>
        </article>

        <article className="ov-card ov-tone ov-tone--mix">
          <p className="ov-tone-label">Payment mix</p>
          <p className="ov-figure ov-figure--md">{view.inRange.length === 0 ? '—' : `${view.mix}%`}</p>
          <p className="ov-sub">{view.topChain ? `${view.topChain} share` : 'No chain mix yet'}</p>
          {view.chainRows.length > 0 ? (
            <ul className="ov-mix" aria-label="Payments by chain">
              {view.chainRows.map(([chain, count]) => {
                const pct = Math.round((count / view.inRange.length) * 100);
                return (
                  <li key={chain}>
                    <span title={chain}>{chain}</span>
                    <span className="ov-mix-track" aria-hidden>
                      <span className="ov-mix-bar" style={{ width: `${Math.max(pct, 6)}%` }} />
                    </span>
                    <strong>{pct}%</strong>
                  </li>
                );
              })}
            </ul>
          ) : (
            <ul className="ov-mix ov-mix--ghost" aria-hidden>
              <li>
                <span className="ov-mix-track">
                  <span className="ov-mix-bar" style={{ width: '72%' }} />
                </span>
              </li>
              <li>
                <span className="ov-mix-track">
                  <span className="ov-mix-bar" style={{ width: '48%' }} />
                </span>
              </li>
              <li>
                <span className="ov-mix-track">
                  <span className="ov-mix-bar" style={{ width: '28%' }} />
                </span>
              </li>
            </ul>
          )}
        </article>

        <article className="ov-card ov-tone ov-tone--rev">
          <div className="ov-rev-copy">
            <span className="ov-rev-pill">Total revenue</span>
            <p className="ov-figure ov-figure--md">{showMoney(view.rangeVolume, view.currency)}</p>
            <p className="ov-sub">
              {selectedDay ? (
                <>
                  {dayLabel(selectedDay)}
                  <button type="button" className="ov-rev-back" onClick={() => setSelectedDay(null)}>
                    <RotateCcw size={12} strokeWidth={2.25} aria-hidden />
                    Last {range} days
                  </button>
                </>
              ) : (
                `Last ${range} days`
              )}
            </p>
          </div>
          <div
            className="ov-ruler"
            role="slider"
            aria-label="Move the date"
            aria-valuemin={0}
            aria-valuemax={Math.max(0, view.byDay.length - 1)}
            aria-valuenow={Math.max(
              0,
              view.byDay.findIndex((d) => d.key === (selectedDay ?? view.byDay.at(-1)?.key)),
            )}
            aria-valuetext={selectedDay ? dayLabel(selectedDay) : `Last ${range} days`}
            tabIndex={0}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              const day = view.byDay[dayAt(e.currentTarget, e.clientX, view.byDay.length)];
              if (day) setSelectedDay(day.key);
            }}
            onPointerMove={(e) => {
              if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
              const day = view.byDay[dayAt(e.currentTarget, e.clientX, view.byDay.length)];
              if (day) setSelectedDay(day.key);
            }}
            onKeyDown={(e) => {
              const current = view.byDay.findIndex((d) => d.key === selectedDay);
              const index = current < 0 ? view.byDay.length - 1 : current;
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault();
                const next = view.byDay[index + (e.key === 'ArrowRight' ? 1 : -1)];
                if (next) setSelectedDay(next.key);
              } else if (e.key === 'Home') {
                e.preventDefault();
                const first = view.byDay[0];
                if (first) setSelectedDay(first.key);
              } else if (e.key === 'End') {
                e.preventDefault();
                const last = view.byDay.at(-1);
                if (last) setSelectedDay(last.key);
              } else if (e.key === 'Escape') {
                setSelectedDay(null);
              }
            }}
          >
            {view.byDay.flatMap((d) =>
              [1, 0.38, 0.62, 0.38].map((scale, tick) => (
                <span
                  key={`${d.key}-${tick}`}
                  data-on={selectedDay === d.key && tick === 0 ? 'true' : 'false'}
                  style={{ height: `${Math.round(scale * 100)}%` }}
                />
              )),
            )}
          </div>
        </article>

        {store && context ? (
          <div className="ov-insights">
            <AiInsightsPanel merchantId={store.id} livemode={context.livemode} />
          </div>
        ) : null}

        <article className="ov-card ov-card--list">
          <header className="ov-card-head">
            <span>Recent payments</span>
            <Link href="/dashboard/payments" className="ov-icon-link" aria-label="All payments">
              <ArrowUpRight size={16} strokeWidth={1.85} />
            </Link>
          </header>
          {recent.length === 0 ? (
            <div className="ov-empty">
              <span className="ov-empty-icon" aria-hidden>
                <Receipt size={22} strokeWidth={1.75} />
              </span>
              <p>No payments in the last {range} days.</p>
            </div>
          ) : (
            <ul className="ov-people">
              {recent.map((p) => {
                const label = p.external_ref?.trim() || p.id;
                return (
                  <li key={p.id}>
                    <Link href={`/dashboard/payments/${p.id}`}>
                      <span className="ov-avatar" aria-hidden>
                        {initials(p)}
                      </span>
                      <span className="ov-person">
                        <strong title={label}>{shortPayLabel(label)}</strong>
                        <span>{p.order.currency}</span>
                      </span>
                      <span className="ov-person-amt">
                        <strong>
                          {p.order.amount} {p.order.currency}
                        </strong>
                        <span className="ov-status" data-tone={statusTone(p.status)}>
                          {STATUS_LABEL[p.status]}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </article>
      </section>

      <section className="ov-card ov-table-card">
        <header className="ov-card-head">
          <span>Recent transactions</span>
          <Link href="/dashboard/payments" className="ov-text-link">
            View all
          </Link>
        </header>
        {data.data.truncated ? (
          <p className="ov-sub ov-note">Showing the latest 200 payments in this range.</p>
        ) : null}
        {shown.length === 0 ? (
          <div className="ov-empty ov-empty--tall">
            <span className="ov-empty-icon" aria-hidden>
              <ArrowRightLeft size={22} strokeWidth={1.75} />
            </span>
            <p>No transactions{selectedDay ? ' on this day' : ' in this range'}.</p>
      </div>
        ) : (
          <div className="dash-table-wrap">
            <table className="dash-table ov-table">
            <thead>
              <tr>
                  <th>Payment</th>
                  <th>Reference</th>
                  <th>Amount</th>
                  <th>Received</th>
                  <th>Status</th>
                  <th>Date</th>
              </tr>
            </thead>
            <tbody>
                {shown.slice(0, 8).map((p) => {
                  const received = formatTokenAmount(
                    p.received.asset,
                    p.received.amount,
                    livemode,
                    p.received,
                  );
                  const ref = referenceLabel(p);
                  return (
                    <tr key={p.id}>
                      <td>
                        <span className="ov-cell-copy">
                          <Link
                            href={`/dashboard/payments/${p.id}`}
                            className="ov-id"
                            title={p.id}
                          >
                            {shortPayLabel(p.id)}
                          </Link>
                          <CopyIconButton value={p.id} label="Copy payment id" />
                        </span>
                      </td>
                      <td className="ov-muted" title={ref !== '—' ? ref : undefined}>
                        {ref}
                      </td>
                      <td>
                        {p.order.amount} {p.order.currency}
                      </td>
                      <td>
                        <span className="ov-cell-copy">
                          <span className="ov-received" title={received}>
                            {shortReceived(received)}
                          </span>
                          <CopyIconButton value={received} label="Copy received amount" />
                        </span>
                      </td>
                      <td>
                        <span className="ov-status" data-tone={statusTone(p.status)}>
                          {STATUS_LABEL[p.status]}
                        </span>
                  </td>
                      <td className="ov-muted">{shortWhen(p.created_at)}</td>
                </tr>
                  );
                })}
            </tbody>
          </table>
          </div>
      )}
    </section>
    </div>
  );
}
