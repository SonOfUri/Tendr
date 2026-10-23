export default function PrivacyPage() {
  return (
    <section className="section" style={{ borderTop: 'none' }}>
      <h1>Privacy</h1>
      <p className="lead">
        This scaffold stores demo merchant and payment records in your local PostgreSQL database for
        development. Do not put production personal data into the sandbox environment.
      </p>
    </section>
  );
}
