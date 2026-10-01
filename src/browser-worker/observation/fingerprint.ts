export function elementFingerprint(input: {
  role?: string
  name?: string
  tag?: string
  inputType?: string
  nth?: number
}): string {
  return [input.role ?? '', input.name ?? '', input.tag ?? '', input.inputType ?? '', String(input.nth ?? 0)].join(':')
}

export function documentFingerprint(input: { url: string; title: string; loaderId: string; frameId: string }): string {
  return [input.frameId, input.loaderId, input.url, input.title].join('|')
}
