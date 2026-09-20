export function roundMacdEvidence(value: unknown) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric === 0) return 0
  return Number(numeric.toPrecision(8))
}

// === MACD Series Calculation ===
export function calculateMacdSeries(closes: readonly number[]) {
  const n = closes.length
  const ema12 = new Array<number>(n).fill(0)
  const ema26 = new Array<number>(n).fill(0)
  const dif = new Array<number>(n).fill(0)
  const dea = new Array<number>(n).fill(0)
  const hist = new Array<number>(n).fill(0)
  if (n === 0) return { difSeries: dif, deaSeries: dea, histSeries: hist, latestDif: 0, latestDea: 0, latestHist: 0 }

  const k12 = 2 / 13, k26 = 2 / 27, k9 = 2 / 10
  ema12[0] = closes[0]!
  ema26[0] = closes[0]!
  dif[0] = 0
  dea[0] = 0
  hist[0] = 0

  for (let i = 1; i < n; i++) {
    ema12[i] = closes[i]! * k12 + ema12[i - 1]! * (1 - k12)
    ema26[i] = closes[i]! * k26 + ema26[i - 1]! * (1 - k26)
    dif[i] = ema12[i]! - ema26[i]!
    dea[i] = dif[i]! * k9 + dea[i - 1]! * (1 - k9)
    hist[i] = dif[i]! - dea[i]!
  }
  return { difSeries: dif, deaSeries: dea, histSeries: hist, latestDif: dif[n - 1]!, latestDea: dea[n - 1]!, latestHist: hist[n - 1]! }
}
