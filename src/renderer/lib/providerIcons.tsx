import type { ReactNode } from 'react'
import xaiLogo from '../assets/xai_logo.webp'
import antgroupAsset from '../assets/provider-icons/antgroup-color.svg'
import anthropicAsset from '../assets/provider-icons/anthropic.svg'
import claudeAsset from '../assets/provider-icons/claude.svg'
import awsAsset from '../assets/provider-icons/aws-color.svg'
import azureAsset from '../assets/provider-icons/azure-color.svg'
import basetenAsset from '../assets/provider-icons/baseten.svg'
import cerebrasAsset from '../assets/provider-icons/cerebras-color.svg'
import cloudflareAsset from '../assets/provider-icons/cloudflare-color.svg'
import cohereAsset from '../assets/provider-icons/cohere-color.svg'
import copilotAsset from '../assets/provider-icons/copilot-color.svg'
import cursorAsset from '../assets/provider-icons/cursor.svg'
import deepseekAsset from '../assets/provider-icons/deepseek-color.svg'
import fireworksAsset from '../assets/provider-icons/fireworks-color.svg'
import githubAsset from '../assets/provider-icons/github.svg'
import googleAsset from '../assets/provider-icons/google-color.svg'
import groqAsset from '../assets/provider-icons/groq.svg'
import huggingfaceAsset from '../assets/provider-icons/huggingface-color.svg'
import kimiAsset from '../assets/provider-icons/kimi-color.svg'
import metaAsset from '../assets/provider-icons/meta-color.svg'
import minimaxAsset from '../assets/provider-icons/minimax-color.svg'
import mistralAsset from '../assets/provider-icons/mistral-color.svg'
import moonshotAsset from '../assets/provider-icons/moonshot.svg'
import nvidiaAsset from '../assets/provider-icons/nvidia-color.svg'
import openrouterAsset from '../assets/provider-icons/openrouter-color.svg'
import openaiAsset from '../assets/provider-icons/openai.svg'
import opencodeAsset from '../assets/provider-icons/opencode.svg'
import qwenAsset from '../assets/provider-icons/qwen-color.svg'
import togetherAsset from '../assets/provider-icons/together-color.svg'
import vercelAsset from '../assets/provider-icons/vercel.svg'
import xaiAsset from '../assets/provider-icons/xai.svg'
import xiaomiAsset from '../assets/provider-icons/xiaomimimo.svg'
import zaiAsset from '../assets/provider-icons/zai.svg'
import zhipuAsset from '../assets/provider-icons/zhipu-color.svg'

interface ProviderIconProps {
  providerId: string
  size?: number
  className?: string
}

function GenericProviderIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ flexShrink: 0 }}
    >
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M12 3.5v6M20.5 12h-6M12 20.5v-6M3.5 12h6" />
    </svg>
  )
}

function SvgIcon({
  size = 14,
  className,
  viewBox = '0 0 24 24',
  children
}: {
  size?: number
  className?: string
  viewBox?: string
  children: React.ReactNode
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={viewBox}
      fill="currentColor"
      aria-hidden
      style={{ flexShrink: 0 }}
    >
      {children}
    </svg>
  )
}

function OpencodeLogo({ size, className }: { size?: number; className?: string }) {
  return (
    <SvgIcon size={size} className={className} viewBox="0 0 512 512">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"
      />
    </SvgIcon>
  )
}

