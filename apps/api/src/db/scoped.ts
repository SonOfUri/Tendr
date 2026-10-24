// Request-scoped data access. Every API route and AI service reaches the database
// through one of these clients; only infra code uses the unscoped `prisma`.
//
// Scoping is fail-closed: a model is reachable only if it is listed in `models.ts`,
// and an operation only if it is listed below. Tenant filters are ANDed into `where`
// (so a caller's own `merchantId`/`livemode`/`OR` can only narrow the scope), and
// tenant columns are written into `data` on create. A row of another merchant or mode
// is therefore "not found" for every operation, including those addressing it by id.
import { Prisma } from '@prisma/client';
import { forbidden } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { PER_MODE_MODELS, SHARED_MODELS } from './models.js';

export type ScopeContext = { merchantId: string; livemode: boolean };

type Args = Record<string, unknown>;

const READ_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);
const UPDATE_OPS = new Set(['update', 'updateMany', 'updateManyAndReturn']);
const DELETE_OPS = new Set(['delete', 'deleteMany']);
const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn']);

/** Columns/relations that pin a row to its tenant; never writable through a scoped update. */
const TENANT_FIELDS = ['merchantId', 'livemode', 'merchant'];

const perMode = new Set<string>(PER_MODE_MODELS);
const shared = new Set<string>(SHARED_MODELS);

/** The filter (and, for creates, the column values) that confine `model` to the tenant. */
function tenantFilter(model: string, ctx: ScopeContext): Args {
  if (perMode.has(model)) return { merchantId: ctx.merchantId, livemode: ctx.livemode };
  if (shared.has(model)) return { merchantId: ctx.merchantId };
  if (model === 'Merchant') return { id: ctx.merchantId };
  throw forbidden(`model ${model} is not accessible through scoped data access`);
}

function scopeWhere(where: unknown, tenant: Args): Args {
  const base = (where ?? {}) as Args;
  const and = base.AND === undefined ? [] : Array.isArray(base.AND) ? base.AND : [base.AND];
  return { ...base, AND: [tenant, ...and] };
}

function assertTenantImmutable(data: unknown): void {
  if (data && typeof data === 'object' && TENANT_FIELDS.some((f) => Object.hasOwn(data, f))) {
    throw forbidden('tenant fields cannot be changed');
  }
}

/** model → (field → kind): `'scalar'` or the related model's name. */
const FIELDS = new Map(
  Prisma.dmmf.datamodel.models.map((m) => [
    m.name,
    new Map(m.fields.map((f) => [f.name, f.kind === 'object' ? f.type : 'scalar'])),
  ]),
);

/**
 * The root's tenant filter does not follow relations, so traversals (include, select,
 * `_count`, relation filters, nested writes) are allowed only where the target is
 * confined by composite FKs: into the merchant, shared models, or per-mode models from
 * a per-mode source. Shared/merchant → per-mode would see both modes; infra is never reachable.
 */
function assertRelationsAllowed(model: string, value: unknown): void {
  if (Array.isArray(value)) return value.forEach((v) => assertRelationsAllowed(model, v));
  if (value === null || typeof value !== 'object' || Prisma.Decimal.isDecimal(value)) return;
  const fields = FIELDS.get(model);
  for (const [key, child] of Object.entries(value)) {
    const target = fields?.get(key);
    if (target === 'scalar') continue;
    if (target !== undefined) {
      const reachable =
        target === 'Merchant' || shared.has(target) || (perMode.has(target) && perMode.has(model));
      if (!reachable) throw forbidden(`relation ${model}.${key} is not accessible`);
    }
    assertRelationsAllowed(target ?? model, child);
  }
}

function scopeArgs(model: string, operation: string, args: Args, ctx: ScopeContext): Args {
  const tenant = tenantFilter(model, ctx);
  assertRelationsAllowed(model, args);
  if (READ_OPS.has(operation) || DELETE_OPS.has(operation)) {
    if (model === 'Merchant' && DELETE_OPS.has(operation))
      throw forbidden('merchants cannot be deleted');
    return { ...args, where: scopeWhere(args.where, tenant) };
  }
  if (UPDATE_OPS.has(operation)) {
    assertTenantImmutable(args.data);
    return { ...args, where: scopeWhere(args.where, tenant) };
  }
  if (model === 'Merchant') throw forbidden('merchants cannot be created');
  if (CREATE_OPS.has(operation)) {
    const data = Array.isArray(args.data)
      ? args.data.map((d: Args) => ({ ...d, ...tenant }))
      : { ...(args.data as Args), ...tenant };
    return { ...args, data };
  }
  if (operation === 'upsert') {
    assertTenantImmutable(args.update);
    return {
      ...args,
      where: scopeWhere(args.where, tenant),
      create: { ...(args.create as Args), ...tenant },
    };
  }
  throw forbidden(`operation ${operation} is not available through scoped data access`);
}

const RAW_OPS = new Set([
  '$queryRaw',
  '$queryRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
  '$queryRawTyped',
  '$runCommandRaw',
]);
const WRITE_OPS = new Set([...UPDATE_OPS, ...DELETE_OPS, ...CREATE_OPS, 'upsert']);

function scopeExtension(ctx: ScopeContext, readOnly: boolean) {
  return Prisma.defineExtension({
    name: readOnly ? 'tendr-read-only' : 'tendr-scoped',
    query: {
      async $allOperations({ model, operation, args, query }) {
        if (RAW_OPS.has(operation))
          throw forbidden('raw SQL is not available on scoped data access');
        if (!model)
          throw forbidden(`operation ${operation} is not available through scoped data access`);
        if (readOnly && WRITE_OPS.has(operation)) throw forbidden('read-only data access');
        return query(scopeArgs(model, operation, args as Args, ctx));
      },
    },
  });
}

/**
 * Full read/write access to one merchant + mode. Interactive `$transaction` is allowed:
 * its `tx` client carries the same query extension, so it is scoped too.
 */
export function scopedDb(ctx: ScopeContext) {
  return prisma.$extends(scopeExtension(ctx, false));
}

/** Read-only access to one merchant + mode. AI services only ever receive this. */
export function readOnlyDb(ctx: ScopeContext) {
  return prisma.$extends(scopeExtension(ctx, true)).$extends({
    client: {
      $transaction() {
        return Promise.reject(forbidden('read-only data access'));
      },
    },
  });
}

export type ScopedDb = ReturnType<typeof scopedDb>;
export type ReadOnlyDb = ReturnType<typeof readOnlyDb>;
