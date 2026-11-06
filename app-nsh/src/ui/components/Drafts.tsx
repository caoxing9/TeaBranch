import { Image, Text, View, resource } from 'nsh'
import { t } from '../../shared/i18n'
import { api } from '../lib/api'
import { Icon } from './Icon'

/**
 * Files on their way into a message: pasted, dropped or picked, saved under the conversation's
 * uploads and shown as chips until the message owns them.
 */
export interface Draft {
  path: string
  name: string
}

export const nameOf = (path: string): string => path.split('/').pop()?.replace(/^\d{14}-/, '') ?? path

/** A pasted file's bytes as base64, the form `saveUpload` takes. */
export async function readAsBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/** Pasted files (images from the clipboard), saved under `uploadKey`. Throws on the first that fails. */
export async function importFiles(uploadKey: string, files: File[]): Promise<Draft[]> {
  const drafts: Draft[] = []
  for (const file of files) {
    const name = file.name || 'pasted.png'
    drafts.push({ path: await api.saveUpload(uploadKey, name, await readAsBase64(file)), name })
  }
  return drafts
}

/** Dropped or pasted local files (`file:` URLs), copied under `uploadKey`. */
export async function importUris(uploadKey: string, uris: string[]): Promise<Draft[]> {
  const { Fs } = await import('teabranch/native')
  const drafts: Draft[] = []
  for (const uri of uris) {
    const source = uri.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : uri
    const name = nameOf(source)
    drafts.push({ path: await api.saveUpload(uploadKey, name, Fs.readFileBase64(source)), name })
  }
  return drafts
}

/** The system's file picker, into `uploadKey`. */
export async function pickDrafts(uploadKey: string): Promise<Draft[]> {
  const paths = await api.pickUploads(uploadKey)
  return paths.map((path) => ({ path, name: nameOf(path) }))
}

/** A draft attachment: its thumbnail when it is an image, its name otherwise; × takes it out. */
export function DraftChip(props: { draft: Draft; onRemove: () => void }) {
  const preview = resource(() => props.draft.path, (path) => api.readUpload(path))
  return (
    <View class="h-10 flex-row items-center gap-1 overflow-hidden rounded-md border border-border bg-muted pl-1" tooltip={props.draft.name}>
      <If
        when={preview()}
        else={
          <>
            <Icon name="file-text" size={14} tint="fg-2" />
            <Text class="max-w-40 text-[12px] text-fg" style={{ numberOfLines: 1 }}>
              {props.draft.name}
            </Text>
          </>
        }
      >
        {(url) => <Image src={url()} class="object-cover" style={{ height: 36, width: 56, borderRadius: 4 }} />}
      </If>
      <View class="size-6 items-center justify-center hover:bg-fill-hover" role="button" tooltip={t('移除')} onPress={props.onRemove}>
        <Icon name="x" size={12} tint="fg-2" />
      </View>
    </View>
  )
}
