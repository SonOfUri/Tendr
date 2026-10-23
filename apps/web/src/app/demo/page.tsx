import Link from 'next/link';

const demos = [
  {
    href: '/demo/ecommerce',
    title: 'E-commerce',
    body: 'Product purchase → Tendr checkout → order confirmation after settlement.',
  },
  {
    href: '/demo/fintech',
    title: 'Fintech',
    body: 'Simulated service funding. Balances are labelled sandbox-only.',
  },
  {
    href: '/demo/gaming',
    title: 'Gaming',
    body: 'Unlock an item only after verified payment success.',
  },
  {
    href: '/demo/prediction-markets',
    title: 'Prediction markets',
    body: 'Simulated position funding only — no market execution.',
  },
];

export default function DemoHubPage() {
  return (
    <section className="section" style={{ borderTop: 'none' }}>
      <h1>Demo hub</h1>
      <p className="lead">
        Four merchant contexts. One checkout engine. All flows run in{' '}
        <strong>Sandbox — no real funds move.</strong>
      </p>
      <div className="grid-3">
        {demos.map((demo) => (
          <Link key={demo.href} href={demo.href} className="tile">
            <h3>{demo.title}</h3>
            <p>{demo.body}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}
