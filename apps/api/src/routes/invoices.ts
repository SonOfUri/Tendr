import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireDashboardUser } from '../gateway/principal.js';
import { createNativePayout } from '../accounts/native-payouts.js';
import {
  InvoiceInput,
  InvoiceTokenInput,
  publicInvoiceBusiness,
  submitInvoice,
  verifyInvoice,
  readPublicInvoice,
  invoiceSettings,
  setInvoiceSettings,
  listInvoices,
  getInvoice,
  rejectInvoice,
} from '../invoices/invoices.js';

export const INVOICE_PUBLIC_PREFIX = '/v1/invoices/public/';
const read = { principals: ['dashboard_user' as const], permission: 'account:read' as const };
const owner = {
  principals: ['dashboard_user' as const],
  permission: 'security:propose' as const,
  stepUp: true,
};
type Business = { Params: { business: string } };
type Invoice = { Params: { id: string } };
export const invoiceRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
  });
  const config = { auth: 'public' as const };
  app.get<Business>(`${INVOICE_PUBLIC_PREFIX}:business`, { config }, (req) =>
    publicInvoiceBusiness(req.params.business),
  );
  app.post<Business>(`${INVOICE_PUBLIC_PREFIX}:business`, { config }, async (req, reply) =>
    reply
      .code(202)
      .send(await submitInvoice(req.params.business, InvoiceInput.parse(req.body), req.ip)),
  );
  app.post<Business>(`${INVOICE_PUBLIC_PREFIX}:business/status`, { config }, (req) =>
    readPublicInvoice(req.params.business, InvoiceTokenInput.parse(req.body).token),
  );
  app.post<Business>(`${INVOICE_PUBLIC_PREFIX}:business/verify`, { config }, (req) =>
    verifyInvoice(req.params.business, InvoiceTokenInput.parse(req.body).token),
  );
  app.get('/v1/invoices/settings', { config: { auth: read } }, (req) =>
    invoiceSettings(requireDashboardUser(req)),
  );
  app.put('/v1/invoices/settings', { config: { auth: owner } }, (req) =>
    setInvoiceSettings(
      requireDashboardUser(req),
      z.object({ enabled: z.boolean() }).strict().parse(req.body).enabled,
    ),
  );
  app.get('/v1/invoices', { config: { auth: read } }, (req) => {
    const { cursor } = z
      .object({ cursor: z.string().max(64).optional() })
      .strict()
      .parse(req.query);
    return listInvoices(requireDashboardUser(req), cursor);
  });
  app.get<Invoice>('/v1/invoices/:id', { config: { auth: read } }, (req) =>
    getInvoice(requireDashboardUser(req), req.params.id),
  );
  app.post<Invoice>('/v1/invoices/:id/reject', { config: { auth: owner } }, (req) =>
    rejectInvoice(requireDashboardUser(req), req.params.id),
  );
  app.post<Invoice>('/v1/invoices/:id/payout', { config: { auth: owner } }, async (req, reply) => {
    const { asset } = z
      .object({ asset: z.string().min(8).max(256).startsWith('nep141:') })
      .strict()
      .parse(req.body);
    return reply
      .code(201)
      .send(
        await createNativePayout(requireDashboardUser(req), { invoiceId: req.params.id, asset }),
      );
  });
};
