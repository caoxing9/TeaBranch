import { AlertDialog } from 'nsh/base'
import { t } from '../../shared/i18n'

/** The system's alert with OK and Cancel; resolves true when confirmed. */
export async function confirmDialog(message: string, title?: string): Promise<boolean> {
  const { action } = await AlertDialog.show({
    title: title ?? message,
    description: title ? message : null,
    actions: [
      { id: 'cancel', label: t('取消'), role: 'cancel' },
      { id: 'ok', label: t('确定'), role: 'default' },
    ],
  })
  return action === 'ok'
}
