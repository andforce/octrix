import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { usePreferredMacOsDmgUrl } from '../hooks/usePreferredMacOsDmgUrl'

type Props = {
  className: string
  children: ReactNode
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'rel'>

/** 根据当前环境优先选择 Apple Silicon / Intel DMG 下载地址 */
export function MacDownloadLink({ className, children, ...rest }: Props) {
  const href = usePreferredMacOsDmgUrl()
  return (
    <a href={href} className={className} rel="noopener noreferrer" {...rest}>
      {children}
    </a>
  )
}
