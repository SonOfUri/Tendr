export default function PrivacyPage() {
  return (
    <section className="section" style={{ borderTop: 'none' }}>
      <h1>Privacy</h1>
      <p className="lead">
        A local Tendr install stores demo merchant records in your local PostgreSQL database for
        development. Do not put production personal data into a development environment.
      </p>
    </section>
  );
}
