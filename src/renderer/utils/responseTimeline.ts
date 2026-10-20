export function formatWorkedFor(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  return `Worked for ${hours ? `${hours}hrs ` : ''}${minutes ? `${minutes}m ` : ''}${seconds}s`
}

export function formatWorkingFor(milliseconds: number): string {
  return formatWorkedFor(milliseconds).replace('Worked for', 'Working ·').concat(' elapsed')
}