const PROVIDER_ICONS: Record<string, (props: { size?: number; className?: string }) => ReactNode> = {
  opencode: ({ size, className }) => <OpencodeLogo size={size} className={className} />,
  'opencode-go': ({ size, className }) => <OpencodeLogo size={size} className={className} />,
  anthropic: ({ size, className }) => (
    <SvgIcon size={size} className={className} viewBox="0 0 92 64">
      <path d="M66.4915 0H52.5029L78.0115 64H92.0001L66.4915 0Z" />
      <path d="M26.08 0 .571472 64H14.8343L20.0512 50.56H46.7374L51.9543 64H66.2172L40.7086 0H26.08ZM24.6647 38.6743 33.3943 16.1829 42.1239 38.6743H24.6647Z" />
    </SvgIcon>
  ),
  openai: ({ size, className }) => (
    <SvgIcon size={size} className={className} viewBox="146.694 227.042 267.198 264.812">
      <path d="M249.176 323.434V298.276C249.176 296.158 249.971 294.569 251.825 293.509L302.406 264.381C309.29 260.409 317.5 258.555 325.973 258.555C357.75 258.555 377.877 283.185 377.877 309.399C377.877 311.253 377.877 313.371 377.611 315.49L325.178 284.771C322.001 282.919 318.822 282.919 315.645 284.771L249.176 323.434ZM367.283 421.415V361.301C367.283 357.592 365.694 354.945 362.516 353.092L296.048 314.43L317.763 301.982C319.617 300.925 321.206 300.925 323.058 301.982L373.639 331.112C388.205 339.586 398.003 357.592 398.003 375.069C398.003 395.195 386.087 413.733 367.283 421.412V421.415ZM233.553 368.452L211.838 355.742C209.986 354.684 209.19 353.095 209.19 350.975V292.718C209.19 264.383 230.905 242.932 260.301 242.932C271.423 242.932 281.748 246.641 290.49 253.26L238.321 283.449C235.146 285.303 233.555 287.951 233.555 291.659V368.455L233.553 368.452ZM280.292 395.462L249.176 377.985V340.913L280.292 323.436L311.407 340.913V377.985L280.292 395.462ZM300.286 475.968C289.163 475.968 278.837 472.259 270.097 465.64L322.264 435.449C325.441 433.597 327.03 430.949 327.03 427.239V350.445L349.011 363.155C350.865 364.213 351.66 365.802 351.66 367.922V426.179C351.66 454.514 329.679 475.965 300.286 475.965V475.968ZM237.525 416.915L186.944 387.785C172.378 379.31 162.582 361.305 162.582 343.827C162.582 323.436 174.763 305.164 193.563 297.485V357.861C193.563 361.571 195.154 364.217 198.33 366.071L264.535 404.467L242.82 416.915C240.967 417.972 239.377 417.972 237.525 416.915ZM234.614 460.343C204.689 460.343 182.71 437.833 182.71 410.028C182.71 407.91 182.976 405.792 183.238 403.672L235.405 433.863C238.582 435.715 241.763 435.715 244.938 433.863L311.407 395.466V420.622C311.407 422.742 310.612 424.331 308.758 425.389L258.179 454.519C251.293 458.491 243.083 460.343 234.611 460.343H234.614ZM300.286 491.854C332.329 491.854 359.073 469.082 365.167 438.892C394.825 431.211 413.892 403.406 413.892 375.073C413.892 356.535 405.948 338.529 391.648 325.552C392.972 319.991 393.766 314.43 393.766 308.87C393.766 271.003 363.048 242.666 327.562 242.666C320.413 242.666 313.528 243.723 306.644 246.109C294.725 234.457 278.307 227.042 260.301 227.042C228.258 227.042 201.513 249.815 195.42 280.004C165.761 287.685 146.694 315.49 146.694 343.824C146.694 362.362 154.638 380.368 168.938 393.344C167.613 398.906 166.819 404.467 166.819 410.027C166.819 447.894 197.538 476.231 233.024 476.231C240.172 476.231 247.058 475.173 253.943 472.788C265.859 484.441 282.278 491.854 300.286 491.854Z" />
    </SvgIcon>
  ),
  // Official xAI "A" logomark from https://x.ai/logo.webp, masked so it follows currentColor
  xai: ({ size = 14, className }) => (
    <span
      className={className}
      aria-hidden
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        flexShrink: 0,
        backgroundColor: 'currentColor',
        opacity: 0.92,
        maskImage: `url(${xaiLogo})`,
        WebkitMaskImage: `url(${xaiLogo})`,
        maskSize: 'contain',
        WebkitMaskSize: 'contain',
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
        maskPosition: 'center',
        WebkitMaskPosition: 'center'
      }}
    />
  ),
}

