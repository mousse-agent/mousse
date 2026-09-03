"use client"
import { Loader2 } from "lucide-react"
import { cn } from "./utils/cn"

export type SpiralLoaderProps = { size?: number; className?: string }
export function SpiralLoader({ size = 16, className }: SpiralLoaderProps) {
  return <Loader2 className={cn("animate-spin text-muted-foreground", className)} style={{ width: size, height: size }} />
}
