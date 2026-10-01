export function renderSkillTemplate(input: {
  name: string
  description: string
  instructions?: string
  license?: string
  compatibility?: string
}): string {
  const frontmatter = [
    '---',
    `name: ${yamlScalar(input.name)}`,
    `description: ${yamlScalar(input.description)}`
  ]
  if (input.license) frontmatter.push(`license: ${yamlScalar(input.license)}`)
  if (input.compatibility) frontmatter.push(`compatibility: ${yamlScalar(input.compatibility)}`)
  frontmatter.push('---')

  const body =
    input.instructions?.trim() ||
    [
      `# ${input.name}`,
      '',
      input.description,
      '',
      '## Instructions',
      '',
      '- Describe when this skill should be used.',
      '- Add step-by-step guidance for the agent.',
      '- Link to scripts, references, or assets with relative paths.',
      ''
    ].join('\n')

  return `${frontmatter.join('\n')}\n\n${body.replace(/^\n+/, '')}\n`
}

function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9 _./+-]+$/.test(value) && !value.includes(':')) return value
  return JSON.stringify(value)
}
