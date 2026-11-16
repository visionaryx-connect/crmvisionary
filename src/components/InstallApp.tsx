import { Download, Share, SquarePlus, MoreVertical } from 'lucide-react'
import { usePwaInstall } from '@/lib/pwa'
import { Button, Dialog } from './ui'

/** Explains how to install the app; uses the native prompt when the browser offers one. */
export function InstallAppDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pwa = usePwaInstall()
  const step = (n: number, body: React.ReactNode) => (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line-strong text-[11px] font-bold">{n}</span>
      <span className="pt-0.5 text-[13px] text-ink-2">{body}</span>
    </li>
  )
  return (
    <Dialog open={open} onClose={onClose} title="Install the app" description="Add Visionary X Operations to your home screen. It opens full-screen like a normal app and stays signed in." width={440}>
      {pwa.installed ? (
        <p className="text-[13px] text-ink-2">You are already using the installed app.</p>
      ) : pwa.canPrompt ? (
        <div className="space-y-3">
          <p className="text-[13px] text-ink-2">Your browser can install it in one tap.</p>
          <Button onClick={async () => { if (await pwa.prompt()) onClose() }}>
            <Download className="size-4" /> Install app
          </Button>
        </div>
      ) : (
        <div className="space-y-5">
          <section>
            <p className="eyebrow mb-2">iPhone / iPad (Safari)</p>
            <ol className="space-y-2.5">
              {step(1, <>Open this site in <b className="text-ink">Safari</b>.</>)}
              {step(2, <>Tap <Share className="inline size-4 align-[-3px]" /> <b className="text-ink">Share</b> in the toolbar.</>)}
              {step(3, <>Choose <SquarePlus className="inline size-4 align-[-3px]" /> <b className="text-ink">Add to Home Screen</b>, then <b className="text-ink">Add</b>.</>)}
            </ol>
          </section>
          <section>
            <p className="eyebrow mb-2">Android (Chrome)</p>
            <ol className="space-y-2.5">
              {step(1, <>Tap <MoreVertical className="inline size-4 align-[-3px]" /> the menu in Chrome.</>)}
              {step(2, <>Choose <b className="text-ink">Install app</b> (or <b className="text-ink">Add to Home screen</b>).</>)}
            </ol>
          </section>
        </div>
      )}
    </Dialog>
  )
}
