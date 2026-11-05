// A window with one built-in terminal in it, for e2e/terminal.test.tsx: the Rust pty, the pty host
// and the terminal view, without the rest of the app around them.
import { View, mount } from 'nsh'
import { TerminalView } from '../src/ui/features/terminal/TerminalView'

function Root() {
  return (
    <View class="flex-1 bg-background">
      <TerminalView id="e2e-terminal" cwd="/tmp" active />
    </View>
  )
}

mount(Root)
