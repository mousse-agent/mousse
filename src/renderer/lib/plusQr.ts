import qrcode from 'qrcode-generator'

/** SVG path data for a QR code: one 1x1 square per dark module, offset by a 4-module quiet zone. */
export function qrSvgPath(text: string): { size: number; path: string } {
  const qr = qrcode(0, 'M')
  qr.addData(text, 'Byte')
  qr.make()
  const count = qr.getModuleCount(),
    margin = 4,
    parts: string[] = []
  for (let row = 0; row < count; row++)
    for (let col = 0; col < count; col++)
      if (qr.isDark(row, col)) parts.push(`M${col + margin} ${row + margin}h1v1h-1z`)
  return { size: count + margin * 2, path: parts.join('') }
}
