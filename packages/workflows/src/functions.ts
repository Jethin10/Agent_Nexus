import { deliverFn } from './deliver.js'
import { ingestFn } from './ingest.js'
import { maintenanceFn } from './maintenance.js'
import { planAndCodeFn } from './plan-and-code.js'
import { qaFn } from './qa.js'
import { triageFn } from './triage.js'

/**
 * Everything the Inngest `serve()` handler in `apps/web` registers. Inngest discovers
 * functions from `/api/inngest`, so this array is the deployment's contract: a function
 * missing here is a function that never runs, however correct it is.
 */
export const functions = [
  ingestFn,
  triageFn,
  planAndCodeFn,
  qaFn,
  deliverFn,
  maintenanceFn,
] as const
