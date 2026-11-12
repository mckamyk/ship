# Records the README demo. Run from the repo root: vhs docs/demo/demo.tape
# Needs vhs (https://github.com/charmbracelet/vhs), ttyd, ffmpeg and bun.

Output docs/demo/ship-demo.mp4
Output docs/demo/ship-demo.gif

Set Shell bash
Set FontSize 18
Set Width 1280
Set Height 760
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 55ms
Set WindowBar Colorful
Set CursorBlink false

Hide
Type "source docs/demo/rc.sh"
Enter
Sleep 2s
Show

Sleep 800ms
# 1. Start a feature from main
Type "ship"
Sleep 400ms
Enter
Sleep 2.5s
Enter
Sleep 1s
Type "Checkout flow"
Sleep 600ms
Enter
Sleep 2.5s

# 2. Write some code
Type "echo 'export const checkout = () => pay(cart);' > src/checkout.ts"
Sleep 300ms
Enter
Sleep 800ms
Type "clear"
Enter
Sleep 300ms

# 3. Ship to dev (commits for you)
Type "ship"
Enter
Sleep 2.5s
Enter
Sleep 1.5s
Enter
Sleep 800ms
Type "Add checkout flow"
Sleep 500ms
Enter
Sleep 4.5s
Type "clear"
Enter
Sleep 300ms

# 4. Ship to staging
Type "ship"
Enter
Sleep 2.5s
Down
Sleep 700ms
Enter
Sleep 1.5s
Type "Checkout v1 for QA"
Sleep 500ms
Enter
Sleep 1.5s
Enter
Sleep 5s
Type "clear"
Enter
Sleep 300ms

# 5. Ship to production
Type "ship"
Enter
Sleep 2.5s
Down
Sleep 400ms
Down
Sleep 700ms
Enter
Sleep 1.5s
Type "Checkout flow"
Sleep 500ms
Enter
Sleep 1.5s
Enter
Sleep 5.5s

# 6. Look at the result
Type "git log --oneline --decorate -3"
Sleep 300ms
Enter
Sleep 4s
