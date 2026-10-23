import { Alert } from '@tendr/ui';

export default function DashboardDevelopersPage() {
  return (
    <section className="section" style={{ borderTop: 'none' }}>
      <h1>Developers</h1>
      <Alert tone="warning">
        API key management is local demo-only. Do not treat this UI as production access control.
      </Alert>
      <div className="tile">
        <h3>API base URL</h3>
        <p className="muted">http://localhost:4000</p>
      </div>
      <div className="tile">
        <h3>Authentication</h3>
        <p className="muted">
          Use <code>Authorization: Bearer &lt;DEMO_MERCHANT_API_KEY&gt;</code> from your server
          environment. Never embed secret keys in the browser.
        </p>
      </div>
      <div className="tile">
        <h3>OpenAPI</h3>
        <p className="muted">GET /v1/openapi.json</p>
      </div>
      <div className="tile">
        <h3>Webhooks</h3>
        <p className="muted">
          Create endpoints via POST /v1/webhooks/endpoints. Signatures use Tendr-Signature and
          Tendr-Timestamp headers.
        </p>
      </div>
    </section>
  );
}
