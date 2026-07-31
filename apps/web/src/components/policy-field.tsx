'use client'

import { useActionState } from 'react'
import { updatePolicy, type ActionResult } from '@/app/policy/actions'

/**
 * One editable threshold. The only client component in this app — every other view is a
 * server component that reads Postgres and renders, with nothing to hydrate.
 *
 * It exists as a client component because §16 beat 4 drags the autonomy threshold live
 * in front of judges, and that needs to feel immediate: the result message has to appear
 * without a full navigation. `useActionState` gives that with no client-side data
 * fetching and no state library.
 */
export function PolicyField({
  field,
  label,
  value,
  step,
  fallback,
  overridden,
  help,
}: {
  field: string
  label: string
  value: number
  step: number
  /** The constant in @ascendant/core, shown when the database has no override. */
  fallback: number
  overridden: boolean
  help?: string
}) {
  const [result, action, pending] = useActionState<ActionResult | null, FormData>(
    updatePolicy,
    null,
  )

  return (
    <form action={action} style={{ marginBottom: 14 }}>
      <input type="hidden" name="field" value={field} />
      <div className="row">
        <label htmlFor={`f-${field}`} style={{ minWidth: 178 }}>
          {label}
        </label>
        <input
          id={`f-${field}`}
          name="value"
          type="number"
          step={step}
          defaultValue={value}
          min={0}
          disabled={pending}
        />
        <button type="submit" disabled={pending}>
          {pending ? 'saving…' : 'save'}
        </button>
        {overridden ? (
          <span className="pill">set in config</span>
        ) : (
          <span className="pill dim">default {fallback}</span>
        )}
        {result && (
          <span
            className="small"
            style={{ color: result.ok ? 'var(--accept)' : 'var(--reject)' }}
            role="status"
          >
            {result.message}
          </span>
        )}
      </div>
      {help && (
        <p className="small dim" style={{ margin: '3px 0 0 188px' }}>
          {help}
        </p>
      )}
    </form>
  )
}
