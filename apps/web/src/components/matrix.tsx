import { TriageOutcome } from '@ascendant/core'
import type { ConfusionMatrix } from '@ascendant/db'

/**
 * §11.2's confusion matrix. Reported instead of a scalar accuracy figure, because
 * REJECTing something that should have been ACCEPTed is a far worse error than the
 * reverse — and a single number hides exactly that.
 *
 * The false-refusal cells (REJECT/MERGE row, ACCEPT column) are highlighted in the
 * error colour. When a judge asks "what if the triage is wrong?", the answer is to point
 * at those cells rather than at the headline.
 */
const OUTCOMES = TriageOutcome.options

export function Matrix({ matrix }: { matrix: ConfusionMatrix }) {
  const rowTotal = (predicted: (typeof OUTCOMES)[number]) =>
    OUTCOMES.reduce((n, actual) => n + (matrix[predicted]?.[actual] ?? 0), 0)

  return (
    <table className="matrix">
      <thead>
        <tr>
          <th style={{ textAlign: 'left' }}>predicted ↓ / actual →</th>
          {OUTCOMES.map((o) => (
            <th key={o}>
              <span className={`badge b-${o}`}>{o}</span>
            </th>
          ))}
          <th>total</th>
        </tr>
      </thead>
      <tbody>
        {OUTCOMES.map((predicted) => (
          <tr key={predicted}>
            <td style={{ textAlign: 'left' }}>
              <span className={`badge b-${predicted}`}>{predicted}</span>
            </td>
            {OUTCOMES.map((actual) => {
              const n = matrix[predicted]?.[actual] ?? 0
              const isDiagonal = predicted === actual
              // Work the gate refused that a human then accepted.
              const isFalseRefusal =
                actual === 'ACCEPT' && (predicted === 'REJECT' || predicted === 'MERGE') && n > 0
              return (
                <td
                  key={actual}
                  className={isDiagonal ? 'diag' : isFalseRefusal ? 'bad' : undefined}
                  title={
                    isFalseRefusal
                      ? 'A refusal a human overturned into real work — the expensive error'
                      : undefined
                  }
                >
                  {n || <span className="dim">·</span>}
                </td>
              )
            })}
            <td className="dim">{rowTotal(predicted)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
