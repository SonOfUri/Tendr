'use client';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="section" style={{ borderTop: 'none' }}>
      <h1>Something went wrong</h1>
      <p className="lead">{error.message}</p>
      <button type="button" onClick={reset}>
        Try again
      </button>
    </section>
  );
}
