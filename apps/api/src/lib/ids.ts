import { ulid } from 'ulid';

/** Resource id prefixes. Ids are `${prefix}_${ulid}`, so they sort by creation time. */
export type IdPrefix =
  | 'mer'
  | 'usr'
  | 'key'
  | 'akey'
  | 'stc'
  | 'pal'
  | 'whe'
  | 'gpol'
  | 'plink'
  | 'ses'
  | 'quo'
  | 'pay'
  | 'ref'
  | 'whd'
  | 'hook'
  | 'gas'
  | 'scr'
  | 'evt'
  | 'obx'
  | 'fplan'
  | 'rev'
  | 'thm'
  | 'tasset'
  | 'sec'
  | 'idem';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}
