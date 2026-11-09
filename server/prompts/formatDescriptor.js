/**
 * Prompt que pide al modelo la FORMA del texto, no sus filas.
 *
 * Es el otro lado de `src/lib/parsers/formatDescriptor.js`: el modelo mira una
 * muestra pequeña y devuelve un descriptor de ~200 tokens; el motor determinista
 * lo aplica a las 40 fichas. Ventajas frente a extraer fila a fila, todas
 * medidas sobre un extracto real de cartera gestionada:
 *
 *   · Extrayendo filas: 10 de 17 cantidades salieron corridas un registro,
 *     una fila se perdió y otra se duplicó.
 *   · Aplicando un descriptor: 17 de 17 correctas.
 *
 * Y como la salida es diminuta, no hay que trocear el texto (que es lo que
 * provocaba los cortes a mitad de ficha) ni se agota el cupo de tokens.
 *
 * El descriptor se valida SIEMPRE antes de usarlo (`validateDescriptor`) y se
 * puntúa contra el texto (`scoreDescriptor`): si no entiende lo que dice
 * entender, se cae a la extracción fila a fila de siempre.
 */

export const DESCRIPTOR_SYSTEM_PROMPT = `You are a format analyst. You are shown a SAMPLE of text copied from a bank or broker screen. Your only job is to describe its SHAPE so a deterministic program can parse the rest. You never extract the data itself.

## THE SHAPE YOU ARE LOOKING FOR

Text copied from a web page usually arrives STACKED: one field per line, no separators, no column headers. A transaction is then a GROUP of consecutive lines that repeats with the same structure. Example:

  Suscripción Fondos de Inversión Acme Global Equity Index Fund   <- line 0: description (starts the record)
  50,00 €                                                          <- line 1: amount
  Puntual                                                          <- line 2: filler (status/frequency)
  Finalizada                                                       <- line 3: filler
  2,5 participaciones                                              <- line 4: quantity, marked by a word

A line containing ONLY a date is a HEADING that applies to every record below it until the next such line.

## OUTPUT

Return ONLY this JSON object, no prose, no markdown fences:

{
  "layout": "stacked",
  "startPattern": "<JS regex source matching the FIRST line of a record>",
  "recordLines": <how many lines one record spans, 1-12>,
  "dateHeading": <true if bare-date lines act as headings>,
  "fields": [
    { "offset": <line index inside the record, 0-based>, "role": "description" },
    { "offset": <n>, "role": "amount" },
    { "offset": <n>, "role": "quantity", "marker": "<regex that MUST appear on that line>" }
  ],
  "confidence": <0..1>
}

Roles available: "description", "amount", "quantity", "price", "date". "description" and "amount" are REQUIRED; the rest only when the sample really shows them.

## RULES

- startPattern must match the record's FIRST line and NOTHING else in the text. Anchor it with ^ and use the literal action word the source uses ("Suscripción", "Compra", "Reembolso", "Suscripcion Iic"...). If it would also match a heading or a summary row, make it stricter.
- Give a "marker" to any field that is NOT always present — above all quantity. Without it, a record missing its units line reads the status word as a number.
- recordLines is the DISTANCE between two consecutive record starts, counting the record's own first line. Count it in the sample; do not guess.
- Every offset must be < recordLines.
- If the text is NOT regular — a prose dump, a real CSV with headers, records whose length varies — return {"layout":"none","confidence":0}. Saying "I don't recognise this" is a correct and useful answer; inventing a shape that half-works is not.
- Describe ONLY the repeating transaction block. Ignore portfolio summaries, market-value tables, totals and navigation labels.

Return only the JSON object.`;

/** Muestra acotada: describir la forma no necesita el documento entero. */
export function buildDescriptorMessage(rawText, { sampleLines = 40 } = {}) {
  const lineas = String(rawText || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const muestra = lineas.slice(0, sampleLines);
  return `SAMPLE (${muestra.length} of ${lineas.length} lines):\n${muestra.join('\n')}`;
}