const PROVIDER_ASSET_ICONS: Record<string, { src: string; monochrome?: boolean }> = {
  antgroup: { src: antgroupAsset },
  anthropic: { src: anthropicAsset, monochrome: true },
  claude: { src: claudeAsset, monochrome: true },
  aws: { src: awsAsset },
  azure: { src: azureAsset },
  baseten: { src: basetenAsset, monochrome: true },
  cerebras: { src: cerebrasAsset },
  cloudflare: { src: cloudflareAsset },
  cohere: { src: cohereAsset },
  copilot: { src: copilotAsset },
  cursor: { src: cursorAsset, monochrome: true },
  deepseek: { src: deepseekAsset },
  fireworks: { src: fireworksAsset },
  github: { src: githubAsset, monochrome: true },
  google: { src: googleAsset },
  groq: { src: groqAsset, monochrome: true },
  huggingface: { src: huggingfaceAsset },
  kimi: { src: kimiAsset },
  meta: { src: metaAsset },
  minimax: { src: minimaxAsset },
  mistral: { src: mistralAsset },
  moonshot: { src: moonshotAsset, monochrome: true },
  nvidia: { src: nvidiaAsset },
  openai: { src: openaiAsset, monochrome: true },
  opencode: { src: opencodeAsset, monochrome: true },
  'opencode-go': { src: opencodeAsset, monochrome: true },
  openrouter: { src: openrouterAsset },
  qwen: { src: qwenAsset },
  together: { src: togetherAsset },
  vercel: { src: vercelAsset, monochrome: true },
  xai: { src: xaiAsset, monochrome: true },
  xiaomi: { src: xiaomiAsset, monochrome: true },
  zai: { src: zaiAsset, monochrome: true },
  zhipu: { src: zhipuAsset }
}

function ProviderAssetIcon({
  asset,
  size,
  className
}: {
  asset: { src: string; monochrome?: boolean }
  size: number
  className?: string
}) {
  return (
    <img
      src={asset.src}
      width={size}
      height={size}
      className={className}
      alt=""
      aria-hidden
      style={{
        display: 'block',
        width: size,
        height: size,
        flexShrink: 0,
        objectFit: 'contain',
        filter: asset.monochrome ? 'invert(0.72)' : undefined
      }}
    />
  )
}

function normalizeProviderId(providerId: string): string {
  const id = providerId.toLowerCase()
  if (id === 'claude' || id === 'claude-subscription') return 'claude'
  if (id.includes('anthropic')) return 'anthropic'
  if (id.includes('ant-ling') || id.includes('antling')) return 'antgroup'
  if (id.includes('azure')) return 'azure'
  if (id.includes('openai')) return 'openai'
  if (id.includes('opencode-go')) return 'opencode-go'
  if (id.includes('opencode')) return 'opencode'
  if (id.includes('google') || id.includes('gemini') || id.includes('vertex')) return 'google'
  if (id.includes('amazon') || id.includes('bedrock')) return 'aws'
  if (id.includes('baseten')) return 'baseten'
  if (id.includes('cerebras')) return 'cerebras'
  if (id.includes('cloudflare')) return 'cloudflare'
  if (id.includes('copilot') || id.includes('github')) return 'copilot'
  if (id.includes('fireworks')) return 'fireworks'
  if (id.includes('huggingface')) return 'huggingface'
  if (id.includes('kimi')) return 'kimi'
  if (id.includes('minimax')) return 'minimax'
  if (id.includes('moonshot')) return 'moonshot'
  if (id.includes('nvidia')) return 'nvidia'
  if (id.includes('openrouter')) return 'openrouter'
  if (id.includes('deepseek')) return 'deepseek'
  if (id.includes('xai') || id.includes('grok')) return 'xai'
  if (id.includes('mistral')) return 'mistral'
  if (id.includes('groq')) return 'groq'
  if (id.includes('meta') || id.includes('llama')) return 'meta'
  if (id.includes('cohere')) return 'cohere'
  if (id.includes('qwen')) return 'qwen'
  if (id.includes('together')) return 'together'
  if (id.includes('vercel')) return 'vercel'
  if (id.includes('xiaomi')) return 'xiaomi'
  if (id.includes('zhipu') || id.includes('glm')) return 'zhipu'
  if (id === 'zai' || id.startsWith('zai-') || id.includes('z-ai')) return 'zai'
  if (id === 'cursor' || id.includes('cursor')) return 'cursor'
  return id
}

export function ProviderIcon({ providerId, size = 14, className }: ProviderIconProps) {
  const normalized = normalizeProviderId(providerId)
  const asset = PROVIDER_ASSET_ICONS[normalized]
  if (asset) {
    return <ProviderAssetIcon asset={asset} size={size} className={className} />
  }
  const Icon = PROVIDER_ICONS[normalized]
  if (Icon) {
    return <Icon size={size} className={className} />
  }
  return <GenericProviderIcon size={size} className={className} />
}
