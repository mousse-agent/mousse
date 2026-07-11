import logoOutlineSvg from '../assets/mousse_logo_icon_outline.svg?raw'

interface MousseLogoOutlineProps {
  className?: string
}

export function MousseLogoOutline({ className }: MousseLogoOutlineProps) {
  return (
    <div
      className={className}
      role="img"
      aria-label="Mousse"
      dangerouslySetInnerHTML={{ __html: logoOutlineSvg }}
    />
  )
}
