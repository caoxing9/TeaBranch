// TeaBranch on nsh: the services boot, the preferences load, then the window's root mounts.
import { mount, Text, View, signal } from 'nsh'
import { boot } from './src/boot'
import { App } from './src/ui/App'
import { loadPrefs } from './src/ui/prefs'

function Root() {
  const ready = signal(false)
  const failure = signal<string | null>(null)
  void Promise.all([boot(), loadPrefs()]).then(
    () => ready.set(true),
    (error: unknown) => failure.set(error instanceof Error ? (error.stack ?? error.message) : String(error)),
  )
  return (
    <View class="flex-1 bg-bg">
      <If when={failure()}>
        <View class="flex-1 gap-2 p-8">
          <Text class="text-[15px] font-semibold text-err">TeaBranch could not start</Text>
          <Text class="font-mono text-[12px] text-fg" style={{ userSelect: 'text' }}>
            {failure()}
          </Text>
        </View>
      </If>
      <If when={ready()}>
        <App />
      </If>
    </View>
  )
}

mount(Root)
