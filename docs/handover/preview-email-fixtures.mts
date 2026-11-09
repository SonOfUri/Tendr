/** Offline design reference only. No mailer, provider, database or production mailbox calls. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { renderMail } from '../../apps/api/src/auth/mail-render.js';
import { MailTemplateValues, type MailMessage } from '../../apps/api/src/auth/mailer.js';

type Fixture = { id: string; scenario: string; message: MailMessage };
const directory = new URL('./', import.meta.url);
const input = JSON.parse(
  await readFile(new URL('email-design-fixtures.json', directory), 'utf8'),
) as { description: string; reviewed_at: string; fixtures: Fixture[] };

assert(Array.isArray(input.fixtures), 'fixtures must be an array');
const ids = new Set<string>();
const templates = new Set<string>();
for (const { id, scenario, message } of input.fixtures) {
  assert(/^[a-z0-9-]+$/.test(id) && !ids.has(id), `Invalid or duplicate fixture ID: ${id}`);
  ids.add(id);
  assert(typeof scenario === 'string' && scenario.length > 0, `${id}: missing scenario`);
  assert(MailTemplateValues.includes(message.template), `${id}: unknown template`);
  templates.add(message.template);
  assert(/^[^@\s]+@example\.com$/.test(message.to), `${id}: use a synthetic recipient`);
  assert(message.data && typeof message.data === 'object', `${id}: missing data`);
  assert(
    Object.values(message.data).every((v) => typeof v === 'string'),
    `${id}: data must be strings`,
  );
  assert.equal(
    Boolean(message.subject),
    Boolean(message.text),
    `${id}: copy overrides must be paired`,
  );
  if (message.subject) {
    assert(typeof message.subject === 'string' && typeof message.text === 'string');
  }
  // Every URL in the supplied data/copy is deliberately unusable. This preview sends nothing.
  for (const value of [...Object.values(message.data), message.text ?? '']) {
    for (const [url] of value.matchAll(/https?:\/\/[^\s"<>]+/g)) {
      assert(new URL(url).hostname.endsWith('.invalid'), `${id}: URL must use a .invalid host`);
    }
  }
}
assert.deepEqual([...templates].sort(), [...MailTemplateValues].sort(), 'Missing email template');
for (const id of [
  'invoice-submitted',
  'invoice-payment-review',
  'invoice-paid',
  'invoice-declined',
]) {
  const fixture = input.fixtures.find((f) => f.id === id);
  assert(fixture?.message.template === 'invoice_notice', `Missing invoice outcome: ${id}`);
  assert.deepEqual(fixture.message.data, {}, `${id}: current handler supplies empty data`);
  assert(fixture.message.subject && fixture.message.text, `${id}: prebuilt invoice copy required`);
}

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

const navigation = input.fixtures.map(({ id }) => `<a href="#${id}">${escape(id)}</a>`).join('\n');
const cards = input.fixtures
  .map((fixture) => {
    const rendered = renderMail(fixture.message);
    assert(rendered.subject && rendered.text, `${fixture.id}: empty rendered mail`);
    if (fixture.message.subject && fixture.message.text) {
      assert.equal(rendered.subject, fixture.message.subject);
      assert.equal(rendered.text, fixture.message.text);
    }
    if (fixture.message.data.livemode === 'false') {
      assert(rendered.subject.startsWith('[Test]'), `${fixture.id}: missing Test label`);
    }
    return `<article id="${fixture.id}" aria-labelledby="${fixture.id}-title">
  <div class="case-heading"><h2 id="${fixture.id}-title">${escape(fixture.id)}</h2><a href="#top">Back to index</a></div>
  <p class="scenario">${escape(fixture.scenario)}</p>
  <dl><dt>Template</dt><dd><code>${escape(fixture.message.template)}</code></dd>
  <dt>Recipient</dt><dd>${escape(fixture.message.to)}</dd>
  <dt>Copy source</dt><dd>${fixture.message.subject ? 'Handler-supplied subject/text (synthetic example)' : 'Current renderer fallback'}</dd></dl>
  <div class="message"><h3>${escape(rendered.subject)}</h3><pre>${escape(rendered.text)}</pre></div>
  <details><summary>Input payload available to the renderer</summary><pre>${escape(JSON.stringify(fixture.message, null, 2))}</pre></details>
</article>`;
  })
  .join('\n');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Tendr email inventory — current text baseline</title>
<style>
  * { box-sizing: border-box; }
  html { scroll-behavior: auto; }
  body { margin: 0; background: #f2f3f5; color: #17191c; font: 16px/1.6 system-ui, sans-serif; }
  main { max-width: 1000px; margin: auto; padding: 36px 24px 80px; }
  h1 { font-size: clamp(26px, 5vw, 38px); line-height: 1.2; margin: 10px 0 16px; }
  h2 { margin: 0; font-size: 20px; overflow-wrap: anywhere; }
  h3 { margin: 0 0 20px; font-size: 20px; line-height: 1.4; }
  a { color: #164eaa; text-underline-offset: 3px; }
  a:focus-visible, summary:focus-visible { outline: 3px solid #164eaa; outline-offset: 3px; }
  .eyebrow { font-weight: 700; letter-spacing: .08em; text-transform: uppercase; font-size: 12px; }
  .notice { padding: 16px 20px; border-left: 4px solid #657087; background: #fff; }
  nav { display: flex; flex-wrap: wrap; gap: 8px; margin: 24px 0 40px; }
  nav a { padding: 6px 10px; border: 1px solid #ccd1d9; border-radius: 5px; background: white; font-size: 13px; overflow-wrap: anywhere; }
  article { background: #fff; border: 1px solid #d7dbe2; border-radius: 10px; padding: 24px; margin: 24px 0; scroll-margin-top: 20px; }
  .case-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
  .case-heading a { flex-shrink: 0; font-size: 13px; }
  .scenario { color: #4c5665; }
  dl { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 6px 16px; font-size: 14px; }
  dt { font-weight: 600; } dd { margin: 0; overflow-wrap: anywhere; }
  .message { border-top: 1px solid #e1e4e9; margin-top: 20px; padding-top: 24px; }
  pre { font: 14px/1.7 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
  details { background: #f5f6f8; padding: 14px; margin-top: 24px; border-radius: 6px; }
  details pre { margin-top: 16px; font-size: 12px; }
  summary { cursor: pointer; font-size: 14px; font-weight: 600; }
  footer { font-size: 13px; color: #4c5665; }
  @media (max-width: 520px) { main { padding: 20px 12px 40px; } article { padding: 16px; } .case-heading { flex-direction: column; gap: 4px; } dl { grid-template-columns: 86px minmax(0, 1fr); gap: 6px; } }
  @media print { body { background: white; } nav, details, .case-heading a { display: none; } main { max-width: none; padding: 0; } article { break-inside: avoid; } }
</style>
</head>
<body><main id="top">
<header><div class="eyebrow">Tendr · frontend handover · ${escape(input.reviewed_at)}</div>
<h1>Transactional email inventory</h1>
<p>${templates.size} template keys · ${input.fixtures.length} synthetic cases · no emails sent</p>
<p class="notice"><strong>Current plain-text baseline, not an HTML email design.</strong> These cards show the current renderer output and supplied copy. Production does not yet send designed HTML. All recipients, IDs and links are synthetic; action URLs are displayed as text.</p>
<p>Use the AI, invoice and email delivery brief alongside this gallery. Expand each payload to see which fields exist today. Regenerate with <code>node --import tsx docs/handover/preview-email-fixtures.mts</code>.</p>
</header>
<nav aria-label="Email scenarios">${navigation}</nav>
${cards}
<footer>Generated from email-design-fixtures.json and apps/api/src/auth/mail-render.ts. This file has no scripts, tracking, external fonts or network assets.</footer>
</main></body></html>
`;
await writeFile(new URL('email-preview.html', directory), html);
console.log(
  `Validated ${templates.size} templates / ${input.fixtures.length} cases; wrote docs/handover/email-preview.html (offline, no sends).`,
);
