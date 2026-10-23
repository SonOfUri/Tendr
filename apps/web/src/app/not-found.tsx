import Link from 'next/link';

export default function NotFound() {
  return (
    <section className="section" style={{ borderTop: 'none' }}>
      <h1>Page not found</h1>
      <p className="lead">
        <Link href="/">Return home</Link>
      </p>
    </section>
  );
}
