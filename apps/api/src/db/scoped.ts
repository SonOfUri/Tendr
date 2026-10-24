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
import { PER_MODE_MODELS, READ_ONLY_PER_MODE_MODELS, SHARED_MODELS } from './models.js';

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
const WRITE_OPS = new Set([...UPDATE_OPS, ...DELETE_OPS, ...CREATE_OPS, 'upsert']);

/**
 * Columns/relations never writable through a scoped update: the primary key (changing it would
 * re-identify a row and break references) and the tenant columns that pin a row to its tenant.
 */
const IMMUTABLE_FIELDS = ['id', 'merchantId', 'livemode', 'merchant'];

const perMode = new Set<string>(PER_MODE_MODELS);
const readOnlyPerMode = new Set<string>(READ_ONLY_PER_MODE_MODELS);
const shared = new Set<string>(SHARED_MODELS);
/** Models confined to one merchant + mode, whether writable or read-only. */
const isPerMode = (model: string): boolean => perMode.has(model) || readOnlyPerMode.has(model);

/** The filter (and, for creates, the column values) that confine `model` to the tenant. */
function tenantFilter(model: string, ctx: ScopeContext): Args {
  if (isPerMode(model)) return { merchantId: ctx.merchantId, livemode: ctx.livemode };
  if (shared.has(model)) return { merchantId: ctx.merchantId };
  if (model === 'Merchant') return { id: ctx.merchantId };
  throw forbidden(`model ${model} is not accessible through scoped data access`);
}

function scopeWhere(where: unknown, tenant: Args): Args {
  const base = (where ?? {}) as Args;
  const and = base.AND === undefined ? [] : Array.isArray(base.AND) ? base.AND : [base.AND];
  return { ...base, AND: [tenant, ...and] };
}

/** model → (field → kind): `'scalar'` or the related model's name. */
const FIELDS = new Map(
  Prisma.dmmf.datamodel.models.map((m) => [
    m.name,
    new Map(m.fields.map((f) => [f.name, f.kind === 'object' ? f.type : 'scalar'])),
  ]),
);

/**
 * Write payloads (`data`, `create`, `update`) may set scalar columns only. Any relation
 * key (`connect`, `connectOrCreate`, `set`, `disconnect`, nested create/update/delete, …)
 * is rejected: a `connect` copies the target's merchant/mode into composite FK columns,
 * and nested writes bypass tenant injection. With scalars only, the tenant columns stay
 * fixed and the DB composite FKs validate every reference. Updates may not set `id` or tenant
 * columns.
 */
function assertScalarWrite(model: string, payload: unknown, isUpdate: boolean): void {
  const rows = Array.isArray(payload) ? payload : [payload];
  const fields = FIELDS.get(model);
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    for (const key of Object.keys(row)) {
      if (fields?.get(key) !== 'scalar' && fields?.has(key)) {
        throw forbidden(`relation writes (${model}.${key}) are not available; set FK columns`);
      }
      if (isUpdate && IMMUTABLE_FIELDS.includes(key)) {
        throw forbidden(`${key === 'id' ? 'id' : 'tenant fields'} cannot be changed`);
      }
    }
  }
}

/**
 * The root's tenant filter does not follow relations, so traversals (include, select,
 * `_count`, relation filters, orderBy) are allowed only where the target is confined by
 * composite FKs: into the merchant, shared models, or per-mode models from a per-mode
 * source. Shared/merchant → per-mode would see both modes; infra is never reachable.
 *
 * Keys are classified by field lookup on the current model: a relation field switches the
 * walk to its target model, a scalar field's value is skipped (it may hold JSON), and any
 * other key is a Prisma argument keyword (`where`, `include`, `some`, `AND`, …) walked on
 * the same model. `_count: true` under include/select counts every relation at once, so it
 * is rejected; callers must name relations via `_count: { select: { … } }`.
 */
function assertRelationsAllowed(model: string, value: unknown, parentKey?: string): void {
  if (Array.isArray(value)) {
    return value.forEach((v) => assertRelationsAllowed(model, v, parentKey));
  }
  if (value === null || typeof value !== 'object' || Prisma.Decimal.isDecimal(value)) return;
  const fields = FIELDS.get(model);
  for (const [key, child] of Object.entries(value)) {
    const target = fields?.get(key);
    if (target === 'scalar') continue;
    if (key === '_count' && child === true && (parentKey === 'include' || parentKey === 'select')) {
      throw forbidden('_count: true is not available; select relations explicitly');
    }
    if (target !== undefined) {
      const reachable =
        target === 'Merchant' || shared.has(target) || (isPerMode(target) && isPerMode(model));
      if (!reachable) throw forbidden(`relation ${model}.${key} is not accessible`);
    }
    assertRelationsAllowed(target ?? model, child, key);
  }
}

function scopeArgs(model: string, operation: string, args: Args, ctx: ScopeContext): Args {
  const tenant = tenantFilter(model, ctx);
  if (readOnlyPerMode.has(model) && WRITE_OPS.has(operation)) {
    throw forbidden(`model ${model} is read-only through scoped data access`);
  }
  assertScalarWrite(model, args.data, UPDATE_OPS.has(operation));
  assertScalarWrite(model, args.create, false);
  assertScalarWrite(model, args.update, true);
  assertRelationsAllowed(model, args);
  if (READ_OPS.has(operation) || DELETE_OPS.has(operation)) {
    if (model === 'Merchant' && DELETE_OPS.has(operation))
      throw forbidden('merchants cannot be deleted');
    return { ...args, where: scopeWhere(args.where, tenant) };
  }
  if (UPDATE_OPS.has(operation)) {
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
  return prisma.$extends(scopeExtension(ctx, false)).$extends({
    client: { $disconnect: rejectDisconnect },
  });
}

/** Read-only access to one merchant + mode. AI services only ever receive this. */
export function readOnlyDb(ctx: ScopeContext) {
  return prisma.$extends(scopeExtension(ctx, true)).$extends({
    client: {
      $disconnect: rejectDisconnect,
      $transaction() {
        return Promise.reject(forbidden('read-only data access'));
      },
    },
  });
}

/** Scoped clients share the process-wide connection pool; only infra code may close it. */
function rejectDisconnect(): Promise<never> {
  return Promise.reject(forbidden('scoped clients cannot disconnect the shared client'));
}

export type ScopedDb = ReturnType<typeof scopedDb>;
export type ReadOnlyDb = ReturnType<typeof readOnlyDb>;
