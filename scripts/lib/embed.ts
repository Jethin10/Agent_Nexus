import { createHash } from 'node:crypto'

/**
 * Embeddings for the seed corpus.
 *
 * Production uses Gemini `gemini-embedding-001` at 768 dimensions, and that is used when
 * `GEMINI_API_KEY` is set. Without a key the alternative is not "no embeddings" —
 * that would leave retrieval sources 1 and 4 permanently empty, and the gate would
 * run on lexical and git evidence only, capping confidence below the autonomy band
 * (`bestSimilarity` counts only vector and decision hits).
 *
 * So the offline path generates deterministic hash-based vectors instead. They are
 * **not semantic** and this file says so loudly, because a reader who mistook them
 * for real embeddings would draw a false conclusion about retrieval quality. What
 * they do buy is real: the pgvector query path, the HNSW index, the cosine ordering
 * and the decision-memory distance bound all execute exactly as in production.
 *
 * Term overlap drives the similarity, so documents sharing vocabulary land closer
 * together — enough for the seeded scenarios to retrieve their intended neighbours,
 * and honest about being a lexical proxy rather than a learned space.
 */

export const DIM = 768

export type EmbeddingKind = 'gemini' | 'hash'

export interface Embedder {
  kind: EmbeddingKind
  model: string
  /** Human-readable provenance, printed by the seed and stored on the row. */
  label: string
  embed: (text: string) => Promise<number[]>
}

/** Lowercased alphanumeric terms, deduped. The unit of the hash embedding. */
function terms(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.toLowerCase().matchAll(/[a-z0-9][a-z0-9._/-]{2,}/g)) {
    if (m[0]) out.add(m[0])
  }
  return [...out]
}

/** Stable per-term index in [0, DIM). */
function bucket(term: string): number {
  return createHash('sha256').update(term).digest().readUInt32BE(0) % DIM
}

/**
 * A hashed bag-of-terms projected onto the unit sphere.
 *
 * L2-normalised because cosine distance is what pgvector's `<=>` computes and what
 * `decisionMemory`'s 0.15 bound is expressed in; unnormalised vectors would make that
 * threshold mean something different per document length.
 *
 * **The output is deliberately rescaled into the range real embeddings occupy.** A raw
 * hashed bag-of-terms discriminates correctly but compresses everything into roughly
 * 0.1-0.35 cosine, while `EVIDENCE_FLOOR` is 0.62 and `EVIDENCE_CEILING` 0.92 —
 * calibrated for Gemini retrieval embeddings, where unrelated documents in one repo genuinely
 * sit around 0.5-0.6. Feeding raw hashed scores into that calibration collapses
 * `evidenceStrength` to 0 for *every* event, so no decision could ever be autonomous
 * and the demo would look like a broken gate.
 *
 * The alternative — lowering EVIDENCE_FLOOR — would corrupt the real path to flatter
 * the fixture. Rescaling here keeps the production constants honest and confines the
 * compromise to the file that is already labelled as not-semantic.
 */
export function hashEmbed(text: string): number[] {
  const v = new Array<number>(DIM).fill(0)
  const ts = terms(text)
  for (const t of ts) {
    // Two buckets per term reduces collisions enough that unrelated documents do not
    // drift into each other's neighbourhoods at this corpus size.
    const a = bucket(t)
    const b = bucket(`${t}#2`)
    v[a] = (v[a] ?? 0) + 1
    v[b] = (v[b] ?? 0) + 0.5
  }

  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm)
  if (norm === 0) {
    // An empty document still needs a valid unit vector; an all-zero vector has no
    // defined cosine distance and pgvector would rank it arbitrarily.
    v[0] = 1
    return v
  }

  /**
   * Mix in a constant component so every vector shares a baseline direction, which
   * lifts the whole cosine range into the band the calibration expects while
   * preserving the *ordering* the term overlap produced. `SHARED` sets the floor:
   * two documents with no terms in common land near it, and full overlap approaches 1.
   */
  const SHARED = 0.72
  const unit = v.map((x) => x / norm)
  const out = unit.map((x) => x * (1 - SHARED) + SHARED / Math.sqrt(DIM))

  let n2 = 0
  for (const x of out) n2 += x * x
  n2 = Math.sqrt(n2)
  return out.map((x) => x / n2)
}

/** Production's real embedder. One request per document; the corpus is ~30 items. */
async function geminiEmbed(text: string, apiKey: string): Promise<number[]> {
  const { embedText } = await import('@ascendant/workflows')
  return embedText({ apiKey, text, task: 'RETRIEVAL_DOCUMENT' })
}

export function makeEmbedder(): Embedder {
  const key = process.env.GEMINI_API_KEY
  if (key) {
    return {
      kind: 'gemini',
      model: 'gemini-embedding-001',
      label: 'Gemini gemini-embedding-001 (768d, real semantic embeddings)',
      embed: (text) => geminiEmbed(text, key),
    }
  }
  return {
    kind: 'hash',
    model: 'fixture:hash-768',
    label:
      'deterministic hashed term vectors (768d) — NOT semantic; exercises the real ' +
      'pgvector path. Set GEMINI_API_KEY for true embeddings.',
    embed: async (text) => hashEmbed(text),
  }
}
