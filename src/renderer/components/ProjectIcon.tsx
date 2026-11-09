import { useState, type ReactNode } from 'react'
import type { Project } from '../../shared/types'
import { useProjectIcon } from '../lib/projectIcons'
import '../styles/project-icons.css'

interface ProjectIconProps {
  project: Pick<Project, 'id' | 'node' | 'iconPath' | 'iconOff' | 'detectedIconPath' | 'iconDetectedAt'> | undefined
  /** Shown when the project has no image icon: another computer's project, icons off, none found, or an older daemon. */
  fallback: ReactNode
  /** Pixels; the image is contained in a square this size. */
  size?: number
  /** Projects tree rows: an open project's icon is bright, a closed one dimmed. Unset elsewhere: always bright. */
  expanded?: boolean
  className?: string
}

/**
 * A project's own icon (its favicon, logo or the file the user chose) as an `<img>`, so an SVG's scripts never run;
 * the folder glyph when it has none or the image does not load.
 */
export function ProjectIcon({ project, fallback, size = 16, expanded, className }: ProjectIconProps) {
  const url = useProjectIcon(project)
  const [broken, setBroken] = useState<string | null>(null)
  if (!url || broken === url) return <>{fallback}</>
  const state = expanded === undefined ? '' : expanded ? ' project-icon-open' : ' project-icon-closed'
  return (
    <img
      src={url}
      alt=""
      aria-hidden="true"
      draggable={false}
      width={size}
      height={size}
      className={`project-icon${state}${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      onError={() => setBroken(url)}
    />
  )
}
